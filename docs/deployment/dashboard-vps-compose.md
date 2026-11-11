# Dashboard VPS Compose 部署

最后更新：2026-11-10

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
  migrate     Go API 镜像内的 go-migrate（Goose）
  api         127.0.0.1:8100  FastAPI 回退
  go-api      127.0.0.1:8200  Go Gateway
  go-worker   Go 异步任务 worker（同一 Go 镜像）
  go-scheduler Go 定时任务调度器（同一 Go 镜像）
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
Web、FastAPI 和 Go API 必须同版本切换与回滚。`go-worker` 与 `go-scheduler` 复用 Go API 镜像，
通过 entrypoint 分别运行 `/usr/local/bin/go-worker` 与 `/usr/local/bin/go-scheduler`，不额外构建镜像。

## 数据库迁移

`migrate` 服务使用 Go API 镜像里的 `/usr/local/bin/go-migrate up`（Goose），不再运行 Alembic。
Alembic 历史已冻结在 revision 285：

- 已有库（`alembic_version = 285`）首次执行时自动 stamp 为 Goose version 1，不重放基线；
- 空库执行 `00001_baseline.sql` + `20261110170000_seed_baseline_data.sql` 建立完整 schema 与基础种子；
- 无 `alembic_version` 且 public schema 非空时拒绝执行，避免误覆盖未知库；
- 迁移只向前，生产回滚不自动回滚 DB；迁移必须保持向后兼容。
- **首次切换前置条件**：若库仍是 Alembic，先运行一次 `bash deploy/prepare-goose-cutover.sh`（用 API 镜像将库升到冻结 head 285）；全新库无需执行。随后正常部署，`go-migrate up` 会 stamp 并运行后续 Goose 迁移。

本机验证命令见 `docs/REFERENCE.md` §数据库与迁移；发布前由 `git deploy` / CI 运行
`cd backend-go && go run ./cmd/checkmigrations`。

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
# web.env：默认直连 FastAPI；显式启用 Go 切流时才改成 http://127.0.0.1:8200
BACKEND_INTERNAL_URL=http://127.0.0.1:8100
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
# 默认空 = 网关只做透明代理（全部回退 FastAPI）。切流是显式 opt-in：
# 设置后必须让 Web 走 8200，并通过部署后的 owned-route 冒烟检查。
GO_API_OWNED=
# 意向客户工作台（crm_intent）需显式加入，例如：health,exchange_rates,notifications,alerts,profile,crm_intent
GO_API_TRUSTED_PROXY_SECRET=<same 64-character hex secret>
```

以下地址必须继续使用公开 URL：

- `NEXTAUTH_URL` / `AUTH_URL`：浏览器认证回调与 Cookie origin。
- `BACKEND_PUBLIC_API_BASE_URL`：前端展示及 Agent 调用说明；`dash-api` 的 Caddy upstream 当前指向 FastAPI `8100`（Go Gateway `8200` 只在 Web 启用切流时被使用）。
- `FRONTEND_URL`：CORS 与邮件中的可点击链接。
- R2、Resend、联网搜索等外部服务地址。

## 本地发布与 GitHub Actions 部署

配置：

```text
~/.config/believeboy-dashboard/deploy.env
```

发布：

```bash
git switch main
git pull --ff-only origin main
git deploy
```

`git deploy` 要求在 `main` 上运行，先推送代码，再由本机执行迁移图检查、前端 lint/test，并构建、推送三张 `linux/amd64` 镜像。脚本读取每张镜像的 registry digest，然后通过 GitHub CLI 派发预构建部署模式。GitHub Actions 连接 VPS，复用统一远端部署脚本；本机不再直接 SSH 到 VPS。

本机发现 Git build context 中存在未跟踪且未忽略的文件时，会在构建前终止，避免将不属于发布 SHA 的文件打入镜像。Actions 与 SSH 两种发布方式都固定使用上表中的三个 GHCR 仓库。

本机脚本会输出每张镜像及三张镜像合计的构建/推送耗时。本地无法访问 `proxy.golang.org` 时，可在 `deploy.env` 设置 `GO_MODULE_PROXY=https://goproxy.cn,direct`。预构建模式会复用本机刚推送的 digest，不在 GitHub runner 上重复构建镜像。

