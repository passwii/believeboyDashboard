"""运维部署工具回归测试（BLF-1039 长期机制项 / BLF-1046 探活重试）

覆盖三类断言：

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

3. **API 探活重试**（BLF-1046，纯函数 + 假时钟）：状态码归一化、截止时间
   内的退避重试（`000 → 000 → 401` 成功 / `200` 直通 / 全程 `000` 判失败 /
   不睡过截止点 / 退避表走完即止不死循环）。这一段锁的是「重试不得把真失败
   洗成成功」——真起不来的服务必须在截止后仍然失败。
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
from collections.abc import Callable, Iterator
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


def test_workers_are_stopped_before_mutating_migration():
    """BLF-1111：改数据的迁移必须「先停后台单元 → 迁 → 再起」，顺序本身要锁住。

    为什么会漏一帧就出事：命令链末尾才重启 worker，在那之前旧 worker 还在跑旧
    代码；窗口内落终态的 run 会把 naive 时间再写一遍（updated_at = 真值 - 8h），
    而迁移已经跑完、`updated_at < created_at` 判据不会再命中 → 该行永久偏 8h、
    `duration_ms ≈ 28.8M ms`。门禁按 max 判 blocking，一行就足以让窗口重新未达标。
    """
    commands = deploy_vps.DEPLOY_COMMANDS
    stop_index = commands.index(deploy_vps.STOP_WORKERS_CMD)
    migrate_index = next(
        i for i, cmd in enumerate(commands) if "alembic upgrade head" in cmd
    )
    assert stop_index < migrate_index, "停后台单元必须排在 alembic upgrade 之前"

    # 停的是三个后台单元（api 不沾这两个派生列的写入，且本链末尾会重启）
    for unit in (
        "believeboy-celery.service",
        "believeboy-celery-scheduled.service",
        "believeboy-beat.service",
    ):
        assert unit in deploy_vps.STOP_WORKERS_CMD, f"{unit} 未被停"
    assert "believeboy-api" not in deploy_vps.STOP_WORKERS_CMD

    # 「只停不起」是漏改：每个停过的单元都必须在本链里被 restart 起回来，
    # 而且重启只能排在迁移之后（提前重启等于窗口还在）
    for unit in deploy_vps.WORKER_UNITS.split():
        restart_indexes = [
            i
            for i, cmd in enumerate(commands)
            if f"systemctl restart {unit}" == cmd.strip()
        ]
        assert restart_indexes, f"{unit} 被停掉后没有 restart"
        assert all(i > migrate_index for i in restart_indexes)

    # 失败出口必须真去复机（否则一次迁移失败会留下「api 活着但没人消费」）
    deploy_src = DEPLOY_PY.read_text(encoding="utf-8")
    assert "run_ssh_command(START_WORKERS_CMD)" in deploy_src
    assert "systemctl start" in deploy_vps.START_WORKERS_CMD


def test_deploy_commands_have_no_nested_single_quotes():
    """SSH 命令串保持「无嵌套单引号」——让命令在两种传参形式下都无歧义。

    传输已改 argv 形式（run_ssh_command 不再走本地 shell），但命令体一律
    避开嵌套单引号：一来人类可读（dry-run 预览把命令包在 `'...'` 里）、
    二来不让「同一串命令因传参方式不同而语义不同」这类陷阱复活。

    BLF-1046：探活命令此前是写在 deploy() 里的内联串（`-w '%{http_code}'`
    + `|| echo '000'`），既绕过了这条断言，也让 SSH 层把它拆成多段。
    现在探活命令提为常量，一并纳入断言。
    """
    commands = [
        cmd
        for name in ("DEPLOY_COMMANDS", "CHECK_COMMANDS")
        for cmd in getattr(deploy_vps, name)
    ]
    commands.append(deploy_vps.HEALTH_PROBE_CMD)
    for cmd in commands:
        assert "'" not in cmd, f"存在嵌套单引号: {cmd[:120]}"


def test_playwright_headless_shell_is_installed_and_verified():
    """定时报告截图依赖 Playwright Headless Shell，部署链必须幂等补齐并校验。

    2026-11-03 线上事故：`playwright==1.52.0` 已装，但
    `/root/.cache/ms-playwright` 被清空，截图在 `BrowserType.launch` 阶段失败。
    截图异常被业务层吞掉后报告仍标记 `sent`，页面只剩一条“成功但无截图”的记录。

    这里锁两件事：
    1. 每次后端部署在 `pip install` 之后执行
       `playwright install --only-shell chromium`，只补截图所需的 headless shell。
    2. 部署后机械校验对应 executable 确实落盘且可执行，不能只看命令退出码。
    """
    install_commands = [
        cmd
        for cmd in deploy_vps.DEPLOY_COMMANDS
        if "playwright install --only-shell chromium" in cmd
    ]
    assert len(install_commands) == 1, "部署链必须且只能有一条 Headless Shell 安装命令"
    install_cmd = install_commands[0]
    assert deploy_vps.VENV_ACTIVATE in install_cmd
    assert "--only-shell" in install_cmd, "不得再次下载完整的 Chromium"

    pip_index = next(
        i
        for i, cmd in enumerate(deploy_vps.DEPLOY_COMMANDS)
        if "pip install -r requirements.txt" in cmd
    )
    assert deploy_vps.DEPLOY_COMMANDS.index(install_cmd) > pip_index, (
        "Playwright 浏览器必须在 Python 依赖安装之后补齐"
    )

    checks = "\n".join(deploy_vps.CHECK_COMMANDS)
    assert "chromium_headless_shell-*/chrome-linux/headless_shell" in checks
    assert "-perm -u+x" in checks, "校验必须确认 headless_shell 可执行"


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


def test_beat_unit_runs_the_beat_only_app():
    """BLF-1047：beat 单元必须用 include=[] 的 celery_beat_app，worker 仍用 celery_app。

    这是「beat 不再 import 任务实现」在部署侧的前提：单元文件与 app 定义分处两地，
    写错了 beat 会把整条任务模块 import 链重新拉进调度进程（~190MB 驻留），
    而进程一样健康启动、一样能发任务——不机械断言就发现不了。
    """

    def _normalized_exec_start(unit: str) -> str:
        """ExecStart= 指令（含反斜杠续行）拼平后的文本。"""
        lines = (SYSTEMD_DIR / unit).read_text(encoding="utf-8").splitlines()
        starts = [i for i, line in enumerate(lines) if line.startswith("ExecStart=")]
        assert len(starts) == 1, f"{unit} 应恰好有一条 ExecStart"
        block = [lines[starts[0]]]
        idx = starts[0]
        while block[-1].rstrip().endswith("\\") and idx + 1 < len(lines):
            idx += 1
            block.append(lines[idx])
        return " ".join(part.rstrip("\\").strip() for part in block)

    beat_exec = _normalized_exec_start("believeboy-beat.service")
    assert "beat" in beat_exec
    assert "-A app.tasks.celery_beat_app" in beat_exec, (
        f"beat 单元未指向 celery_beat_app（执行命令：{beat_exec}）"
    )
    # 旧的 `-A app.tasks.celery_app` 写法不得回流
    assert "-A app.tasks.celery_app " not in beat_exec

    for unit in ("believeboy-celery.service", "believeboy-celery-scheduled.service"):
        exec_line = _normalized_exec_start(unit)
        assert "worker" in exec_line
        assert "-A app.tasks.celery_app worker" in exec_line, (
            f"{unit} 应继续用 celery_app（含 include 全量任务模块）"
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

# 假 /proc 单核 100%：每 0.02s 涨 20 ticks（CLK_TCK=100）。
TICKS_PER_INTERVAL = 20
_CPU_BUMP_INTERVAL = 0.02


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
        "SAMPLE_SECONDS": "0.1",
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
            stop.wait(_CPU_BUMP_INTERVAL)

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


# ---------------------------------------------------------------------------
# 3. API 健康探活重试（BLF-1046）
#
# 起因：`systemctl restart believeboy-api` 到 uvicorn `Application startup
# complete` 之间有约 15s 起窗，单次探活落在窗内必然 000 → 假失败告警 +
# 人工排查。下面用假时钟 + 假探活把「重试成功」与「真失败仍被拦住」两条
# 路径都钉死——最容易做坏的是后者（重试把真失败洗成成功）。
# ---------------------------------------------------------------------------


class FakeClock:
    """可控单调时钟：sleep 时按等待量前进，便于断言截止时间边界。"""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start
        self.slept: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _sequence_probe(codes: list[str]) -> tuple[Callable[[], str], list[str]]:
    """返回「依次吐 codes、用完后一直吐最后一个」的假探活 + 调用记录。"""
    calls: list[str] = []

    def probe() -> str:
        code = codes[min(len(calls), len(codes) - 1)]
        calls.append(code)
        return code

    return probe, calls


# --- 状态码归一化 ---


def test_parse_health_code_normalises_curl_output():
    # curl 自身打印 000 + `|| echo '000'` 追加的 000 → 现场观察到的 000000
    assert deploy_vps.parse_health_code("000000") == "000"
    assert deploy_vps.parse_health_code("000") == "000"
    assert deploy_vps.parse_health_code("401") == "401"
    assert deploy_vps.parse_health_code("200\n") == "200"


def test_parse_health_code_treats_unparseable_as_failure():
    """空输出 / 非数字（SSH 层挂掉等）一律 000——不可探明 ≠ 健康。"""
    for raw in ("", "   ", "not-a-code", "curl: (7) Failed to connect\n"):
        assert deploy_vps.parse_health_code(raw) == "000"


def test_ready_codes_are_200_and_401_only():
    assert deploy_vps.is_health_ready("200")
    assert deploy_vps.is_health_ready("401")  # 服务已起，/health 需 API key
    for code in ("000", "301", "404", "500", "502", "503", ""):
        assert not deploy_vps.is_health_ready(code)


# --- 探活命令本身 ---


def test_health_probe_command_has_no_nested_single_quotes():
    cmd = deploy_vps.HEALTH_PROBE_CMD
    assert "'" not in cmd  # 嵌套单引号会被 SSH 外层单引号截断
    assert cmd.count("%{http_code}") == 1
    assert deploy_vps.HEALTH_URL in cmd


def test_health_retry_is_wired_into_deploy():
    """部署步骤 7 必须走重试函数，且探活命令只能来自常量（不得再有内联串）。"""
    src = DEPLOY_PY.read_text(encoding="utf-8")
    assert "wait_for_api_health(" in src
    # 常量外不得再出现可执行探活：`curl ` 只允许出现在 HEALTH_PROBE_CMD 里
    assert src.count("curl -s") == 1
    assert "|| echo" not in deploy_vps.HEALTH_PROBE_CMD
    assert deploy_vps.HEALTH_PROBE_CMD == (
        'curl -s -o /dev/null -w "%{http_code}" ' + deploy_vps.HEALTH_URL
    )


def test_health_defaults_cover_the_uvicorn_startup_window():
    """起窗实测 ~15s（BLF-1038）；默认退避表与截止时间要留出数倍余量。"""
    assert deploy_vps.HEALTH_PROBE_DEADLINE_SECONDS >= 45
    assert sum(deploy_vps.HEALTH_PROBE_BACKOFF_SECONDS) >= 45


# --- 重试行为 ---


def test_wait_for_api_health_passes_immediately_on_200():
    clock = FakeClock()
    probe, calls = _sequence_probe(["200"])
    result = deploy_vps.wait_for_api_health(
        probe, clock=clock.monotonic, sleep=clock.sleep
    )
    assert result.ready is True
    assert result.code == "200"
    assert result.attempts == 1
    assert calls == ["200"]
    assert clock.slept == []  # 首次就通过，不等待


def test_wait_for_api_health_retries_through_startup_000_to_401():
    """000 → 000 → 401：起窗内失败可重试，服务起来后即通过。"""
    clock = FakeClock()
    probe, calls = _sequence_probe(["000", "000", "401"])
    result = deploy_vps.wait_for_api_health(
        probe, clock=clock.monotonic, sleep=clock.sleep
    )
    assert result.ready is True
    assert result.code == "401"
    assert result.attempts == 3
    assert calls == ["000", "000", "401"]
    assert clock.slept == [1, 2]  # 退避 1s / 2s
    assert result.elapsed == 3.0


def test_wait_for_api_health_covers_realistic_15s_startup_window():
    """前 5 次探活（t=0/1/3/6/11）落在起窗内，第 6 次 t=16s 拿到 401。"""
    clock = FakeClock()
    probe, _ = _sequence_probe(["000"] * 5 + ["401"])
    result = deploy_vps.wait_for_api_health(
        probe, clock=clock.monotonic, sleep=clock.sleep
    )
    assert result.ready is True
    assert result.attempts == 6
    assert result.elapsed == 16.0
    assert result.elapsed <= deploy_vps.HEALTH_PROBE_DEADLINE_SECONDS


def test_wait_for_api_health_fails_when_service_never_starts():
    """真失败必须被拦住：全程 000 → ready=False（且不无限重试）。"""
    clock = FakeClock()
    probe, calls = _sequence_probe(["000"])
    result = deploy_vps.wait_for_api_health(
        probe,
        deadline_seconds=60,
        backoff=(1, 2, 3),
        clock=clock.monotonic,
        sleep=clock.sleep,
    )
    assert result.ready is False
    assert result.code == "000"
    assert len(calls) == 4  # 首次 + 退避表 3 项，走完即止


def test_wait_for_api_health_never_sleeps_past_deadline():
    """再等一轮就会越过截止时间时收手，不把时间花在必然超时的等待上。"""
    clock = FakeClock()
    probe, calls = _sequence_probe(["000"])
    result = deploy_vps.wait_for_api_health(
        probe,
        deadline_seconds=10,
        backoff=(1, 2, 3, 5),
        clock=clock.monotonic,
        sleep=clock.sleep,
    )
    assert result.ready is False
    assert clock.slept == [1, 2, 3]  # 第 4 次等待（5s）会到 11s > 10s，不再睡
    assert clock.now == 6.0
    assert clock.now <= 10
    assert len(calls) == 4


def test_wait_for_api_health_allows_probe_exactly_at_deadline():
    """边界：累计等待正好等于截止时间时的探活仍要发生（最后一次不越界）。"""
    clock = FakeClock()
    probe, calls = _sequence_probe(["000"])
    result = deploy_vps.wait_for_api_health(
        probe,
        deadline_seconds=6,
        backoff=(1, 2, 3, 5, 5, 5),
        clock=clock.monotonic,
        sleep=clock.sleep,
    )
    assert result.ready is False
    assert clock.slept == [1, 2, 3]
    assert clock.now == 6.0  # 第 4 次探活正好落在截止时刻
    assert len(calls) == 4


def test_wait_for_api_health_terminates_even_if_sleep_does_not_advance_clock():
    """兜底：sleep 不推进时钟（异常环境）也不能死循环——退避表走完即止。"""
    clock = FakeClock()
    probe, calls = _sequence_probe(["000"])
    result = deploy_vps.wait_for_api_health(
        probe,
        backoff=(1, 2),
        clock=clock.monotonic,
        sleep=lambda _seconds: None,
    )
    assert result.ready is False
    assert len(calls) == 3
    assert clock.now == 0.0


def test_api_unit_has_no_systemd_readiness_signal():
    """BLF-1046 复核 CHECK_COMMANDS：api 单元没有 systemd 就绪信号。

    Type=simple（未声明 Type=）意味着 systemd 在 fork 出主进程后立即标记
    active，因此 `systemctl is-active believeboy-api` 在 uvicorn 起窗内也返回
    active——它断言的是「单元已被 systemd 接管」，不是「服务已能响应请求」。
    就绪判定的唯一权威是步骤 7 的 HTTP 探活。若将来单元改成 notify/exec
    （系统提供就绪通知），这条断言会提醒重新评估两条判定的关系。
    """
    content = (SYSTEMD_DIR / "believeboy-api.service").read_text(encoding="utf-8")
    assert "Type=notify" not in content
    assert "Type=exec" not in content
    # 单元级落地校验保留（配置/单元是否装上仍然必须机械核对）
    assert any("is-active believeboy-api" in cmd for cmd in deploy_vps.CHECK_COMMANDS)
