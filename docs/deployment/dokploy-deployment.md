# 部署方案：基于 Dokploy（自托管 PaaS）+ Cloudflare Tunnel

> 文档版本：2026-06-20
> 适用项目：`believeboyDashboard`（Next.js 16 前端 + FastAPI 后端 + Celery worker + PostgreSQL + Redis）
> 部署目标：单 VPS（Ubuntu 26.04 / 20C / 32G）

> 📄 **这是和 [Coolify 方案](./coolify-deployment.md) 平行写的方案**。两份文档结构一致，可以二选一。Coolify 生态更成熟（16k Discord / 200k+ instances），Dokploy 更新更现代（MIT 协议、强通知系统、remote server 管理）。读这两份前，先看 §1 的"两个方案的关键差异"决定。

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
                       └───────────┬───────────┘
                                   │ 出站 tunnel
                                   ▼
   ╔════════════════════════════════════════════════════════════╗
   ║  单 VPS（Ubuntu 26.04 / 20C / 32G）                        ║
   ║                                                            ║
   ║  ┌──────────────────────────────────────────────────────┐  ║
   ║  │ cloudflared（systemd，dashboard.believeboy.com 隧道）│  ║
   ║  └──────────────────────┬───────────────────────────────┘  ║
   ║                         │                                  ║
   ║  ┌──────────────────────▼───────────────────────────────┐  ║
   ║  │ Dokploy（Traefik 反代 + Dashboard UI，:3000）         │  ║
   ║  └──────────────────────┬───────────────────────────────┘  ║
   ║                         │ manages                          ║
   ║  ┌──────────────────────▼───────────────────────────────┐  ║
   ║  │ Docker network: dokploy-network（bridge）            │  ║
   ║  │                                                      │  ║
   ║  │  ┌──────────────────┐  ┌──────────────────────────┐  │  ║
   ║  │  │ frontend         │  │ backend                  │  │  ║
   ║  │  │ Next.js 16       │──▶ FastAPI 0.115            │  │  ║
   ║  │  │ :3200            │  │ Uvicorn :8100            │  │  ║
   ║  │  │ Nixpacks build   │  │ Dockerfile build         │  │  ║
   ║  │  └──────────────────┘  └──────┬───────────────────┘  │  ║
   ║  │                               │                      │  ║
   ║  │  ┌──────────────────┐  ┌──────▼──────────┐  ┌──────┐ │  ║
   ║  │  │ celery-worker    │  │ celery-flower   │  │beat  │ │  ║
   ║  │  │ -Q default,      │  │ :5555           │  │(可选)│ │  ║
   ║  │  │   reports,       │  │ 监控 UI         │  └──────┘ │  ║
   ║  │  │   insights       │  └─────────────────┘           │  ║
   ║  │  └────────┬─────────┘                                 │  ║
   ║  │           │                                           │  ║
   ║  │  ┌────────▼─────────┐  ┌──────────────────────────┐   │  ║
   ║  │  │ postgres         │  │ redis                    │   │  ║
   ║  │  │ 16.x             │  │ 7.x                      │   │  ║
   ║  │  │ :5432            │  │ :6379                    │   │  ║
   ║  │  └──────────────────┘  └──────────────────────────┘   │  ║
   ║  │                                                      │  ║
   ║  │  全部走 dokploy-network 内网通信                     │  ║
   ║  │  5432/6379/8100 端口**不**对外暴露                   │  ║
   ║  └──────────────────────────────────────────────────────┘  ║
   ║                                                            ║
   ║  ┌──────────────────────────────────────────────────────┐  ║
   ║  │ systemd fallback: believeboy-api.service             │  ║
   ║  │ （Dokploy 故障时手动启用的应急服务，监听 127.0.0.1） │  ║
   ║  └──────────────────────────────────────────────────────┘  ║
   ╚════════════════════════════════════════════════════════════╝
