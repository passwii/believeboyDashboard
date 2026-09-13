"""运维部署工具回归测试（BLF-1039 长期机制项）

覆盖两类断言：

1. **静态配置一致性**（纯读文件，不触网、不连 VPS）：部署/回滚命令序列是否
   覆盖了所有 systemd 单元、长跑膨胀防护（RuntimeMaxSec）是否落在单元文件里、
   dockerd 看门狗脚本 + cron.d 条目是否成套存在。BLF-1039 的起因正是
   believeboy-beat 长期游离在部署范围之外（手工安装的单元、无同步无重启），
   所以这里用「目录里有几个 unit，部署链里就必须有几个」这种机械断言防复发。

2. **看门狗脚本行为**（在临时目录里用假 /proc + 假 systemctl/logger/docker
   驱动真脚本）：阈值以下不动手、连续超阈值才重启、冷却期内不重复重启、
   dockerd pid 变化时计数归零、输出不可解析时 fail closed（不拿未知 CPU 值
   做重启决定）。脚本跑在生产 VPS 上且会重启 docker，所以这里用假外部命令
   把决策路径全部走一遍——脚本改动若破坏判定逻辑，本文件必须失败。
"""

from __future__ import annotations

import contextlib
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT / "productEnvAgent") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "productEnvAgent"))

# 直接 import 部署/回滚脚本（与 test_rollback_tooling.py 同一做法）：既断言
# 运行时真实命令串（含 f-string 展开），也保证脚本本身可被导入（无语法/导入坑）。
# 这两个 import 依赖上面的 sys.path 注入，静态解析器看不到，故显式标注。
import deploy_vps  # noqa: E402  # pyright: ignore[reportMissingImports]
import rollback  # noqa: E402  # pyright: ignore[reportMissingImports]

DEPLOY_PY = REPO_ROOT / "productEnvAgent" / "deploy_vps.py"
ROLLBACK_PY = REPO_ROOT / "productEnvAgent" / "rollback.py"
SYSTEMD_DIR = REPO_ROOT / "backend" / "deploy" / "systemd"
CRON_DIR = REPO_ROOT / "backend" / "deploy" / "cron"
SCRIPTS_DIR = REPO_ROOT / "backend" / "deploy" / "scripts"
WATCHDOG = SCRIPTS_DIR / "dockerd_watchdog.sh"
WATCHDOG_CRON = CRON_DIR / "believeboy-dockerd-watchdog"

# 目录里现存的后端单元（新增单元必须同时更新本常量与 deploy/rollback 命令）
# 顺序为 sorted() 字典序：'-'(0x2d) < '.'(0x2e)，故 *-scheduled 排在 *.service 前
SERVICES = [
    "believeboy-api.service",
    "believeboy-beat.service",
    "believeboy-celery-scheduled.service",
    "believeboy-celery.service",
]


def _rollback_source() -> str:
    return ROLLBACK_PY.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. 静态配置一致性
# ---------------------------------------------------------------------------


def test_every_systemd_unit_is_synced_by_deploy():
    """目录里的每个 unit 都必须出现在部署同步链里（防「手工安装的单元」复发）。"""
    sync_chain = "\n".join(
        cmd for cmd in deploy_vps.DEPLOY_COMMANDS if "/etc/systemd/system" in cmd
    )
    units = sorted(path.name for path in SYSTEMD_DIR.glob("*.service"))
    assert units == SERVICES  # 目录内容本身也锁定，新增单元必须同步更新本断言
    for unit in units:
        assert f"backend/deploy/systemd/{unit}" in sync_chain, (
            f"{unit} 未纳入 deploy_vps.py 的同步范围"
        )
        assert f"/etc/systemd/system/{unit}" in sync_chain, f"{unit} 安装目标缺失"


def test_beat_is_restarted_by_deploy_and_rollback():
    """beat 必须随部署/回滚重启——BLF-1039 修的就是这个缺口。"""
    commands = deploy_vps.DEPLOY_COMMANDS
    checks = deploy_vps.CHECK_COMMANDS
    assert any("systemctl restart believeboy-beat.service" in c for c in commands)
    assert any("systemctl is-active believeboy-beat.service" in c for c in checks)
    # enable 也要带上（首次部署时新单元必须自启）
    assert any("believeboy-beat.service" in c and "enable" in c for c in commands)

    rollback_src = _rollback_source()
    services_block = rollback_src.split("SERVICES = [", 1)[1].split("]", 1)[0]
    assert "believeboy-beat.service" in services_block
    assert "重启四个服务" in rollback_src
    assert "重启三个服务" not in rollback_src
    # 回滚命令序列本身也要带上 beat（SERVICES 与计划保持一致）
    plan = rollback.build_backend_plan("deadbeef")
    restart_cmd = dict(plan)["重启四个服务"]
    assert "believeboy-beat.service" in restart_cmd


