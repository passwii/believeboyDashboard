# Phase 2 — Go API 服务（405 路由移植）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 0 + Phase 1 Exit Criteria 全绿

**Goal:** 用 Gin + sqlc 建起与 Python 行为一致的 API 服务，所有 405 路由按组移植完毕，每组有契约测试。

**Architecture:** `services/api` 三层：`handler`（Gin，只做参数绑定/鉴权/调用）→ `service`（编排，调 `pkg/` 领域包）→ `store`（sqlc 生成 + 手写 SQL）。读/写分离沿用 Python 语义（`get_read_db`→读副本，写走主库，副本故障熔断——对齐 `app/db/replica.py`）。

**新增依赖（锁版本）：** `gin-gonic/gin`、`github.com/jackc/pgx/v5`、`github.com/sqlc-dev/sqlc`（工具）、`golang-jwt/jwt/v5`、`golang.org/x/crypto`（bcrypt）、`redis/go-redis/v9`、`aws/aws-sdk-go-v2`（R2）、`resend/resend-go`（Phase 3 用，本 Phase 只接 SDK 初始化）。

## 路由分组与源文件映射（405 装饰器，按 9 个 router_group + 3 特殊组）

| 组 | Go 包 | Python 源 | 规模 |
|----|-------|-----------|------|
| auth+users+profile | `internal/auth` | `endpoints/auth.py`、`users.py`、`profile.py`、`core/security.py`、`core/passwords.py`、`middleware/agent_api_audit.py` | 先做（所有组依赖鉴权） |
| ads | `internal/ads` | `endpoints/ad_analysis.py`、`ad_upload.py` + `router_groups/ads_group.py` | — |
| ai | `internal/ai` | `endpoints/ai_chat.py`、`ai_chat_v2.py`、`ai_chat_usage.py`、`ai_file_upload.py`、`ai_insight.py` + `services/ai/`（orchestrator/runner、stream bus、llm.py、tools.py） | 最难，单独 Task |
| analysis | `internal/analysis` | `daily_analysis.py`、`product_analysis.py`、`product_analysis_reports.py`、`return_analysis.py`、`category_research.py`、`order_info.py`、`platform_revenues.py`、`report_reconciliation.py`、`vat_invoices.py`、`exchange_rates.py` | 最大组 |
| crm | `internal/crm` | `endpoints/crm.py` + `services/crm/`（21 文件） | — |
| digital | `internal/digital` | `digital_employees.py`、`digital_office.py`、`digital_display.py` | 含 `office_tick` 对接（Phase 3） |
| inventory | `internal/inventory` | `inventory_ledger.py`、`inventory_ledger_common.py`、`inventory_replenishment.py`、`inventory_replenishment_snapshots.py`、`shipment_schedules.py`、`sku_info.py` | — |
| pricing | `internal/pricing` | `pricing_calculation.py`、`pricing_calculation_snapshots.py`、`shop_calculation.py`、`new_product_calculations.py` | 调 Phase 1 `pkg/pricing` |
| reporting | `internal/reporting` | `scheduled_reports.py`、`monthly_reports.py`、`jobs.py`、`internal_jobs.py`、`notifications.py`、`notification_settings.py`、`page_render.py`、`uploads.py`、`rpa_reports.py` | 写侧多，对接 Phase 3 |
| system_extra | `internal/system` | `system_management/`（7 文件 + commission/） | 佣金走资金红线 |
| agent（30 文件） | `internal/agentapi` | `endpoints/agent/` 全目录 + `api/agent/`（鉴权/scope/限流）+ `_whitelist.py` | Bearer+Agent-Id 双头鉴权原样搬 |
| misc | `internal/misc` | `health.py`（Phase 0 已做，补全）、`projects.py`、`project_goals.py`、`inspections.py`、`alerts.py`、`presence.py` | — |

Schema 映射：`app/schemas/` 49 文件 → sqlc 生成的 model + 手写 `api.go` 请求/响应 struct；字段名保持 snake_case JSON（前端 `lib/*-api.ts` 不用改——这是硬约束，契约测试断言）。

## 任务

### Task 2.1：`store` 层地基（pgx pool + 读/写分离 + sqlc 管线）

- [ ] Step 1: `internal/store/db.go`：pgxpool 主库 + 可选读副本（`database_read_url` 为空则复用主库——与 `deps.py get_read_db` 语义一致）+ 熔断计数器（对齐 `replica.py`）。
- [ ] Step 2: `internal/store/sqlc.yaml` + `queries/*.sql` 首批（auth + projects + sku 基础查询）；`make sqlc-generate` 接入 Makefile。
- [ ] Step 3: Redis 客户端（`go-redis`，对齐 `app/db/redis.py` 的 key 前缀与 TTL：`DAILY_ANALYSIS` 5min 等——常量表从 `services/infra/cache.py` 搬）。
- [ ] Step 4: Commit：`feat(go): store 地基（读写分离+sqlc+redis）`。