```

**关键设计原则**（和 Coolify 方案一致）：
- ✅ **单 VPS 全栈**——frontend/backend/worker/postgres/redis 全部在同一台
- ✅ **零端口暴露**——80/443/5432/6379 全部不开放公网
- ✅ **唯一公网入口**——`https://dashboard.believeboy.com` 经 Cloudflare → cloudflared → Traefik → frontend:3200
- ✅ **后端通过前端 `/api/backend/*` 反代**（已存在的 `app/api/backend/[...path]/route.ts`）
- ✅ **应急冷启动**——保留现有 systemd 服务

### 1.1 和 Coolify 方案的关键差异

| 维度 | Coolify | Dokploy |
|---|---|---|
| 社区规模 | 16k Discord / 200k+ instances | Discord 较小但活跃 |
| 通知系统 | webhook only | **Slack/Discord/Telegram/Email 全套** ✅ |
| 协议 | Apache 2.0 | **MIT**（更宽松） ✅ |
| 多服务器 | master + worker | **remote servers 零配置管理** ✅ |
| UI | 功能多（稍复杂） | 更精简现代 ✅ |
| 健康度 | 已稳定 4+ 年 | 2025 年后发力，更新更快 |
| 安装 | `curl ... \| bash`（同 Dokploy） | `curl ... \| sh`（同 Coolify） |
| Docker Compose 部署 | ✅ 完整支持 | ✅ 完整支持 |
| 模板市场 | 280+ 一键 | Plausible/Pocketbase/Calcom 等 |

**选 Coolify 如果**：你需要最大的生态成熟度、PR Preview UI 现成、监控 dashboard 完善
**选 Dokploy 如果**：你想要更现代的代码、Slack/Discord 通知开箱即用、MIT 协议

## 2. 前置条件

### 2.1 VPS 现状

| 项 | 要求 |
|---|---|
| 系统 | **Ubuntu 26.04**（已确认） |
| CPU | 20 核 |
| 内存 | 32 GB |
| 磁盘 | ≥ 100 GB |
| 用户 | `damon`（已有 sudo NOPASSWD 权限） |
| 网络 | 出站：`github.com`, `registry.npmjs.org`, `pypi.org`, `docker.io`, `api.cloudflare.com` |

### 2.2 域名 & Cloudflare

- `believeboy.com`（Cloudflare 上管理）
- 前端：`dashboard.believeboy.com` / `pr-<N>.preview.believeboy.com`
- 不需要独立 API 域名

### 2.3 GitHub & 仓库

- `git@github.com:passwii/believeboyDashboard.git`
- Dokploy 自身接 GitHub webhook

### 2.4 Redis 决策

- **保留 Redis**——20 核 32G 配缓存有意义
- **Redis 7.x**

## 3. 安装 Dokploy

### 3.1 装 Docker（如果还没有）

```bash
# 同 Coolify 方案 §3.1
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

sudo usermod -aG docker $USER
newgrp docker

docker --version
docker compose version
```

### 3.2 资源规划（32G 内存分配建议）

| 服务 | CPU limit | Memory limit | Reserved |
|---|---|---|---|
| Dokploy（Traefik + UI） | 2 | 2 GB | 512 MB |
| postgres | 4 | 8 GB | 2 GB |
| redis | 2 | 4 GB | 256 MB |
| backend | 4 | 4 GB | 1 GB |
| celery-worker | 4 | 4 GB | 1 GB |
| celery-flower | 0.5 | 512 MB | 64 MB |
| frontend | 2 | 2 GB | 512 MB |
| **总计 reserved** | | | **~5.5 GB** |
| **OS + 缓冲** | | | **~3 GB** |
| **剩余** | | | **~23 GB** |

### 3.3 一行命令装 Dokploy

```bash
# Dokploy 官方安装脚本
curl -sSL https://dokploy.com/install.sh | sh

# 装完会自动启动
# 访问 http://<VPS_IP>:3000 第一次设置管理员账号
```

> ⚠️ Dokploy 默认监听 `:3000`，**不是 `:8000`**（和 Coolify 不同）。**首先把 Dokploy 自身 bind 到 127.0.0.1**：
>
> Dokploy 装在 Docker 里，需要改 docker-compose：
>
> ```bash
> sudo vim /etc/dokploy/docker-compose.yml
> # 找到 dokploy 服务的 ports
> # 把 "3000:3000" 改成 "127.0.0.1:3000:3000"
> sudo docker compose up -d
> ```

