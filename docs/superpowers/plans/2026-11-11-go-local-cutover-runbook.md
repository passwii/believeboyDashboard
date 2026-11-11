# Go 本地全量切流 Runbook

> 日期：2026-11-11
> 目标：在本地用 Go 后端（gateway + worker + scheduler）以 `GO_API_OWNED=all` 跑完整业务流量，验证 FastAPI 是否真的可以被替换。
> 边界：只连本地 `BLF_TEST`，不碰 `BLF`、不部署、不改生产。

## 1. 一键起停

```bash
cd backend-go

# 起（默认读 <repo>/backend/.env.test，GO_API_OWNED=all，网关 127.0.0.1:18200）
go run ./cmd/localcutover up

# 查看状态（进程存活 + /health/ready）
go run ./cmd/localcutover status

# 看三个进程的日志尾部
go run ./cmd/localcutover logs -lines 80

# 停
go run ./cmd/localcutover down
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--env-file` | 提供 `API_KEY` 与 `DATABASE_URL` 的 env 文件，相对路径从仓库根算 |
| `--owned` | `GO_API_OWNED`，默认 `all`；可传逗号列表做单域验证 |
| `--gateway-addr` | 网关监听地址，默认 `127.0.0.1:18200` |
| `--fastapi-origin` | 回落目标，默认 `http://127.0.0.1:8100` |
| `--state-dir` | 二进制、日志、状态目录，默认 `<repo>/.local-cutover` |
| `--stop-python-celery` | 起 Go worker 前用 `pkill` 停掉本地 Python celery/beat |
| `--no-worker` / `--no-scheduler` | 只跑网关做路由验证 |

## 2. 运行要求

- `backend/.env.test`（或 `--env-file` 指定）必须提供：
  - `API_KEY`
  - `DATABASE_URL`（`postgresql+psycopg://` 会被自动转成 `postgres://`）或 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`
  - 可选 `REDIS_HOST/REDIS_PORT` 或 `REDIS_URL`
- 本地 PostgreSQL（5432）与 Redis（6379）可用；`BLF_TEST` 已有 285 基线 schema。
- **必须停掉本地 Python celery / beat**，否则任务双跑（报表邮件最危险）：`up --stop-python-celery`。
- 网关会在 `<state>/api.env` 生成完整环境文件（600 权限，值已 shell 转义），可直接：

```bash
set -a; . .local-cutover/api.env; set +a
```

## 3. 鉴权要点（实跑踩过）

1. **master key 必须同时带受信代理密钥**：`GO_API_TRUSTED_PROXY_SECRET` 为空时，master key 请求一律 403 `Invalid API key`。runbook 自动生成 32 字节随机值并写进 `api.env`。
2. **user-scoped 路由还要 `X-User-Id`**（master key 只解决服务身份），前端由 Next.js 代理注入。
3. 健康接口 `/api/v1/health/live`、`/api/v1/health/ready` 免鉴权，可直接用于探活。

样例：

```bash
set -a; . .local-cutover/api.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18200/api/v1/health/ready
curl -s -H "X-API-Key: $API_KEY" -H "X-Trusted-Proxy-Secret: $GO_API_TRUSTED_PROXY_SECRET" \
  http://127.0.0.1:18200/api/v1/projects/manage
```

## 4. 已验证（2026-11-11 本机）

| 项 | 结果 |
| --- | --- |
| `GO_API_OWNED=all` 启动 | 70 模块，无 panic |
| gateway / worker / scheduler | 三进程同时常驻；worker 18 个 task handler、5 个队列；scheduler 11 条静态 job + insight 动态同步 |
| `/api/v1/health/ready` | 200（DB / Redis ok） |
| `/api/v1/projects/manage` | 200 |
| `/api/v1/exchange-rates` | 200，返回 BLF_TEST 数据 |
| `/api/v1/notifications/unread-count` | 200（带 `X-User-Id`） |
| `/api/v1/ai/config` | 200 |
| fallback 到 FastAPI | 抽样请求 0 次（需配合 #817 的 fallback 日志统计） |

## 5. 已知缺口（切流前必须处理）

| 缺口 | 影响 |
| --- | --- |
| `dispatch_one` / `generate_delivery_summary` 仍为空壳 | 定时报表能触发但执行必失败 |
| ~~定时报表每分钟扫描调度源缺失~~ | ✅ 已补（`cmd/scheduler` 每分钟扫描，2026-11-11） |
| PDF 写入 / Playwright 截图 / Pillow 合成仍是 Python 独占 | 产品标签、月报 PDF、邮件截图不可用 |
| 生产 compose 无 `go-worker` / `go-scheduler` | 只影响部署，本地 runbook 已覆盖 |

## 6. 下一步

1. 合并 #817 后重跑，用 `grep 'fell back to FastAPI' gateway.log` 统计真实回落；
2. 334 条 GET 全量对账（8100 vs 18200，同参数比对 status + JSON key 集合）；
3. 补 `dispatch_one` / `generate_delivery_summary` 与定时报表扫描；
4. PDF / 截图 Go 化；
5. 测试体系去 Python（pytest → Go、部署与迁移校验脚本 → Go）。
