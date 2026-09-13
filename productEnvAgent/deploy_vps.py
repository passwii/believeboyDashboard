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

import subprocess
import sys
import argparse
import datetime
import json
import os

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
    f"cp {PROJECT_DIR}backend/deploy/systemd/believeboy-celery.service /etc/systemd/system/believeboy-celery.service "
    f"&& cp {PROJECT_DIR}backend/deploy/systemd/believeboy-celery-scheduled.service /etc/systemd/system/believeboy-celery-scheduled.service "
    f"&& cp {PROJECT_DIR}backend/deploy/systemd/believeboy-api.service /etc/systemd/system/believeboy-api.service "
    f"&& mkdir -p /etc/systemd/journald.conf.d "
    f"&& cp {PROJECT_DIR}backend/deploy/journald/00-believeboy-cap.conf /etc/systemd/journald.conf.d/00-believeboy-cap.conf "
    f"&& systemctl restart systemd-journald "
    f"&& cp {PROJECT_DIR}backend/deploy/cron/believeboy-swap-reclaim /etc/cron.d/believeboy-swap-reclaim "
    f"&& chmod 0644 /etc/cron.d/believeboy-swap-reclaim "
    f"&& chmod +x {PROJECT_DIR}backend/deploy/scripts/swap_reclaim.sh "
    f"&& systemctl daemon-reload",
    # 启用新单元（首次部署时 enable，后续幂等）
    "systemctl enable believeboy-celery.service believeboy-celery-scheduled.service 2>/dev/null || true",
    "systemctl restart believeboy-api",
    # Celery worker 必须随代码部署一起重启，否则旧进程内存里的 task 签名
    # 不更新（如 dispatch_one 的 old_log_id 参数），补发任务会抛 TypeError
    # 并永久卡在 preparing。两个 worker 单元：
    #   believeboy-celery（-Q default,reports,insights,ai_summary -c 4）
    #   believeboy-celery-scheduled（-Q scheduled -c 2，截图内存隔离）
    # 均用 acks_late + task_reject_on_worker_lost，重启时 in-flight 任务
    # 会被 broker 重投，安全。
    "systemctl restart believeboy-celery.service",
    "systemctl restart believeboy-celery-scheduled.service",
    "systemctl status believeboy-api --no-pager",
]

# 检查命令（部署后验证）
CHECK_COMMANDS = [
    "systemctl is-active believeboy-api",
    "systemctl is-active believeboy-celery.service",
    "systemctl is-active believeboy-celery-scheduled.service",
    f'cd {BACKEND_DIR} && {VENV_ACTIVATE} && python -c "import app.main"',
    "grep -q ^SystemMaxUse=200M$ /etc/systemd/journald.conf.d/00-believeboy-cap.conf"
    " && grep -q ^SystemKeepFree=1G$ /etc/systemd/journald.conf.d/00-believeboy-cap.conf",
    "test -x /root/believeboyDashboard/backend/deploy/scripts/swap_reclaim.sh"
    " && grep -q swap_reclaim.sh /etc/cron.d/believeboy-swap-reclaim",
]

# 日志获取命令（用于错误分析）
LOG_COMMANDS = {
    "recent": "journalctl -u believeboy-api --no-pager -n 50",
    "error": "journalctl -u believeboy-api --no-pager -p err -n 30",
    "today": "journalctl -u believeboy-api --no-pager --since today",
    "service": "systemctl show believeboy-api --property=MainPID,ActiveState,SubState,Result",
}


def run_ssh_command(command, host=VPS_HOST, user=VPS_USER, dry_run=False, timeout=300):
    """通过 SSH 在 VPS 上执行命令。"""
    ssh_command = f"ssh {user}@{host} '{command}'"
    if dry_run:
        print(f"[DRY RUN] 即将执行: {ssh_command}")
        return 0, "", ""

    try:
        result = subprocess.run(
            ssh_command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "命令执行超时（120秒）"
    except Exception as e:
        return -1, "", str(e)


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
    rc, out, err = run_ssh_command(
        f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && python -c 'import app.main' 2>&1",
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
    lines.append(f"\n🔍 可能原因:")
    for cause in analysis["likely_causes"]:
        lines.append(f"   • {cause}")

    lines.append(f"\n💡 建议操作:")
    for rec in analysis["recommendations"]:
        lines.append(f"   → {rec}")

    lines.append(f"\n📊 详细日志:")
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
    """保存报告到本地文件。"""
    if dry_run:
        return

    log_dir = os.path.join(os.path.dirname(__file__), "logs")
    os.makedirs(log_dir, exist_ok=True)

    date_str = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = os.path.join(log_dir, f"deploy-failed-{date_str}.json")

    report_data = {
        "logs": logs,
        "analysis": analysis,
        "generated_at": datetime.datetime.now().isoformat(),
    }

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(report_data, f, ensure_ascii=False, indent=2)

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

    # 步骤 6: 验证服务状态
    print("\n>>> 步骤 6: 验证部署结果...")
    is_active = False
    for cmd in CHECK_COMMANDS:
        rc, out, err = run_ssh_command(cmd, dry_run=dry_run)
        result = out.strip() if rc == 0 else err.strip()
        status_icon = "✓" if rc == 0 else "✗"
        print(f"  {status_icon} {cmd}: {result}")
        if "is-active" in cmd and "active" in out:
            is_active = True

    # 检查服务是否真正启动
    print("\n>>> 步骤 7: 确认服务健康状态...")
    rc, out, err = run_ssh_command(
        "curl -s -o /dev/null -w '%{http_code}' "
        "http://127.0.0.1:8100/api/v1/health || echo '000'",
        dry_run=dry_run,
        timeout=10,
    )
    code = (out or "").strip() or "000"
    # 200 = 健康(含 DB/Redis 状态);401 = 服务已起,但 /health 需 API key(部署探活视为通过)
    if code in ("200", "401"):
        print(f"  ✓ API 健康检查通过 (HTTP {code})")
    else:
        print(f"  ✗ API 健康检查失败 (HTTP {code})，收集诊断信息...")
        handle_deploy_failure("API health check", dry_run=dry_run, error=f"HTTP {code}")
        return False

    if not dry_run:
        print("\n>>> 部署完成！显示最近日志：\n")
        try:
            subprocess.run(
                f"ssh {VPS_USER}@{VPS_HOST} 'journalctl -u believeboy-api --no-pager -n 20'",
                shell=True,
                timeout=30,
            )
            # 一并显示 scheduled worker 启动日志，确认新代码已加载、dispatch_one 已注册
            subprocess.run(
                f"ssh {VPS_USER}@{VPS_HOST} 'journalctl -u believeboy-celery-scheduled --no-pager -n 12'",
                shell=True,
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