### 3.4 验证 Dokploy 安装

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# 应该看到 dokploy, dokploy-traefik 等
curl -s http://127.0.0.1:3000/api/health
# 期望: {"status":"ok"}
```

## 4. 在 Dokploy 上部署 PostgreSQL

### 4.1 创建数据库服务

Dokploy Dashboard → **Create Service** → **Database** → **PostgreSQL**：

| 字段 | 值 |
|---|---|
| Name | `believeboy-postgres` |
| Image | `postgres:16-alpine` |
| Database Name | `believeboy` |
| Username | `believeboy` |
| Password | `openssl rand -base64 32` |
| Persistent Volume | ✅ 20 GB |
| Resource Limits | CPU 4 / Memory 8 GB |
| Exposed Externally | **❌ 不开**（内网用） |

### 4.2 验证 Postgres

Dokploy Dashboard → `believeboy-postgres` → **Console**：

```bash
psql -U believeboy -d believeboy -c '\dt'
# 期望: No relations found.
psql -U believeboy -d believeboy -c 'SELECT version();'
# 期望: PostgreSQL 16.x ...
```

### 4.3 数据迁移（可选）

如果从现有 backend 迁数据：

```bash
# 在旧机器上
pg_dump "$OLD_DATABASE_URL" --no-owner --no-acl -Fc -f backup.dump
scp backup.dump damon@192.168.100.113:/tmp/

# 在 Dokploy postgres 容器里恢复
docker exec -i $(docker ps -q -f name=believeboy-postgres) \
  pg_restore -U believeboy -d believeboy --no-owner --no-acl < /tmp/backup.dump
```

## 5. 在 Dokploy 上部署 Redis

### 5.1 创建 Redis 服务

Dokploy Dashboard → **Create Service** → **Database** → **Redis**：

| 字段 | 值 |
|---|---|
| Name | `believeboy-redis` |
| Image | `redis:7-alpine` |
| Password | `openssl rand -base64 32` |
| Persistent Volume | ✅ 10 GB |
| Resource Limits | CPU 2 / Memory 4 GB |
| Exposed Externally | **❌ 不开** |

### 5.2 Redis 参数

Dokploy Dashboard → `believeboy-redis` → **Configuration** → **Command Override**：

```
redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 2gb --maxmemory-policy allkeys-lru --save "" --appendonly no
```

### 5.3 验证 Redis

```bash
docker exec -it $(docker ps -q -f name=believeboy-redis) \
  redis-cli -a "$REDIS_PASSWORD" ping
# 期望: PONG
```

## 6. 在 Dokploy 上部署后端（FastAPI）

### 6.1 创建后端应用

Dokploy Dashboard → **Create Service** → **Application**：

#### 6.1.1 基础信息

| 字段 | 值 |
|---|---|
| Name | `believeboy-api` |
| Build Type | `Dockerfile` |
| Git Provider | `GitHub` |
| Repository | `passwii/believeboyDashboard` |
| Branch | `main` |
| Build Path | `/backend` |

#### 6.1.2 Dockerfile

`backend/Dockerfile`（**和 Coolify 方案完全相同**）：

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

RUN useradd -m -u 1000 app && chown -R app:app /app
USER app

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8100/api/v1/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--no-access-log", "--workers", "4"]
```

#### 6.1.3 端口

- Container Port: **8000**
- Expose: **❌ Internal Only**（Dokploy 选项卡里不勾"Public"）

#### 6.1.4 环境变量

