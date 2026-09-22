# 部署方案：基于 Coolify（自托管 PaaS）+ Cloudflare Tunnel

> 文档版本：2026-06-20
> 适用项目：`believeboyDashboard`（Next.js 16 前端 + FastAPI 后端 + Celery worker + PostgreSQL + Redis）
> 部署目标：单 VPS（Ubuntu 26.04 / 20C / 32G）

## 1. 概述 & 架构图

```
                              互联网用户
                                  │
                                  │ HTTPS
                                  ▼
                       ┌──────────────────────┐
                       │  Cloudflare 边缘       │
                       │  - 静态资源 CDN       │
                       │  - DDoS 防护          │
                       │  - WAF               │
                       └───────────┬───────────┘
                                   │ 出站 tunnel
                                   │ (cloudflared 主动连接)
                                   ▼
   ╔════════════════════════════════════════════════════════════╗
   ║  单 VPS（Ubuntu 26.04 / 20C / 32G）                        ║
   ║                                                            ║
   ║  ┌──────────────────────────────────────────────────────┐  ║
   ║  │ cloudflared（systemd，dashboard.believeboy.com 隧道）│  ║
   ║  └──────────────────────┬───────────────────────────────┘  ║
   ║                         │                                  ║
   ║  ┌──────────────────────▼───────────────────────────────┐  ║
   ║  │ Coolify（Traefik 反代 + Dashboard UI，:8000）         │  ║
   ║  └──────────────────────┬───────────────────────────────┘  ║
   ║                         │ manages                          ║
   ║  ┌──────────────────────▼───────────────────────────────┐  ║
   ║  │ Docker network: believeboy_net（bridge）             │  ║
   ║  │                                                      │  ║
   ║  │  ┌──────────────────┐  ┌──────────────────────────┐  │  ║
   ║  │  │ frontend         │  │ backend                  │  │  ║
   ║  │  │ Next.js 16       │──▶ FastAPI 0.115            │  │  ║
   ║  │  │ :3200            │  │ Uvicorn :8100            │  │  ║
   ║  │  │ Nixpacks build   │  │ Dockerfile build         │  │  ║
   ║  │  └──────────────────┘  └──────┬───────────────────┘  │  ║
   ║  │                               │                      │  ║
    ║  │  ┌──────────────────┐  ┌──────▼──────────┐ │  ║
    ║  │  │ celery-worker    │  │ celery-beat     │ │  ║
    ║  │  │ -Q default,      │  │ APScheduler     │ │  ║
    ║  │  │   reports,       │  │ (可选)          │ │  ║
    ║  │  │   insights       │                   │  ║
   ║  │  └────────┬─────────┘                                 │  ║
   ║  │           │                                           │  ║
   ║  │  ┌────────▼─────────┐  ┌──────────────────────────┐   │  ║
   ║  │  │ postgres         │  │ redis                    │   │  ║
   ║  │  │ 16.x（最新 LTS） │  │ 7.x                      │   │  ║
   ║  │  │ :5432            │  │ :6379                    │   │  ║
   ║  │  └──────────────────┘  └──────────────────────────┘   │  ║
   ║  │                                                      │  ║
   ║  │  全部走 believeboy_net 内网通信                      │  ║
   ║  │  5432/6379/8100 端口**不**对外暴露                   │  ║
   ║  └──────────────────────────────────────────────────────┘  ║
   ║                                                            ║
   ║  ┌──────────────────────────────────────────────────────┐  ║
   ║  │ systemd fallback: believeboy-api.service             │  ║
   ║  │ （Coolify 故障时手动启用的应急服务，监听 127.0.0.1） │  ║
   ║  └──────────────────────────────────────────────────────┘  ║
   ╚════════════════════════════════════════════════════════════╝
```

**关键设计原则**：
- ✅ **单 VPS 全栈**——frontend/backend/worker/postgres/redis 全部在同一台，**内网（Docker bridge）通信**
- ✅ **零端口暴露**——VPS 上 80/443/5432/6379 全部不开放公网，**只让 cloudflared 出站连 Cloudflare 边缘**
- ✅ **唯一公网入口**——`https://dashboard.believeboy.com` 经 Cloudflare → cloudflared → Traefik → frontend:3200
- ✅ **后端通过前端 `/api/backend/*` 反代**——前端内部反代到 `backend:8100`（已存在的 `app/api/backend/[...path]/route.ts` 路径）
- ✅ **应急冷启动**——保留现有 `backend/deploy/systemd/believeboy-api.service` 作为故障兜底

## 2. 前置条件

### 2.1 VPS 现状确认

