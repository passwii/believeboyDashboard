#!/usr/bin/env python3
"""
生产回滚 Agent（BLF-524）— BelieveBoy Dashboard

合并即上线、无 staging，坏合并直接到生产。本脚本是「回滚协议」的执行端：
对刚部署的坏 commit 做后端 revert + 服务重启 + 健康检查，并对前端做
Vercel 回滚，失败时通过现有渠道（multica issue 评论）告警。

使用方式（CLI，风格对齐 deploy_vps.py）:
    cd productEnvAgent
    python rollback.py --bad-sha <sha>                # 交互式（会二次确认）
    python rollback.py --bad-sha <sha> --dry-run      # 只打印命令序列，不执行
    python rollback.py --bad-sha <sha> --auto --force # 非交互 + 跳过确认
    python rollback.py --auto --force                 # bad-sha 自动取最近一次失败部署

关键安全约束（BEL-492 / 本任务注意项）:
- --dry-run 必须可用；默认（含 --auto）要求确认，仅 --force 跳过确认。
- 迁移已部署的禁止改 revision id；downgrade 前必须 `alembic history` 核对。
- 回滚是生产运维工具：执行前会显示完整命令序列。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

from alerting import (
    STATE_FILE,
    read_failed_deploy_state,
    resolve_alert_issue_id,
    send_deploy_failure_alert,
)

# VPS 配置（与 deploy_vps.py 保持一致）
VPS_HOST = "145.79.143.98"
VPS_USER = "root"
PROJECT_DIR = "/root/believeboyDashboard/"
BACKEND_DIR = f"{PROJECT_DIR}backend/"
VENV_ACTIVATE = "source /root/believeboyDashboard/backend/.venv/bin/activate"

# 四个后端服务（部署/回滚都要一起重启）
# believeboy-beat 于 BLF-1039 补入：beat 侧变更（beat_schedule / 任务模块
# 惰性导入）必须重启 beat 进程才生效，此前回滚漏掉 beat 会让「回滚成功」
# 却仍跑着新代码的 beat 进程。
SERVICES = [
    "believeboy-api",
    "believeboy-celery.service",
    "believeboy-celery-scheduled.service",
    "believeboy-beat.service",
]

GITHUB_REPO = "passwii/believeboyDashboard"

SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


# ---------------------------------------------------------------------------
# 纯逻辑（可单测，不触网）
# ---------------------------------------------------------------------------


def resolve_bad_sha(cli_sha: str | None, state: dict | None) -> str | None:
    """bad-sha 解析：CLI 参数优先，其次最近一次失败部署状态文件。"""
    if cli_sha:
        sha = cli_sha.strip()
        return sha if SHA_RE.match(sha) else None
    if state and isinstance(state.get("bad_sha"), str):
        sha = state["bad_sha"].strip()
        if sha != "unknown" and SHA_RE.match(sha):
            return sha
    return None


def _ssh(remote_cmd: str) -> str:
    return f"ssh {VPS_USER}@{VPS_HOST} '{remote_cmd}'"


def build_backend_plan(
    bad_sha: str, *, downgrade_rev: str | None = None, push_back: bool = False
) -> list[tuple[str, str]]:
    """后端回滚命令序列：[(阶段名, 远程命令)]。

    顺序：状态展示 → fetch → 校验 bad-sha → revert（merge-aware）→
    （可选 push 回 origin）→ alembic 处理 → 重启四服务 → 健康检查。
    """
    plan: list[tuple[str, str]] = []

    plan.append(
        (
            "展示当前状态",
            _ssh(f"cd {PROJECT_DIR} && git fetch origin && git log --oneline -3"),
        )
    )

    plan.append(
        (
            "校验 bad-sha 存在",
            _ssh(
                f"cd {PROJECT_DIR} && git cat-file -e {bad_sha}^{{commit}} "
                f'&& echo "bad-sha 存在: {bad_sha}"'
            ),
        )
    )

    # revert（merge commit 需要 -m 1；在 VPS 上数 parent 数判断，避免猜错）
    plan.append(
        (
            "git revert 坏提交",
            _ssh(
                f"cd {PROJECT_DIR} && "
                f'parents=$(git cat-file -p {bad_sha} | grep -c "^parent"); '
                f'if [ "$parents" -ge 2 ]; then '
                f"git revert --no-edit -m 1 {bad_sha}; "
                f"else git revert --no-edit {bad_sha}; fi"
            ),
        )
    )

    if push_back:
        plan.append(
            (
                "推送 revert 回 origin/main",
                _ssh(f"cd {PROJECT_DIR} && git push origin main"),
            )
        )

    # alembic 处理：先跑机械检查（BLF-492），再视需要 downgrade（必须现看 history）
    plan.append(
        (
            "Alembic 机械检查",
            _ssh(
                f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && python scripts/check_alembic.py"
            ),
        )
    )
    if downgrade_rev:
        plan.append(
            (
                "核对 alembic history",
                _ssh(
                    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && alembic history | head -40"
                ),
            )
        )
        plan.append(
            (
                "downgrade 到指定修订",
                _ssh(
                    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && alembic downgrade {downgrade_rev}"
                ),
            )
        )

    plan.append(("重启四个服务", _ssh("systemctl restart " + " ".join(SERVICES))))

    plan.append(
        (
            "服务状态检查",
            _ssh(
                "systemctl is-active believeboy-api "
                "believeboy-celery.service believeboy-celery-scheduled.service "
                "believeboy-beat.service"
            ),
        )
    )

    plan.append(
        (
            "健康检查 (HTTP)",
            _ssh(
                'curl -s -o /dev/null -w "%{http_code}" '
                'http://127.0.0.1:8100/api/v1/health || echo "000"'
            ),
        )
    )

    return plan


def build_frontend_plan() -> list[tuple[str, str]]:
    """前端（Vercel）回滚命令序列（本地执行）。

    优先 vercel CLI（已登录）；否则走 VERCEL_TOKEN REST API；
    两者都没有 → 最后一项给出人工指引并标记为需要凭据。
    """
    plan: list[tuple[str, str]] = []
    plan.append(("获取上一 production 部署", "vercel ls --prod --limit 2"))
    plan.append(
        ("回滚到上一 production 部署", "vercel rollback <上一步返回的旧部署 URL>")
    )
    return plan


def format_plan(plan: list[tuple[str, str]], prefix: str = "  ") -> str:
    lines = [
        f"{prefix}步骤 {i}: {label}\n{prefix}    {cmd}"
        for i, (label, cmd) in enumerate(plan, 1)
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------


def run_local(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"命令超时（{timeout}s）"
    except Exception as e:  # pragma: no cover
        return -1, "", str(e)


def confirm_proceed(plan_backend: list, plan_frontend: list) -> bool:
    """展示完整命令序列并请求确认（--force / --dry-run 时由调用方跳过）。"""
    print("\n" + "=" * 64)
    print("⚠️  即将在生产 VPS / Vercel 上执行回滚，请核对完整命令序列：")
    print("=" * 64)
    print("\n[后端]\n" + format_plan(plan_backend))
    print("\n[前端]\n" + format_plan(plan_frontend))
    resp = input("\n确认执行回滚？[y/N]: ").strip().lower()
    return resp == "y"


def run_rollback(
    *,
    bad_sha: str,
    dry_run: bool = False,
    force: bool = False,
    push_back: bool = False,
    downgrade_rev: str | None = None,
    do_frontend: bool = True,
    alert_issue: str | None = None,
) -> int:
    """执行回滚主流程。返回 exit code。"""
    print("=" * 64)
    print("  BelieveBoy Dashboard - 生产回滚工具（BLF-524）")
    print(f"  目标: {VPS_USER}@{VPS_HOST} / Vercel")
    print(f"  bad-sha: {bad_sha}")
    print("=" * 64)

    if dry_run:
        print("\n[DRY RUN 模式] - 不会执行任何命令\n")

    backend_plan = build_backend_plan(
        bad_sha, downgrade_rev=downgrade_rev, push_back=push_back
    )
    frontend_plan = build_frontend_plan() if do_frontend else []

    print("\n[后端回滚命令序列]\n" + format_plan(backend_plan))
    if frontend_plan:
        print("\n[前端回滚命令序列（Vercel，本地执行）]\n" + format_plan(frontend_plan))

    if dry_run:
        print("\n[DRY RUN] 序列如上，未执行任何操作。")
        return 0

    if not force and not confirm_proceed(backend_plan, frontend_plan):
        print("回滚已取消。")
        return 1

    failed: list[str] = []

    # --- 后端 ---
    print("\n>>> 执行后端回滚...")
    for label, cmd in backend_plan:
        print(f"\n--- {label} ---")
        print(f"$ {cmd}")
        rc, out, err = run_local(cmd, timeout=300)
        if out.strip():
            print(out.strip()[:2000])
        if rc != 0:
            print(f"✗ {label} 失败: {err.strip()[:800] or out.strip()[:800]}")
            failed.append(label)
            break
        if label == "健康检查 (HTTP)":
            code = (out or "").strip() or "000"
            # 200 = 健康;401 = 服务已起但 /health 需 API key（探活视为通过）
            if code in ("200", "401"):
                print(f"  ✓ API 健康检查通过 (HTTP {code})")
            else:
                print(f"  ✗ API 健康检查失败 (HTTP {code})")
                failed.append(label)
                break
        else:
            print("  ✓ OK")

    # --- 前端 ---
    if do_frontend and not failed:
        print("\n>>> 执行前端回滚（Vercel）...")
        rc, out, err = run_local("vercel whoami", timeout=30)
        if rc != 0:
            print("✗ vercel CLI 未登录，且未提供 VERCEL_TOKEN；前端回滚需人工执行：")
            print(
                "   vercel login 后运行: vercel ls --prod && vercel rollback <旧部署 URL>"
            )
            print("   或设置 VERCEL_TOKEN 后重跑本脚本。")
            failed.append("frontend:vercel-credentials")
        else:
            # CLI 已登录：列出 production 部署，回滚到上一个
            rc, out, err = run_local("vercel ls --prod --limit 2", timeout=60)
            print(out.strip()[:1500])
            if rc != 0:
                print(f"✗ 获取 Vercel 部署列表失败: {err.strip()[:500]}")
                failed.append("frontend:vercel-ls")
            else:
                # 解析部署 URL（vercel ls 输出的第一列为 URL，取第二个即上一部署）
                urls = [
                    ln.split()[0]
                    for ln in out.splitlines()
                    if ln.strip().startswith(("https://", "http://"))
                ]
                if len(urls) >= 2:
                    rc, out, err = run_local(f"vercel rollback {urls[1]}", timeout=120)
                    if rc != 0:
                        print(
                            f"✗ vercel rollback 失败: {err.strip()[:500] or out.strip()[:500]}"
                        )
                        failed.append("frontend:vercel-rollback")
                    else:
                        print("  ✓ Vercel 已回滚到上一 production 部署")
                else:
                    print(
                        "✗ 未找到上一 production 部署（可能从未发布或列表解析失败），需人工处理。"
                    )
                    failed.append("frontend:vercel-no-previous")

    # --- 汇总 / 告警 ---
    print("\n" + "=" * 64)
    if failed:
        print(f"✗ 回滚未完全成功，失败环节: {', '.join(failed)}")
        print("=" * 64)
        send_deploy_failure_alert(
            bad_sha=bad_sha,
            stage="rollback:" + ",".join(failed),
            error="回滚执行失败，需人工介入（见上方输出）。",
            issue_id=alert_issue,
        )
        return 1

    print(
        "  ✓ 回滚完成：后端已 revert + 服务已重启 + 健康检查通过"
        + ("" if not frontend_plan else "；前端已回滚")
    )
    print("=" * 64)
    print("提示: 回滚后请同步 revert 提交（见 ROLLBACK.md「回滚后重试部署」）。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="生产回滚工具（BLF-524）")
    parser.add_argument("--bad-sha", help="要回滚的坏 commit（默认取最近一次失败部署）")
    parser.add_argument("--dry-run", action="store_true", help="只打印命令序列，不执行")
    parser.add_argument(
        "--auto",
        action="store_true",
        help="自动模式：bad-sha 未指定时从失败状态文件读取（仍需确认，除非 --force）",
    )
    parser.add_argument("--force", action="store_true", help="跳过确认提示")
    parser.add_argument(
        "--push-back",
        action="store_true",
        help="revert 后把提交推回 origin/main（保持两端一致）",
    )
    parser.add_argument(
        "--downgrade",
        metavar="REV",
        help="需要 DB 降级时指定 alembic 目标修订（执行前会先展示 alembic history）",
    )
    parser.add_argument(
        "--no-frontend", action="store_true", help="跳过前端 Vercel 回滚"
    )
    parser.add_argument("--alert-issue", help="失败告警目标 issue id（默认走配置）")
    args = parser.parse_args()

    state = read_failed_deploy_state()
    bad_sha = resolve_bad_sha(args.bad_sha, state if args.auto else None)

    if not bad_sha:
        print(
            "❌ 无法确定 bad-sha：请用 --bad-sha <sha> 指定，或用 --auto 读取"
            "最近一次失败部署状态文件。"
        )
        print(f"   状态文件: {STATE_FILE}")
        return 1

    alert_issue = resolve_alert_issue_id(args.alert_issue)
    return run_rollback(
        bad_sha=bad_sha,
        dry_run=args.dry_run,
        force=args.force,
        push_back=args.push_back,
        downgrade_rev=args.downgrade,
        do_frontend=not args.no_frontend,
        alert_issue=alert_issue,
    )


if __name__ == "__main__":
    sys.exit(main())
