# Dashboard 前端本地构建 + GHCR + VPS 部署设计

日期：2026-11-05

状态：用户已批准

## 目标

把 `dash.believeboy.com` 的前端从 Vercel 切到 VPS，但不在 VPS 上执行源码安装或
Next.js 构建。Mac 是主构建机，GitHub Actions 是手动备用构建机；VPS 只拉取 GHCR
镜像、运行容器并保留运行时环境变量。

## 边界

- Mac：Git 状态检查、lint、测试、Docker 镜像构建、GHCR 推送、Compose 同步。
- GitHub Actions：仅 `workflow_dispatch`，复用同一 Dockerfile、Compose 和远程脚本。
- GHCR：保存不可变 `sha-<commit>` 与便利标签 `latest`。
- VPS：Docker Compose、Caddy、只读 GHCR 凭据和 `0600 app.env`；不保存源码。
- Caddy：`dash.believeboy.com` 反代到 `127.0.0.1:3200`，负责 TLS。

## 运行镜像

Next.js 开启 `output: 'standalone'`。Dockerfile 分 three stages：安装依赖、构建、
复制 standalone 产物到非 root Node.js 运行镜像。构建期 `NEXTAUTH_SECRET` 通过
BuildKit secret 挂载；运行期秘密只来自 VPS 的 `app.env`。

## 发布与失败处理

本地脚本要求 `HEAD == origin/main`，执行 lint/test 后构建 `linux/amd64` 镜像并推送。
远程脚本先记录当前 SHA 镜像，再拉取新镜像、替换容器并轮询 `/healthz`。启动或健康
检查失败时自动回滚上一 SHA。首次发布由本地脚本创建 `app.env`；Actions 备用路径只
在 `app.env` 已存在时运行。

## 验收

- `dash.believeboy.com` 使用 Caddy 自动签发证书，容器只监听 `127.0.0.1:3200`。
- 公网 `/healthz` 返回 `ok`，登录页可用，Next.js API Route 与 Auth.js 正常工作。
- VPS 不执行 `pnpm` 或 `next build`。
- Actions 只能手动触发且只接受 `main`。
- 健康检查失败时可以按上一 SHA 回滚。