def test_deploy_commands_have_no_nested_single_quotes():
    """SSH 命令外层用单引号包裹：命令体里出现单引号会破坏解析。"""
    for name in ("DEPLOY_COMMANDS", "CHECK_COMMANDS"):
        for cmd in getattr(deploy_vps, name):
            assert "'" not in cmd, f"[{name}] 存在嵌套单引号: {cmd[:120]}"


def test_runtime_max_sec_on_long_running_units():
    """长跑膨胀防护：beat + 两个 worker 都要有 RuntimeMaxSec=7d。"""
    for unit in [
        "believeboy-beat.service",
        "believeboy-celery.service",
        "believeboy-celery-scheduled.service",
    ]:
        content = (SYSTEMD_DIR / unit).read_text(encoding="utf-8")
        assert "RuntimeMaxSec=7d" in content, f"{unit} 缺少 RuntimeMaxSec"
        # Restart=always 与 RuntimeMaxSec 必须成对：到期被 SIGTERM 后要能自动起回来
        assert "Restart=always" in content, f"{unit} 缺少 Restart=always"

    # 部署后必须机械校验已落地（否则又是「改了仓库文件但 VPS 没生效」）
    checks = "\n".join(deploy_vps.CHECK_COMMANDS)
    assert "grep -q ^RuntimeMaxSec=7d$ /etc/systemd/system/believeboy-beat.service" in (
        checks
    )


def test_watchdog_script_and_cron_are_wired():
    """看门狗脚本 + cron.d 条目必须成套，且被部署安装 + 校验。"""
    assert WATCHDOG.is_file()
    assert WATCHDOG.stat().st_mode & stat.S_IXUSR, "看门狗脚本必须可执行"

    sync_chain = "\n".join(
        cmd for cmd in deploy_vps.DEPLOY_COMMANDS if "/etc/cron.d" in cmd
    )
    assert "backend/deploy/scripts/dockerd_watchdog.sh" in sync_chain
    assert "backend/deploy/cron/believeboy-dockerd-watchdog" in sync_chain
    assert "/etc/cron.d/believeboy-dockerd-watchdog" in sync_chain

    checks = "\n".join(deploy_vps.CHECK_COMMANDS)
    assert "dockerd_watchdog.sh" in checks
    assert "/etc/cron.d/believeboy-dockerd-watchdog" in checks


