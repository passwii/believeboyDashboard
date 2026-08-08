#!/usr/bin/env python3
"""
告警助手（BLF-524）— deploy_vps.py / rollback.py 共用。

职责：
1. 记录「最近一次失败部署」状态（bad-sha / 阶段 / 时间 / 回滚命令），供
   rollback.py --auto 自动取 bad-sha。
2. 通过现有通知渠道（workspace 内 multica issue 评论，复用不新建）发出部署
   失败告警，标明受影响 PR 与回滚命令；multica 不可用时兜底落本地文件。

渠道解析顺序（复用现有渠道，不新建）：
    CLI 参数 --alert-issue <uuid> > 环境变量 ALERT_ISSUE_ID >
    productEnvAgent/config.json 的 alert.issue_id > 不指定（仅本地文件）

multica 评论要求（MUL-2904）：正文必须写成文件后用 --content-file 提交，
禁止 --content 内联 / --content-stdin 与其他 flag 混用。本模块统一处理。
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

# productEnvAgent/ 目录（本文件所在目录）
SCRIPT_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
LOGS_DIR = SCRIPT_DIR / "logs"
ALERTS_DIR = LOGS_DIR / "alerts"
STATE_FILE = LOGS_DIR / "last-failed-deploy.json"

GITHUB_REPO = "passwii/believeboyDashboard"


# ---------------------------------------------------------------------------
# 配置解析
# ---------------------------------------------------------------------------


def _load_config() -> dict:
    """读取 productEnvAgent/config.json（不存在或损坏返回 {}）。"""
    cfg_path = SCRIPT_DIR / "config.json"
    if not cfg_path.exists():
        return {}
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def resolve_alert_issue_id(cli_value: str | None = None) -> str | None:
    """解析告警目标 issue id：CLI 参数 > 环境变量 > config.json > None。"""
    if cli_value:
        return cli_value.strip()
    env = os.environ.get("ALERT_ISSUE_ID", "").strip()
    if env:
        return env
    cfg_issue = _load_config().get("alert", {}).get("issue_id")
    return (
        cfg_issue.strip() if isinstance(cfg_issue, str) and cfg_issue.strip() else None
    )


# ---------------------------------------------------------------------------
# 本地状态记录
# ---------------------------------------------------------------------------


def record_failed_deploy(
    *,
    bad_sha: str | None,
    stage: str,
    error: str = "",
    alert_issue: str | None = None,
) -> Path:
    """把一次失败部署写进 logs/last-failed-deploy.json（rollback --auto 读取）。

    返回状态文件路径；写入失败（目录不可写）时返回 None 语义由调用方决定。
    """
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    state = {
        "bad_sha": bad_sha or "unknown",
        "stage": stage,
        "error": error[:2000],
        "timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
        "alert_issue": alert_issue,
        "rollback_command": build_rollback_command(bad_sha),
    }
    state_path = STATE_FILE
    state_path.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return state_path


def read_failed_deploy_state() -> dict | None:
    """读取最近一次失败部署状态；不存在 / 损坏返回 None。"""
    if not STATE_FILE.exists():
        return None
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


# ---------------------------------------------------------------------------
# 告警正文组装
# ---------------------------------------------------------------------------


def build_rollback_command(bad_sha: str | None) -> str:
    """生成告警里附带的回滚命令（后端 + 前端提示）。"""
    if not bad_sha or bad_sha == "unknown":
        return "无法自动定位 bad-sha，请先人工确认出错的 commit。"
    return (
        f"python productEnvAgent/rollback.py --bad-sha {bad_sha} "
        f"--auto --force\n"
        f"  （如需把 revert 同步回 origin/main 加 --push-back；"
        f"涉及已部署迁移需降级时按 ROLLBACK.md 核对 alembic history 后加 --downgrade <rev>）"
    )


def lookup_pr_for_commit(bad_sha: str | None) -> str | None:
    """用 gh api 反查 commit 关联的 PR（尽力而为，失败返回 None）。"""
    if not bad_sha or bad_sha == "unknown":
        return None
    try:
        out = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{GITHUB_REPO}/commits/{bad_sha}/pulls",
                "--jq",
                ".[0].number",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        num = out.stdout.strip()
        return f"#{num}" if num.isdigit() else None
    except Exception:
        return None


def build_alert_body(*, title: str, sections: dict) -> str:
    """按固定模板组装 issue 评论正文。sections 为 {小节标题: 文本}。"""
    lines = [f"## {title}", ""]
    for key, val in sections.items():
        lines.append(f"- **{key}**：{val}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 告警发送
# ---------------------------------------------------------------------------


def _multica_available() -> bool:
    try:
        subprocess.run(
            ["multica", "--version"],
            capture_output=True,
            timeout=10,
        )
        return True
    except Exception:
        return False


def _post_multica_comment(issue_id: str, body: str) -> bool:
    """通过 multica CLI 把告警发成 issue 评论（--content-file，遵守 MUL-2904）。

    返回是否成功。正文先写临时文件再提交；临时文件用完即删。
    注意 MUL-4252：--content-file 必须在当前工作目录内（/tmp 会被拒绝），
    因此临时文件写到 cwd 下，用后即删。
    """
    if not _multica_available():
        return False
    tmp_path = Path(os.getcwd()) / f".blf524-alert-{os.getpid()}.md"
    try:
        tmp_path.write_text(body, encoding="utf-8")
        result = subprocess.run(
            [
                "multica",
                "issue",
                "comment",
                "add",
                issue_id,
                "--content-file",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            print(
                f"    multica comment add 失败: {result.stderr.strip()[:300]}",
                file=sys.stderr,
            )
        return result.returncode == 0
    except Exception as e:
        print(f"    multica comment add 异常: {e}", file=sys.stderr)
        return False
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


def send_alert(
    *,
    kind: str,
    sections: dict,
    issue_id: str | None,
    dry_run: bool = False,
) -> dict:
    """发送部署失败告警。

    - issue_id 解析成功且 multica 可用 → 发 issue 评论（真实渠道）。
    - 无论是否发出，都落一份 logs/alerts/alert-<ts>.json 兜底留痕。
    - dry_run=True 只打印将发送的内容，不实际发送。

    返回 {"sent": bool, "channel": str, "file": str, "issue_id": str|None}。
    """
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    body = build_alert_body(title=f"🚨 {kind}", sections=sections)

    alert_file = None
    if not dry_run:
        ALERTS_DIR.mkdir(parents=True, exist_ok=True)
        alert_file = ALERTS_DIR / f"alert-{timestamp}.json"
        alert_file.write_text(
            json.dumps(
                {
                    "kind": kind,
                    "sections": sections,
                    "body": body,
                    "timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
                    "issue_id": issue_id,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    sent = False
    channel = "local-file"
    if issue_id and not dry_run:
        if _post_multica_comment(issue_id, body):
            sent, channel = True, f"multica-issue:{issue_id}"
        else:
            channel = "multica-unavailable->local-file"

    print(
        f"\n📢 告警（{kind}）：{'已发送 → ' + channel if sent else '未发送（' + channel + '）'}"
    )
    print(f"  告警正文：\n{body}")
    print(f"  本地留痕：{alert_file or '（dry-run 未落盘）'}")
    return {
        "sent": sent,
        "channel": channel,
        "file": str(alert_file) if alert_file else None,
        "issue_id": issue_id,
    }


def send_deploy_failure_alert(
    *,
    bad_sha: str | None,
    stage: str,
    error: str = "",
    issue_id: str | None = None,
    dry_run: bool = False,
) -> dict:
    """部署失败告警入口：记录状态文件 + 发送告警。

    dry_run=True 时不写状态文件、不发送（避免预览污染 rollback --auto 的 bad-sha）。
    """
    pr = lookup_pr_for_commit(bad_sha)
    if not dry_run:
        record_failed_deploy(
            bad_sha=bad_sha, stage=stage, error=error, alert_issue=issue_id
        )
    return send_alert(
        kind="部署失败告警",
        sections={
            "失败阶段": stage,
            "失败时间": datetime.datetime.now().isoformat(timespec="seconds"),
            "受影响 commit (bad-sha)": bad_sha or "unknown",
            "受影响 PR": pr or "未知/未关联",
            "回滚命令": build_rollback_command(bad_sha),
            "失败摘要": (error or "见 VPS journalctl 日志")[:500],
        },
        issue_id=issue_id,
        dry_run=dry_run,
    )


def main() -> int:
    """send_test_alert 入口：python productEnvAgent/alerting.py --test [--issue <uuid>]"""
    import argparse

    parser = argparse.ArgumentParser(description="部署失败告警助手（BLF-524）")
    parser.add_argument("--test", action="store_true", help="发送一条测试告警")
    parser.add_argument("--issue", help="告警目标 issue id（默认走配置解析）")
    parser.add_argument("--dry-run", action="store_true", help="只打印不发送")
    args = parser.parse_args()

    if args.test:
        issue = resolve_alert_issue_id(args.issue)
        if not issue:
            print(
                "❌ 未配置告警目标 issue：请用 --issue <uuid>、环境变量 "
                "ALERT_ISSUE_ID 或 config.json 的 alert.issue_id 指定。"
            )
            return 1
        result = send_alert(
            kind="测试告警（BLF-524 回滚协议就绪）",
            sections={
                "说明": "这是一条由 alerting.py --test 发出的连通性测试告警。",
                "目标 issue": issue,
                "回滚命令": build_rollback_command("6fa68520"),
            },
            issue_id=issue,
            dry_run=args.dry_run,
        )
        return 0 if result["sent"] or args.dry_run else 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
