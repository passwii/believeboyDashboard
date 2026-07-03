# ProductEnvAgent - VPS 部署工具

本目录包含用于自动化部署 BelieveBoy Dashboard 到生产服务器（145.79.143.98）的工具和配置。

## 快速开始

### 交互式部署
```bash
cd productEnvAgent
python deploy_vps.py
```

### 自动部署（无确认提示）
```bash
python deploy_vps.py --auto
```

### 预览模式（仅显示将要执行的命令）
```bash
python deploy_vps.py --dry-run
```

## 功能特性

- ✓ 自动 SSH 连接（使用 Key 认证，无需密码）
- ✓ Git pull 拉取最新代码
- ✓ Alembic 数据库迁移
- ✓ Systemd 服务重启
- ✓ 部署失败自动诊断
- ✓ 收集 journalctl 日志
- ✓ 生成结构化错误报告
- ✓ 本地保存失败记录

## 部署流程

1. SSH 连接到 VPS
2. 切换到项目目录 `cd /root/believeboyDashboard/`
3. 执行 `git pull`
4. 切换到后端目录 `cd backend/`
5. 激活虚拟环境 `source .venv/bin/activate`
6. 运行数据库迁移 `alembic upgrade head`
7. 停止服务 `systemctl stop believeboy-api`
8. 启动服务 `systemctl start believeboy-api`
9. 验证服务状态 `systemctl status believeboy-api`

## 服务信息

- **服务名称**: `believeboy-api`
- **Systemd 配置**: `/etc/systemd/system/believeboy-api.service`
- **运行方式**: Python 3 + uvicorn (FastAPI)
- **API 端口**: http://127.0.0.1:8100
- **虚拟环境**: `/root/believeboyDashboard/backend/.venv/`

## 失败诊断

当部署失败时，脚本会自动：

1. 收集最近 50 条 journalctl 日志
2. 筛选错误级别日志
3. 获取今日所有相关日志
4. 检查服务状态和进程信息
5. 尝试导入 Python 应用模块
6. 分析可能的原因并给出建议
7. 将完整报告保存到 `logs/` 目录

### 常见错误类型及处理

| 错误类型 | 可能原因 | 建议操作 |
|---------|---------|---------|
| ModuleNotFoundError | Python 模块缺失 | 检查 requirements.txt，运行 pip install |
| ImportError | 依赖问题或代码冲突 | 检查新增的导入语句 |
| 端口占用 | 8100 端口被占用 | lsof -i:8100 查看占用进程 |
| 权限不足 | Systemd 配置问题 | 检查 service 文件的 User/Group |
| 数据库连接失败 | DATABASE_URL 配置错误 | 检查环境变量配置 |

## 日志文件

失败报告保存在：
- `logs/deploy-failed-YYYY-MM-DD_HH-MM-SS.json`

## 触发方式

### 方式 1: 手动调用
```
/deploy-vps
```

### 方式 2: Git Hook（推送后自动部署）
```bash
# 安装 post-push hook
cp post-push.sh ~/.git-templates/hooks/post-push
chmod +x ~/.git-templates/hooks/post-push
```

### 方式 3: Claude Code Schedule
```
/schedule
  命令: deploy-vps --auto
  时间: 每天凌晨 2:00
```

## 配置说明

编辑 `config.json` 可修改：
- VPS 连接信息
- 部署触发条件
- 日志保存策略

## 手动操作命令

```bash
# SSH 连接到 VPS（root + 密钥）
ssh root@145.79.143.98

# 在 VPS 上手动重启服务
systemctl stop believeboy-api
systemctl start believeboy-api
systemctl restart believeboy-api

# 查看实时日志
journalctl -u believeboy-api -f

# 查看最近 100 条日志
journalctl -u believeboy-api -n 100
```