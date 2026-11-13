# backend-go —— Go 后端

网关 + worker + scheduler + 数据库迁移，全部是 Go。FastAPI 已下线（`backend/` 只保留 Alembic 冻结归档）。

## 组成

| 二进制 | 作用 | 默认端口 |
| --- | --- | --- |
| `cmd/gateway` | HTTP 网关，注册 70 个模块 / 694 条路由，覆盖全部 623 个 OpenAPI operation | `127.0.0.1:8200` |
| `cmd/worker` | 异步任务消费者（Redis 队列） | — |
| `cmd/scheduler` | 定时任务调度器（静态 job + 定时报表扫描） | — |
| `cmd/migrate` | Goose 迁移执行器（`up` / `status` / `version` / `baseline`） | — |

## 目录

```
cmd/            可执行入口（gateway / worker / scheduler / migrate / 各类运维工具）
internal/
  api/          70 个业务模块，每个模块一个 handler + registrar
  httpserver/   路由装配、中间件、fallback 日志
  store/        PostgreSQL 访问层
  queue/        Redis 队列
  scheduler/    定时任务注册
  scheduledreport/  定时报表（数据 + 截图 + 邮件）
  mailer/       SMTP 发信（支持附件）
  pdf/          PDF 生成
  migrations/   Goose SQL（00001_baseline = Alembic 285 的 schema 快照）
  livecontract/ 契约用例与 golden token 化
tests/contract/ golden 契约测试
```

## 本地启动

```bash
cd backend-go
cp ../backend/.env.example .env      # 填 DATABASE_URL / API_KEY / REDIS_*
go run ./cmd/migrate up              # 应用迁移（空库会跑 baseline）
go run ./cmd/gateway                 # 网关 127.0.0.1:8200
go run ./cmd/worker                  # 另开终端：异步任务
go run ./cmd/scheduler               # 另开终端：定时任务
```

## 测试

```bash
go vet ./...
go test ./... -count=1               # 全量（93 个包）
go test ./internal/api/ad_upload -count=1   # 单包
go run ./cmd/checkmigrations         # 迁移 + Alembic 冻结校验
```

契约测试（对比 FastAPI golden 录制，不需要 Python）：

```bash
BELIEVEBOY_ENV_FILE=../backend/.env.test ./scripts/run-live-contract.sh
```

## 新增迁移

```bash
cd backend-go
go run ./cmd/newmigration add_customer_tag   # 生成 YYYYMMDDHHMMSS_add_customer_tag.sql
# 写 Up/Down 后：
go run ./cmd/checkmigrations
```

规则：已应用的迁移禁止改名 / 改内容；baseline 禁止修改；修正一律用新迁移。

## 相关文档

- [迁移状态](../docs/migration-status.md)
- [部署手册](../docs/deployment/dashboard-vps-compose.md)
- [契约测试说明](tests/contract/README.md)
- [测试总览](../TESTING.md)