GitHub Actions 预构建模式继续以 VPS 当前 `web.env` 为 Web 运行配置来源，并通过 GitHub Secret 更新 Go 代理密钥。需要同步本机 `.env.local` 中的运行期配置时，使用显式本机 SSH 应急路径：

```bash
DEPLOY_METHOD=ssh git deploy
```

本机 SSH 路径需要 `deploy.env` 中的 `DEPLOY_HOST` 和 `GO_API_TRUSTED_PROXY_SECRET`，会按本机 frontend env 生成 Web/Go 运行配置并上传到 VPS。

手动运行 Actions 时，不传预构建输入会执行完整构建备用流程；预构建模式由 `git deploy` 自动传入 SHA 与三个 digest。只推代码仍使用：

```bash
PUSH_ONLY=1 git deploy
gh workflow run deploy-dashboard.yml --ref main
gh run list --workflow deploy-dashboard.yml --limit 3
```

Actions 和 SSH 调用端只创建部署根目录与唯一暂存目录、上传本次部署文件；所有 VPS 活动状态修改都由持有 `.deploy.lock` 的远端脚本完成。锁内流程包含 legacy 环境 bootstrap、目录初始化、镜像拉取与 revision 校验、旧写入方停机、legacy 数据复制与权限调整、migration、健康检查、回滚和清理。legacy storage/celerybeat 只在旧服务停止后复制，避免把仍在写入的不一致快照切到新运行目录。Actions 的 `always()` 暂存清理也会先取得同一把锁；远端事务仍在运行时延后清理，由远端退出逻辑或下一次部署回收。

**部署冻结（2026-11-10 起）**：仓库变量 `DEPLOYMENTS_ENABLED` 不为 `true` 时，`deploy-dashboard.yml` 和 `deploy/deploy-local.sh` 都会立即失败退出。Go 后端全量迁移完成前不要解除冻结，只在本地 Docker 验证；重新启用时在仓库 Settings → Variables 设置 `DEPLOYMENTS_ENABLED=true`。

每次远端部署会先仅回收三个 Dashboard GHCR 仓库中未被容器或当前镜像清单引用的镜像，再读取部署分区总容量与可用空间。空间门槛是可配置的**绝对下限**（原版固定 10% 在 15 GB VPS 上、两套镜像共存时不可达）：`DEPLOY_FREE_SPACE_MIN_BYTES`（默认 1 GiB）与 `DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES`（默认 512 MiB，目标镜像拉取后）；可选 `DEPLOY_FREE_SPACE_PERCENT`（默认 0 表示关闭）。需要复制 legacy 数据时，仍会按“估算已分配空间 + 10% + 512 MiB 缓冲”预检；目标镜像拉取后、停机复制前会再次执行精确检查。空间不足时在运行 migration 前中止；数据复制预检不通过时不会停止旧服务。日志记录源码 SHA、三个镜像 digest、分区总容量、各项门槛、可用空间、清理的镜像引用数量以及各阶段的 Docker 镜像占用。

成功部署后只回收没有容器引用的旧 Dashboard 镜像。失败后若应用回滚成功，会恢复 `.storage-migrated` / `.celerybeat-migrated` 的部署前状态，使旧写入方恢复后产生的新数据能在下一次部署重新复制；同时重启部署前处于运行状态的旧 systemd 服务和旧单体容器。回滚会清理未被恢复中的容器或当前镜像清单引用的失败目标镜像；若回滚失败，则保留回滚副本和可用镜像供人工恢复。自动回滚失败时会先停止失败的 Compose 写入服务，再尝试恢复部署前活动的 legacy 写入方，避免新 API/Celery/beat 与旧写入方并行。数据库 migration 不会自动回滚；迁移后的应用回滚使用 `--no-deps` 只启动 API、Go API、Celery、beat 和 Web，跳过 `migrate`，避免旧迁移 runner 不识别数据库中的新版本。新版本健康后会禁用旧 systemd 单元并逐个确认已 disabled；若仍有单元 enabled，部署以失败结束，并保留 rollback 副本和旧镜像供人工处理。其他应用镜像、Docker volumes、上传目录和数据库文件都不会被自动删除。不要在自动部署中使用全局 `docker image prune -a` 或 `docker system prune`。

