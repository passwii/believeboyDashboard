# VPS 部署 Skill 配置

## Skill 名称: `deploy-vps`

此 Skill 用于在本地 git push 之后，自动化部署 BelieveBoy Dashboard 到生产 VPS（`192.168.100.113`，`damon` 用户）。

## 使用方式

### 作为 CLI 工具
```bash
# 从项目根目录执行:
cd productEnvAgent
python deploy_vps.py              # 交互式部署
python deploy_vps.py --dry-run    # 预览命令
python deploy_vps.py --auto       # 非交互式
```

### 作为 Skill（Claude Code）
```
/deploy-vps
```

或通过 Skill 工具编程调用:
```json
{
  "skill": "deploy-vps",
  "args": "--dry-run"
}
```

## 部署流程

Skill 在 VPS 上执行以下步骤：

1. **切换到项目目录** → `cd /home/damon/believeboyDashboard/`
2. **拉取最新代码** → `git pull`（从 origin/main 获取）
3. **切换到后端目录** → `cd backend/`
4. **激活虚拟环境** → `source .venv/bin/activate`
5. **运行数据库迁移** → `alembic upgrade head`
6. **停止服务** → `systemctl stop believeboy-api`
7. **启动服务** → `systemctl start believeboy-api`
8. **验证服务状态** → `systemctl status believeboy-api`
9. **显示最近日志** → `journalctl -u believeboy-api -n 20`

## 配置信息

### VPS 详情
- **主机**: `192.168.100.113`（LAN，与本机同网段；走 SSH key 认证，本机 `~/.ssh/` 已存密钥）
- **用户**: `damon`
- **项目路径**: `/home/damon/believeboyDashboard/`
- **后端路径**: `/home/damon/believeboyDashboard/backend/`
- **虚拟环境**: `/home/damon/believeboyDashboard/backend/.venv/`
- **服务名称**: `believeboy-api`
- **API 端口**: `8000`（通过 systemd）

### 服务管理命令
```bash
# 手动命令（供参考）
systemctl stop believeboy-api    # 停止 API
systemctl start believeboy-api   # 启动 API
systemctl restart believeboy-api  # 重启
systemctl status believeboy-api   # 查看状态
journalctl -u believeboy-api -f   # 实时日志
```

## 触发方式

### 方式 1: 手动调用
直接对 Claude 说: "/deploy-vps" 或 "部署到 VPS"

### 方式 2: Git Post-Commit Hook（推荐）
添加 git post-commit hook 在本地提交后自动部署:
```bash
# ~/.git-templates/hooks/post-commit
#!/bin/bash
# 用 git rev-parse 解析 repo 根目录，避免硬编码 /Users/damon/DamonProjects/...
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root/productEnvAgent"
python deploy_vps.py --auto
```

### 方式 3: Git Post-Push Hook（更安全）
使用 post-push hook 只在推送到远程后部署。仓库自带 `productEnvAgent/post-push.sh`，已支持 `git rev-parse --show-toplevel` 解析路径，可直接安装：
```bash
# 一次性安装到本仓库（推荐）
cp productEnvAgent/post-push.sh .git/hooks/post-push
chmod +x .git/hooks/post-push
```

或者作为 git 模板，全局生效（用 `git rev-parse` 自动定位 repo）：
```bash
# ~/.git-templates/hooks/post-push
#!/bin/bash
repo_root="$(git rev-parse --show-toplevel)"
if [[ "$1" == *"origin/main"* ]]; then
    cd "$repo_root/productEnvAgent"
    python deploy_vps.py --auto
fi
```

### 方式 4: 通过 settings.json（自动化配置）
在 `projectEnvAgent/settings.json` 中配置:
```json
{
  "triggers": {
    "on_git_push": {
      "enabled": true,
      "branch": "main",
      "auto_deploy": true
    },
    "on_commit": {
      "enabled": false,
      "message_pattern": ".*deploy.*"
    }
  }
}
```

