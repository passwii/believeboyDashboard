# backend/ —— 历史归档（无 Python 运行时）

本目录**不再包含可运行的 FastAPI 应用**。Go 网关（`backend-go/`）已接管全部
623 个 OpenAPI operation，Python 运行时、Celery worker 与 pytest 套件已下线。

剩下的是必须保留的历史资产：

| 路径 | 用途 | 约束 |
| --- | --- | --- |
| `alembic/versions/` | Alembic 迁移历史，冻结在 revision 285 | **只读**：`backend-go/cmd/checkmigrations` 会用 manifest 校验，任何增删改都会让校验失败。新迁移一律写 Goose SQL（`backend-go/internal/migrations/sql/`） |
| `deploy/systemd/`、`deploy/cron/`、`deploy/journald/` | 旧 systemd 单元与 cron 配置，作为冷启动/排障参考 | 生产已切 Docker Compose，这些单元必须保持 disabled；部署脚本会校验 |
| `.env.example` | 环境变量清单 | Go 网关与 Web 共用同一批变量名 |

## 常用命令

```bash
cd backend-go
go run ./cmd/migrate up          # 应用 Goose 迁移
go run ./cmd/checkmigrations     # 校验迁移 + Alembic 归档冻结
go test ./... -count=1           # 全部后端测试
```

## 为什么保留 Alembic 归档

Goose baseline（`backend-go/internal/migrations/sql/00001_baseline.sql`）是 revision 285
的 schema 快照。归档保留是为了在库版本落后时用
`bash deploy/prepare-goose-cutover.sh`（需 `LEGACY_API_IMAGE`）升到 285，以及让 manifest 校验有可比对的基准。