| 项 | 要求 |
|---|---|
| 系统 | **Ubuntu 26.04**（已确认） |
| CPU | 20 核（充裕——足够 5 个容器 + Coolify 本身 + 备用 worker 进程） |
| 内存 | 32 GB（充裕——分配参考见 §3.2） |
| 磁盘 | ≥ 100 GB（Postgres + 备份 + Docker images） |
| 用户 | `damon`（已有 sudo NOPASSWD 权限，能跑 `systemctl`） |
| 网络 | 能出站 `github.com`、`registry.npmjs.org`、`pypi.org`、`docker.io`、`api.cloudflare.com` |

### 2.2 域名 & Cloudflare

- **域名**：`believeboy.com`（假设已在 Cloudflare 上管理——Tunnel 需要走 Cloudflare Dashboard 创建）
- **前端域名**：`dashboard.believeboy.com`（生产）/ `pr-<N>.preview.believeboy.com`（PR Preview）
- **不需要**独立 API 域名——前端通过 `/api/backend/*` 同源反代到 backend
- **Tunnel 路由**：CF Dashboard → Zero Trust → Networks → Tunnels → 创建 tunnel → 路由 `dashboard.believeboy.com` → `http://coolify-traefik:80`

### 2.3 GitHub & 仓库

- 仓库：`git@github.com:passwii/believeboyDashboard.git`（已 SSH 配权）
- 分支：`main`（生产） + PR（预览）
- **Coolify 部署方式**：自身接 GitHub webhook（无需额外 GitHub Actions）

### 2.4 Redis 决策

- **保留 Redis**——20 核 32G 配置做高性能缓存有意义；Celery worker 本来就配了 Redis broker
- 版本：**Redis 7.x**（比 6.x 性能更好，ACL 更完善）

## 3. 安装 Coolify

### 3.1 在 VPS 上装 Docker（如果还没有）

```bash
# 装 Docker CE + Compose plugin（Ubuntu 26.04）
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 当前用户加进 docker 组（避免每次 sudo）
sudo usermod -aG docker $USER
newgrp docker

# 验证
docker --version
docker compose version
```

### 3.2 资源规划（32G 内存分配建议）

| 服务 | CPU limit | Memory limit | Reserved | 备注 |
|---|---|---|---|---|
| Coolify（Traefik + UI） | 2 | 2 GB | 512 MB | 轻量 |
| postgres | 4 | 8 GB | 2 GB | shared_buffers 配 2 GB |
| redis | 2 | 4 GB | 256 MB | maxmemory 2-3 GB |
| backend（uvicorn） | 4 | 4 GB | 1 GB | workers=4 |
| celery-worker | 4 | 4 GB | 1 GB | concurrency=8 |
| frontend（next start） | 2 | 2 GB | 512 MB | 多副本可加 |
| **小计 reserved** | | | **~5.5 GB** | |
| **OS + 缓冲** | | | **~3 GB** | |
| **剩余可分配** | | | **~23 GB** | 给 pg/redis 缓存余量 |

### 3.3 一行命令装 Coolify

```bash
# Coolify 官方安装脚本（v4.x）
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

# 装完会自动启动，访问 http://<VPS_IP>:8000
# 第一次访问会要求设置管理员账号
```

> ⚠️ **重要**：装完先**把 Coolify 自身的 8000 端口设为只监听 127.0.0.1**（避免暴露公网，靠 cloudflared tunnel 出去）。Coolify v4 默认会绑 `0.0.0.0`，需要改 `/data/coolify/source/.env` 里的 `APP_URL` 和端口绑定：

```bash
sudo vim /data/coolify/source/.env
# 把 APP_URL 改成 https://coolify.believeboy.com
# 然后重启 Coolify
sudo systemctl restart coolify
```

更简单的做法：**不暴露 Coolify 自身 8000 端口**到公网，只在 `127.0.0.1` 上跑，靠 Cloudflare Tunnel 转发：

```bash
sudo vim /etc/systemd/system/coolify.service
# ExecStart 行加 -H 127.0.0.1:8000
sudo systemctl daemon-reload
sudo systemctl restart coolify
```

**实际推荐**：先不急着改，等 §11 配好 cloudflared tunnel 后再决定是否把 Coolify 也通过 tunnel 暴露（给运维一个独立入口）。

### 3.4 验证 Coolify 安装

```bash
# 看 Coolify 容器
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# 应该看到 coolify, coolify-traefik, coolify-redis 等
# 健康检查
curl -s http://127.0.0.1:8000/api/health
# 期望: {"status":"ok"}
```

## 4. 在 Coolify 上部署 PostgreSQL