| 变量 | 值 |
|---|---|
| `DATABASE_URL` | `postgresql+psycopg://believeboy:<PG_PWD>@believeboy-postgres:5432/believeboy` |
| `REDIS_URL` | `redis://:<REDIS_PWD>@believeboy-redis:6379/0` |
| `API_KEY` | Dokploy Secrets 注入 |
| `NEXTAUTH_SECRET` | 已有值 |
| `BACKEND_API_KEY` | 已有值 |
| `AI_CHAT_PROVIDER_BASE_URL` | 已有值 |
| `AI_CHAT_PROVIDER_API_KEY` | Dokploy Secrets 注入 |
| `AI_CHAT_DEFAULT_MODEL` | 已有值 |
| `CELERY_BROKER_URL` | `redis://:<REDIS_PWD>@believeboy-redis:6379/1` |
| `CELERY_RESULT_BACKEND` | `redis://:<REDIS_PWD>@believeboy-redis:6379/2` |
| `ENVIRONMENT` | `production` |
| `LOG_LEVEL` | `info` |

> **Dokploy 比 Coolify 多一个特性**：环境变量可以**引用其他服务的 secrets**，比如 `${believeboy-postgres.PASSWORD}`，不用手动同步。

#### 6.1.5 资源限制

CPU 4 / Memory 4 GB / Memory Reservation 1 GB。

#### 6.1.6 Persistent Storage

如果要写本地文件，挂卷：

```
Source: /data/believeboy-uploads
Destination: /app/uploads
```

### 6.2 验证后端

Dokploy Dashboard → `believeboy-api` → **Console**：

```bash
curl -s http://127.0.0.1:8100/api/v1/health
# 期望: {"status":"ok",...}

alembic upgrade head
```

## 7. 在 Dokploy 上部署 Celery Worker + Flower

### 7.1 Celery Worker

Dokploy Dashboard → **Create Service** → **Application**：

| 项 | 值 |
|---|---|
| Name | `believeboy-worker` |
| Build | 同 backend（Dockerfile + 同一仓库 + 同一 base dir） |
| Environment | 同 backend（共享） |
| Command Override | `celery -A app.tasks.celery_app worker -Q default,reports,insights -c 8 -l info` |
| Resource | CPU 4 / Memory 4 GB |

### 7.2 Celery Flower

| 项 | 值 |
|---|---|
| Name | `believeboy-flower` |
| Build | 同 backend |
| Environment | 同 backend（最少需要 `CELERY_BROKER_URL`） |
| Command Override | `celery -A app.tasks.celery_app flower --port=5555 --broker=redis://:<REDIS_PWD>@believeboy-redis:6379/1` |
| Port | 5555（**Internal Only**） |
| Resource | CPU 0.5 / Memory 512 MB |

## 8. 在 Dokploy 上部署前端（Next.js）

### 8.1 创建前端应用

Dokploy Dashboard → **Create Service** → **Application**：

| 字段 | 值 |
|---|---|
| Name | `believeboy-frontend` |
| Build Type | **Nixpacks** |
| Repository | `passwii/believeboyDashboard` |
| Branch | `main` |
| Build Path | `/frontend` |

### 8.2 Nixpacks 配置

| 字段 | 值 |
|---|---|
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm gen:api-types && pnpm build`（首次不 check） |
| Start Command | `pnpm start` |

### 8.3 端口

- Container Port: **3200**
- Expose: **✅ Public**（让 Dokploy 配 Traefik 路由）

### 8.4 域名

Dokploy Dashboard → `believeboy-frontend` → **Domains** → Add：

| 字段 | 值 |
|---|---|
| Host | `dashboard.believeboy.com` |
| HTTPS | ✅（Dokploy 会申请 Let's Encrypt 证书） |
| Container Port | 3200 |

> **重要**：因为走 cloudflared tunnel，CF 边缘终止 TLS。Dokploy 申请证书可选（双层 TLS）。**推荐方案**：在 CF Dashboard → SSL/TLS → Origin Server 创建 Origin Certificate，传到 Dokploy。

### 8.5 环境变量

| 变量 | 值 |
|---|---|
| `BACKEND_API_BASE_URL` | `http://believeboy-api:8100`（内网） |
| `BACKEND_API_KEY` | 同 backend |
| `NEXTAUTH_URL` | `https://dashboard.believeboy.com` |
| `NEXTAUTH_SECRET` | 同 backend |
| `NEXT_PUBLIC_API_BASE_URL` | `https://dashboard.believeboy.com/api/backend` |
| `NEXT_PUBLIC_BACKEND_API_BASE_URL` | 同上 |

