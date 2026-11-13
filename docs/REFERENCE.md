# 仓库深度参考（Reference）

> 本文件是**深度参考**，不被 ZCode 自动读取。指令性内容（CodeGraph / 测试 / 提交 / 部署规则）见 [`AGENTS.md`](../AGENTS.md)；`CLAUDE.md` 已弃用为薄壳。

---

## 业务模块说明（Business Modules）

- [库存补货分析](./库存补货分析.md)：库存健康、补货与清货动作的判定边界。
- [发货规划](./发货规划.md)：未来 180 天的供给情景模拟与销售上限；与正式货件管理分离（BLF-1284 实施中）。

## 架构（Architecture）

### Frontend → Backend 通信
前端**绝不直接连 PostgreSQL**。所有后端调用经 Next.js API 路由代理 `frontend/app/api/backend/[...path]/route.ts`，转发到 `BACKEND_API_BASE_URL`（默认 `http://127.0.0.1:8200`，即 Go 网关），带 `X-API-Key` / `X-User-Id` / `X-User-Name` / `X-Operator` / `X-Is-Admin` 头。网关在 `backend-go/internal/auth` 校验 `X-API-Key`，并额外支持 `GO_API_TRUSTED_PROXY_SECRET` 受信代理模式。

### Backend API（Go）
- 入口：`backend-go/cmd/gateway`；路由装配：`backend-go/internal/httpserver/router.go`
- 模块：`backend-go/internal/api/<module>/`（70 个模块，623 个 OpenAPI operation；每个模块自带 `registrar.go` 注册路由）
- 业务逻辑：`backend-go/internal/store/`（PostgreSQL 访问层）；异步任务：`backend-go/internal/queue` + `cmd/go-worker`；定时任务：`backend-go/internal/scheduler` + `cmd/go-scheduler`
- 面向 Agent 的读写 API（`/api/v1/agent/*`）设计与实施规格见 [`docs/agent-api-design.md`](./agent-api-design.md) + [`docs/superpowers/specs/2026-08-04-agent-readwrite-api-spec.md`](./superpowers/specs/2026-08-04-agent-readwrite-api-spec.md)

### Frontend 结构
- `frontend/app/dashboard/` — 页面（App Router）：`ai-panel/`、`ai-insights/`、`operations/`、`data-reporting/`、`data-analysis/`、`data-management/`、`system-management/`、`tools/`、`changelog/`
- `frontend/components/dashboard/`、`frontend/components/ui/`（shadcn）、`frontend/components/notifications/`
- `frontend/lib/` — 工具、auth、backend 代理；`frontend/app/api/backend/[...path]/route.ts` — 代理所有后端调用

### Auth
- 前端：NextAuth.js v4（`frontend/app/api/auth/[...nextauth]/route.ts`）
- 后端：`backend-go/internal/auth` 校验 `X-API-Key`（`API_KEY` 主密钥）或受信代理密钥；除 `/api/v1/health` 外全保护；请求级用户上下文来自 `X-Operator` / `X-User-Id` / `X-Is-Admin`

### Background Jobs（Go）
- `go-worker`：消费 Redis 队列（alerts / CRM / 月度报表 / AI 摘要等），对应 `backend-go/cmd/go-worker`
- `go-scheduler`：注册静态 job + insight 同步 + 定时报表分钟扫描，对应 `backend-go/cmd/go-scheduler`
- 两者与 `go-api` 共用同一个 `GO_API_IMAGE`，通过不同 entrypoint 启动；没有独立 HTTP 健康检查，用 `docker compose ps` 确认 Running。
- 定时报表截图在 `go-worker` 内通过 Obscura CDP 执行（`OBSCURA_CDP_URL`，默认 `http://127.0.0.1:9222`）；Obscura 启动时需用 `--font-dir` 加载 CJK 字体。旧 Playwright Chrome CLI 仅作为显式回退保留。

### autoReportUpload（遗留 Python，尚未迁移）
`autoReportUpload/` 是**仓库里最后一个 Python 运行时**，监控目录、识别报表并上传。它的实现依赖
`backend/app/**` 的共享代码（`app.utils.*`、`app.services.ad.upload.*`、`app.models`），而该目录已在
2026-11 的运行时下线中删除——**当前 main 上无法直接运行**。迁移方案与临时运行方式见
[`autoReportUpload/README.md`](../autoReportUpload/README.md)。