远端环境文件通过权限受限的唯一暂存目录传输。部署成功或回滚结束后清除暂存密钥和回滚副本；若 SSH 中断导致 VPS 暂不可达，下一次部署会清理超过 24 小时的残留暂存目录。活动 `backend.env`、`web.env`、`go.env`、`backend-storage` 和 `celerybeat` 保留。

Go Gateway 首次健康后，再把 VPS Caddy 的 `dash-api` upstream 改为 `127.0.0.1:8200` 并 reload。

Actions 仍复用 Secrets：`VPS_SSH_KEY`、`VPS_KNOWN_HOSTS`、`VPS_HOST`、
`NEXTAUTH_SECRET`、`GO_API_TRUSTED_PROXY_SECRET`、`GHCR_TOKEN`。`GO_API_TRUSTED_PROXY_SECRET`
用 `openssl rand -hex 32` 生成；完整构建模式使用的 `GHCR_TOKEN` 需具备 `write:packages`，
因为已有 GHCR package 最初由本机 PAT 创建，Actions 自带的 `GITHUB_TOKEN` 没有该 package 的读权限。
公网 Web/API 检查在远端部署事务清理回滚点前执行，失败会触发同一镜像组回滚。

## 检查

```bash
curl -fsS https://dash.believeboy.com/healthz
curl -fsS https://dash-api.believeboy.com/api/v1/health/ready

ssh guitar-vps '
  cd /opt/believeboy-dashboard
  docker compose ps
  docker compose logs --tail=100 api go-api go-worker go-scheduler web celery celery-scheduled beat
  # DB 感知探活：503/degraded 说明数据库不可达（/health/live 不查库，不能作为门禁）
  curl -fsS http://127.0.0.1:8100/api/v1/health/ready
  curl -fsS http://127.0.0.1:8200/api/v1/health/ready
'
```

预期：

- `api`、`go-api`、`web` 为 healthy（api/go-api 的 healthcheck 已改为 DB 感知的 `/health/ready`）。
- `go-api` 读取 `backend.env` 中的 `DATABASE_URL`、`REDIS_HOST`、`REDIS_PORT`、`REDIS_DB`、Redis 凭据和 `API_KEY`，并把未接管路由转发至 `8100`。
- `go-worker` 消费 Go 任务队列（alerts / CRM / 月度报表等）；`go-scheduler` 注册 11 条静态 job + insight 同步 + 定时报表分钟扫描。两者与 `go-api` 使用同一个 `GO_API_IMAGE` 和 `backend.env` / `go.env`，无独立 HTTP 健康检查，用 `docker compose ps` 确认 Running。
- 启用 `GO_API_OWNED` 时，部署脚本会用 `API_KEY` + `GO_API_TRUSTED_PROXY_SECRET` 冒烟 `/api/v1/health` 与 `/api/v1/exchange-rates`，不通过直接回滚。
- 两个 Celery worker 响应 `celery inspect ping`。
- `beat` 持续运行。
- `5432`、`6379`、`8100`、`8200`、`3200` 只监听宿主机回环；Caddy 的 API upstream 当前指向 `8100`（FastAPI），Go Gateway `8200` 仅由 Web 在启用切流时使用。

## 本地 Docker 验证（部署冻结期）

不触达 VPS、不推 GHCR；只在本机构建并验证 Go API runtime：

```bash
bash deploy/validate-local-go-api.sh
```

默认（`binary` 模式，离线可用）：① 本机交叉编译 linux gateway 二进制（含 `time/tzdata`）；② 选一个**本地已有、且没有 `/usr/share/zoneinfo`** 的镜像（优先 `believeboy-go-api:local*`）作为基座运行它，证明时区数据来自二进制内嵌而不是宿主机；③ 连本机 `BLF_test`，带 `API_KEY` + `GO_API_TRUSTED_PROXY_SECRET` 请求 `/api/v1/health`（要求 `database: ok`）和 `/api/v1/exchange-rates`（要求 200）。

需要验证完整 Dockerfile（含 apk tzdata）时：

```bash
GO_API_VALIDATE_MODE=image bash deploy/validate-local-go-api.sh
```

该模式需要能访问 Docker Hub；本机 2026-11-10 出现过 `auth.docker.io` 元数据超时，因此默认用离线 binary 模式。

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