### 4.1 创建数据库服务

在 Coolify Dashboard → **New Resource** → **Database** → **PostgreSQL**：

| 字段 | 值 |
|---|---|
| Name | `believeboy-postgres` |
| Image | `postgres:16-alpine`（最新 LTS） |
| Database Name | `believeboy` |
| Username | `believeboy` |
| Password | **生成 32 字符随机串**（用 `openssl rand -base64 32`） |
| Persistent Storage | ✅ 启用，20 GB 起步 |
| Resource Limits | CPU 4 / Memory 8 GB（见 §3.2） |
| Internal Port | 5432（**不要**勾 "Expose as public"） |
| Health Check | `pg_isready -U believeboy` |

### 4.2 验证 Postgres

Coolify Dashboard → 容器详情 → **Terminal**：

```bash
psql -U believeboy -d believeboy -c '\dt'
# 期望: No relations found.（还没建表）
psql -U believeboy -d believeboy -c 'SELECT version();'
# 期望: PostgreSQL 16.x ...
```

### 4.3 提前初始化（可选）

如果你想先把现有的 PG 数据迁移过来，先**确认旧 backend `DATABASE_URL`**，用 `pg_dump` 导出现有数据：

```bash
# 在旧 backend 运行的机器上
pg_dump "$OLD_DATABASE_URL" --no-owner --no-acl -Fc -f backup.dump

# 把 backup.dump 传到新 VPS
scp backup.dump root@145.79.143.98:/tmp/

# 在新 Coolify postgres 容器里恢复
docker exec -i $(docker ps -q -f name=believeboy-postgres) \
  pg_restore -U believeboy -d believeboy --no-owner --no-acl < /tmp/backup.dump

# 然后跑 alembic 迁移确保 schema 最新
# （backend 容器跑起来后通过 alembic upgrade head）
```

## 5. 在 Coolify 上部署 Redis

### 5.1 创建 Redis 服务

Coolify Dashboard → **New Resource** → **Database** → **Redis**：

| 字段 | 值 |
|---|---|
| Name | `believeboy-redis` |
| Image | `redis:7-alpine` |
| Password | **生成 32 字符随机串** |
| Persistent Storage | ✅ 启用，10 GB 起步 |
| Resource Limits | CPU 2 / Memory 4 GB（见 §3.2） |
| Internal Port | 6379（**不要**勾 "Expose as public"） |

### 5.2 配置 Redis 参数

Coolify Dashboard → `believeboy-redis` → **Configuration** → 加 `REDIS_ARGS`:

```
--maxmemory 2gb --maxmemory-policy allkeys-lru --save "" --appendonly no
```

- `--maxmemory 2gb`：限制到 2 GB，超出按 LRU 淘汰
- `--maxmemory-policy allkeys-lru`：缓存友好
- `--save ""`：关掉 RDB 快照（纯缓存用）
- `--appendonly no`：关掉 AOF（纯缓存用，省 IO）

### 5.3 验证 Redis

```bash
docker exec -it $(docker ps -q -f name=believeboy-redis) \
  redis-cli -a "$REDIS_PASSWORD" ping
# 期望: PONG
```

## 6. 在 Coolify 上部署后端（FastAPI）

### 6.1 创建后端应用

Coolify Dashboard → **New Resource** → **Application**：

#### 6.1.1 基础信息

| 字段 | 值 |
|---|---|
| Name | `believeboy-api` |
| Build Pack | `Dockerfile`（我们要自定义） |
| Git Repository | `git@github.com:passwii/believeboyDashboard` |
| Branch | `main` |
| Base Directory | `/backend`（monorepo 子目录） |

#### 6.1.2 Dockerfile

在 `backend/Dockerfile`（新建）：

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 系统依赖（psycopg[binary] 已自带 libpq，其他可选）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY requirements.txt .
RUN pip install -r requirements.txt

# 应用代码
COPY . .

# 非 root 用户运行
RUN useradd -m -u 1000 app && chown -R app:app /app
USER app

EXPOSE 8100

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8100/api/v1/health || exit 1

