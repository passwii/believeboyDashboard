# Goose 迁移切换（Alembic → Goose）

日期：2026-11-10
状态：已实施（代码与本地验证完成；生产部署仍处于冻结期，未执行）

## 结论

数据库迁移工具由 Alembic 切换为 **Goose**：

- 迁移文件：`backend-go/internal/migrations/sql/`
- 运行器：`backend-go/cmd/migrate`（嵌入 SQL，随 Go API 镜像发布）
- 部署：Compose `migrate` 服务使用 `GO_API_IMAGE`，执行 `/usr/local/bin/go-migrate up`
- Alembic：历史归档冻结在 revision 285，不再新增/修改（见 `backend/alembic/README_FROZEN.md`）

## 基线

`00001_baseline.sql` 是从 revision 285 的 schema 快照生成的完整 schema，仅用于**全新数据库**初始化。
已有数据库不执行 baseline，而是由 `migrate up` 自动 stamp 为 Goose version 1。

| 数据库状态 | `migrate up` 行为 |
| --- | --- |
| 空库 | 执行 baseline，建立完整 schema |
| 有 `alembic_version = 285`、无 Goose 表 | stamp baseline，不重放 DDL |
| 有 `alembic_version < 285` | 拒绝执行，提示先跑 `deploy/prepare-goose-cutover.sh` |
| 无 `alembic_version` 且 public schema 非空 | 拒绝执行，避免覆盖未知库 |
| 已有 Goose 表且 version ≥ 1 | 继续执行未应用的 Goose 迁移 |

## 首次切换步骤（生产解冻后执行一次）

1. 确认部署冻结已解除（`DEPLOYMENTS_ENABLED=true`）。
2. 若生产库仍是 Alembic，运行：
   ```bash
   bash deploy/prepare-goose-cutover.sh
   ```
   该脚本用 API 镜像把库升到冻结 head 285；全新库自动跳过。
3. 正常执行 `git deploy` 或 GitHub Actions 部署；`go-migrate up` 会 stamp 并应用后续迁移。
4. 验证：
   ```bash
   docker compose -f /opt/believeboy-dashboard/docker-compose.yml run --rm -T migrate version
   docker compose -f /opt/believeboy-dashboard/docker-compose.yml run --rm -T migrate status
   ```
   期望 version ≥ 1，status 显示 baseline applied。

## 新迁移流程

```bash
git fetch origin && git rebase origin/main
python3 backend-go/scripts/new_go_migration.py add_customer_tag
# 编辑 Up/Down
python3 backend-go/scripts/check_go_migrations.py
cd backend-go && DATABASE_URL=... go run ./cmd/migrate up
```

规则：

- 文件名 `YYYYMMDDHHMMSS_slug.sql`，14 位 UTC 时间戳；版本号唯一。
- 已应用迁移禁止改名/改内容；修正用新迁移。
- 迁移必须向后兼容（expand/contract），生产回滚不自动回滚 DB。
- FastAPI 仍读同一库时，同步更新 `backend/app/models/`。
- 没有 revision graph / merge heads；多 worktree 时间戳撞车由后建者改名。

## 回滚

- 应用回滚：按现有三镜像回滚流程，`--no-deps` 跳过 `migrate`。
- 数据库：不自动 downgrade。Goose 的 Down 仅用于本地/测试；生产用备份或前向修复迁移。
- 旧 Alembic runner 不会识别 Goose 版本；不要在生产回滚时重新运行 Alembic。

## 验证记录（2026-11-10，本地）

- 从 revision 285 schema 生成 baseline（151 张表、8 张 crm_intent；剔除 pgcrypto/pg_trgm 遗留 C 函数，保留应用 function）。
- 全新库：`migrate up` 执行 baseline，得到 151 张业务表 + `goose_db_version`。
- 已有 285 库：`migrate up` stamp version 1，无 DDL 重放。
- 284 库：`migrate up` 拒绝并提示先跑 cutover；Alembic 285 后再次 `migrate up` stamp 成功。
- 新增一条测试 Goose 迁移：成功应用到 version 2，验证后已删除测试文件。
- `backend-go/scripts/check_go_migrations.py`：baseline SHA + Alembic manifest + 命名/重复/标记校验通过。
- 部署 Compose 配置测试通过；Go 全量测试 82 包 PASS。
- Docker 镜像构建因本机到 Docker Hub TLS 超时未完成（Dockerfile 变更待有网环境复验）。