### 8.6 资源限制

CPU 2 / Memory 2 GB / Memory Reservation 512 MB。

### 8.7 PR Preview

Dokploy Dashboard → `believeboy-frontend` → **Preview Deployments** → 启用。

PR 推上来自动部署到 `pr-<N>.preview.believeboy.com`。

> **Dokploy 比 Coolify 强的地方**：Dokploy 的 PR Preview 默认会**自动建临时数据库**（不污染生产数据）。Coolify 默认共享。

## 9. 内网通信

### 9.1 Dokploy 网络

Dokploy 默认把所有 service 放进同一个 Docker network（叫 `dokploy-network`），service 之间用服务名互通。

```bash
docker network ls
# 应该看到 dokploy-network
docker network inspect dokploy-network | jq '.[0].Containers[].Name'
# 应该看到 believeboy-frontend, believeboy-api, believeboy-postgres, believeboy-redis, believeboy-worker, believeboy-flower
```

### 9.2 通信路径

```
浏览器
  │ GET https://dashboard.believeboy.com/api/backend/api/v1/projects
  ▼
Cloudflare 边缘（终止 TLS）
  │ 出站 tunnel
  ▼
cloudflared（systemd）
  │ 转发到 127.0.0.1:80（Dokploy Traefik）
  ▼
Dokploy Traefik
  │ 路由匹配 dashboard.believeboy.com → frontend:3200
  ▼
frontend（Next.js :3200）
  │ /api/backend/* 匹配 app/api/backend/[...path]/route.ts
  │ BACKEND_API_BASE_URL=http://believeboy-api:8100
  ▼
backend（FastAPI :8100）
  │ 内网
  ▼
postgres（:5432）
  │ 原路返回
```

**所有内网通信**：HTTP（不加 TLS），因为同机容器间。

**VPS 上 5432/6379/8100 都不监听 `0.0.0.0`**——只 Docker bridge。

## 10. GitHub Webhook 集成

### 10.1 Dokploy 配置

Dokploy Dashboard → `believeboy-frontend` → **Webhooks** → **Create Webhook**。

Dokploy 会生成一个 webhook URL：
```
https://<DOKPLOY_HOST>/api/deploy/<app-id>
```

复制到 GitHub 仓库 Settings → Webhooks → Add：
- Payload URL: 上面的 URL
- Content type: `application/json`
- Events: Just the push event
- Active: ✅

对 `believeboy-api`、`believeboy-worker`、`believeboy-flower` 重复。

### 10.2 验证

```bash
git commit --allow-empty -m "test webhook"
git push origin main
# GitHub → Settings → Webhooks → Recent Deliveries → 200 OK
# Dokploy → Deployments → 新部署记录
```

## 11. Cloudflare Tunnel 配置

### 11.1 在 CF Dashboard 创建 Tunnel

**Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**：

1. 命名：`believeboy-tunnel`
2. 保存 token（形如 `eyJh...`）

### 11.2 在 VPS 上装 cloudflared

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared focal main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared
```

### 11.3 配置路由

CF Dashboard → Tunnel → **Public Hostname**：

| Subdomain | Domain | Service | URL |
|---|---|---|---|
| `dashboard` | `believeboy.com` | HTTP | `http://127.0.0.1:80` |
| `*.preview` | `believeboy.com` | HTTP | `http://127.0.0.1:80` |

> **Dokploy 的 Traefik 监听**: Dokploy 的 Traefik 容器绑 `0.0.0.0:80`（同 Coolify），cloudflared 通过 `127.0.0.1:80` 访问，**VPS 80 端口外部不开放**（firewall 限制）。

### 11.4 验证 Tunnel

```bash
curl -sI https://dashboard.believeboy.com
# 期望: HTTP/2 200, server: cloudflare
```

## 12. HTTPS / DNS

同 Coolify 方案 §12。**推荐双层 TLS**（CF Origin cert + Traefik）。

## 13. 备份策略

### 13.1 Postgres 备份

Dokploy Dashboard → `believeboy-postgres` → **Backups** → **Schedule**：

