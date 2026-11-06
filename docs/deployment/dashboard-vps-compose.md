# Dashboard VPS Compose 部署

最后更新：2026-11-06

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
  api         127.0.0.1:8100  FastAPI 回退
  go-api      127.0.0.1:8200  Go Gateway
  celery
  celery-scheduled
  beat
  web         127.0.0.1:3200
```

PostgreSQL、Redis、Caddy 不进入 Dashboard Compose。Go API 从 `backend.env` 读取
`DATABASE_URL`、`API_KEY` 和 FastAPI 使用的 Redis host/port/db/credential。显式 `REDIS_URL`
优先；未设置时 Go 会按这些 Redis 字段构造连接 URL。Go 通过宿主机网络访问 `127.0.0.1`。Go Gateway
监听 `8200`，把未接管路由反向代理到 FastAPI `8100`。Caddy 的 `dash-api` upstream
指向 Go Gateway；当前示例见 `deploy/Caddyfile.example`。首次切换时需更新 VPS Caddyfile 并 reload。

## 镜像

| 组件 | GHCR |
| --- | --- |
| Web | `ghcr.io/passwii/believeboydashboard-web` |
| FastAPI 与全部 Celery 进程 | `ghcr.io/passwii/believeboydashboard-api` |
| Go Gateway | `ghcr.io/passwii/believeboydashboard-go-api` |

发布使用同一 commit 构建的三个镜像；部署参数使用 registry digest，而不是可变标签。
Web、FastAPI 和 Go API 必须同版本切换与回滚。

## VPS 文件

| 路径 | 用途 |
| --- | --- |
| `/opt/believeboy-dashboard/docker-compose.yml` | 统一 Compose |
| `/opt/believeboy-dashboard/backend.env` | 后端运行环境，权限 `0600` |
| `/opt/believeboy-dashboard/web.env` | Web/Auth.js 运行环境，权限 `0600` |
| `/opt/believeboy-dashboard/go.env` | Go Gateway 监听、路由所有权和代理密钥，权限 `0600` |
| `/opt/believeboy-dashboard/.deploy-images` | 最近一次通过健康检查的三镜像清单，权限 `0600` |
| `/opt/believeboy-dashboard/backend-storage` | 上传、分析结果与临时工作文件 |
| `/opt/believeboy-dashboard/celerybeat` | Celery beat schedule 状态 |
| `/opt/believeboy-dashboard/legacy` | 首次切流前的前端 Compose/env 回滚副本 |

`backend.env`、`web.env` 和 `go.env` 不进入镜像或 Git。`GO_API_TRUSTED_PROXY_SECRET`
必须在 `web.env` 和 `go.env` 中相同，生成命令为 `openssl rand -hex 32`。

## 内网与公网地址

服务间调用优先使用本机回环：

```dotenv
# web.env：Next.js 服务端请求走 Go Gateway
BACKEND_INTERNAL_URL=http://127.0.0.1:8200
GO_API_TRUSTED_PROXY_SECRET=<64-character hex secret>

# backend.env：Go 复用 FastAPI 的数据库与 Redis 配置
DATABASE_URL=postgresql+psycopg://...@127.0.0.1:5432/BLF
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
# 如 Redis 需要认证，Go 复用 backend.env 中已有的凭据

# go.env
GO_API_ADDR=127.0.0.1:8200
FASTAPI_ORIGIN=http://127.0.0.1:8100
GO_API_OWNED=health,exchange_rates,notifications,alerts,profile
GO_API_TRUSTED_PROXY_SECRET=<same 64-character hex secret>
```

以下地址必须继续使用公开 URL：

- `NEXTAUTH_URL` / `AUTH_URL`：浏览器认证回调与 Cookie origin。
- `BACKEND_PUBLIC_API_BASE_URL`：前端展示及 Agent 调用说明；`dash-api` 的 Caddy upstream 使用 Go Gateway `8200`。
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
2. 构建并推送 FastAPI、Go API、Web 三个 `linux/amd64` 镜像；只推送 commit SHA
   标签，不推送 `latest`。脚本会输出每张镜像及三张镜像的总构建/推送秒数。
   本地无法访问 `proxy.golang.org` 时，可在 `deploy.env` 设置 `GO_MODULE_PROXY=https://goproxy.cn,direct`。