### 方式 5: 通过任务调度器
使用 `/schedule` 设置自动化部署:
```
/schedule
  command: deploy-vps
  cron: "0 2 * * *"  # 每天凌晨 2 点
  description: "每日部署 main 分支"
```

## 错误处理

部署过程中会自动检查以下失败点:

| 检查项 | 命令 | 成功标识 |
|-------|------|---------|
| SSH 连接 | `ssh damon@192.168.100.113 echo ok` | `ok` |
| Git pull | `git pull` | 无冲突，快速前进 |
| 数据库迁移 | `alembic upgrade head` | INFO: Context impl PostgresqlImpl |
| 服务停止 | `systemctl stop believeboy-api` | `Deactivated successfully` |
| 服务启动 | `systemctl start believeboy-api` | `active (running)` |
| API 健康检查 | `curl http://127.0.0.1:8000/api/v1/health` | `{"status":"ok"}` |

## 失败诊断功能

当部署失败时，脚本会自动执行以下诊断步骤：

1. **收集服务状态** - systemctl show 获取进程 ID、活动状态
2. **获取最近日志** - journalctl 最近 50 条
3. **筛选错误日志** - journalctl -p err 过滤错误级别
4. **获取今日日志** - journalctl --since today
5. **Python 模块测试** - 尝试导入 app.main
6. **API 健康检查** - curl 健康检查接口

### 诊断结果分析

脚本会自动识别以下常见错误类型:

| 错误关键词 | 可能原因 | 建议操作 |
|-----------|---------|---------|
| ModuleNotFoundError | Python 模块缺失 | pip install -r requirements.txt |
| ImportError | 依赖问题或代码冲突 | 检查新增导入语句 |
| alembic error | 数据库迁移失败 | 检查迁移脚本语法 |
| port bind | 端口 8000 被占用 | lsof -i:8000 查看进程 |
| Permission denied | 权限不足 | 检查 systemd User/Group |
| connection refused | 数据库连接失败 | 检查 DATABASE_URL |

## 日志保存

失败报告保存到:
- `productEnvAgent/logs/deploy-failed-YYYY-MM-DD.log`

报告格式为 JSON，包含:
- 完整日志输出
- 分析结果
- 建议操作
- 时间戳

## 安全说明

- 部署使用 SSH Key 认证（无需密码）
- VPS 使用 root 访问权限
- 服务通过 systemd 以 root 身份运行
- 数据库迁移在事务内原子执行
- 部署前请务必 review git diff

## 故障排除

### "alembic: command not found"
→ 先激活虚拟环境: `source .venv/bin/activate`

### "Fast-forward only" 错误
→ 本地分支领先远程，先执行 `git pull --rebase`

### systemctl 权限问题
→ 确保 `damon` 用户有 NOPASSWD sudo 权限（见 `/etc/sudoers.d/damon-systemctl`）。非交互 SSH 下 polkit 会拒绝 start/stop，需走 `sudo` 传统鉴权

### 服务启动失败
→ 查看日志: `journalctl -u believeboy-api -n 50`
→ 检查端口: `ss -tlnp | grep 8000`

## 维护操作

### 回滚部署
```bash
# SSH 到 VPS
ssh damon@192.168.100.113
cd /home/damon/believeboyDashboard/
git log --oneline  # 找到之前的提交
git revert <commit>  # 或 git reset --hard <commit>
source backend/.venv/bin/activate
alembic downgrade -1  # 回滚上一个迁移
sudo systemctl restart believeboy-api
```

### 部署前数据库备份
```bash
ssh damon@192.168.100.113
pg_dump -U damon -d BLF > /backups/believeboy-$(date +%F).sql
```

## 与 Claude Code 集成

此 Skill 可与 `/loop` 和 `/schedule` 功能配合使用:

```
# 每次推送到 main 后自动部署
/loop 5m
  # 检查 origin/main 是否有新提交
  git fetch origin
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)
  if [ "$LOCAL" != "$REMOTE" ]; then
    /deploy-vps --auto
  fi
```