def test_watchdog_shell_syntax_is_valid():
    result = subprocess.run(
        ["bash", "-n", str(WATCHDOG)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_watchdog_cron_entry_is_well_formed():
    """cron.d 格式：5 个时间字段 + user + 绝对路径；且不含 %（会截断命令）。"""
    lines = [
        line
        for line in WATCHDOG_CRON.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert len(lines) == 1, "cron.d 文件应只有 1 条生效条目"
    fields = lines[0].split()
    assert fields[0] == "*", "需每分钟采样一次"
    assert fields[5] == "root", "cron.d 条目必须显式给出 user 字段"
    command = " ".join(fields[6:])
    assert command.startswith("/usr/bin/flock "), "需用 flock 防止采样窗口重叠"
    assert command.endswith(
        "/root/believeboyDashboard/backend/deploy/scripts/dockerd_watchdog.sh"
    )
    assert "%" not in command


# ---------------------------------------------------------------------------
# 2. 看门狗脚本行为（假 /proc + 假外部命令）
# ---------------------------------------------------------------------------

FAKE_LOGGER = """#!/bin/bash
# 把 logger 的参数与 stdin 落到文件，便于断言
{ printf 'ARGS %s\\n' "$*"; cat; } >> "${FAKE_LOG}"
exit 0
"""

FAKE_SYSTEMCTL = """#!/bin/bash
case "$1" in
    show)
        # show -p <prop> --value <unit>
        case "$3" in
            ActiveState) echo "${FAKE_ACTIVE_STATE:-active}" ;;
            MainPID) echo "${FAKE_PID}" ;;
            *) echo "" ;;
        esac
        ;;
    restart) echo "$2" >> "${FAKE_RESTART_LOG}" ;;
esac
exit 0
"""

FAKE_DOCKER = """#!/bin/bash
case "$1" in
    ps) echo "komari" ;;
    inspect) echo "true" ;;
    info) exit 0 ;;
esac
exit 0
"""

# 假 /proc 单核 100% = 每 0.1s 涨 10 ticks（CLK_TCK=100）
TICKS_PER_INTERVAL = 10


def _write_fake_proc(proc_root: Path, pid: int, ticks: int, comm: str = "dockerd"):
    """写 /proc/<pid>/stat 的最小合法内容（comm 故意含括号与空格）。

    字段对齐 proc(5)：去掉 pid 与 comm 后，$12=utime、$13=stime（ticks）。
    先用临时文件再 os.replace，避免读取端（脚本的 cat）撞上半截内容。
    """
    proc_dir = proc_root / str(pid)
    proc_dir.mkdir(parents=True, exist_ok=True)
    fields = (
        f"S 1 {pid} {pid} 0 -1 4194560 7761 34177 1580 85 {ticks} 0 31 10 20 0 11 0"
    )
    target = proc_dir / "stat"
    tmp = proc_dir / "stat.tmp"
    tmp.write_text(f"{pid} ({comm}) {fields}\n", encoding="utf-8")
    os.replace(tmp, target)


@pytest.fixture()
def watchdog_env(tmp_path):
    """搭一套假环境：假 systemctl/logger/docker + 假 /proc + 状态目录。"""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "logger").write_text(FAKE_LOGGER, encoding="utf-8")
    (fake_bin / "systemctl").write_text(FAKE_SYSTEMCTL, encoding="utf-8")
    (fake_bin / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
    for name in ("logger", "systemctl", "docker"):
        (fake_bin / name).chmod(0o755)

    proc_root = tmp_path / "proc"
    state_dir = tmp_path / "state"
    pid = 4242
    _write_fake_proc(proc_root, pid, ticks=1000)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "PROC_ROOT": str(proc_root),
        "STATE_DIR": str(state_dir),
        "FAKE_LOG": str(tmp_path / "watchdog.log"),
        "FAKE_RESTART_LOG": str(tmp_path / "restarts.log"),
        "FAKE_PID": str(pid),
        "CLK_TCK": "100",
        "SAMPLE_SECONDS": "1",
    }
    return {
        "env": env,
        "proc_root": proc_root,
        "pid": pid,
        "state_dir": state_dir,
        "state_file": state_dir / "dockerd-watchdog.state",
        "cooldown_file": state_dir / "dockerd-watchdog.last-restart",
        "log_file": Path(env["FAKE_LOG"]),
        "restart_log": Path(env["FAKE_RESTART_LOG"]),
    }


def _run_watchdog(ctx, **env_overrides):
    env = {**ctx["env"], **{key: str(value) for key, value in env_overrides.items()}}
    return subprocess.run(
        ["bash", str(WATCHDOG)],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
        check=False,
    )


def _log(ctx) -> str:
    return (
        ctx["log_file"].read_text(encoding="utf-8") if ctx["log_file"].exists() else ""
    )


def _restarts(ctx) -> str:
    path = ctx["restart_log"]
    return path.read_text(encoding="utf-8") if path.exists() else ""


@contextlib.contextmanager
def _cpu_growing(ctx) -> Iterator[None]:
    """采样窗口内持续抬高假 /proc 的 ticks（约 100% 单核），退出时停掉线程。"""
    ticks = [1000]
    stop = threading.Event()

    def bump():
        while not stop.is_set():
            ticks[0] += TICKS_PER_INTERVAL
            _write_fake_proc(ctx["proc_root"], ctx["pid"], ticks[0])
            stop.wait(0.1)

    thread = threading.Thread(target=bump, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


def test_watchdog_low_cpu_does_not_restart(watchdog_env):
    """CPU 低于阈值：只把计数归零，绝不重启。"""
    proc = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=1)
    assert proc.returncode == 0, proc.stderr
    assert _restarts(watchdog_env) == ""
    assert watchdog_env["state_file"].read_text().split() == [
        str(watchdog_env["pid"]),
        "0",
    ]


def test_watchdog_restarts_after_sustained_high_cpu(watchdog_env):
    """连续超阈值：达到次数后重启 docker，记录诊断并校验容器回来。"""
    with _cpu_growing(watchdog_env):
        proc = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=1)

    assert proc.returncode == 0, proc.stderr
    assert _restarts(watchdog_env).split() == ["docker.service"]
    assert "ALERT" in _log(watchdog_env)
    # 重启后写冷却时间戳（供下一次到期判断）
    assert watchdog_env["cooldown_file"].exists()
    assert watchdog_env["cooldown_file"].read_text().strip().isdigit()
    # 计数归零，避免重启后立刻再次触发
    assert watchdog_env["state_file"].read_text().split()[1] == "0"


def test_watchdog_counts_up_then_fires(watchdog_env):
    """CONSECUTIVE_REQUIRED=2：第一次只计数，第二次才重启。"""
    with _cpu_growing(watchdog_env):
        first = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=2)
        assert first.returncode == 0, first.stderr
        pid_field, count_field = watchdog_env["state_file"].read_text().split()
        assert pid_field == str(watchdog_env["pid"])
        assert count_field == "1"
        assert _restarts(watchdog_env) == ""

        second = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=2)

    assert second.returncode == 0, second.stderr
    assert _restarts(watchdog_env).split() == ["docker.service"]