### AI Chat
外部 AI provider（env `AI_CHAT_PROVIDER_*`），联网搜索 `AI_CHAT_WEB_SEARCH_*`；历史存 `AIConversation` / `AIMessage`；`ai_insight` 端点提供 AI 数据洞察。

---

## 部署与重启服务（Deployment）

> 生产运行在 `/opt/believeboy-dashboard` 的 Docker Compose 栈（`network_mode: host`），
> 使用 GHCR 的 Web + Go API 两个镜像。PostgreSQL、Redis、Caddy 是宿主机公共设施。

### 服务清单

| 服务 | 端口 | 说明 |
|---|---|---|
| `migrate` | — | Go API 镜像内的 `go-migrate up`（Goose），一次性执行 |
| `go-api` | `127.0.0.1:8200` | Go 网关，承接全部 623 个 OpenAPI operation |
| `go-worker` | — | Go 异步任务 worker |
| `go-scheduler` | — | Go 定时任务调度器 |
| `web` | `127.0.0.1:3200` | Next.js 前端 |

> **FastAPI / Celery 已下线**：`backend/app` 已删除，Compose 里不再有 `api` / `celery` /
> `celery-scheduled` / `beat` 服务。`backend/deploy/systemd/` 只剩历史单元作排障参考，
> 生产必须保持 disabled。部署细节见 [dashboard-vps-compose.md](./deployment/dashboard-vps-compose.md)。

### 生产检查

```bash
cd /opt/believeboy-dashboard
docker compose ps
docker compose logs --tail=100 go-api go-worker go-scheduler web
curl -fsS http://127.0.0.1:8200/api/v1/health/live
curl -fsS http://127.0.0.1:3200/healthz
```

