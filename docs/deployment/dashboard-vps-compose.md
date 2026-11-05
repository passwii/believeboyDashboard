# Dashboard VPS Compose 部署

最后更新：2026-11-05

生产入口：

- Web：`https://dash.believeboy.com`
- API：`https://dash-api.believeboy.com`

## 架构

```text
宿主机公共设施
  PostgreSQL 18.1  127.0.0.1:5432
  Redis 8.0        127.0.0.1:6379
  Caddy            80/443

Dashboard Compose（network_mode: host）
  migrate
  api         127.0.0.1:8100
  celery
  celery-scheduled
  beat
  web         127.0.0.1:3200
```

PostgreSQL、Redis、Caddy 不进入 Dashboard Compose。容器使用宿主机网络，直接访问
现有回环地址，因此不需要修改 Redis bind、PostgreSQL HBA 或 Caddy upstream。

## 镜像

| 组件 | GHCR |
| --- | --- |
| Web | `ghcr.io/passwii/believeboydashboard-web` |
| API 与全部 Celery 进程 | `ghcr.io/passwii/believeboydashboard-api` |

发布使用同一 commit 构建的两个镜像；部署参数使用 registry digest，而不是可变标签。
Web 和 API 必须成对切换与回滚。

## VPS 文件

| 路径 | 用途 |
| --- | --- |
| `/opt/believeboy-dashboard/docker-compose.yml` | 统一 Compose |
| `/opt/believeboy-dashboard/backend.env` | 后端运行环境，权限 `0600` |
| `/opt/believeboy-dashboard/web.env` | Web/Auth.js 运行环境，权限 `0600` |
| `/opt/believeboy-dashboard/backend-storage` | 上传、分析结果与临时工作文件 |
| `/opt/believeboy-dashboard/celerybeat` | Celery beat schedule 状态 |
| `/opt/believeboy-dashboard/legacy` | 首次切流前的前端 Compose/env 回滚副本 |

`backend.env` 和 `web.env` 不进入镜像或 Git。

## 内网与公网地址

服务间调用优先使用本机回环：

```dotenv
BACKEND_INTERNAL_URL=http://127.0.0.1:8100
DATABASE_URL=postgresql+psycopg://...@127.0.0.1:5432/BLF
REDIS_HOST=127.0.0.1
AI_CHAT_PROVIDER_BASE_URL=http://127.0.0.1:3100/v1
```

以下地址必须继续使用公开 URL：

- `NEXTAUTH_URL` / `AUTH_URL`：浏览器认证回调与 Cookie origin。
- `BACKEND_PUBLIC_API_BASE_URL`：前端展示及 Agent 调用说明。
- `FRONTEND_URL`：CORS 与邮件中的可点击链接。
- R2、Resend、联网搜索等外部服务地址。

## 本地发布

配置：

```text
~/.config/believeboy-dashboard/deploy.env
```

发布：

```bash
git switch main
git pull --ff-only origin main
deploy/deploy-local.sh
```

本地脚本依次执行：

1. 校验最新 `origin/main`、Alembic 迁移图、前端 lint 和全量测试。
2. 构建并推送 API、Web 两个 `linux/amd64` 镜像。
3. 从镜像 metadata 读取 digest。
4. 首次切流时复制旧后端环境、storage 和 celerybeat 状态。
5. 停止旧的四个 systemd 后端单元和旧前端容器。
6. 同步 Compose/Web env，执行 `alembic upgrade head`。
7. 启动统一 Compose，检查 API、Web、两个 Celery worker 与 beat。

失败时本地脚本会重新启动旧 systemd 服务，并尝试恢复旧前端容器。

## GitHub Actions 备用发布

`.github/workflows/deploy-dashboard.yml` 只能手动触发，且只接受 `main`：

```bash
gh workflow run deploy-dashboard.yml --ref main
gh run list --workflow deploy-dashboard.yml --limit 3
```

Actions 复用现有 Secrets：`VPS_SSH_KEY`、`VPS_KNOWN_HOSTS`、`VPS_HOST`、
`NEXTAUTH_SECRET`。首次本地切流完成后才能使用此入口。

## 检查

```bash
curl -fsS https://dash.believeboy.com/healthz
curl -fsS https://dash-api.believeboy.com/api/v1/health/live

ssh guitar-vps '
  cd /opt/believeboy-dashboard
  docker compose ps
  docker compose logs --tail=100 api web celery celery-scheduled beat
'
```

预期：

- `api`、`web` 为 healthy。
- 两个 Celery worker 响应 `celery inspect ping`。
- `beat` 持续运行。
- `5432`、`6379`、`8100`、`3200` 只监听宿主机回环或被 Caddy 使用。

## 回滚

应用回滚要求 API/Web digest 成对恢复。数据库 migration 不会自动回滚，后续迁移必须
保持向后兼容。

首次切流后的短期回退：

```bash
systemctl start believeboy-api believeboy-celery believeboy-celery-scheduled believeboy-beat
cd /opt/believeboy-dashboard/legacy
IMAGE_TAG=latest APP_PORT=3200 docker compose up -d --no-build web
```

稳定运行 24 小时后，再禁用 systemd 单元并删除 VPS 上的旧 Git 仓库、`frontend/node_modules`
和 `backend/.venv`。删除前确认 `backend-storage` 与 `celerybeat` 已包含全部运行状态。
