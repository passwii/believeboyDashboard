#!/usr/bin/env python3
"""
CodeReview Agent — 本地代码审查 CLI，结果同步到生产端 Dashboard。

Usage:
    cd backend
    source .venv/bin/activate
    export DIGITAL_EMPLOYEE_API_BASE_URL=https://your-production.com
    export DIGITAL_EMPLOYEE_ID=42
    export DIGITAL_EMPLOYEE_API_SECRET=sk_live_xxxx

    python scripts/code_review_agent.py                       # 审查当前分支未合并的变更
    python scripts/code_review_agent.py --since="2 days ago"  # 审查最近 2 天的变更
    python scripts/code_review_agent.py --branch main        # 审查 main 分支最新提交
    python scripts/code_review_agent.py --since="HEAD~5"     # 审查最近 5 个提交
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import textwrap
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.digital_employee_client import DigitalEmployeeClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("code_review_agent")


# ── Git Helpers ───────────────────────────────────────────────────────────────

@dataclass
class FileDiff:
    path: str
    status: str  # A=added, M=modified, D=deleted, R=renamed
    hunks: list[str] = field(default_factory=list)


@dataclass
class CommitInfo:
    sha: str
    short_sha: str
    message: str
    author: str
    date: str


def run_git(cmd: list[str], cwd: str | None = None) -> str:
    """Run a git command and return stdout."""
    try:
        return subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except subprocess.CalledProcessError as exc:
        log.error("Git command failed: %s", exc.stderr.strip())
        sys.exit(1)


def get_changed_files(since: str) -> list[FileDiff]:
    """Get list of changed files (staged + unstaged) compared to `since` ref."""
    diff_output = run_git([
        "git", "diff", "--name-status", "--diff-filter=AMD",
        f"{since}..HEAD",
    ])
    files: list[FileDiff] = []
    for line in diff_output.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status_code = parts[0][0].upper()
        path = parts[1] if len(parts) > 1 else parts[0]
        status_map = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed"}
        status = status_map.get(status_code, status_code)
        files.append(FileDiff(path=path, status=status))
    return files


def get_diff_hunks(path: str, since: str) -> list[str]:
    """Get unified diff hunks for a single file."""
    try:
        return run_git(["git", "diff", f"{since}..HEAD", "--", path]).split("\n")
    except SystemExit:
        return []


def get_recent_commits(since: str, limit: int = 10) -> list[CommitInfo]:
    """Get recent commits."""
    output = run_git([
        "git", "log", f"--after={since}", "--format=%H|%s|%an|%ad",
        "--date=iso", "-n", str(limit),
    ])
    commits: list[CommitInfo] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) < 4:
            continue
        sha = parts[0]
        commits.append(CommitInfo(
            sha=sha,
            short_sha=sha[:8],
            message=parts[1],
            author=parts[2],
            date=parts[3],
        ))
    return commits


def get_current_branch() -> str:
    return run_git(["git", "rev-parse", "--abbrev-ref", "HEAD"])


def get_repo_root() -> str:
    return run_git(["git", "rev-parse", "--show-toplevel"])


# ── Review Logic ──────────────────────────────────────────────────────────────

SKIP_EXTENSIONS = {
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico",
    ".pdf", ".zip", ".tar", ".gz", ".rar",
    ".lock", ".sum",
    "__pycache__", ".pyc", ".pyo",
    "node_modules", ".git", ".venv", "dist", "build",
}

SKIP_PATTERNS = {
    ".min.", "bundle.", "compiled.", "generated.",
}

CODE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx",
    ".go", ".rs", ".java", ".c", ".cpp", ".h",
    ".sh", ".bash", ".zsh",
    ".sql", ".yaml", ".yml", ".toml", ".json",
    ".md", ".rst",
}


def should_review(path: str) -> bool:
    for skip in SKIP_EXTENSIONS:
        if skip in path:
            return False
    for pat in SKIP_PATTERNS:
        if pat in path:
            return False
    return any(path.endswith(ext) for ext in CODE_EXTENSIONS)


@dataclass
class ReviewFinding:
    file: str
    severity: str  # INFO | WARN | ERROR
    line_hint: str
    message: str
    suggestion: str = ""


def review_python_file(path: str, hunks: list[str]) -> list[ReviewFinding]:
    findings: list[ReviewFinding] = []
    full_content = "\n".join(hunks)

    lines = full_content.split("\n")
    in_docstring = False
    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        # Detect docstring state
        if stripped.startswith('"""') or stripped.startswith("'''"):
            in_docstring = not in_docstring

        # TODO without description
        if stripped.startswith("# TODO") and len(stripped) < 20:
            findings.append(ReviewFinding(
                file=path, severity="WARN",
                line_hint=f"line {i}",
                message="TODO 注释缺少描述",
                suggestion="添加具体说明：需要做什么、截止日期、负责人",
            ))

        # Bare except
        if stripped == "except:" and not in_docstring:
            findings.append(ReviewFinding(
                file=path, severity="ERROR",
                line_hint=f"line {i}",
                message="使用了裸 except，未捕获具体异常",
                suggestion="使用 except Exception 或具体的异常类型",
            ))

        # print() in production code
        if stripped.startswith("print(") and "DEBUG" not in stripped:
            findings.append(ReviewFinding(
                file=path, severity="INFO",
                line_hint=f"line {i}",
                message="发现 print() 语句",
                suggestion="使用 logging 模块替代 print",
            ))

        # Slow loop: nested list comprehension or multiple enumerate
        if "for " in stripped and ("[" in stripped and "]" in stripped) and stripped.count(":") >= 2:
            findings.append(ReviewFinding(
                file=path, severity="INFO",
                line_hint=f"line {i}",
                message="嵌套数据结构可能导致性能问题",
                suggestion="检查是否有 O(n²) 复杂度",
            ))

        # SQL injection risk: string formatting in query
        if ("SELECT" in stripped or "INSERT" in stripped or "UPDATE" in stripped) and (
            "%" in stripped or "+ " in stripped and '"' in stripped
        ):
            findings.append(ReviewFinding(
                file=path, severity="ERROR",
                line_hint=f"line {i}",
                message="疑似 SQL 注入风险：避免用字符串拼接构建 SQL",
                suggestion="使用参数化查询",
            ))

        # Hardcoded credentials
        lower = stripped.lower()
        if any(kw in lower for kw in ["password", "api_key", "secret", "token"]) and "=" in stripped:
            if "#" not in stripped.split("=")[0]:
                findings.append(ReviewFinding(
                    file=path, severity="ERROR",
                    line_hint=f"line {i}",
                    message="疑似硬编码敏感信息",
                    suggestion="使用环境变量或配置文件管理敏感数据",
                ))

    return findings


