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
| 空库 | 执行 baseline + seed 迁移，建立 schema 与基础种子 |
| 有 `alembic_version = 285`、无 Goose 表 | stamp baseline，再执行尚未应用的 seed 迁移 |
| 有 `alembic_version < 285` | 拒绝执行，提示先跑 `deploy/prepare-goose-cutover.sh` |
| 无 `alembic_version` 且 public schema 非空 | 拒绝执行，避免覆盖未知库 |
| 已有 Goose 表且 version ≥ 1 | 继续执行未应用的 Goose 迁移 |

## 首次切换步骤（生产解冻后执行一次）

1. 确认部署冻结已解除（`DEPLOYMENTS_ENABLED=true`）。
2. 若生产库仍是 Alembic，运行：
   ```bash
   LEGACY_API_IMAGE=ghcr.io/passwii/believeboydashboard-api@sha256:<digest> \
     bash deploy/prepare-goose-cutover.sh
   ```
   该脚本用**历史 FastAPI 镜像**（已停止发布，需显式提供 digest）把库升到冻结 head 285；
   全新库、以及已被 Goose stamp 的库都会跳过。
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
cd backend-go && go run ./cmd/newmigration add_customer_tag
# 编辑 Up/Down
go run ./cmd/checkmigrations
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

- 从 revision 285 schema 生成 baseline（151 张表、8 张 crm_intent；剔除 pg_trgm 遗留对象，pgcrypto 以 extension 形式保留/安装，Go 的 `crypt()/gen_salt()` 依赖它；已有 285 库若只有孤立函数则不会重复创建 extension）。
- 新增幂等种子迁移 `20261110170000_seed_baseline_data.sql`：补齐 `crm_intent_meta`、`crm_workflow_settings`、9 个 `crm_categories`、MVP CRM 规则、2 个启动台模板/12 个节点（来自 Alembic 250/251/252/276/285）。
- 全新库：`migrate up` 执行 baseline + seed，得到 151 张业务表 + `goose_db_version`；`crm_intent_meta=1`、9 类目、1 条 MVP 规则、2 模板/12 节点，`crypt/gen_salt` 可用。
- 已有 285 库：`migrate up` stamp version 1，不重放 baseline；随后执行 seed 迁移（幂等，已有行保留）。
- 284 库：`migrate up` 拒绝并提示先跑 cutover；Alembic 285 后再次 `migrate up` stamp 成功。
- 临时新增一条测试 Goose 迁移并成功应用，验证后已删除测试文件。
- `cd backend-go && go run ./cmd/checkmigrations`：baseline SHA + Alembic manifest + 命名/重复/标记校验通过。
- 部署 Compose 配置测试通过；Go 全量测试 82 包 PASS。
- 本机 Docker 构建/运行（2026-11-10）：用本机 `golang:1.27-alpine` + `--build-arg GO_VERSION=1.27` 构建 `blf-go-migrate-test` 成功（镜像 47.5 MB，同时含 `go-api`/`go-migrate`，运行 UID 10001）；默认 `1.27.3` 仍因 Docker Hub IPv6/TLS 拉取失败。容器实测：空库 `up`（151 张业务表 + seed 计数正确、`crypt` 可用）、285 库 stamp+seed、Compose `migrate` 服务执行成功、`go-api` 在 `GO_API_OWNED=health` 下 `/api/v1/health/live|ready` 均 200。生产 `linux/amd64` 镜像待 CI/有网环境复验。
