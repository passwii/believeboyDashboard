# VPS 部署 Skill 配置

## Skill 名称: `deploy-vps`

此 Skill 用于在本地 git push 之后，自动化部署 BelieveBoy Dashboard 到生产 VPS（`145.79.143.98`，`root` 用户，密钥认证）。

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

1. **切换到项目目录** → `cd /root/believeboyDashboard/`
2. **拉取最新代码** → `git pull`（从 origin/main 获取）
3. **切换到后端目录** → `cd backend/`
4. **激活虚拟环境** → `source .venv/bin/activate`
5. **运行数据库迁移** → `alembic upgrade head`
6. **重启服务** → `systemctl restart believeboy-api`
7. **验证服务状态** → `systemctl status believeboy-api`
9. **显示最近日志** → `journalctl -u believeboy-api -n 20`

## 配置信息

### VPS 详情
- **主机**: `145.79.143.98`（公网 IP；走 SSH key 认证，本机 `~/.ssh/` 已存密钥）
- **用户**: `root`（密钥免密）
- **项目路径**: `/root/believeboyDashboard/`
- **后端路径**: `/root/believeboyDashboard/backend/`
- **虚拟环境**: `/root/believeboyDashboard/backend/.venv/`
- **服务名称**: `believeboy-api`
- **API 端口**: `8100`（通过 systemd）

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

### 方式 1：Git pre-push Hook（生产推荐，已安装）
仓库已安装 `.git/hooks/pre-push`（唯一会在 push 时自动触发的 hook），逻辑：
- push 到 `main` 且本次改动命中 `backend/` 才部署；纯前端改动不触发（前端在 Vercel）。
- 内部用 `git push --no-verify` 完成推送（避免重入自身），随后在 VPS 跑 `deploy_vps.py --auto`。
- 临时跳过：`SKIP_POST_PUSH_DEPLOY=1 git push origin main`。
- 长期关闭：`chmod -x .git/hooks/pre-push`。

源码与安装说明见 hook 文件头部注释；如需新 clone 复用，可放进 `~/.git-templates/hooks/pre-push` 并 `git config --global init.templateDir ~/.git-templates`。

### 方式 2：手动调用 / Skill
- 对 Claude 说 `/deploy-vps` 或 "部署到 VPS"。
- 或本地直接跑（等价于 hook 触发的部署）：`cd productEnvAgent && python deploy_vps.py --auto`。

### 方式 3：post-push.sh（可选替代，非默认）
`productEnvAgent/post-push.sh` 是 pre-push 的替代模板。注意：**git 没有内置的 post-push hook**，把它装成 `.git/hooks/post-push` 也不会被 git 自动调用；自动部署请用上面的 pre-push。该文件仅作参考 / 手动执行用。

> 弃用说明：旧版文档曾推荐 post-commit hook（每次提交即部署、含本地分支，危险）与无过滤的 post-push。这些均已弃用，请勿使用。

### 配置来源
部署参数（host / user / 路径 / 触发开关）以 `productEnvAgent/config.json` 为准（注意是 `config.json`，不是 `settings.json`）；脚本里的 `VPS_HOST` 等常量与之一致。

## 错误处理

部署过程中会自动检查以下失败点:

| 检查项 | 命令 | 成功标识 |
|-------|------|---------|
| SSH 连接 | `ssh root@145.79.143.98 echo ok` | `ok` |
| Git pull | `git pull` | 无冲突，快速前进 |
| 数据库迁移 | `alembic upgrade head` | INFO: Context impl PostgresqlImpl |
| 服务停止 | `systemctl stop believeboy-api` | `Deactivated successfully` |
| 服务启动 | `systemctl start believeboy-api` | `active (running)` |
| API 健康检查 | `curl -w '%{http_code}' http://127.0.0.1:8100/api/v1/health` | `200`（健康）；`401` 表示服务已起但 `/health` 需 API key（探活视为通过） |

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
| port bind | 端口 8100 被占用 | lsof -i:8100 查看进程 |
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
→ root 用户直跑即可，无需 sudo。部署命令见 `deploy_vps.py:DEPLOY_COMMANDS`。

### 服务启动失败
→ 查看日志: `journalctl -u believeboy-api -n 50`
→ 检查端口: `ss -tlnp | grep 8100`

## 维护操作

### 回滚部署
```bash
# SSH 到 VPS
ssh root@145.79.143.98
cd /root/believeboyDashboard/
git log --oneline  # 找到之前的提交
git revert <commit>  # 或 git reset --hard <commit>
source backend/.venv/bin/activate
alembic downgrade -1  # 回滚上一个迁移
systemctl restart believeboy-api
```

### 部署前数据库备份
```bash
ssh root@145.79.143.98
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