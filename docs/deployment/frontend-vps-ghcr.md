# Dashboard 前端 VPS + GHCR 部署

最后更新：2026-11-05

生产入口：`https://dash.believeboy.com`

## 架构

```text
Mac（主路径）
  main → lint + test
  → docker buildx --platform linux/amd64
  → GHCR: ghcr.io/passwii/believeboydashboard:sha-<commit>
  → SSH 同步 Compose / app.env
  → VPS pull + restart + /healthz

GitHub Actions（手动备用路径）
  workflow_dispatch → 相同校验、镜像和远程部署脚本
```

VPS 只拉取镜像，不安装 Node.js，不保存源码，不执行 `pnpm build`。Next.js 使用
`standalone` 输出；运行镜像内没有源码、`node_modules` 或构建缓存。

## 共享构建缓存

Node 基础镜像使用 `public.ecr.aws/docker/library/node:24-alpine`，Docker 会在本机
复用相同基础镜像层。Dockerfile 还声明了两个 BuildKit cache mount：

- `believeboy-corepack`：缓存 Corepack 下载的 pnpm。
- `believeboy-pnpm-store`：缓存 pnpm content-addressed store。

其他 Node 项目使用相同 cache id 时，会共享已经下载的 pnpm 包；cache mount 不会进入
最终镜像。GitHub Actions 的运行器是一次性的，跨运行仍使用 workflow 的 GHA 构建缓存。

## VPS 参数

| 项目 | 值 |
| --- | --- |
| 镜像 | `ghcr.io/passwii/believeboydashboard` |
| 部署目录 | `/opt/believeboy-dashboard` |
| 容器名 | `believeboy-dashboard` |
| 回环端口 | `127.0.0.1:3200` |
| Caddy 上游 | `reverse_proxy 127.0.0.1:3200` |
| 运行环境文件 | `/opt/believeboy-dashboard/app.env`，权限 `0600` |

`app.env` 保存 `BACKEND_API_BASE_URL`、`BACKEND_API_KEY`、`NEXTAUTH_SECRET`、
`NEXTAUTH_URL` 等运行时而值，不进入镜像和 Git。

## DNS 与 Caddy

`dash.believeboy.com` 的 DNS 必须指向 VPS；首次签发证书时使用 DNS only：

```bash
dig +short dash.believeboy.com
# 145.79.143.98
```

Caddy 站点块见 [`frontend/deploy/Caddyfile.example`](../../frontend/deploy/Caddyfile.example)。
修改后先验证再重载：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

## 本地配置

```bash
mkdir -p ~/.config/believeboy-dashboard
cp frontend/deploy/local.env.example ~/.config/believeboy-dashboard/deploy.env
chmod 600 ~/.config/believeboy-dashboard/deploy.env
```

默认配置使用已有 SSH 别名 `guitar-vps`。本地 GHCR 写权限由
`docker login ghcr.io` 保存，仓库内不保存 token。

## 日常发布

发布提交必须先合入并同步到最新 `origin/main`：

```bash
git switch main
git pull --ff-only origin main
frontend/deploy/deploy-local.sh
```

脚本依次执行：

1. 拒绝带未提交 tracked 改动或落后于 `origin/main` 的发布。
2. 必要时执行 `pnpm install --frozen-lockfile`。
3. 执行 `pnpm lint && pnpm test`。
4. 从 `frontend/.env.local` 读取运行时变量，生成权限 `0600` 的临时文件。
5. 通过 BuildKit secret 注入 `NEXTAUTH_SECRET`，构建并推送 SHA 与 `latest` 镜像。
6. 把 Compose 和 `app.env` 同步到 VPS。
7. VPS 拉取 SHA 镜像并替换容器。
8. 检查容器健康与公网 `/healthz`；失败时自动回滚上一 SHA。

## GitHub Actions 备用发布

`.github/workflows/deploy-frontend.yml` 只能手动运行，且 ref 必须是 `main`：

```bash
gh workflow run deploy-frontend.yml --ref main
gh run list --workflow deploy-frontend.yml --limit 3
```

首次由 Actions 发布前，VPS 上必须已有 `app.env`，因此先完成一次本地发布。
Actions 复用现有 Secrets：`VPS_SSH_KEY`、`VPS_KNOWN_HOSTS`、`VPS_HOST`、
`NEXTAUTH_SECRET`。首次推送私有 GHCR 包后，需要在 package settings 中将
`passwii/believeboyDashboard` 的 Actions access 设为 `Write`，否则会出现
`permission_denied: read_package`。

## 检查与回滚

```bash
curl -fsS https://dash.believeboy.com/healthz
ssh guitar-vps '
  cd /opt/believeboy-dashboard
  docker compose ps
  docker compose logs --tail=100 web
'
```

手动回滚到上一 SHA：

```bash
ssh guitar-vps '
  cd /opt/believeboy-dashboard
  IMAGE_TAG=sha-<previous-commit> docker compose up -d --no-build web
'
```
