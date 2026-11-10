# Alembic 历史归档（已冻结）

从 2026-11-10 起，数据库迁移切换到 Goose：

- 新迁移：`backend-go/internal/migrations/sql/`
- 运行器：`backend-go/cmd/migrate`
- 基线：`00001_baseline.sql`（Alembic revision 285 的 schema 快照）

本目录只用于历史追溯与 `check_alembic.py` 图完整性校验，**禁止新增或修改**；
`backend-go/scripts/check_go_migrations.py` 会校验本目录 manifest，任何变动都会失败。