# 启动
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--no-access-log", "--workers", "4"]
```

#### 6.1.3 端口

- Internal Port: **8100**
- ⚠️ **不要**勾 "Expose as public"——只内网

#### 6.1.4 环境变量

| 变量 | 值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://believeboy:<PG_PWD>@believeboy-postgres:5432/believeboy` | 内网 |
| `REDIS_URL` | `redis://:<REDIS_PWD>@believeboy-redis:6379/0` | 内网 |
| `API_KEY` | 从 Coolify Secrets 注入 | |
| `NEXTAUTH_SECRET` | 已存在的值（保持一致） | |
| `BACKEND_API_KEY` | 已存在的值（保持一致） | |
| `AI_CHAT_PROVIDER_BASE_URL` | 已存在的值 | |
| `AI_CHAT_PROVIDER_API_KEY` | Coolify Secrets 注入 | |
| `AI_CHAT_DEFAULT_MODEL` | 已存在的值 | |
| `CELERY_BROKER_URL` | `redis://:<REDIS_PWD>@believeboy-redis:6379/1` | |
| `CELERY_RESULT_BACKEND` | `redis://:<REDIS_PWD>@believeboy-redis:6379/2` | |
| `ENVIRONMENT` | `production` | |
| `LOG_LEVEL` | `info` | |

**重要**：把 `DATABASE_URL` / `REDIS_URL` 里的 hostname 改成 Docker 网络里的服务名（`believeboy-postgres`、`believeboy-redis`），不要用 `localhost` 或 `127.0.0.1`（容器内的 localhost 是容器自己）。

#### 6.1.5 资源限制

| 字段 | 值 |
|---|---|
| CPU Limit | 4 |
| Memory Limit | 4 GB |
| Memory Reservation | 1 GB |

#### 6.1.6 Persistent Storage（可选）

如果 backend 要写本地文件（比如上传到 `bucket.believeboy.com` 的临时文件），挂一个卷：

```
Source: /data/believeboy-uploads
Destination: /app/uploads
```

否则不挂卷——backend 是 stateless 的。

### 6.2 验证后端

Coolify Dashboard → `believeboy-api` → **Terminal**：

```bash
curl -s http://127.0.0.1:8100/api/v1/health
# 期望: {"status":"ok",...}

# 跑 alembic 迁移（首次部署）
alembic upgrade head

# 验证数据库连通
python -c "from app.db.session import engine; print(engine.connect())"
```

## 7. 在 Coolify 上部署 Celery Worker

### 7.1 Celery Worker

Coolify Dashboard → **New Resource** → **Application** → 同 backend 一样的 Git/Base Dir/Build。

环境变量和后端**完全相同**（共享同一个数据库和 Redis）。

启动命令覆盖：

```
celery -A app.tasks.celery_app worker \
  -Q default,reports,insights \
  -c 8 \
  -l info
```

资源限制：CPU 4 / Memory 4 GB / Reservation 1 GB。


## 8. 在 Coolify 上部署前端（Next.js）

### 8.1 创建前端应用

Coolify Dashboard → **New Resource** → **Application**：

| 字段 | 值 |
|---|---|
| Name | `believeboy-frontend` |
| Build Pack | **Nixpacks**（自动检测 Node.js + pnpm） |
| Git Repository | `git@github.com:passwii/believeboyDashboard` |
| Branch | `main` |
| Base Directory | `/frontend` |

### 8.2 Nixpacks 配置

Coolify Dashboard → `believeboy-frontend` → **Build**：

| 字段 | 值 |
|---|---|
| Build Command | `pnpm gen:api-types:check && pnpm build` |
| Start Command | `pnpm start` |
| Install Command | `pnpm install --frozen-lockfile` |

### 8.3 端口

- Internal Port: **3000**
- Expose as Public: **✅**（让 Traefik 监听，cloudflared tunnel 到这个 Traefik）

### 8.4 域名 & HTTPS

Coolify Dashboard → `believeboy-frontend` → **Domains**：

| 字段 | 值 |
|---|---|
| Domain | `dashboard.believeboy.com` |
| HTTPS | ✅ 自动（Coolify 用 Let's Encrypt） |

> **重要**：Coolify 默认会用 Let's Encrypt 直接签证书，**但因为我们走 cloudflared tunnel，CF 会终止 TLS**，所以前端应用层不需要证书。Coolify 这边可以让 Traefik 监听 80（HTTP），TLS 在 CF 边缘终止。
>
> 或者：让 Coolify/Traefik 也申请证书（双层 TLS，由 CF 边缘 → CF origin cert → Traefik），更稳。
> **推荐方案**：在 CF Dashboard → SSL/TLS → Origin Server 创建 Origin Certificate，下载 `cert.pem` + `key.pem`，粘贴到 Coolify 的 Custom Certificate。

### 8.5 环境变量