### Task 2.2：鉴权与中间件（`internal/auth` + `internal/middleware`）

- [ ] Step 1: JWT（`core/security.py` 语义：算法/过期/刷新）+ bcrypt（`passwords.py` cost 对齐）+ API Key（`require_api_key`）+ Agent 双头鉴权（`Agent-Id` + Bearer + scope 门控 + `_whitelist.py` 白名单）。
- [ ] Step 2: 中间件：`trace_id` 注入（Phase 0 logging）、Agent API 审计日志（`middleware/agent_api_audit.py` → 写 `agent_api_audit_log` 表，采样规则原样搬）、慢查询日志、CORS（对齐 `main.py`）、限流（slowapi 规则 → Go 令牌桶，key 粒度一致）。
- [ ] Step 3: 契约测试：`auth.py` 的 login/refresh/me 全流程 + Agent 非法 scope 被拒用例。Commit：`feat(go): 鉴权与中间件`。

### Task 2.3–2.12：按组移植（每组一个 Task，同一模板，不含 ai 组）

每组执行以下 6 步（以 `pricing` 组为例写出，其余组替换包名/源文件）：

- [ ] Step 1: 用 CodeGraph `callers` 列出该组 handler 调用的 service 函数清单（防漏）。
- [ ] Step 2: 先写契约测试（`internal/pricing/contract_test.go`）：seed `BLF_test` → 调 **Python 版**录制响应 → 调 Go 版 → `DiffJSON`。先红。
- [ ] Step 3: 写 `queries/pricing.sql`（sqlc）+ `service.go`（调 Phase 1 `pkg/pricing`）+ `handler.go`（Gin 路由，路径**一字不差**，含 `/api/v1` 前缀与 trailing slash 行为）。
- [ ] Step 4: 跑绿契约测试；逐个 endpoint 在测试里打勾（checklist 写进文件头注释）。
- [ ] Step 5: `.all()` + Python 侧聚合循环一律改写为 SQL 聚合或 `pkg/aggregate`（见 Phase 1-Task 1.4 决策树；`aggregator.py` 930 行是重点）。
- [ ] Step 6: Commit：`feat(go): <组名>路由移植（N/M 端点，契约全绿）`。

组顺序（依赖排序）：misc(projects/health) → auth 已做 → inventory → pricing → analysis → ads → crm → digital → reporting → system → agent（agent 最后，因它横跨所有读侧）。

### Task 2.13：AI 组专项（`internal/ai`，最高风险）

**源：** `endpoints/ai_chat.py`、`ai_chat_v2.py`（stream/cancel）、`ai_insight.py`（`time.sleep(2)` 在 216 行——Go 版删掉，用正常 SSE 心跳代替）、`services/ai/`（orchestrator/runner.py、stream bus、protocol SSE 编码、llm.py 重试、tools.py Tavily、context_parser.py）。

- [ ] Step 1: SSE 事件格式**字节级对齐** `protocol/` 编码（含事件名/重试字段/错误帧），前端 `components/chat` 不用改是验收标准。
- [ ] Step 2: stream 取消（cancel 路由 → context 取消 → LLM 请求中断 + token 上报），并发取消单测（`insight_concurrency.py` 语义）。
- [ ] Step 3: 工具调用（Tavily web search）→ function-calling schema 手写客户端；`api_base_url` 参数名坑（requirements 注释）写进代码注释。
- [ ] Step 4: Token 用量快照（`ai_chat_token_usage` 表写入语义一致）。Commit：`feat(go): AI 聊天与洞察流式 API`。

### Task 2.14：文件上传/R2 链路（`internal/uploads`）

**源：** `endpoints/uploads.py`、`ai_file_upload.py`、`page_render.py` + `services/artifact_service.py`（R2 key 列自发现、dead-letter `r2_delete_failures`、URL/key 双向转换）。

- [ ] Step 1: aws-sdk-go-v2 + R2 endpoint（S3 兼容）+ 预签名 URL（过期时间与 Python 一致）。
- [ ] Step 2: dead-letter 表语义原样搬（含重试任务归 Phase 3）。Commit：`feat(go): 上传与 R2 链路`。

## Exit Criteria

- [ ] 405 路由装饰器逐个在契约测试中打勾（`grep -c` 对账：测试覆盖的路由数 == 405）
- [ ] JSON 字段名与 Python 版逐字节一致（前端零改动）
- [ ] `go vet` + `make lint` 全绿；`internal/agentapi` 非法 scope 用例全绿
- [ ] SSE 事件流与 Python 版字节级一致（diff  harness 对比 3 个真实会话）