| 字段 | 值 |
|---|---|
| Schedule | `0 3 * * *` |
| Retention | 7 份 |
| Destination | **S3**（Dokploy 内置支持） |
| Bucket | `believeboy-backups-postgres` |
| Region | `ap-east-1` 或 `ap-southeast-1` |
| Credentials | Dokploy Secrets |

### 13.2 Redis 备份

同 Coolify 方案 §13.2——纯缓存，不备份。

### 13.3 上传文件备份

`/data/believeboy-uploads` 卷 → Dokploy 的 Volume Backup。

## 14. 监控 + 告警

### 14.1 Dokploy 自带

Dokploy Dashboard → 资源页面 → **Stats** → CPU/Memory/Network 实时图。

### 14.2 通知系统（Dokploy 强项 ⭐）

Dokploy Dashboard → **Settings** → **Notifications** → **Create**：

| 类型 | 配置 |
|---|---|
| **Slack** | 填 Slack Webhook URL |
| **Discord** | 填 Discord Webhook URL |
| **Telegram** | 填 Bot Token + Chat ID |
| **Email** | 填 SMTP 配置 |

Dokploy 默认在以下事件触发通知：
- ✅ Application 部署成功/失败
- ✅ 数据库备份成功/失败
- ✅ 服务器磁盘/CPU 报警

**推荐配 Slack + Email**。

### 14.3 外部 Uptime 监控

- **UptimeRobot**（免费）：监控 `https://dashboard.believeboy.com` + `https://dashboard.believeboy.com/api/v1/health`（前端反代过来的）
- 5 分钟一次 HEAD 请求
- 失败时发邮件/Slack

## 15. 回滚预案

### 15.1 应用层回滚

Dokploy Dashboard → Application → **Deployments** → 选历史成功部署 → **Redeploy**。

### 15.2 数据库回滚

```bash
docker exec -it $(docker ps -q -f name=believeboy-api) alembic downgrade -1
```

Dokploy 没有自动 DB 回滚，要手动。

### 15.3 整个 stack 回滚（应急）

启用 systemd fallback + 临时切流量：

```bash
sudo systemctl start believeboy-api
# Cloudflare Tunnel 路由临时改到 127.0.0.1:8100（绕过 Dokploy）
```

## 16. 与现有 systemd 的过渡

同 Coolify 方案 §16。**保留 `believeboy-api.service` 作为应急**，`productEnvAgent/deploy_vps.py` 退役但保留作为"应急部署"。

切换步骤：参考 Coolify 方案 §16.3。

## 17. 性能对比（vs Vercel）

| 指标 | Vercel free | Dokploy + 自建（20C/32G） |
|---|---|---|
| 冷启动 | 500ms~1.5s | **0**（容器常驻） |
| 热请求 SSR | 100~300ms | **30~80ms** |
| 后端 API 调用 | 80~150ms（Vercel→VPS RTT） | **5~20ms**（同机 Docker 内网） |
| `/dashboard` LCP | 1554ms | **预计 <800ms** |
| perf 分数 | 0.90 | **预计 >0.97** |

## 18. 常见问题排查

### 18.1 容器启动失败：DB connection refused

Dokploy Dashboard → `believeboy-api` → **Configuration** → **Depends On** → 加 `believeboy-postgres` 和 `believeboy-redis`。

或者改 Dockerfile 的 CMD：

```dockerfile
CMD ["sh", "-c", "until pg_isready -h believeboy-postgres -p 5432; do sleep 2; done && uvicorn app.main:app --host 0.0.0.0 --port 8100"]
```

### 18.2 cloudflared tunnel 连接失败

```bash
sudo journalctl -u cloudflared -n 100
# - "connection refused" → 检查 token
# - "DNS resolution failed" → 检查 53 端口
# - "tunnel connection error" → 检查 outbound 到 api.cloudflare.com
```

### 18.3 前端 build 失败：API type check

`pnpm gen:api-types:check` 需要 backend 已经 build 过 OpenAPI 文档。

**解决**：首次部署 build command 用 `pnpm gen:api-types && pnpm build`（不 check），后续改回 `check`。

