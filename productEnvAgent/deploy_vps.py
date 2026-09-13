#!/usr/bin/env python3
"""
VPS 部署 Agent - BelieveBoy Dashboard

使用方式（CLI）:
    cd productEnvAgent
    python deploy_vps.py                # 交互式部署
    python deploy_vps.py --dry-run      # 预览命令，不执行
    python deploy_vps.py --auto         # 非交互式自动部署

使用方式（Claude Code Skill）:
    /deploy-vps                         # 调用此 Agent

本脚本自动化完整的部署流程：
1. SSH 连接到 VPS
2. git pull 拉取最新代码
3. 激活后端虚拟环境
4. 运行 alembic 数据库迁移
 5. 重启 believeboy-api 服务与两个 Celery worker（believeboy-celery / believeboy-celery-scheduled）
 6. 验证服务运行状态
 7. 获取并分析部署失败的日志
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from typing import NamedTuple

# BLF-524：部署失败告警（复用 workspace 内 multica issue 评论渠道）
from alerting import (
    resolve_alert_issue_id,
    send_deploy_failure_alert,
)

# VPS 配置
VPS_HOST = "145.79.143.98"
VPS_USER = "root"
PROJECT_DIR = "/root/believeboyDashboard/"
BACKEND_DIR = f"{PROJECT_DIR}backend/"
VENV_ACTIVATE = "source /root/believeboyDashboard/backend/.venv/bin/activate"

# 迁移图前置检查（BLF-492）：多 head / 命名违规 / 重复 id 在跑迁移前拦截，
# 避免 `alembic upgrade head` 因 "Multiple head revisions" 在改库前暴雷
CHECK_MIGRATIONS_CMD = (
    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && python scripts/check_alembic.py"
)

# 部署命令（在 VPS 上执行）
# root 用户直跑 systemctl，无需 sudo；SSH 走密钥认证（无需密码）
DEPLOY_COMMANDS = [
    f"cd {PROJECT_DIR} && git pull --ff-only",
    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && pip install -r requirements.txt",
    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && alembic upgrade head",
    # --- 一次性迁移：believeboy-worker* → believeboy-celery* ---
    # 停旧单元（不存在则跳过），禁用并删除旧 service 文件
    "systemctl stop believeboy-worker.service believeboy-worker-scheduled.service 2>/dev/null || true",
    "systemctl disable believeboy-worker.service believeboy-worker-scheduled.service 2>/dev/null || true",
    "rm -f /etc/systemd/system/believeboy-worker.service /etc/systemd/system/believeboy-worker-scheduled.service",
    # --- 同步 service / journald / cron.d 配置到系统目录并重新加载 ---
    # BLF-1035：journald cap（00-believeboy-cap.conf）与 swap 每日回收
    # BLF-1039：believeboy-beat 纳入同步范围——此前该单元是历史上手工安装
    # 到 /etc/systemd/system 的，部署只重启 api / 两个 worker，导致 beat 侧
    # 代码变更（beat_schedule 删除、惰性导入等）必须人工 restart 才生效。
    # BLF-1039：dockerd 看门狗（脚本 + cron.d）一并幂等安装。
    f"cp {PROJECT_DIR}backend/deploy/systemd/believeboy-celery.service /etc/systemd/system/believeboy-celery.service "
    f"&& cp {PROJECT_DIR}backend/deploy/systemd/believeboy-celery-scheduled.service /etc/systemd/system/believeboy-celery-scheduled.service "
    f"&& cp {PROJECT_DIR}backend/deploy/systemd/believeboy-api.service /etc/systemd/system/believeboy-api.service "
    f"&& cp {PROJECT_DIR}backend/deploy/systemd/believeboy-beat.service /etc/systemd/system/believeboy-beat.service "
    f"&& mkdir -p /etc/systemd/journald.conf.d "
    f"&& cp {PROJECT_DIR}backend/deploy/journald/00-believeboy-cap.conf /etc/systemd/journald.conf.d/00-believeboy-cap.conf "
    f"&& systemctl restart systemd-journald "
    f"&& cp {PROJECT_DIR}backend/deploy/cron/believeboy-swap-reclaim /etc/cron.d/believeboy-swap-reclaim "
    f"&& chmod 0644 /etc/cron.d/believeboy-swap-reclaim "
    f"&& chmod +x {PROJECT_DIR}backend/deploy/scripts/swap_reclaim.sh "
    f"&& cp {PROJECT_DIR}backend/deploy/cron/believeboy-dockerd-watchdog /etc/cron.d/believeboy-dockerd-watchdog "
    f"&& chmod 0644 /etc/cron.d/believeboy-dockerd-watchdog "
    f"&& chmod +x {PROJECT_DIR}backend/deploy/scripts/dockerd_watchdog.sh "
    f"&& systemctl daemon-reload",
    # 启用新单元（首次部署时 enable，后续幂等）
    "systemctl enable believeboy-celery.service believeboy-celery-scheduled.service believeboy-beat.service 2>/dev/null || true",
    "systemctl restart believeboy-api",
    # Celery worker 必须随代码部署一起重启，否则旧进程内存里的 task 签名
    # 不更新（如 dispatch_one 的 old_log_id 参数），补发任务会抛 TypeError
    # 并永久卡在 preparing。两个 worker 单元：
    #   believeboy-celery（-Q default,reports,insights,ai_summary -c 1）
    #   believeboy-celery-scheduled（-Q scheduled -c 2，截图内存隔离）
    # 均用 acks_late + task_reject_on_worker_lost，重启时 in-flight 任务
    # 会被 broker 重投，安全。
    "systemctl restart believeboy-celery.service",
    "systemctl restart believeboy-celery-scheduled.service",
    # beat 同理必须随部署重启（BLF-1039）：beat 侧变更（beat_schedule 条目
    # 增删 / 任务模块惰性导入）只在 beat 进程重新导入时生效。beat 的调度
    # 进度落在 --schedule 本地 db，重启不丢已发出的记录。
    "systemctl restart believeboy-beat.service",
    "systemctl status believeboy-api --no-pager",
]

# 检查命令（部署后验证）
#
# 就绪语义复核（BLF-1046 交付范围的一部分）：
# 这里的 `systemctl is-active <unit>` **不是**就绪信号——后端四个单元都是
# Type=simple（未声明 Type=），systemd 在 fork 出主进程后立即标记 active，
# 所以起窗内 is-active 也已经返回 active。它们断言的是「单元已被 systemd
# 接管 + 配置确实落地」，不是「服务已能响应请求」。就绪判定唯一权威是
# 步骤 7 的 HTTP 探活（带截止时间重试）。保持现状不改：把这些换成探活
# 只会让单元级故障（单元没装上/崩了）的信息丢失，而 readiness 已由步7覆盖。
CHECK_COMMANDS = [
    "systemctl is-active believeboy-api",
    "systemctl is-active believeboy-celery.service",
    "systemctl is-active believeboy-celery-scheduled.service",
    # BLF-1039：beat 已纳入部署范围（同步 + restart）。单引号会被 SSH 外层
    # 单引号破坏，因此 grep 模式一律不加引号。
    "systemctl is-active believeboy-beat.service",
    f'cd {BACKEND_DIR} && {VENV_ACTIVATE} && python -c "import app.main"',
    "grep -q ^SystemMaxUse=200M$ /etc/systemd/journald.conf.d/00-believeboy-cap.conf"
    " && grep -q ^SystemKeepFree=1G$ /etc/systemd/journald.conf.d/00-believeboy-cap.conf",
    "test -x /root/believeboyDashboard/backend/deploy/scripts/swap_reclaim.sh"
    " && grep -q swap_reclaim.sh /etc/cron.d/believeboy-swap-reclaim",
    # BLF-1039：dockerd 看门狗落地校验（脚本可执行 + cron.d 条目指向它）
    "test -x /root/believeboyDashboard/backend/deploy/scripts/dockerd_watchdog.sh"
    " && grep -q dockerd_watchdog.sh /etc/cron.d/believeboy-dockerd-watchdog",
    # BLF-1039：长跑膨胀防护落地校验（beat / 两个 worker 单元都有
    # RuntimeMaxSec=7d；/etc/systemd/system 下是部署同步后的副本）
    "grep -q ^RuntimeMaxSec=7d$ /etc/systemd/system/believeboy-beat.service"
    " && grep -q ^RuntimeMaxSec=7d$ /etc/systemd/system/believeboy-celery.service"
    " && grep -q ^RuntimeMaxSec=7d$ /etc/systemd/system/believeboy-celery-scheduled.service",
]

# --- API 健康探活（BLF-1046）---
#
# 为什么不能单次 curl 定生死：`systemctl restart believeboy-api` 到 uvicorn
# `Application startup complete` 之间有约 15s 起窗（BLF-1038 实测：restart
# 00:39:09 → startup complete 00:39:24）。探活落在起窗内必然 connection
# refused → curl 打印 000 → 旧逻辑判定「API 健康检查失败」→ 走失败出口。
# 结果每次重启型部署都可能产生一次假失败告警 + 一次人工排查（BLF-1033
# Stage 5 即如此：现场三单元全 active、health 401/4ms，部署本身完全健康）。
# 故改为「截止时间内退避重试」，真起不来仍然在截止后失败。
#
# 探活 URL 保持 /api/v1/health（语义不变）：401 = 服务已起但端点需 API key，
# 200 = 连 DB/Redis 状态都健康。刻意不换成 /health/live（无鉴权无 DB），
# 那会丢掉「DB/Redis 可用」这层信号。
HEALTH_URL = "http://127.0.0.1:8100/api/v1/health"
# 用双引号包 %{http_code}：run_ssh_command 已用单引号包裹整条命令，
# 命令体内再出现单引号会被 SSH 外层单引号截断（BLF-1039 前车之鉴）。
# 不加 `|| echo '000'`：curl 即便连不上也会打印 000，且会额外追加一个
# 000（现场观察到的 "HTTP 000000" 就是这么来的）。
HEALTH_PROBE_CMD = f'curl -s -o /dev/null -w "%{{http_code}}" {HEALTH_URL}'
# 200 = 健康（含 DB/Redis 状态）；401 = 服务已起，但 /health 需 API key。
HEALTH_READY_CODES = ("200", "401")
# 截止时间与退避表：起窗约 15s，60s 截止留足 4 倍余量（累计等待到 ~56s：
# 探活在 t=0/1/3/6/11/16/21/26/31/36/41/46/51/56s）；退避表走完即止，
# 保证「探活本身几乎不耗时」时也不会无限重试。
HEALTH_PROBE_DEADLINE_SECONDS = 60
HEALTH_PROBE_BACKOFF_SECONDS = (1, 2, 3) + (5,) * 12
HEALTH_PROBE_TIMEOUT_SECONDS = 10

# 日志获取命令（用于错误分析）
LOG_COMMANDS = {
    "recent": "journalctl -u believeboy-api --no-pager -n 50",
    "error": "journalctl -u believeboy-api --no-pager -p err -n 30",
    "today": "journalctl -u believeboy-api --no-pager --since today",
    "service": "systemctl show believeboy-api --property=MainPID,ActiveState,SubState,Result",
}


def run_ssh_command(command, host=VPS_HOST, user=VPS_USER, dry_run=False, timeout=300):
    """通过 SSH 在 VPS 上执行命令。

    命令以 argv 形式传给 ssh（不走本地 shell）：`command` 原样作为 ssh 的第二个
    参数，由 VPS 上的远端 shell 解释。好处是本地 shell 不再参与拆分——
    旧写法 `ssh host '{command}'` 会因为命令体里出现单引号而被本地 shell
    截断/重拼（`python -c 'import app.main'` 就是这么被拆成
    `python -c import app.main` 而静默失败的）。
    """
    ssh_command = f"ssh {user}@{host} '{command}'"  # 仅用于 dry-run 预览/人工复现
    if dry_run:
        print(f"[DRY RUN] 即将执行: {ssh_command}")
        return 0, "", ""

    try:
        result = subprocess.run(
            ["ssh", f"{user}@{host}", command],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "命令执行超时（120秒）"
    except Exception as e:
        return -1, "", str(e)


class HealthProbeResult(NamedTuple):
    """一次「重试到截止时间」探活的结论。"""

    ready: bool
    code: str
    attempts: int
    elapsed: float


def parse_health_code(output: str) -> str:
    """从 `curl -w '%{http_code}'` 的输出里取归一化 HTTP 状态码。

    curl 即便连接失败也会打印 `000`，`|| echo '000'` 之类的兜底还会再追加
    一个（现场即 `HTTP 000000`），SSH 层失败时 stdout 甚至可能为空。
    这里抓出所有三位码取最后一个，取不到（空输出 / 非数字）一律当 `000`
    （不可探明 = 未就绪 = 可重试），绝不把未知状态当成功。
    """
    codes = re.findall(r"\d{3}", output or "")
    return codes[-1] if codes else "000"


def is_health_ready(code: str) -> bool:
    """200 / 401 视为服务已起（401 = /health 需 API key，语义保留）。"""
    return code in HEALTH_READY_CODES


def probe_api_health(dry_run: bool = False) -> tuple[int, str, str]:
    """单次探活（不做重试）：返回 run_ssh_command 的 (rc, out, err)。"""
    return run_ssh_command(
        HEALTH_PROBE_CMD, dry_run=dry_run, timeout=HEALTH_PROBE_TIMEOUT_SECONDS
    )


def _default_health_probe() -> str:
    """默认探活：真实 SSH + curl，返回归一化状态码（不可探明 → 000）。"""
    return parse_health_code(probe_api_health()[1])


def wait_for_api_health(
    probe: Callable[[], str] = _default_health_probe,
    *,
    deadline_seconds: float = HEALTH_PROBE_DEADLINE_SECONDS,
    backoff: Sequence[float] = HEALTH_PROBE_BACKOFF_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> HealthProbeResult:
    """在截止时间内退避重试探活，直到就绪或彻底判失败。

    - `000`（连不上 / 起窗内）可重试；`200` / `401` 立即通过。
    - 退避表 `backoff` 逐项作为「下一次探活前的等待」，走完即止。
    - 「再等一轮就会超过截止时间」时不再等待，直接判失败——即最后一次
      探活必定发生在截止时间内。
    判失败只是返回 ready=False，由调用方走既有失败出口（收日志 + 告警）。
    探活函数与时钟 / 等待都从参数注入，便于在单测里用假时钟锁住边界。
    """
    max_attempts = len(backoff) + 1
    start = clock()
    attempts = 0

    while True:
        attempts += 1
        code = probe()
        elapsed = clock() - start
        if is_health_ready(code):
            return HealthProbeResult(True, code, attempts, elapsed)
        if attempts >= max_attempts:
            return HealthProbeResult(False, code, attempts, elapsed)

        delay = backoff[min(attempts - 1, len(backoff) - 1)]
        if elapsed + delay > deadline_seconds:
            return HealthProbeResult(False, code, attempts, elapsed)
        sleep(delay)


def detect_bad_sha():
    """定位本次部署的目标 commit（本地仓库 HEAD，即刚推送/正在部署的提交）。

    在无法定位（如 CI 环境无仓库）时返回 None，告警里显示 unknown。
    """
    try:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=repo_root,
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        return None


def handle_deploy_failure(stage, dry_run=False, error=""):
    """部署失败统一出口：收集日志 → 保存报告 → 记录 bad-sha → 发告警（BLF-524）。

    告警内容含受影响 PR 与回滚命令；dry-run 模式只打印不发送。
    """
    logs = collect_failure_logs(stage, dry_run=dry_run)
    analysis = analyze_logs(logs)
    print(format_report(logs, analysis))
    save_report(logs, analysis, dry_run)

    bad_sha = detect_bad_sha()
    alert_issue = resolve_alert_issue_id()
    send_deploy_failure_alert(
        bad_sha=bad_sha,
        stage=stage,
        error=error or analysis["summary"],
        issue_id=alert_issue,
        dry_run=dry_run,
    )
    return analysis


def collect_failure_logs(stage_name, dry_run=False):
    """收集部署失败时的详细日志信息。"""
    print(f"\n{'=' * 60}")
    print(f"  收集 {stage_name} 失败时的日志...")
    print(f"{'=' * 60}\n")

    logs = {
        "timestamp": datetime.datetime.now().isoformat(),
        "stage": stage_name,
        "service_status": {},
        "journal_logs": {},
    }

    # 获取服务状态
    print(">>> 获取服务状态...")
    for name, cmd in LOG_COMMANDS.items():
        rc, out, err = run_ssh_command(cmd, dry_run=dry_run)
        logs["journal_logs"][name] = {
            "success": rc == 0,
            "output": out if rc == 0 else err,
        }
        if rc == 0:
            print(f"  [{name}] OK")
        else:
            print(f"  [{name}] 失败")

    # 获取 Python 错误追踪
    print("\n>>> 检查 Python 应用错误...")
    # 用双引号（不用单引号）：命令串保持「无嵌套单引号」的约定
    rc, out, err = run_ssh_command(
        f'cd {BACKEND_DIR} && {VENV_ACTIVATE} && python -c "import app.main" 2>&1',
        dry_run=dry_run,
    )
    logs["journal_logs"]["python_import"] = {
        "success": rc == 0,
        "output": out + err if rc != 0 else "导入成功",
    }

    return logs


def analyze_logs(logs):
    """分析收集到的日志，返回结构化的错误报告。"""
    report = {
        "summary": "",
        "likely_causes": [],
        "recommendations": [],
        "details": [],
    }

    service_state = logs["journal_logs"].get("service", {}).get("output", "")

    # 分析服务状态
    if "ActiveState=failed" in service_state or "Result=exit-code" in service_state:
        report["likely_causes"].append("服务启动失败（返回错误码）")
        report["recommendations"].append("检查 journalctl 日志中的具体错误信息")

    # 分析错误级别日志
    error_log = logs["journal_logs"].get("error", {}).get("output", "")
    if "ModuleNotFoundError" in error_log:
        report["likely_causes"].append("Python 模块缺失（可能需要 pip install）")
        report["recommendations"].append(
            "检查 requirements.txt 是否完整，尝试 pip install -r requirements.txt"
        )

    if "ImportError" in error_log:
        report["likely_causes"].append("模块导入失败（依赖问题或代码冲突）")
        report["recommendations"].append("检查最近的代码变更，特别是新增的导入语句")

    if "alembic" in error_log.lower() and "error" in error_log.lower():
        report["likely_causes"].append("数据库迁移失败")
        report["recommendations"].append("检查迁移脚本语法，或手动运行 alembic 排查")

    if "port" in error_log.lower() and (
        "bind" in error_log.lower() or "address" in error_log.lower()
    ):
        report["likely_causes"].append("端口 8100 被占用")
        report["recommendations"].append(
            "运行 lsof -i:8100 查看占用进程，然后 kill 或重启该进程"
        )

    if "Permission denied" in error_log:
        report["likely_causes"].append("权限不足")
        report["recommendations"].append("检查 systemd service 文件的 User/Group 配置")

    if (
        "connection refused" in error_log.lower()
        or "cannot connect" in error_log.lower()
    ):
        report["likely_causes"].append("数据库连接失败")
        report["recommendations"].append("检查 DATABASE_URL 配置和服务是否运行")

    # 如果没有找到明显原因
    if not report["likely_causes"]:
        report["likely_causes"].append("未知错误，请查看下方详细日志")
        report["recommendations"].append("查看最近 50 条日志，手动定位问题")

    # 生成摘要
    report["summary"] = (
        f"部署在 [{logs['stage']}] 阶段失败，可能原因：{' | '.join(report['likely_causes'])}"
    )

    return report


def format_report(logs, analysis):
    """格式化输出错误报告。"""
    lines = []
    lines.append("\n")
    lines.append("=" * 60)
    lines.append("  部署失败分析报告")
    lines.append("=" * 60)
    lines.append(f"\n📋 失败阶段: {logs['stage']}")
    lines.append(f"⏰ 发生时间: {logs['timestamp']}")
    lines.append("\n🔍 可能原因:")
    for cause in analysis["likely_causes"]:
        lines.append(f"   • {cause}")

    lines.append("\n💡 建议操作:")
    for rec in analysis["recommendations"]:
        lines.append(f"   → {rec}")

    lines.append("\n📊 详细日志:")
    lines.append("-" * 40)

    # 按优先级显示日志
    log_order = ["error", "recent", "today", "service"]
    for name in log_order:
        if name in logs["journal_logs"]:
            data = logs["journal_logs"][name]
            lines.append(f"\n  [{name}] (状态: {'✓' if data['success'] else '✗'}):")
            output = data["output"].strip()
            if output:
                # 限制输出长度
                lines.append("  " + "\n  ".join(output.split("\n")[:20]))
                if len(output.split("\n")) > 20:
                    lines.append(f"  ... (共 {len(output.split(chr(10)))} 行)")

    lines.append("\n" + "=" * 60)

    return "\n".join(lines)


def save_report(logs, analysis, dry_run=False):
    """保存报告到本地文件（best-effort）。

    失败出口的顺序是「收日志 → 存报告 → 发告警」，报告只是存档：磁盘满 /
    目录不可写不能连带把告警吞吐，否则真失败会被降级成一次静默的崩溃
    （BLF-1046 验收要求「真失败仍被拦住」，这条路径本身必须可靠）。
    """
    if dry_run:
        return

    log_dir = os.path.join(os.path.dirname(__file__), "logs")
    date_str = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = os.path.join(log_dir, f"deploy-failed-{date_str}.json")

    report_data = {
        "logs": logs,
        "analysis": analysis,
        "generated_at": datetime.datetime.now().isoformat(),
    }

    try:
        os.makedirs(log_dir, exist_ok=True)
        with open(filename, "w", encoding="utf-8") as f:
            json.dump(report_data, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"\n⚠️ 失败报告保存失败（不影响告警发送）: {e}")
        return None

    print(f"\n💾 报告已保存到: {filename}")
    return filename


def deploy(dry_run=False, auto_confirm=False):
    """执行完整部署流程。"""
    print("=" * 60)
    print("  BelieveBoy Dashboard - VPS 部署工具")
    print(f"  目标服务器: {VPS_USER}@{VPS_HOST}")
    print("=" * 60)

    if dry_run:
        print("\n[DRY RUN 模式] - 不会执行任何命令\n")

    # 步骤 1: 显示当前 git 状态
    print("\n>>> 步骤 1: 检查代码仓库状态...")
    rc, out, err = run_ssh_command(
        f"cd {PROJECT_DIR} && git log --oneline -3", dry_run=dry_run
    )
    if rc == 0:
        print("当前 HEAD:")
        print(out)

    if not auto_confirm and not dry_run:
        resp = input("\n是否继续部署？[y/N]: ")
        if resp.lower() != "y":
            print("部署已取消。")
            return False

    # 步骤 2: 拉取最新代码
    print("\n>>> 步骤 2: 拉取最新代码...")
    rc, out, err = run_ssh_command(DEPLOY_COMMANDS[0], dry_run=dry_run, timeout=300)
    if rc == 0:
        print(out if out.strip() else "✓ 代码已更新")
    else:
        print(f"✗ Git pull 失败: {err}")
        # BLF-524：失败统一出口（记录 bad-sha + 告警）
        handle_deploy_failure("git pull", dry_run=dry_run, error=err)
        return False

    # 步骤 3: 迁移图前置检查（多 head / 命名违规 / 重复 id 在改库前拦截）
    print("\n>>> 步骤 3: Alembic 迁移图检查...")
    rc, out, err = run_ssh_command(CHECK_MIGRATIONS_CMD, dry_run=dry_run)
    if rc == 0:
        print(out if out.strip() else "✓ 迁移图检查通过")
    else:
        print(f"✗ Alembic 迁移图检查失败: {err or out}")
        print(
            "  修复提示: 多 head 时先在 main 侧跑 "
            '`alembic merge heads --rev-id <下一序号> -m "merge xxx"` 合回单链，'
            "再重新部署。"
        )
        # BLF-524：迁移图被拦截是高风险失败，同样走告警
        handle_deploy_failure(
            "alembic migration graph check", dry_run=dry_run, error=err or out
        )
        return False

    # 步骤 4: 安装后端依赖
    print("\n>>> 步骤 4: 安装后端依赖...")
    rc, out, err = run_ssh_command(DEPLOY_COMMANDS[1], dry_run=dry_run)
    if rc == 0:
        print(out if out.strip() else "✓ 依赖安装完成")
    else:
        print(f"✗ 依赖安装失败: {err}")
        handle_deploy_failure("pip install", dry_run=dry_run, error=err)
        return False

    # 步骤 5: 运行数据库迁移 + 重启服务
    print("\n>>> 步骤 5: 运行数据库迁移并重启服务...")
    for cmd in DEPLOY_COMMANDS[2:]:
        rc, out, err = run_ssh_command(cmd, dry_run=dry_run)
        print(out)
        if err and "active" not in out.lower():
            print(err)
        # BLF-524：迁移/重启任一命令失败立即拦截（原逻辑只打印不判断 rc）
        if rc != 0 and not dry_run:
            print(f"✗ 命令失败 (exit {rc}): {cmd[:160]}")
            print(f"  错误: {err.strip()[:800] or out.strip()[:800]}")
            handle_deploy_failure(
                "deploy commands (migrate/restart)", dry_run=dry_run, error=err
            )
            return False

    # 步骤 6: 验证服务状态（含 journald/cron 落地校验，失败即阻断部署）
    print("\n>>> 步骤 6: 验证部署结果...")
    checks_ok = True
    failed_checks = []
    for cmd in CHECK_COMMANDS:
        rc, out, err = run_ssh_command(cmd, dry_run=dry_run)
        result = out.strip() if rc == 0 else err.strip()
        status_icon = "✓" if rc == 0 else "✗"
        print(f"  {status_icon} {cmd}: {result}")
        if rc != 0:
            checks_ok = False
            failed_checks.append(cmd)

    # 任一落地校验失败：走既有失败出口（健康检查前拦截，避免"检查失败
    # 但 API 200 → 部署成功"的假阳性——BLF-1035 review）
    if not checks_ok and not dry_run:
        print(f"✗ 部署后校验失败 ({len(failed_checks)}/{len(CHECK_COMMANDS)} 项):")
        for cmd in failed_checks:
            print(f"  ✗ {cmd}")
        handle_deploy_failure(
            "post-deploy checks (services/journald/cron)",
            dry_run=dry_run,
            error="; ".join(failed_checks),
        )
        return False

    # 检查服务是否真正启动（BLF-1046：截止时间内退避重试，容忍 uvicorn 起窗）
    print(
        f"\n>>> 步骤 7: 确认服务健康状态（{HEALTH_PROBE_DEADLINE_SECONDS}s 内重试）..."
    )
    if dry_run:
        # dry-run 没有真实探活结果，也不该按退避表空转等待：只预览命令
        print(
            f"  [DRY RUN] 探活命令（退避至 {HEALTH_PROBE_DEADLINE_SECONDS}s 截止）: "
            f"{HEALTH_PROBE_CMD}"
        )
        print("  ✓ API 健康检查通过 (dry-run 跳过)")
    else:

        def _probe() -> str:
            rc, out, err = probe_api_health()
            code = parse_health_code(out)
            detail = "" if rc == 0 else f" (exit {rc}: {err.strip()[:120]})"
            print(f"    探活: HTTP {code}{detail}")
            return code

        result = wait_for_api_health(_probe)
        if result.ready:
            print(
                f"  ✓ API 健康检查通过 (HTTP {result.code}，"
                f"第 {result.attempts} 次探活，耗时 {result.elapsed:.1f}s)"
            )
        else:
            error = (
                f"HTTP {result.code}"
                f"（{result.attempts} 次探活 / {result.elapsed:.1f}s 内始终未就绪）"
            )
            print(f"  ✗ API 健康检查失败 ({error})，收集诊断信息...")
            handle_deploy_failure("API health check", dry_run=dry_run, error=error)
            return False

    if not dry_run:
        print("\n>>> 部署完成！显示最近日志：\n")
        remote = f"{VPS_USER}@{VPS_HOST}"
        try:
            subprocess.run(
                [
                    "ssh",
                    remote,
                    "journalctl -u believeboy-api --no-pager -n 20",
                ],
                timeout=30,
            )
            # 一并显示 scheduled worker 启动日志，确认新代码已加载、dispatch_one 已注册
            subprocess.run(
                [
                    "ssh",
                    remote,
                    "journalctl -u believeboy-celery-scheduled --no-pager -n 12",
                ],
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            pass

    print("\n" + "=" * 60)
    print("  ✓ 部署成功完成！")
    print("=" * 60)
    return True


def main():
    parser = argparse.ArgumentParser(description="部署 BelieveBoy Dashboard 到 VPS")
    parser.add_argument("--dry-run", action="store_true", help="预览命令但不执行")
    parser.add_argument("--auto", action="store_true", help="跳过所有确认提示")
    args = parser.parse_args()

    success = deploy(dry_run=args.dry_run, auto_confirm=args.auto)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
