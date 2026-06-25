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
5. 重启 believeboy-api 服务
6. 验证服务运行状态
7. 获取并分析部署失败的日志
"""

import subprocess
import sys
import argparse
import datetime
import json
import os

# VPS 配置
VPS_HOST = "192.168.100.113"
VPS_USER = "damon"
PROJECT_DIR = "/home/damon/believeboyDashboard/"
BACKEND_DIR = f"{PROJECT_DIR}backend/"
VENV_ACTIVATE = "source /home/damon/believeboyDashboard/backend/.venv/bin/activate"

# 部署命令（在 VPS 上执行）
# 注意：systemctl 操作需 damon 用户有 NOPASSWD sudo 权限（见 /etc/sudoers.d/damon-systemctl）
# 在没有交互 TTY 的非交互 ssh 下，polkit 会拒绝 start/stop，所以用 sudo 走传统 sudo 鉴权
DEPLOY_COMMANDS = [
    f"cd {PROJECT_DIR} && git pull",
    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && alembic upgrade head",
    "sudo systemctl restart believeboy-api",
    "systemctl status believeboy-api --no-pager",
]

# 检查命令（部署后验证）
CHECK_COMMANDS = [
    "systemctl is-active believeboy-api",
    f"cd {BACKEND_DIR} && {VENV_ACTIVATE} && python -c \"import app.main\"",
]

# 日志获取命令（用于错误分析）
LOG_COMMANDS = {
    "recent": "journalctl -u believeboy-api --no-pager -n 50",
    "error": "journalctl -u believeboy-api --no-pager -p err -n 30",
    "today": "journalctl -u believeboy-api --no-pager --since today",
    "service": "systemctl show believeboy-api --property=MainPID,ActiveState,SubState,Result",
}


def run_ssh_command(command, host=VPS_HOST, user=VPS_USER, dry_run=False, timeout=120):
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


def collect_failure_logs(stage_name, dry_run=False):
    """收集部署失败时的详细日志信息。"""
    print(f"\n{'='*60}")
    print(f"  收集 {stage_name} 失败时的日志...")
    print(f"{'='*60}\n")

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
        dry_run=dry_run
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
        report["recommendations"].append("检查 requirements.txt 是否完整，尝试 pip install -r requirements.txt")

    if "ImportError" in error_log:
        report["likely_causes"].append("模块导入失败（依赖问题或代码冲突）")
        report["recommendations"].append("检查最近的代码变更，特别是新增的导入语句")

    if "alembic" in error_log.lower() and "error" in error_log.lower():
        report["likely_causes"].append("数据库迁移失败")
        report["recommendations"].append("检查迁移脚本语法，或手动运行 alembic 排查")

    if "port" in error_log.lower() and ("bind" in error_log.lower() or "address" in error_log.lower()):
        report["likely_causes"].append("端口 8100 被占用")
        report["recommendations"].append("运行 lsof -i:8100 查看占用进程，然后 kill 或重启该进程")

    if "Permission denied" in error_log:
        report["likely_causes"].append("权限不足")
        report["recommendations"].append("检查 systemd service 文件的 User/Group 配置")

    if "connection refused" in error_log.lower() or "cannot connect" in error_log.lower():
        report["likely_causes"].append("数据库连接失败")
        report["recommendations"].append("检查 DATABASE_URL 配置和服务是否运行")

    # 如果没有找到明显原因
    if not report["likely_causes"]:
        report["likely_causes"].append("未知错误，请查看下方详细日志")
        report["recommendations"].append("查看最近 50 条日志，手动定位问题")

    # 生成摘要
    report["summary"] = f"部署在 [{logs['stage']}] 阶段失败，可能原因：{' | '.join(report['likely_causes'])}"

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
    rc, out, err = run_ssh_command(f"cd {PROJECT_DIR} && git log --oneline -3", dry_run=dry_run)
    if rc == 0:
        print("当前 HEAD:")
        print(out)

    if not auto_confirm and not dry_run:
        resp = input("\n是否继续部署？[y/N]: ")
        if resp.lower() != 'y':
            print("部署已取消。")
            return False

    # 步骤 2: 拉取最新代码
    print("\n>>> 步骤 2: 拉取最新代码...")
    rc, out, err = run_ssh_command(DEPLOY_COMMANDS[0], dry_run=dry_run)
    if rc == 0:
        print(out if out.strip() else "✓ 代码已更新")
    else:
        print(f"✗ Git pull 失败: {err}")
        logs = collect_failure_logs("git pull", dry_run=dry_run)
        analysis = analyze_logs(logs)
        print(format_report(logs, analysis))
        save_report(logs, analysis, dry_run)
        return False

    # 步骤 3: 运行数据库迁移
    print("\n>>> 步骤 3: 运行数据库迁移...")
    rc, out, err = run_ssh_command(DEPLOY_COMMANDS[1], dry_run=dry_run)
    if rc == 0:
        print(out if out.strip() else "✓ 迁移完成")
    else:
        print(f"✗ Alembic 迁移失败: {err}")
        logs = collect_failure_logs("alembic upgrade", dry_run=dry_run)
        analysis = analyze_logs(logs)
        print(format_report(logs, analysis))
        save_report(logs, analysis, dry_run)
        return False

    # 步骤 4: 重启服务
    print("\n>>> 步骤 4: 重启 believeboy-api 服务...")
    for cmd in DEPLOY_COMMANDS[2:]:
        rc, out, err = run_ssh_command(cmd, dry_run=dry_run)
        print(out)
        if err and "active" not in out.lower():
            print(err)

    # 步骤 5: 验证服务状态
    print("\n>>> 步骤 5: 验证部署结果...")
    is_active = False
    for cmd in CHECK_COMMANDS:
        rc, out, err = run_ssh_command(cmd, dry_run=dry_run)
        result = out.strip() if rc == 0 else err.strip()
        status_icon = "✓" if rc == 0 else "✗"
        print(f"  {status_icon} {cmd}: {result}")
        if "is-active" in cmd and "active" in out:
            is_active = True

    # 检查服务是否真正启动
    print("\n>>> 步骤 6: 确认服务健康状态...")
    rc, out, err = run_ssh_command(
        f"curl -s http://127.0.0.1:8100/api/v1/health || echo 'HEALTH_CHECK_FAILED'",
        dry_run=dry_run,
        timeout=10
    )

    # 健康检查：检查是否有 {"detail":...} 或 {"status":...} 响应，说明服务在运行
    if '"detail"' in out or '"status"' in out:
        print(f"  ✓ API 健康检查通过")
    else:
        print(f"  ✗ API 健康检查失败，收集诊断信息...")
        logs = collect_failure_logs("API health check", dry_run=dry_run)
        analysis = analyze_logs(logs)
        print(format_report(logs, analysis))
        save_report(logs, analysis, dry_run)
        return False

    if not dry_run:
        print("\n>>> 部署完成！显示最近日志：\n")
        try:
            subprocess.run(
                f"ssh {VPS_USER}@{VPS_HOST} 'journalctl -u believeboy-api --no-pager -n 20'",
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
    parser = argparse.ArgumentParser(description='部署 BelieveBoy Dashboard 到 VPS')
    parser.add_argument('--dry-run', action='store_true', help='预览命令但不执行')
    parser.add_argument('--auto', action='store_true', help='跳过所有确认提示')
    args = parser.parse_args()

    success = deploy(dry_run=args.dry_run, auto_confirm=args.auto)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()