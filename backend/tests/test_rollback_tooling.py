"""rollback.py / alerting.py 单元测试（BLF-524 回滚协议）

纯逻辑测试：验证 bad-sha 解析、回滚命令序列的组成（revert / 重启 / 健康检查）、
SSH 命令外层单引号不嵌套、告警正文与状态文件往返。不触网、不连 VPS、
不执行任何回滚操作。
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]  # 仓库根目录
if str(REPO_ROOT / "productEnvAgent") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "productEnvAgent"))

from alerting import (  # noqa: E402  # pyright: ignore[reportMissingImports]
    build_alert_body,
    build_rollback_command,
    read_failed_deploy_state,
    record_failed_deploy,
    resolve_alert_issue_id,
)
from rollback import (  # noqa: E402  # pyright: ignore[reportMissingImports]
    VPS_HOST,
    VPS_USER,
    build_backend_plan,
    build_frontend_plan,
    format_plan,
    resolve_bad_sha,
)

SHA = "6fa6852020f2048124ed14a0ca9756b1b9ed0ca6"


# ---------------------------------------------------------------------------
# bad-sha 解析
# ---------------------------------------------------------------------------


def test_resolve_bad_sha_from_cli():
    assert resolve_bad_sha(SHA, None) == SHA
    assert resolve_bad_sha(SHA[:8], None) == SHA[:8]  # 短 sha 也接受


def test_resolve_bad_sha_rejects_invalid_cli():
    assert resolve_bad_sha("not-a-sha!!", None) is None
    assert resolve_bad_sha("", None) is None


def test_resolve_bad_sha_from_state_file():
    state = {"bad_sha": SHA, "stage": "git pull"}
    assert resolve_bad_sha(None, state) == SHA


def test_resolve_bad_sha_unknown_state_ignored():
    state = {"bad_sha": "unknown"}
    assert resolve_bad_sha(None, state) is None
    assert resolve_bad_sha(None, None) is None


def test_resolve_bad_sha_cli_beats_state():
    state = {"bad_sha": SHA}
    assert resolve_bad_sha("deadbeef", state) == "deadbeef"


# ---------------------------------------------------------------------------
# 后端回滚命令序列
# ---------------------------------------------------------------------------


def test_backend_plan_default_steps():
    plan = build_backend_plan(SHA)
    labels = [label for label, _ in plan]
    assert len(plan) == 7
    assert labels[0] == "展示当前状态"
    assert "git revert 坏提交" in labels
    assert "Alembic 机械检查" in labels
    assert "重启四个服务" in labels
    assert "服务状态检查" in labels
    assert "健康检查 (HTTP)" in labels


def test_backend_plan_revert_is_merge_aware():
    plan = build_backend_plan(SHA)
    revert_cmd = dict(plan)["git revert 坏提交"]
    # 在 VPS 上数 parent 数，>=2 用 -m 1，否则普通 revert —— 两者都必须在命令里
    assert 'grep -c "^parent"' in revert_cmd
    assert "git revert --no-edit -m 1" in revert_cmd
    assert "else git revert --no-edit" in revert_cmd


def test_backend_plan_restart_all_four_services():
    plan = build_backend_plan(SHA)
    restart_cmd = dict(plan)["重启四个服务"]
    for svc in [
        "believeboy-api",
        "believeboy-celery.service",
        "believeboy-celery-scheduled.service",
        # BLF-1039：beat 侧变更必须重启 beat 才生效，回滚序列同样不能漏
        "believeboy-beat.service",
    ]:
        assert svc in restart_cmd


def test_backend_plan_health_check_hits_8100():
    plan = build_backend_plan(SHA)
    health_cmd = dict(plan)["健康检查 (HTTP)"]
    assert "127.0.0.1:8100/api/v1/health" in health_cmd
    assert "200" not in health_cmd  # 探活代码由执行端判定，命令里不该写死


def test_backend_plan_push_back_and_downgrade_options():
    plan = build_backend_plan(SHA, push_back=True, downgrade_rev="123")
    labels = [label for label, _ in plan]
    assert "推送 revert 回 origin/main" in labels
    assert "核对 alembic history" in labels  # BEL-492: downgrade 前必须核对
    assert "downgrade 到指定修订" in labels
    downgrade_cmd = dict(plan)["downgrade 到指定修订"]
    assert "alembic downgrade 123" in downgrade_cmd


def test_backend_plan_ssh_commands_target_configured_host():
    """序列里的 ssh 目标取自配置，计划里不另写死地址。

    run_rollback() 会在非 dry-run 时用 resolve_vps_host() 的结果覆盖该模块级
    地址（IPv4 优先、不通退 IPv6），所以这里断言的是「计划消费配置」这一契约，
    而不是某个具体 IP。
    """
    ssh_cmds = [cmd for _label, cmd in build_backend_plan(SHA) if cmd.startswith("ssh ")]
    assert ssh_cmds, "回滚序列里应当有 ssh 命令"
    for cmd in ssh_cmds:
        assert cmd.startswith(f"ssh {VPS_USER}@{VPS_HOST} "), cmd


def test_ssh_commands_have_no_nested_single_quotes():
    """SSH 命令外层用单引号包裹，内层出现单引号会破坏解析（本地 bash 报错）。"""
    for label, cmd in build_backend_plan(SHA, push_back=True, downgrade_rev="9"):
        # 只有外层包裹的 2 个单引号（ssh user@host '...'）
        assert cmd.count("'") == 2, f"[{label}] 存在嵌套单引号: {cmd}"


# ---------------------------------------------------------------------------
# 前端回滚命令序列
# ---------------------------------------------------------------------------


def test_frontend_plan_lists_vercel_steps():
    plan = build_frontend_plan()
    labels = [label for label, _ in plan]
    assert "获取上一 production 部署" in labels
    assert "回滚到上一 production 部署" in labels
    assert any("vercel ls" in cmd for _, cmd in plan)
    assert any("vercel rollback" in cmd for _, cmd in plan)


def test_format_plan_is_numbered():
    plan = build_backend_plan(SHA)[:2]
    text = format_plan(plan)
    assert "步骤 1:" in text and "步骤 2:" in text


# ---------------------------------------------------------------------------
# 告警（alerting.py）
# ---------------------------------------------------------------------------


def test_resolve_alert_issue_priority(monkeypatch):
    # CLI 参数 > 环境变量 > config.json > None
    monkeypatch.delenv("ALERT_ISSUE_ID", raising=False)
    assert resolve_alert_issue_id("cli-id") == "cli-id"
    monkeypatch.setenv("ALERT_ISSUE_ID", "env-id")
    assert resolve_alert_issue_id(None) == "env-id"
    assert resolve_alert_issue_id("cli-id") == "cli-id"  # CLI 优先


def test_build_rollback_command_contains_sha():
    cmd = build_rollback_command(SHA)
    assert f"--bad-sha {SHA}" in cmd
    assert "rollback.py" in cmd
    assert "unknown" not in cmd


def test_build_rollback_command_unknown_sha():
    cmd = build_rollback_command("unknown")
    assert "无法自动定位 bad-sha" in cmd


def test_build_alert_body_shape():
    body = build_alert_body(title="测试告警", sections={"失败阶段": "git pull"})
    assert "## 测试告警" in body
    assert "**失败阶段**：git pull" in body


def test_failed_deploy_state_roundtrip(tmp_path, monkeypatch):
    import alerting  # pyright: ignore[reportMissingImports]

    monkeypatch.setattr(alerting, "LOGS_DIR", tmp_path)
    monkeypatch.setattr(alerting, "STATE_FILE", tmp_path / "last-failed-deploy.json")
    monkeypatch.setattr(alerting, "ALERTS_DIR", tmp_path / "alerts")

    record_failed_deploy(bad_sha=SHA, stage="git pull", error="conflict")
    state = read_failed_deploy_state()
    assert state is not None
    assert state["bad_sha"] == SHA
    assert state["stage"] == "git pull"
    assert "rollback_command" in state


def test_failed_deploy_state_missing(tmp_path, monkeypatch):
    import alerting  # pyright: ignore[reportMissingImports]

    monkeypatch.setattr(alerting, "STATE_FILE", tmp_path / "nope.json")
    assert read_failed_deploy_state() is None