### 18.4 PR Preview 共享数据库（不会发生）

Dokploy 默认每个 PR Preview **自动建独立数据库**，不污染生产。如果发现没建，看 PR Preview 配置。

### 18.5 worker 队列积压

```bash
docker exec -it $(docker ps -q -f name=believeboy-redis) \
  redis-cli -a "$REDIS_PASSWORD" LLEN celery:reports
```

解决：增加 worker 副本或 `-c` 并发数。

### 18.6 Dokploy 自身的备份

```bash
# Dokploy 自己的数据库（PostgreSQL）备份
docker exec $(docker ps -q -f name=dokploy-postgres) \
  pg_dump -U dokploy dokploy > dokploy-backup-$(date +%F).sql

# 恢复到新机器
docker exec -i $(docker ps -q -f name=dokploy-postgres) \
  psql -U dokploy dokploy < dokploy-backup-2026-06-20.sql
```

## 附录 A：完整 docker-compose 参考

和 Coolify 方案附录 A **基本相同**，但 Dokploy 默认网络叫 `dokploy-network`：

```yaml
name: believeboy

services:
  frontend:
    build:
      context: ./frontend
      dockerfile_inline: |
        FROM node:20-alpine
        RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
        WORKDIR /app
        COPY package.json pnpm-lock.yaml ./
        RUN pnpm install --frozen-lockfile
        COPY . .
        RUN pnpm gen:api-types && pnpm build
        EXPOSE 3200
        CMD ["pnpm", "start"]
    environment:
      BACKEND_API_BASE_URL: http://backend:8100
      NEXTAUTH_URL: https://dashboard.believeboy.com
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      BACKEND_API_KEY: ${BACKEND_API_KEY}
    networks: [dokploy-network]
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
    networks: [dokploy-network]
    depends_on: [postgres, redis]

  worker:
    build: ./backend
    command: celery -A app.tasks.celery_app worker -Q default,reports,insights -c 8 -l info
    environment:
      DATABASE_URL: postgresql+psycopg://believeboy:${PG_PWD}@postgres:5432/believeboy
      REDIS_URL: redis://:${REDIS_PWD}@redis:6379/0
      CELERY_BROKER_URL: redis://:${REDIS_PWD}@redis:6379/1
    networks: [dokploy-network]
    depends_on: [postgres, redis, backend]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: believeboy
      POSTGRES_PASSWORD: ${PG_PWD}
      POSTGRES_DB: believeboy
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [dokploy-network]

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PWD} --maxmemory 2gb --maxmemory-policy allkeys-lru --save "" --appendonly no
    volumes: [redisdata:/data]
    networks: [dokploy-network]

volumes:
  pgdata:
  redisdata:
```

## 附录 B：Dokploy vs Coolify 最终决策表

| 你的诉求 | 推荐 |
|---|---|
| 最大的生态成熟度 + 多年生产验证 | **Coolify** |
| 想要 Slack/Discord/Telegram/Email 通知开箱即用 | **Dokploy** |
| PR Preview 默认独立数据库（不污染生产） | **Dokploy** |
| MIT 协议 / 开源更宽松 | **Dokploy** |
| 更精简的现代 UI | **Dokploy** |
| 远程管理多台服务器（不是 master-worker） | **Dokploy** |
| 280+ 一键应用模板 | **Coolify** |
| 16k Discord 社区，遇到问题有人帮 | **Coolify** |
| 团队小，只想要 PaaS 别太复杂 | **Dokploy** |
| 长期项目、要稳 | **Coolify** |
| 短期项目、要快 | **Dokploy** |

**实操建议**：
1. **两边都装**（30 分钟成本很低）—— 在同一台 VPS 上先装 Coolify 跑通一个资源试试，再装 Dokploy
2. **看 UI 选**——团队里每个人上去点点，看哪个舒服
3. **撤掉另一边**——定下来后，卸载另一个

如果选不出来，**推荐 Dokploy**——更现代、通知系统强、对新项目更友好。

---

**文档结束**。配套的 Coolify 方案见 [`coolify-deployment.md`](./coolify-deployment.md)。