| 变量 | 值 |
|---|---|
| `BACKEND_API_BASE_URL` | `http://believeboy-api:8100`（**内网** Docker 网络） |
| `BACKEND_API_KEY` | 同 backend |
| `NEXTAUTH_URL` | `https://dashboard.believeboy.com` |
| `NEXTAUTH_SECRET` | 同 backend |
| `NEXT_PUBLIC_API_BASE_URL` | `https://dashboard.believeboy.com/api/backend`（**同源**，CF 终止 TLS 后走 Traefik 回到 :3200，然后前端反代到 backend:8100） |
| `NEXT_PUBLIC_BACKEND_API_BASE_URL` | 同上 |

### 8.6 资源限制

| 字段 | 值 |
|---|---|
| CPU Limit | 2 |
| Memory Limit | 2 GB |
| Memory Reservation | 512 MB |

### 8.7 PR Preview（可选但推荐）

Coolify Dashboard → `believeboy-frontend` → **Preview Deployments** → 启用。

每个 PR 推上来会自动建一个临时部署，URL 形如 `pr-123.preview.believeboy.com`（或 Coolify 随机域名）。

DNS 配置：CF Dashboard → `*.preview.believeboy.com` CNAME 到 tunnel。

## 9. 内网通信总览

部署完后，在 Coolify 上**所有应用勾选 "Connect to pre-defined network: believeboy_net"**，让它们都在同一个 Docker network 里。

```
docker network ls
# NETWORK ID     NAME              DRIVER    SCOPE
# abc123...      believeboy_net    bridge    local
# def456...      coolify-infra     ...       ...
```

Coolify v4 默认会把所有资源放进一个叫 `coolify-infra` 的网络，但我们推荐**显式创建**一个 `believeboy_net`：

```bash
docker network create believeboy_net
# 然后在每个 Application 的 Configuration 里加
# Networks: believeboy_net (追加到默认)
```

**通信路径**（以"前端用户发起一次 API 调用"为例）：

```
浏览器
  │ GET https://dashboard.believeboy.com/api/backend/api/v1/projects
  ▼
Cloudflare 边缘（终止 TLS）
  │ 出站 tunnel
  ▼
cloudflared（VPS 上的 systemd 服务）
  │ 转发到 coolify-traefik:80
  ▼
Traefik（Coolify 的反代）
  │ 路由匹配 dashboard.believeboy.com → frontend:3200
  ▼
frontend（Next.js :3200）
  │ /api/backend/* 路径匹配 app/api/backend/[...path]/route.ts
  │ 它内部用 BACKEND_API_BASE_URL=http://believeboy-api:8100
  ▼
backend（FastAPI :8100）
  │ 查询数据库
  ▼
postgres（:5432）
  │ 走内网返回
  ▼
原路返回
```

**所有内网通信**：HTTP（不加 TLS），因为都是同一台机器的容器之间。

**VPS 上 5432/6379/8100 都不监听 `0.0.0.0`**——只监听 Docker bridge。

## 10. GitHub Webhook 集成

### 10.1 Coolify 配置

Coolify Dashboard → `believeboy-frontend` → **Webhooks**：

- Coolify 会生成一个 webhook URL，格式：`https://<coolify-host>/api/v1/deploy?uuid=<resource-uuid>&force=false`
- 把这个 URL 复制到 GitHub 仓库的 webhook 配置

### 10.2 GitHub 配置

GitHub 仓库 `passwii/believeboyDashboard` → **Settings** → **Webhooks** → **Add webhook**：

| 字段 | 值 |
|---|---|
| Payload URL | 上面的 Coolify URL |
| Content type | `application/json` |
| SSL verification | ✅ |
| Events | **Just the push event** |
| Active | ✅ |

对 `believeboy-api`、`celery-worker` 重复上面步骤（每个 Coolify resource 独立 webhook）。

### 10.3 验证

```bash
git commit --allow-empty -m "test webhook"
git push origin main
# 去 GitHub Settings → Webhooks → Recent Deliveries 应该看到 200 OK
# 去 Coolify Dashboard → Deployments 应该看到新的部署
```

## 11. Cloudflare Tunnel 配置

### 11.1 在 CF Dashboard 创建 Tunnel

1. 登录 Cloudflare Dashboard → **Zero Trust** → **Networks** → **Tunnels**
2. **Create a tunnel** → 选 **Cloudflared**
3. 命名：`believeboy-tunnel`
4. 保存 token（形如 `eyJhIjoixxxxx...`）

### 11.2 在 VPS 上装 cloudflared

```bash
# Debian/Ubuntu 装 cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared focal main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# 用 token 安装为 systemd 服务
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared

# 验证
sudo systemctl status cloudflared
```

### 11.3 配置路由

回到 CF Dashboard → Tunnel → **Public Hostname**：