### Mac 本地开发（launchd）
仓库根 `deploy/launchd/` 是 Mac 本地开发对应物。**DB 现走本地生产快照**（`localhost:5432` 的 `BLF`，BEL-376 起常驻；详见 [TESTING.md](../TESTING.md#本地生产快照库bel-376-集成--手动读写测试)），`backend/.env` 的 `DATABASE_URL` 已指向它。

### 已知坑
- `ss -ltnp` 在沙箱看不到非自己用户的 socket，用 `docker compose ps` + `ps -ef | grep` 双确认。
- 网关健康检查用 `/api/v1/health` 与 `/api/v1/health/ready`；`/docs` 已不提供 Swagger UI。
- BFF 路由 404 通常漏 `pnpm build`（`app/api/.../route.ts` 改后必须 build）。

---

## 环境变量（Environment Variables）

**Frontend**（`frontend/.env.local`，Mac 本地）：`BACKEND_API_BASE_URL`、`BACKEND_API_KEY`、`NEXTAUTH_URL`、`NEXTAUTH_SECRET`。

**Backend**（`backend.env` / `go.env`）：`DATABASE_URL`、`API_KEY`（须匹配前端 `BACKEND_API_KEY`）、`GO_API_TRUSTED_PROXY_SECRET`、`UPLOAD_ROOT` / `RESULT_ROOT` / `MAX_UPLOAD_BYTES`、`AI_CHAT_PROVIDER_*`、`AI_CHAT_WEB_SEARCH_*`、`REDIS_*`。完整清单见 `backend/.env.example`。
> 注（BEL-376 更新）：`backend/.env` 现已**直接写入** `DATABASE_URL`，指向本地生产快照 `postgresql+psycopg://damon:<pw>@localhost:5432/BLF`（旧值曾误指向死端口 `55432`；更早的本地开发曾直连远程 VPS `145.79.143.98:5432`，均已弃用）。`TEST_DATABASE_URL` / `GO_API_TEST_DATABASE_URL` 在 `backend/.env.test`（gitignored）→ 本机 `brew` Postgres 的 `BLF_test`，供 Go 测试与 Playwright 隔离用（见 [TESTING.md](../TESTING.md#本地服务mac--brew)）。

---

## 数据库与迁移（Database）

PostgreSQL only，无 SQLite 回退。数据访问层在 `backend-go/internal/store/`，迁移已从 Alembic 切换到 **Goose**。

**Cutover 基线（2026-11-10，详见 [docs/deployment/goose-migration-cutover.md](./deployment/goose-migration-cutover.md)）**：Alembic 历史冻结在 revision 285；`backend/alembic/versions` 只归档、不再新增。`backend-go/internal/migrations/sql/00001_baseline.sql` 是 285 的完整 schema 快照，**禁止修改**。已有库（有 `alembic_version` = 285）运行 `migrate up` 时自动 stamp 为 Goose version 1，不重放 baseline，随后执行未应用的 seed/后续迁移；空库执行 baseline + seed；无 `alembic_version` 且非空的未知 schema 会拒绝执行。

**新迁移命名**：`YYYYMMDDHHMMSS_slug.sql`（14 位 UTC 时间戳 + 小写 snake_case），例如 `20261110153000_add_customer_tag.sql`；版本号必须唯一，已应用迁移禁止改名/改内容，修正一律用新迁移。

```bash
cd backend-go && go run ./cmd/newmigration add_customer_tag
# 编辑 Up/Down 后：
go run ./cmd/checkmigrations
```

**本地执行**（`DATABASE_URL` 必须指向目标库；`cmd/migrate` 会自动把 `postgresql+psycopg://` 转成 pgx DSN 并启用 simple protocol）：

```bash
cd backend-go
DATABASE_URL=postgresql://damon@127.0.0.1:5432/BLF_test go run ./cmd/migrate status
DATABASE_URL=postgresql://damon@127.0.0.1:5432/BLF_test go run ./cmd/migrate up
go run ./cmd/migrate version
```

**多 worktree**：没有 revision graph / merge heads；建迁移前先 `git fetch origin && git rebase origin/main`，时间戳撞车由后建者改名，绝不复用已存在版本号。迁移随 feature 分支同批 review/合并，保持向后兼容（生产回滚不自动回滚 DB）。

**机械检查**：`cd backend-go && go run ./cmd/checkmigrations` 校验 baseline SHA、Alembic 归档 manifest（任何变动即失败）、文件名/重复版本、goose Up/Down 标记；已接入 `git deploy`、`deploy/deploy-local.sh`、`productEnvAgent/deploy.sh` 与 `deploy-dashboard.yml`。

---

## 广告数据说明（Ad Data）

ad 报告现用 `ad_upload_files` 体系（**使用中**），取代旧 `analysis_source_files` + `analysis_ad_product_rows` 的 ad_product_report 路径（**已下线**：2026-06-01 alembic 152 删 27,445 行）。

- `ad_upload_promoted_product_rows` 对应 `AdUploadFile.report_type = 'ad_promoted_product_report'`
- 日期过滤用 `AdUploadFile.report_date`（单日上传 = `period_end_date`）
- scope 过滤：`AdUploadPromotedProductRow.scope_status == 'included_product'`

**决策记录 2026-06-01**：ad_product_report 从 A 表完整迁移到 C 表（`ad_upload_files` + `ad_upload_promoted_product_rows`）；10 个业务读取调用点已切换；新入口走 C 表；A 表数据已删，CHECK constraint 移除；`raw_row.__meta__` 保留迁移来源追溯。

---

## 代码检查（Lint）

后端是 Go：

```bash
cd backend-go
gofmt -l ./cmd ./internal        # 格式
go vet ./...                     # 静态检查（CI 门禁）
go test ./... -count=1           # 测试（CI 门禁）
```

**合并门禁**：`.github/workflows/test-ci.yml` 的 `backend-go test + vet`、`go-parity`、
`live-contract` 三个 job 全绿。Go 没有单独的 lint 工具链；`go vet` 是唯一的静态门禁，
新增检查工具（staticcheck / golangci-lint）前先确认对现有代码零告警，再接入 CI。

**PR 把关**：合并前由把关人完成语义复核（需求覆盖 / 契约一致 / 边界与错误处理 /
权限边界 / 调试残留 / commit author），并核对 PR 正文里的测试证据；高风险改动交用户拍板。
机器门禁全绿 + 语义复核通过才可合并。

> 历史：Python 时代用 ruff（`backend/ruff.toml`），已随 `backend/app` 一起删除。

---

## 测试规则（完整）

> **本地数据库（BLF-472）**：所有测试都调用**本地数据库**完成，不依赖远程 VPS——本地 Postgres（端口 5432）常驻 `BLF`（生产快照，每日与生产拉取同步，数据完备，供集成 / 手动读写 / 真实数据验证）与 `BLF_test`（测试隔离库）。测试一律走 `BLF_test`，绝不写 `BLF`。详见 [TESTING.md](../TESTING.md)。

每次前端/后端开发后仍走两轮测试（技术 + 业务），但技术测试**按变更面分流**、不默认全量：

**规则 1 技术测试（按变更面分流，不默认全量）**

表格场景用于初步归类；若与下方条件冲突，按更高档执行。判档命中任一 T3 条件即升 T3：① 改动跨模块复用的公共符号、共享契约或其行为（用 CodeGraph `callers` / `impact` 确认影响面）；② 改动迁移或权限逻辑；③ 改动 `internal/config` 的配置字段 / 默认值，或 `internal/store` 的字段映射、`internal/api/**/types.go` 的序列化契约。仅注释 / 文案改动不因此升档。字段级改动对目标集不可见，因此相关行为改动必须全量验证。

| 档 | 场景 | 后端 | 前端 |
| --- | --- | --- | --- |
| **T0** | 只改 `docs/`、注释或文案，且不改变运行行为 | 不跑 | 不跑 |
| **T1** | 叶子改动：单个工具函数 / 单个组件，仅影响局部实现，未触发 T3 条件 | 目标文件（~8s） | `vitest run <该文件/目录>`（~10s） |
| **T2** | 局部功能：新增端点 / 新页面，未触发 T3 条件 | 目标集 + 该目录回归 | Vitest 目标用例 + 该目录回归 + `pnpm lint` |
| **T3** | 跨模块 / 高风险：公共 hook、schema、model、**迁移**、权限、共享 utils | **全量（单次；耗时以当次实测为准）+ 失败集对账** | 全量（BLF-1238 已修好：235 文件 / 1660 例 / **~43s**，同机满载约 2 分钟）+ lint + `pnpm build` |

**E2E 不按 T 档一刀切：** 涉及登录、权限隔离、NextAuth、前后端代理或关键跨服务用户流程时，跑对应 Playwright 用例；纯业务逻辑 / API 行为优先用 Go 单测 / 契约测试覆盖，不为凑档位盲目跑 E2E。运行前按 [TESTING.md](../TESTING.md) 准备测试数据库与服务。前端命令：`cd frontend && pnpm test:ui -- tests/<area>/<name>.spec.ts`。

**为什么第 ③ 条旋钮要单列**：字段级改动对目标集天然不可见。BLF-1237 把 `avatar_max_bytes` 并进了上一行注释，`Settings` 丢字段、生产头像上传 500，而目标集 64 例全绿；且因 main 上同批用例本来就失败（R2 未配置），**失败集合一模一样，回归被完全掩盖**——只有全量跑才暴露。

**前端铁律（BLF-1238 后更新）**：T1/T2 **优先带路径过滤**（`vitest run <路径>`），但**全量 `pnpm test` 已可裸跑**——235 文件 / 1660 例 / **~43s**（本机较空闲）～**~2 分钟**（同机其他 agent 满载，实测 59s / 79s / 124s），T3 才需要。`pnpm build` 在 T3 和镜像发布前必须通过。判「挂住」不看绝对秒数，看是否在推进（见下条）。

**卡住判型（BLF-1238 教训）**：跑到 60s 仍无 `Test Files` 汇总 + 某 worker 长时间 100%+ CPU = 某文件**无限渲染循环**（不是「慢」）；`--testTimeout` / `vi.waitFor` 救不了（微任务链饿死计时器，表现为永久挂起而非超时失败）。二分与根因规则见 [TESTING.md](../TESTING.md) §前端单测。

**失败集对账（替代基线全量）**：PR 上全量只跑一次并记录失败项；仅对 main 上存在的失败用例文件，在相同命令 / 环境下对账一次，不再跑第二遍全量。PR 与 main 出现相同失败时，记录为既有失败，不误报为本次回归；新增用例无法在 main 对账，需单独复现。若失败不稳定，只定向重跑失败用例确认并记录；修复本次引入的问题，不用 `skip` / `xfail` 隐藏失败。BLF-1237 那轮 26 个既有失败只落在 8 个文件上，对账 10 秒，省掉一整轮 6 分钟。

**后端 T3 跑全量**：`cd backend-go && go test ./... -count=1`（CI 的 `backend-go test + vet` job 与 `go-parity` job 也会跑）。耗时受机器负载影响，不提供固定时间估计。

**不要用 `go test -p N` 并行多包共享同一测试库**：`BLF_test` 上的 fixture 会互相清表，多包并发会死锁或互相污染。需要并行时先给每个包独立数据库，另开任务。

- 前端命令：**按上表选要跑哪条，不是固定顺序**——`vitest run <路径>`（Vitest 单测，T1/T2 主力）、`pnpm lint`（2-5s，T2/T3）、`pnpm build`（T3 与镜像发布）。
- 后端命令：`cd backend-go && go test ./internal/api/<模块> -count=1`（单个包）或 `go test ./... -count=1`（T3 全量）。新增失败立即修；确认是基线既有失败的，按上面的失败集对账规则记录，不误报为本次回归。
- 前端单元测试已放开：Vitest（jsdom，配置 `frontend/vitest.config.ts`），`*.test.ts(x)` 放单元断言，组件交互用 `@testing-library/react`；新建纯函数 / 工具模块优先补单测。

> **实测数字口径**：本节引用的 420s / 900s、225 failed / 155 errors、380 例、26 个失败落在 8 个文件、对账 10 秒等，均为 **Damon 本机（macOS）2026-10-05 / 10-06 单次实测**，只用于说明量级与相对关系，**不是通用基准**；换机器 / 换分支 / 换库后请以当次实测为准。其中 420s / 900s 是 **BLF-1238 修复前**的前端挂起现象记录（已定位并修复，当前前端全量约 **43s 起、同机满载约 2 分钟**，2026-10-06 实测）。后端并行测试的耗时比较中，**6 分 42 秒是串行基准，5 分 02 秒是 10 worker 的失败试跑**；失败试跑有 380 例未完成，因此这组数据不能作为有效性能对比，失败试跑也不能视为全量结果。

**规则 2 业务测试（每次必做）**：功能完成后 AI 提供业务测试清单，用户手动执行并反馈。

**规则 3 反馈循环**：bug → 修复并重跑两轮测试；建议 → 记录评估。

### 如何向 AI 反馈
```markdown
## 测试反馈
**功能**：<功能名称>
**URL**：<测试页面 URL>

### 技术测试结果
- [ ] 前端构建通过
- [ ] 后端测试通过（如果有）

### 业务测试结果
| 测试项 | 结果 | 说明 |
|--------|------|------|
| 测试项 1 | ✅/❌ | 说明 |

### 问题/建议
1. <问题描述>
2. <建议>
```

---

## Git 提交与部署

### 提交规范
中文 + Conventional Commits：`<type>(<scope>): <subject>`。type 保留英文（feat/fix/docs/test/chore/refactor/perf/style/ci/revert），scope/subject 中文，subject 动宾短语 ≤50 字无句号，正文中文。详细见 `chinese-commit-conventions` 技能。

### Workflow
- 推送前：按 §测试规则 的分级跑（**不默认全量**）；前端 T1/T2 优先带路径过滤，全量 `pnpm test` 已可裸跑（BLF-1238 已修，~43s 起）；后端 T3 才跑全量并做失败集对账。
- 推送 + 部署：`git deploy` 先校验 main、Goose 迁移（含 Alembic 冻结归档）和 push，再执行 `deploy/deploy-local.sh`。
- `deploy/deploy-local.sh` 构建并推送 `believeboydashboard-web` / `believeboydashboard-api`，使用镜像 digest 部署 `/opt/believeboy-dashboard/docker-compose.yml`。
- PostgreSQL、Redis、Caddy 不进入 Compose；应用容器使用 host network 访问现有回环端口。
- Actions 只作手动备用：`gh workflow run deploy-dashboard.yml --ref main`。
- 只推代码：`PUSH_ONLY=1 git deploy`。
- 回滚与故障处理见 [dashboard-vps-compose.md](./deployment/dashboard-vps-compose.md)。

### Key Conventions
- **Projects API**：前端取项目列表用 `/api/v1/projects/manage`（非 `/api/v1/projects`）——`/manage` 按 `X-Operator` 过滤可见项目。