def review_file(path: str, hunks: list[str]) -> list[ReviewFinding]:
    """Route to language-specific reviewer."""
    if path.endswith(".py"):
        return review_python_file(path, hunks)
    return []


def review_files(files: list[FileDiff], since: str, client: DigitalEmployeeClient) -> dict[str, Any]:
    """Review changed files and report findings."""
    findings: list[ReviewFinding] = []
    total = len(files)
    reviewed = 0

    for i, f in enumerate(files):
        progress = int((i / max(total, 1)) * 100)
        client.update_progress(
            client._task_id or "",
            "RUNNING",
            progress,
            f"审查 {f.path} ({i+1}/{total})",
        )

        if not should_review(f.path):
            continue

        hunks = get_diff_hunks(f.path, since)
        results = review_file(f.path, hunks)
        findings.extend(results)

        for finding in results:
            level = "WARN" if finding.severity == "WARN" else "ERROR" if finding.severity == "ERROR" else "INFO"
            client.log(
                client._task_id or "",
                level,
                f"[{f.path}] {finding.line_hint}: {finding.message}" +
                (f" → {finding.suggestion}" if finding.suggestion else ""),
            )
            log.info("[%s] %s %s", finding.severity, f.path, finding.message)

        reviewed += 1

    return {
        "files_reviewed": reviewed,
        "total_changed": total,
        "issues_found": len(findings),
        "by_severity": {
            "ERROR": sum(1 for f in findings if f.severity == "ERROR"),
            "WARN": sum(1 for f in findings if f.severity == "WARN"),
            "INFO": sum(1 for f in findings if f.severity == "INFO"),
        },
        "findings": findings,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CodeReview Agent — 本地代码审查")
    parser.add_argument(
        "--since",
        default="HEAD~1",
        help="Git ref 或时间范围，默认为上一提交。例：--since='2 days ago'，--since='main'",
    )
    parser.add_argument(
        "--branch",
        help="指定分支，与 --since 配合：比较当前分支与指定分支的差异",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="不连接生产端，仅输出审查结果",
    )
    parser.add_argument(
        "--since-commit",
        dest="since_commit",
        help="显式指定起始 commit SHA（会覆盖 --since）",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo_root = get_repo_root()
    current_branch = get_current_branch()
    since = args.since

    if args.branch:
        since = args.branch
        log.info("Reviewing %s vs %s", current_branch, args.branch)
    elif args.since_commit:
        since = args.since_commit

    commits = get_recent_commits(since, limit=5)
    changed_files = get_changed_files(since)
    log.info("Found %d changed file(s) since %s", len(changed_files), since)
    for f in changed_files:
        log.info("  %s: %s", f.status, f.path)

    if not changed_files:
        log.warning("No changed files found. Nothing to review.")
        return

    if args.dry_run:
        log.info("[DRY RUN] Skipping production sync.")
        result = review_files(changed_files, since, _NOOP_CLIENT)
        print_summary(result)
        return

    # Connect to production
    try:
        client = DigitalEmployeeClient.from_env()
    except EnvironmentError as exc:
        log.error("Configuration error: %s", exc)
        log.info("Set the following env vars before running:")
        log.info("  DIGITAL_EMPLOYEE_API_BASE_URL")
        log.info("  DIGITAL_EMPLOYEE_ID")
        log.info("  DIGITAL_EMPLOYEE_API_SECRET")
        sys.exit(1)

    task_id = client.start_task(
        task_name=f"CodeReview: {current_branch} vs {since}",
        task_type="CODE_REVIEW",
    )
    log.info("Task started: %s", task_id)
    client.log(task_id, "INFO", f"审查分支 {current_branch}，对比基准 {since}")

    try:
        result = review_files(changed_files, since, client)
        result["branch"] = current_branch
        result["base"] = since
        result["commits"] = [
            {"sha": c.short_sha, "message": c.message, "author": c.author}
            for c in commits
        ]
        client.complete(task_id, metadata=result)
        log.info("Task completed.")
        print_summary(result)
    except Exception as exc:
        tb = traceback.format_exc()
        client.fail(task_id, str(exc))
        client.log(task_id, "ERROR", f"审查异常:\n{tb}")
        log.error("Review failed: %s", exc)
        sys.exit(1)


# ── Noop client for dry-run ──────────────────────────────────────────────────

class _NoopClient:
    """Dummy client used in --dry-run mode."""
    _task_id: str = "dry-run-task"
    def update_progress(self, task_id: str, status: str, progress: int, step: str) -> None:
        pass
    def log(self, task_id: str, level: str, message: str) -> None:
        log.info("[%s] %s", level, message)


_NOOP_CLIENT = _NoopClient()


def print_summary(result: dict[str, Any]) -> None:
    print()
    print("=" * 60)
    print(f"  CodeReview Summary")
    print("=" * 60)
    print(f"  Branch: {result.get('branch', 'N/A')}")
    print(f"  Files reviewed: {result['files_reviewed']}/{result['total_changed']}")
    print(f"  Total issues: {result['issues_found']}")
    by_sev = result.get("by_severity", {})
    print(f"    ERROR : {by_sev.get('ERROR', 0)}")
    print(f"    WARN  : {by_sev.get('WARN', 0)}")
    print(f"    INFO  : {by_sev.get('INFO', 0)}")
    print("=" * 60)

    findings = result.get("findings", [])
    if findings:
        print("\nFindings:")
        for f in findings:
            severity_icon = {"ERROR": "🔴", "WARN": "🟡", "INFO": "🔵"}.get(f.severity, "⚪")
            print(f"  {severity_icon} [{f.severity}] {f.file} {f.line_hint}")
            print(f"       {f.message}")
            if f.suggestion:
                print(f"       → {f.suggestion}")


if __name__ == "__main__":
    main()