| 字段 | 值 |
|---|---|
| Subdomain | `dashboard` |
| Domain | `believeboy.com` |
| Service Type | `HTTP` |
| URL | `coolify-traefik:80`（Traefik 在 `coolify-infra` 网络里的服务名） |

> **为什么是 `coolify-traefik:80` 而不是 `frontend:3200`？**
> 因为 Traefik 负责基于 Host header 路由（dashboard.believeboy.com → frontend），让 Traefik 来分流比 cloudflared 直连 frontend 更灵活（以后加其他子域名都走 Traefik）。

> **如何让 cloudflared 能解析 `coolify-traefik`？**
> cloudflared 在 VPS 上跑，能访问 `127.0.0.1`，所以可以写：
> `URL: http://127.0.0.1:80`（Traefik 监听 VPS 的 80）
> 或者：cloudflared 实际上要通过 Docker 网络名访问，需要 Traefik 把 80 端口也暴露到 host。
> **推荐**：让 Coolify 的 Traefik bind `0.0.0.0:80` 和 `0.0.0.0:443`（VPS 上的 localhost），cloudflared 访问 `127.0.0.1:80`。**这样 80 端口只有 VPS 自己访问，公网是 cloudflared 入口**。

### 11.4 PR Preview 域名

每个 PR 一个子域名：CF Dashboard → Tunnel → Public Hostname → 新增：

| 字段 | 值 |
|---|---|
| Subdomain | `*.preview` |
| Domain | `believeboy.com` |
| Service Type | `HTTP` |
| URL | `127.0.0.1:80`（同样走 Traefik，由 Coolify 的 Preview Deployments 自动创建 Host 路由） |

或者更简单：让 Coolify 的 Preview Deployment 自动在 Traefik 加路由（Coolify v4 默认就这么干），cloudflared 这边只需要 `*.preview.believeboy.com → 127.0.0.1:80` 的通配路由。

### 11.5 验证 Tunnel

```bash
# 从外部测试
curl -sI https://dashboard.believeboy.com
# 期望: HTTP/2 200, server: cloudflare

# 在 VPS 上看 cloudflared 日志
sudo journalctl -u cloudflared -f
# 应该看到连到 coolify-traefik:80 的请求
```

## 12. HTTPS / DNS

### 12.1 TLS 终止位置

```
浏览器 ── HTTPS ──▶ Cloudflare 边缘
                  │
                  └── CF Origin cert（如果你选择双层 TLS）
                       │
                       ▼
                  Traefik（监听 80 或 443）
                       │
                       ▼
                  frontend:3200
```

**两种模式**：

| 模式 | 优点 | 缺点 |
|---|---|---|
| **A. 单层 TLS（CF 终止）** | 配置简单，证书只 CF 管 | VPS 上 frontend 收到 HTTP 明文 |
| **B. 双层 TLS（CF + Traefik）** | 端到端加密 | 需要 CF Origin cert + 在 Traefik 配置 |

**推荐 B**：和现有 backend `proxy.ts` 里的 `BACKEND_FAILURE_*` 熔断器一致（HTTPS 链路没变）。

### 12.2 DNS 配置

- `dashboard.believeboy.com` —— 不需要在 CF 写 A 记录；Tunnel 自动处理
- `*.preview.believeboy.com` —— 同上

## 13. 备份策略

### 13.1 Postgres 备份

Coolify Dashboard → `believeboy-postgres` → **Backup** → **Schedule Backup**：

| 字段 | 值 |
|---|---|
| Frequency | `0 3 * * *`（每天凌晨 3 点） |
| Keep Last | 7（保留最近 7 份） |
| S3 Endpoint | `s3.amazonaws.com` |
| S3 Bucket | `believeboy-backups-postgres` |
| S3 Access Key | 你的 AWS Access Key |
| S3 Secret Key | Coolify Secrets 注入 |
| S3 Region | `ap-east-1`（香港）或 `ap-southeast-1`（新加坡） |

### 13.2 Redis 备份

Redis 当前是纯缓存（`--save "" --appendonly no`），**不需要备份**。重启丢失可重建。

如果将来 Redis 存了重要数据（如 session），再加 AOF：

```
--appendonly yes --appendfsync everysec
```

### 13.3 上传文件备份

`backend/uploads/`（如果有）通过 Coolify 的 Volume Backup 配置同样定时备份。

## 14. 监控 + 告警

### 14.1 Coolify 自带

Coolify Dashboard → 各个资源页面都自带 CPU / Memory / Network 实时图。

### 14.2 外部 Uptime 监控

- **UptimeRobot**（免费）：监控 `https://dashboard.believeboy.com` 和 `/api/v1/health`
- 配置 5 分钟一次的 HEAD 请求
- 失败时发邮件 / Slack