3. 从三个镜像 metadata 读取 digest。
4. 生成 `web.env.next` 和 `go.env.next`，同一个可信代理密钥只通过运行环境传递。
5. 暂存 Compose 与环境文件；首次安装允许没有旧 Compose/Web env。远端保存已有配置和镜像清单作为回滚点。
6. 执行 `alembic upgrade head`，启动 FastAPI `8100`、Go Gateway `8200` 和 Web。
7. 检查 FastAPI、Go、Web、两个 Celery worker、beat 和公网 Web/API 健康地址；全部通过后更新 `.deploy-images` 并清理回滚副本。

部署失败时脚本恢复上一版 Compose、环境文件和 API/Web/Go 镜像；数据库 migration
不会自动回滚。旧 systemd 服务不会自动启动。Go Gateway 首次健康后，再把 VPS Caddy 的
`dash-api` upstream 改为 `127.0.0.1:8200` 并 reload。

## GitHub Actions 备用发布

`.github/workflows/deploy-dashboard.yml` 只能手动触发，且只接受 `main`：

```bash
gh workflow run deploy-dashboard.yml --ref main
gh run list --workflow deploy-dashboard.yml --limit 3
```

Actions 复用 Secrets：`VPS_SSH_KEY`、`VPS_KNOWN_HOSTS`、`VPS_HOST`、
`NEXTAUTH_SECRET`、`GO_API_TRUSTED_PROXY_SECRET`、`GHCR_TOKEN`。`GO_API_TRUSTED_PROXY_SECRET`
用 `openssl rand -hex 32` 生成；`GHCR_TOKEN` 需具备 `write:packages`，因为已有 GHCR
package 最初由本机 PAT 创建，Actions 自带的 `GITHUB_TOKEN` 没有该 package 的读权限。
工作流从 VPS 现有 env 复制 `web.env`，并暂存 Go Gateway 配置，再部署三张镜像。
公网 Web/API 检查在远端部署事务清理回滚点前执行，失败会触发同一镜像组回滚。

## 检查

```bash
curl -fsS https://dash.believeboy.com/healthz
curl -fsS https://dash-api.believeboy.com/api/v1/health/live

ssh guitar-vps '
  cd /opt/believeboy-dashboard
  docker compose ps
  docker compose logs --tail=100 api go-api web celery celery-scheduled beat
'
```

预期：

- `api`、`go-api`、`web` 为 healthy。
- `go-api` 读取 `backend.env` 中的 `DATABASE_URL`、`REDIS_HOST`、`REDIS_PORT`、`REDIS_DB`、Redis 凭据和 `API_KEY`，并把未接管路由转发至 `8100`。
- 两个 Celery worker 响应 `celery inspect ping`。
- `beat` 持续运行。
- `5432`、`6379`、`8100`、`8200`、`3200` 只监听宿主机回环；Caddy 的 API upstream 指向 `8200`。

## 回滚

应用回滚要求 FastAPI、Go API、Web 三个 digest 成组恢复。数据库 migration 不会自动回滚，
后续迁移必须保持向后兼容。

首次切流后的短期回退：

```bash
systemctl start believeboy-api believeboy-celery believeboy-celery-scheduled believeboy-beat
cd /opt/believeboy-dashboard/legacy
IMAGE_TAG=latest APP_PORT=3200 docker compose up -d --no-build web
```

稳定运行 24 小时后，再禁用 systemd 单元并删除 VPS 上的旧 Git 仓库、`frontend/node_modules`
和 `backend/.venv`。删除前确认 `backend-storage` 与 `celerybeat` 已包含全部运行状态。