def test_watchdog_cooldown_blocks_repeat_restart(watchdog_env):
    """冷却期内即使持续高 CPU 也不再重启（避免重启风暴放大故障）。"""
    watchdog_env["state_dir"].mkdir(parents=True, exist_ok=True)
    watchdog_env["cooldown_file"].write_text(f"{int(time.time())}\n", encoding="utf-8")

    with _cpu_growing(watchdog_env):
        proc = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=1)

    assert proc.returncode == 0, proc.stderr
    assert _restarts(watchdog_env) == ""
    assert "cooldown" in _log(watchdog_env)


def test_watchdog_resets_counter_on_pid_change(watchdog_env):
    """dockerd 换 pid（被重启过）：计数不可跨进程比较，必须归零。"""
    watchdog_env["state_dir"].mkdir(parents=True, exist_ok=True)
    watchdog_env["state_file"].write_text("1 7\n", encoding="utf-8")  # 旧 pid + 高计数
    proc = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=10)
    assert proc.returncode == 0, proc.stderr
    new_pid, count = watchdog_env["state_file"].read_text().split()
    assert new_pid == str(watchdog_env["pid"])
    assert count == "0"


def test_watchdog_comm_with_parens_is_parsed(watchdog_env):
    """comm 含「) 」的内核进程名不能让字段解析错位：按最后一个 ") " 截断。"""
    _write_fake_proc(
        watchdog_env["proc_root"], watchdog_env["pid"], ticks=1000, comm="a) S) X"
    )
    proc = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=1)
    assert proc.returncode == 0, proc.stderr
    assert "ERROR" not in _log(watchdog_env)


def test_watchdog_skips_when_docker_not_running(watchdog_env):
    proc = _run_watchdog(watchdog_env, FAKE_ACTIVE_STATE="inactive", FAKE_PID="0")
    assert proc.returncode == 0, proc.stderr
    assert "skip" in _log(watchdog_env)
    assert _restarts(watchdog_env) == ""


def test_watchdog_fails_closed_on_unreadable_proc(watchdog_env):
    """CPU 输出不可解析 → exit 1，不做重启决定（fail closed）。"""
    shutil.rmtree(watchdog_env["proc_root"] / str(watchdog_env["pid"]))
    proc = _run_watchdog(watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=1)
    assert proc.returncode == 1
    assert "ERROR" in _log(watchdog_env)
    assert _restarts(watchdog_env) == ""


def test_watchdog_dry_run_never_restarts(watchdog_env):
    with _cpu_growing(watchdog_env):
        proc = _run_watchdog(
            watchdog_env, CPU_THRESHOLD=50, CONSECUTIVE_REQUIRED=1, DRY_RUN="1"
        )

    assert proc.returncode == 0, proc.stderr
    assert _restarts(watchdog_env) == ""
    assert "dry-run" in _log(watchdog_env)