### 14.3 报警（Slack / Discord / Email）

**Coolify v4 限制**：自带的通知比较弱（webhook only）。

**升级路径**：在 Coolify 之外，加一个简单的 monitoring 脚本（比如 `monitor.py`）通过 cron 跑：

```python
# /usr/local/bin/believeboy-monitor.py
import requests
import sys

checks = [
    ("https://dashboard.believeboy.com", "Frontend"),
    ("http://127.0.0.1:8100/api/v1/health", "Backend"),
]

failed = []
for url, name in checks:
    try:
        r = requests.get(url, timeout=5)
        if r.status_code >= 400:
            failed.append(f"{name} ({r.status_code})")
    except Exception as e:
        failed.append(f"{name} ({e})")

if failed:
    requests.post("https://hooks.slack.com/services/...", json={
        "text": f"🚨 BelieveBoy alerts:\n" + "\n".join(failed)
    })
    sys.exit(1)
```

```bash
# crontab -e
*/5 * * * * /usr/bin/python3 /usr/local/bin/believeboy-monitor.py
```

## 15. 回滚预案

### 15.1 应用层回滚

Coolify Dashboard → Application → **Deployments** → 选历史成功部署 → **Redeploy**。

### 15.2 数据库回滚

如果 migration 升级坏了，Coolify 没有自动回滚，需要手动：

```bash
docker exec -it $(docker ps -q -f name=believeboy-api) alembic downgrade -1
```

### 15.3 整个 stack 回滚（应急）

最坏情况，Coolify 全挂：

```bash
# 启用 systemd fallback（§16）
sudo systemctl start believeboy-api
sudo systemctl enable believeboy-api

# 把前端反代到 backend 的 :8100/api/backend 路由指向 :8100
# 临时改 /etc/nginx/sites-enabled/believeboy-frontend
# 反代 backend:8100 和 frontend:3200

# 或者：临时切换 Cloudflare Tunnel 路由到 :3200 直连 frontend
```

## 16. 与现有 systemd 服务的过渡

### 16.1 保留 systemd fallback

`backend/deploy/systemd/believeboy-api.service` **保留**作为冷启动 fallback，但**默认不启用**：

```bash
# 查看当前状态
sudo systemctl status believeboy-api

# 禁用（Coolify 管的时候）
sudo systemctl disable --now believeboy-api

# 启用（Coolify 挂了的时候）
sudo systemctl enable --now believeboy-api
```

### 16.2 退役 `productEnvAgent/deploy_vps.py`

Coolify 接 webhook 后，**不再需要 SSH 部署脚本**。但是：

- **保留**这个脚本作为"应急部署"——Coolify 挂了的时候用
- 把它的 `DEPLOY_COMMANDS` 改成"如果 Coolify 挂了，启用 systemd + 重建 backend 容器"
- 或者直接禁用，告诉团队"用 Coolify"

### 16.3 切换步骤

1. **D-3 天**：Coolify 部署完整套环境（frontend + backend + worker + postgres + redis），内部测试通过
2. **D-1 天**：配置 Cloudflare Tunnel，绑 `dashboard-staging.believeboy.com`（或别的测试子域名）
3. **D 天**：DNS 切到 Tunnel，监控 1 小时
4. **D+1 天**：确认无问题后，禁用 `believeboy-api.service`
5. **D+7 天**：如果稳定运行，标记 `deploy_vps.py` 为 "fallback only"，加入 README

## 17. 性能对比（vs Vercel）

| 指标 | Vercel free | Coolify + 自建（20C/32G） |
|---|---|---|
| 冷启动 | 500ms~1.5s | **0**（容器常驻） |
| 热请求 SSR | 100~300ms | **30~80ms**（内网 + 同机） |
| 静态资源 TTFB | 50~100ms（CDN） | 30~80ms（同 region）+ 可挂 CDN |
| 后端 API 调用 | 80~150ms（Vercel → VPS RTT） | **5~20ms**（同机 Docker 内网） |
| 每月成本 | $0 | VPS 成本（看 provider，~$30-50/月独立机器，或与现有后端共用就 $0） |
| `/dashboard` LCP | 1554ms（baseline） | **预计 <800ms** |
| perf 分数 | 0.90（baseline） | **预计 >0.97** |

## 18. 常见问题排查

### 18.1 容器启动失败：DB connection refused

`backend` 启动比 `postgres` 快，连接被拒。
**解决**：Coolify → backend → Configuration → **Depends On** → 勾 `believeboy-postgres`。或者在启动命令前加等待：

```bash
CMD ["sh", "-c", "until pg_isready -h believeboy-postgres -p 5432; do sleep 2; done && uvicorn app.main:app --host 0.0.0.0 --port 8100"]
```

### 18.2 cloudflared tunnel 连接失败

```bash
sudo journalctl -u cloudflared -n 100
# 常见错误：
# - "connection refused" → 检查 token 是否正确
# - "DNS resolution failed" → 检查 53 端口是否被 systemd-resolved 占着
# - "tunnel connection error" → 检查 outbound 到 api.cloudflare.com 是否被墙（境内 VPS）
```

### 18.3 前端 build 失败：API type check

`pnpm gen:api-types:check` 需要后端 OpenAPI 文档。**首次部署**时 backend 还没启动，types 文件可能没生成。

**解决**：先单独跑 `pnpm gen:api-types`（不 check）然后 build：

```
Build Command: pnpm gen:api-types && pnpm build
```

后续部署 backend 跑通后，可以改回 `:check`。

### 18.4 PR Preview 数据库怎么办？

Coolify 默认每个 PR 部署**共享同一个 postgres**——这有风险，PR 的迁移可能污染数据库。

**建议**：
- **A. 不在 PR 上跑 alembic**——只部署 frontend + backend（用现有 schema）
- **B. 每个 PR 用临时数据库**——Coolify 支持 "Preview Database" 配置

**推荐 A**——简单。

### 18.5 worker 队列积压

```bash
docker exec -it $(docker ps -q -f name=believeboy-redis) \
  redis-cli -a "$REDIS_PASSWORD" LLEN celery:reports
```

如果积压：
- 加 worker 副本（再开一个 Coolify Application，env 一样，start command 一样）
- 或增加现有 worker 的 `-c` 并发数

## 附录 A：完整的 docker-compose 等价参考

如果想跳过 Coolify Dashboard UI 直接写 compose（高级用户），参考：

```yaml
# docker-compose.yml（参考用，实际部署走 Coolify UI）
name: believeboy

services:
  frontend:
    build:
      context: ./frontend
      dockerfile_inline: |
        FROM node:24-alpine
        RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
        WORKDIR /app
        COPY package.json pnpm-lock.yaml ./
        RUN pnpm install --frozen-lockfile
        COPY . .
        RUN pnpm gen:api-types && pnpm build
        EXPOSE 3000
        CMD ["pnpm", "start"]
    environment:
      BACKEND_API_BASE_URL: http://backend:8100
      NEXTAUTH_URL: https://dashboard.believeboy.com
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      BACKEND_API_KEY: ${BACKEND_API_KEY}
    networks: [believeboy_net]
    depends_on: [backend]

  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql+psycopg://believeboy:${PG_PWD}@postgres:5432/believeboy
      REDIS_URL: redis://:${REDIS_PWD}@redis:6379/0
      CELERY_BROKER_URL: redis://:${REDIS_PWD}@redis:6379/1
      API_KEY: ${API_KEY}
      AI_CHAT_PROVIDER_BASE_URL: ${AI_CHAT_PROVIDER_BASE_URL}
      AI_CHAT_PROVIDER_API_KEY: ${AI_CHAT_PROVIDER_API_KEY}
    networks: [believeboy_net]
    depends_on: [postgres, redis]

  worker:
    build: ./backend
    command: celery -A app.tasks.celery_app worker -Q default,reports,insights -c 8 -l info
    environment:
      DATABASE_URL: postgresql+psycopg://believeboy:${PG_PWD}@postgres:5432/believeboy
      REDIS_URL: redis://:${REDIS_PWD}@redis:6379/0
      CELERY_BROKER_URL: redis://:${REDIS_PWD}@redis:6379/1
    networks: [believeboy_net]
    depends_on: [postgres, redis, backend]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: believeboy
      POSTGRES_PASSWORD: ${PG_PWD}
      POSTGRES_DB: believeboy
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [believeboy_net]

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PWD} --maxmemory 2gb --maxmemory-policy allkeys-lru --save "" --appendonly no
    volumes: [redisdata:/data]
    networks: [believeboy_net]

volumes:
  pgdata:
  redisdata:

networks:
  believeboy_net:
    driver: bridge
```

## 附录 B：Coolify 配置文件导出

Coolify 支持导出所有资源定义为 `docker-compose.yml`，可以存到 `infra/coolify/docker-compose.yml`，作为 IaC 备份。

Dashboard → Project → **Export** → 选所有资源 → 导出。

---

**文档结束**。配套的 Dokploy 方案见 [`dokploy-deployment.md`](./dokploy-deployment.md)。
