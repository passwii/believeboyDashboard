# FastAPI 逐步重构至 Go 后端总规划与多 Sub-Agent 协同实施方案 (Master Plan)

> **版本：** v1.0.0
> **创建日期：** 2026-11-07
> **实施状态：** 静态路由实现已全量对账完成（623/623 OpenAPI operation owned）；等待独立 Reviewer、本地全量验证记录与运行期 fallback 观察。**未部署、未切流。**
> **适用范围：** BelieveBoy Dashboard 后端架构从 FastAPI (Python) 向 Go (`backend-go`) 全量渐进迁移，以及后续多 Agent/Sub-Agent 并行重构跟踪。

---

## 1. 执行摘要与重构目标 (Executive Summary & Goals)

### 1.1 背景现状
当前 BelieveBoy Dashboard 拥有庞大的 FastAPI (Python 3.12) 后端体系：
- **代码规模**：694 个 Python 源码文件，约 **170,169 行代码**；单测 387 个文件，约 **108,058 行代码**。
- **路由规模**：OpenAPI 契约共 **527 paths / 623 operations**；FastAPI AST 另含 18 条 `include_in_schema=false` 兼容路由。
- **业务实现**：341 个 Service 文件，约 **97,070 行业务逻辑**。
- **后台异步体系**：29 个任务文件，包含 **18 个 Celery 任务** 与 **10 个 Celery Beat 定时调度**。
- **Alembic 迁移**：261 个迁移版本，为当前 PostgreSQL 数据库唯一的 Schema 真源。

`backend-go` 网关（监听 `127.0.0.1:8200`）已完成全部域 Registrar 的中央接线；运行期仍通过 `GO_API_OWNED` 选择实际接管子集，未接管路由继续透明代理给 FastAPI (`127.0.0.1:8100`)。静态路由对账见 `stage7-route-coverage-audit.md` / `stage7-route-manifest.json`。

### 1.2 核心目标 (Goals)
1. **零停机平滑迁移**：通过 Go 网关反向代理与 `GO_API_OWNED` 模块化灰度开关，按 URL 域与业务切片逐个接管，支持单模块秒级回退至 FastAPI。
2. **100% 契约兼容 (Wire-Compatibility)**：保持所有已有接口的 JSON 字段（`snake_case`）、状态码、微秒级 RFC 3339 时间戳以及标准错误结构（`{"detail": "..."}`）严格对齐，前端与移动/桌面客户端零改动无感切换。
3. **多 Sub-Agent 并行重构**：制定严格的垂直切片隔离规范与公共基础支持（公共审计、事务辅助、模块自注册），消除并发冲突，支持 3~4 个 Sub-Agent 并行改写不同业务函数与端点。
4. **终局 Python 下线**：在完成 API、后台任务引擎（Asynq / gocron 替代 Celery）及数据迁移交接后，下线 FastAPI 与 Celery 容器，实现纯 Go 原生高并发、低内存常驻后端。

---

## 2. 目标架构与网关拓扑 (Target Architecture)

```text
                                 ┌──────────────────────────────┐
                                 │   Caddy (127.0.0.1:80/443)   │
                                 └──────────────┬───────────────┘
                                                │
                                    dash-api.believeboy.com
                                                │
                                                ▼
                                 ┌──────────────────────────────┐
                                 │   backend-go (Port 8200)     │
                                 │       Go API Gateway         │
                                 └──────┬────────────────┬──────┘
                                        │                │
                        [Owned Modules] │                │ [Unowned Fallback]
                                        ▼                ▼
                          ┌──────────────────┐   ┌──────────────────┐
                          │ Go Handlers      │   │ FastAPI (8100)   │
                          │ - Chi Router     │   │ - Uvicorn Worker │
                          │ - pgxpool Pool   │   │ - SQLAlchemy ORM │
                          │ - Native Services│   │ - Legacy Celery  │
                          └─────────┬────────┘   └─────────┬────────┘
                                    │                      │
                                    └───────────┬──────────┘
                                                ▼
                                 ┌──────────────────────────────┐
                                 │  PostgreSQL (Port 5432)      │
                                 │  - Primary: BLF              │
                                 │  - Test: BLF_test            │
                                 │  - Read Replica (Optional)   │
                                 └──────────────────────────────┘
```

### 2.1 网关所有权与动态回退
- 环境变量 `GO_API_OWNED` 控制接管模块，格式为逗号分隔字符串，例如：
  `GO_API_OWNED=health,exchange_rates,notifications,alerts,profile,projects,users`
- 路由匹配规则：
  - 若命中已接管模块：由 Go 原生 Handler 处理。
  - 若未接管：由 `httputil.ReverseProxy` 转发至 `FASTAPI_ORIGIN`（默认 `http://127.0.0.1:8100`）。
  - 代理层完整保留 `Authorization`、`X-API-Key`、`api_key` 查询参数、SSE/流式分块、Multipart 文件上传及请求取消通知。

### 2.2 鉴权与上下文体系 (Authentication & Context)
- **Web 端受信代理**：Next.js 服务端发出的请求携带 Master API Key 与共享密钥头 `X-Trusted-Proxy-Secret`（`GO_API_TRUSTED_PROXY_SECRET`）。Go 网关验证通过后，在向下游 FastAPI 代理时剥离该头，防止外泄。
- **设备/客户端直连**：桌面端或移动端携带用户设备 Key，Go 网关通过 `user_api_keys` -> `user_accounts` 表校验 SHA-256 哈希，提取权威身份生成强类型 `UserContext` 注入 Context：
  - `UserID`, `Email`, `Name`, `Operator`, `RoleType`, `SessionID`, `IsAdmin`
  - 严禁信任客户端自行伪造的 `X-User-Id` 或 `X-Operator`。

### 2.3 数据库模型与 Alembic 契约
- **唯一真源**：在 API 全量重构完成前，PostgreSQL 表结构、索引、约束完全由 Alembic 迁移（`backend/alembic/versions`）管理。
- **Go 数据库映射**：Go 采用 `jackc/pgx/v5`，严格匹配数据库现有列名与类型，禁止在 Go 端擅自执行 DDL 变更表结构。

---

## 3. 多 Sub-Agent 并行重构规范 (Sub-Agent Working Protocol)

为了支持多个 Sub-Agent 同时进行不同模块/函数的改写，必须遵守以下严格规范：

### 3.1 垂直切片隔离 (Vertical Slice Principle)
- **单一职责目录**：
  每个 Sub-Agent 只能操作自己的独立业务目录：
  - Handler 层：`backend-go/internal/api/<domain>/handler.go` 及 `handler_test.go`
  - Store 接口：在 `internal/api/<domain>/` 中定义 `Store` 接口
  - Store 实现：`backend-go/internal/store/<domain>.go` 及 `internal/store/<domain>_test.go`
  - SQL 查询源：`backend-go/internal/store/queries/<domain>.sql`
- **公共文件防冲突规则**：
  - Sub-Agent **严禁**直接编辑 `backend-go/internal/httpserver/routes.go` 与 `backend-go/cmd/gateway/dependencies.go`。
  - 各模块通过导出标准的 `RegisterRoutes` 契约或自注册机制注入。
  - 统一由 Lead Agent 或任务负责人将模块接驳至路由表。

### 3.2 严格的数据契约标准 (Contract Invariants)
1. **JSON 命名**：所有对外 DTO 结构体的 `json` tag 必须严格为 `snake_case`，与现有 FastAPI Pydantic schema 逐字对齐。
2. **时间戳格式**：必须使用 `httpapi.Timestamp(t)` 或 `httpapi.OptionalTimestamp(t)`，输出微秒精度的 RFC 3339 字符串（如 `2026-10-01T02:03:04.123000Z`）。
3. **错误响应体**：统一调用 `httpapi.WriteDetail(w, statusCode, "错误信息")`，生成 `{"detail": "..."}` 格式响应。
4. **分页响应格式**：统一包含 `items`, `total`, `page`, `page_size`。

### 3.3 测试驱动开发与双重门禁 (TDD & Dual Gate)
- **静态契约测试**：Sub-Agent 必须提供 `backend-go/tests/contract/<domain>_contract_test.go`，使用 Mock Store 验证空态、正常态、参数校验与错误分支。
- **动态契约对账**：通过 `tests/contract/live_contract_test.go`，在本地测试库（`BLF_test`）上对齐同一参数下 Go 与 FastAPI 的响应 Key 集合与数值类型。
- **单元测试全绿**：提交前必须保证 `cd backend-go && go test ./...` 耗时在 10s 内且 100% 通过。

---

## 4. P0 基础设施规范 (Stage 0 Infrastructure)

在派发 Sub-Agent 前，主工程先行固化以下 4 大公共组件：

### 4.1 操作审计公共服务 (`backend-go/internal/audit`)
FastAPI 广泛嵌入了 `append_operation_audit_log` 与 `append_operation_view_log`，写入 `operation_audit_logs` 表。
Go 统一抽象 `AuditService`：
```go
type AuditEntry struct {
    Action         string
    TargetType     string
    TargetID       *string
    Operator       *string
    TraceID        *string
    RequestMethod  string
    RequestPath    string
    IPAddress      *string
    UserAgent      *string
    BeforeJSON     any
    AfterJSON      any
    AgentID        *string
    AgentName      *string
    IdempotencyKey *string
    Result         string
    ErrorMessage   *string
}

type Service interface {
    LogAction(ctx context.Context, entry AuditEntry) error
    LogView(ctx context.Context, action string, targetType string, operator *string, after any, r *http.Request) error
}
```

### 4.2 数据库事务封装 (`backend-go/internal/store`)
扩展 `store.DB` 接口支持事务并提供原子执行闭包：
```go
type DB interface {
    Query(ctx context.Context, sql string, args ...any) (Rows, error)
    QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
    Ping(ctx context.Context) error
    Begin(ctx context.Context) (pgx.Tx, error)
}

func RunInTx(ctx context.Context, db DB, fn func(tx pgx.Tx) error) error
```

### 4.3 分页解析与 DTO 增强 (`backend-go/internal/httpapi`)
提供通用分页参数解析：
```go
type PaginationParams struct {
    Page     int
    PageSize int
    Offset   int
}

func ParsePagination(r *http.Request, defaultPageSize, maxPageSize int) PaginationParams
```

### 4.4 模块自注册机制 (`backend-go/internal/httpserver`)
解耦中心化路由，各模块通过配置判定并挂载。

---

## 5. 阶段与分期实施细化 (Stages & Phases Breakdown)

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Stage 0: 基础设施先行 (Lead Agent)                                                │
│ 交付 internal/audit, store.RunInTx, httpapi.Pagination, 自注册机制               │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 1: 权限与主数据闭环 (3 Sub-Agents 并发)                                     │
│ ├── 1A: 认证、用户与系统凭据 (auth, users, internal_keys)                         │
│ ├── 1B: 项目主数据与工作流 (projects, project_shops, project_workflows)           │
│ └── 1C: 既有接管模块写闭环 (exchange_rates_write, alerts_write, notifications_write)│
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 2: 核心电商运营链路 (3 Sub-Agents 并发)                                     │
│ ├── 2A: 订单与商品主数据 (order_info, sku_info)                                   │
│ ├── 2B: 发货排期与库存台账 (shipment_schedules, shipping_plan, inventory_ledger) │
│ └── 2C: 补货分析与客诉中心 (inventory_replenishment, complaints, product_label) │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 3: 价格测算与毛利模型 (3 Sub-Agents 并发)                                   │
│ ├── 3A: 定价测算与目录快照 (pricing_calculation, pricing_calculation_snapshots)  │
│ ├── 3B: 新品测算与对比导出 (new_product_calculations)                             │
│ └── 3C: 店铺级综合测算模型 (shop_calculation)                                    │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 4: 数据分析与财务对账 (3 Sub-Agents 并发)                                   │
│ ├── 4A: 每日分析与 KPI 大盘 (daily_analysis, project_goals)                       │
│ ├── 4B: 广告分析、RPA 上报与投放 (ad_analysis, rpa_reports, ad_upload)           │
│ └── 4C: 财务结算、税费与对账 (platform_revenues, vat_invoices, report_reconciliation)│
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 5: Agent 开放生态全量接管 (2 Sub-Agents 并发)                              │
│ ├── 5A: Agent 鉴权框架与两步确认 (AgentApiKey, Scope, RateLimit, ConfirmKey)     │
│ └── 5B: Agent 30+ 业务端点映射 (/api/v1/agent/* 复用底层 Go Store)               │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 6: 异步任务引擎与报表生成 (Lead Agent / 2 Sub-Agents)                      │
│ ├── 6A: Asynq 队列架构与 18 个后台任务移植 (替代 Celery Worker)                   │
│ ├── 6B: Gocron 定时调度器移植 (替代 Celery Beat 10 项定时任务)                    │
│ └── 6C: 月报长任务引擎与 Excel/PDF 导出 (monthly_reports)                         │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────▼─────────────────────────────────────────┐
│ Stage 7: AI 交互、长连接与 Python 终局下线 (Lead Agent)                           │
│ ├── 7A: AI Chat / AI Insight / Digital Office 流式长连接迁移                      │
│ └── 7B: 数据库迁移工具移交 (Alembic 固化/转换)，彻底下线 FastAPI 容器             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Stage 1 细化清单 (Phase 1A / 1B / 1C)

#### Phase 1A: 认证、用户与系统凭据
- **涉及端点**：
  - `POST /api/v1/auth/login` (密码校验、会话颁发、设备 Key 登记)
  - `GET /api/v1/auth/me` (当前登录身份获取)
  - `GET/POST/PATCH/DELETE /api/v1/users` (用户管理 CRUD)
  - `GET/POST/DELETE /api/v1/internal/api-keys` (主 API 密钥轮换与管理)
  - `GET/POST/DELETE /api/v1/internal/user-api-keys` (用户设备密钥绑定与解绑)
- **数据库表**：`user_accounts`, `user_api_keys`, `api_keys`, `sessions`, `operation_audit_logs`
- **核心逻辑**：Argon2/bcrypt 密码校验、Redis 会话同步、审计日志记录。

#### Phase 1B: 项目主数据与工作流
- **涉及端点**：
  - `GET /api/v1/projects` (项目选项列表)
  - `GET /api/v1/projects/manage` (按操作人/管理员权限过滤的项目列表)
  - `GET /api/v1/projects/operator-options` (操作人枚举)
  - `POST /api/v1/projects` (创建项目 + 审计)
  - `PATCH /api/v1/projects/{project_id}` (更新项目 + 审计)
  - `GET /api/v1/projects/{project_id}/shops` (店铺映射列表)
  - `PUT /api/v1/projects/{project_id}/shops/{country}` (更新店铺及 Seller 别名对照)
  - `DELETE /api/v1/projects/{project_id}/shops/{country}` (解绑店铺)
  - `GET/POST /api/v1/projects/{project_id}/context` (项目背景配置及 JSON Merge Patch)
  - `GET /api/v1/project-workflows/*`, `GET/POST /api/v1/project-workflow-templates/*`
- **数据库表**：`projects`, `project_shops`, `project_workflows`, `project_workflow_templates`, `operation_audit_logs`
- **核心逻辑**：操作人过滤鉴权、SellerIdentity 变更比对与敏感审计。

#### Phase 1C: 既有接管模块写闭环
- **涉及端点**：
  - `POST /api/v1/exchange-rates` (新增汇率)
  - `PUT /api/v1/exchange-rates/{id}` (修改汇率)
  - `DELETE /api/v1/exchange-rates/{id}` (删除汇率)
  - `POST /api/v1/notifications/{id}/read` (标为已读)
  - `POST /api/v1/notifications/mark-all-read` (全部已读)
  - `DELETE /api/v1/notifications/{id}` (删除通知)
  - `POST/PATCH/DELETE /api/v1/alerts/rules` (告警规则 CRUD)
  - `POST /api/v1/alerts/events/{id}/acknowledge` (告警确认)
  - `POST /api/v1/alerts/events/{id}/resolve` (告警解决)
  - `GET/POST/PUT/DELETE /api/v1/notification-settings` (通知偏好设置)
- **数据库表**：`exchange_rates`, `notifications`, `alert_rules`, `alert_events`, `notification_settings`

### Stage 2 细化清单 (Phase 2A / 2B / 2C)

#### Phase 2A: 订单与商品主数据
- **涉及端点**：
  - `GET /api/v1/order-info/page` (订单首屏聚合数据)
  - `GET /api/v1/order-info/list` (订单列表分页)
  - `GET /api/v1/order-info/stats` (顶部统计)
  - `GET /api/v1/order-info/overview` (列表 + 统计聚合)
  - `GET /api/v1/order-info/filter-options` (筛选条件选项)
  - `GET /api/v1/order-info/live-stream` (今日出单事件流)
  - `POST /api/v1/order-info/export` (导出 CSV)
  - `PATCH /api/v1/order-info/{order_id}` (FBM 订单补录与更新)
  - `GET /api/v1/sku-info`, `GET /api/v1/product-costs` (SKU 列表)
  - `POST /api/v1/sku-info`, `POST /api/v1/product-costs` (创建/更新 SKU)
  - `POST /api/v1/sku-info/bulk`, `POST /api/v1/product-costs/bulk` (批量创建/更新)
  - `PATCH /api/v1/sku-info/{sku_record_id}`, `PATCH /api/v1/product-costs/{sku_record_id}` (局部更新)
  - `DELETE /api/v1/sku-info/{sku_record_id}`, `DELETE /api/v1/product-costs/{sku_record_id}` (删除 SKU)
  - `POST /api/v1/sku-info/{sku_record_id}/move`, `POST /api/v1/product-costs/{sku_record_id}/move` (调整排序)
  - `POST /api/v1/sku-info/import-csv`, `POST /api/v1/product-costs/import-csv` (CSV 导入)
  - `GET /api/v1/sku-info/export` (导出 CSV)
  - `POST /api/v1/sku-info/recalculate-first-leg-costs` (重算头程运费)
  - `GET /api/v1/sku-info/sync-first-leg-from-shipment` (从发货汇总同步头程运费)
  - `POST /api/v1/sku-info/batch-parse-factory-info` (解析工厂属性)
  - `POST /api/v1/sku-info/batch-update-factory-info` (批量更新工厂属性)
  - `POST /api/v1/sku-info/batch-update-listing-copy` (批量更新产品文案)
  - `POST /api/v1/sku-info/fnsku-labels/by-skus` (批量查询 FNSKU 标签)
- **数据库表**：`analysis_sales_order_rows`, `analysis_source_files`, `product_costs`, `projects`, `operation_audit_logs`

#### Phase 2B: 发货排期与库存台账
- **涉及端点**：
  - `GET /api/v1/shipment-schedules` (发货排期分页列表)
  - `GET /api/v1/shipment-schedules/cost-summary` (发货费用汇总)
  - `GET /api/v1/shipment-schedules/sku-summary` (SKU 发运汇总)
  - `GET /api/v1/shipment-schedules/fba-box-details` (FBA 箱规明细)
  - `GET /api/v1/shipment-schedules/batches` (批次选项列表)
  - `DELETE /api/v1/shipment-schedules/batches/hidden` (隐藏批次)
  - `GET /api/v1/shipment-schedules/{schedule_id}` (发货排期详情)
  - `POST /api/v1/shipment-schedules` (创建发货排期)
  - `PATCH /api/v1/shipment-schedules/{schedule_id}` (更新发货排期)
  - `DELETE /api/v1/shipment-schedules/{schedule_id}` (删除发货排期)
  - `POST /api/v1/shipment-schedules/import-csv` (导入排期)
  - `POST /api/v1/shipment-schedules/{schedule_id}/items/import-csv` (导入排期项)
  - `POST /api/v1/shipment-schedules/{schedule_id}/costs/calculate` (重算物流费用)
  - `GET /api/v1/shipping-plan/skus` (发运计划 SKU 列表)
  - `GET /api/v1/shipping-plan/forecast` (SKU 销量与库存预测)
  - `PUT /api/v1/shipping-plan/skus/{sku}/growth-factor` (更新增长系数)
  - `GET /api/v1/shipping-plan/shipment-history` (发运历史对照)
  - `GET /api/v1/shipping-plan/batches` (发货批次计划)
  - `POST /api/v1/shipping-plan/batches` (创建发货批次计划)
  - `PATCH /api/v1/shipping-plan/batches/{batch_id}` (更新发货批次计划)
  - `POST /api/v1/shipping-plan/batches/{batch_id}/cancel` (取消批次计划)
  - `POST /api/v1/shipping-plan/batches/{batch_id}/allocations` (分配发货排期)
  - `DELETE /api/v1/shipping-plan/allocations/{allocation_id}` (取消排期分配)
  - `GET /api/v1/inventory-ledger/months` (库存账期月份列表)
  - `GET /api/v1/inventory-ledger/snapshot` (月度期末库存快照)
  - `GET /api/v1/inventory-ledger/events` (月度出入库事件流)
  - `GET /api/v1/inventory-ledger/receipt-clusters` (入库批次聚类)
  - `GET /api/v1/inventory-ledger/location-detail` (库位及处置状态明细)
  - `GET /api/v1/inventory-ledger/trend` (多月库存趋势)
  - `GET /api/v1/inventory-ledger/detail` (明细事件台账)
  - `GET /api/v1/inventory-ledger/summary` (每日水位流水台账)
  - `GET /api/v1/inventory-ledger/batches` (上传批次溯源)
  - `GET /api/v1/inventory-ledger/consistency` (账实对账校验)
  - `GET /api/v1/inventory-ledger/month-analysis` (月度综合全景数据)
- **数据库表**：`shipment_schedules`, `shipment_schedule_items`, `shipping_plan_batches`, `shipping_plan_items`, `shipping_plan_allocations`, `shipping_plan_sku_settings`, `inventory_ledger_summary`, `inventory_ledger_detail`, `inventory_ledger_ingest_batches`, `operation_audit_logs`

#### Phase 2C: 补货分析与客诉中心
- **涉及端点**：
  - `GET /api/v1/inventory-analysis` (库存风险基础分析)
  - `GET /api/v1/inventory-snapshot-options` (补货分析快照列表)
  - `GET /api/v1/inventory-replenishment-analysis` (全维度补货建议列表)
  - `PUT /api/v1/inventory-replenishment-settings/{project_id}/{sku}` (补货参数设置)
  - `GET /api/v1/inventory-replenishment-shipments` (补货关联在途发货)
  - `GET /api/v1/inventory-replenishment-calendar` (补货履约日历)
  - `GET /api/v1/seasonal-replenishment-analysis` (季节性波动分析)
  - `GET/POST /api/v1/inventory-replenishment-snapshots` (补货历史快照归档与创建)
  - `PUT/DELETE /api/v1/inventory-replenishment-snapshots/{snapshot_id}` (快照修改与删除)
  - `GET /api/v1/complaints/overview` (客诉指标大盘与近 30 天趋势)
  - `GET /api/v1/complaints` (客诉对话列表及筛选)
  - `GET /api/v1/complaints/{complaint_id}` (客诉明细与买家历史记录)
  - `PATCH /api/v1/complaints/{complaint_id}` (状态流转与处理备注)
  - `POST /api/v1/product-label/generate` (PDF 产品标签文案叠加制作)
- **数据库表**：`inventory_replenishment_settings`, `inventory_replenishment_snapshots`, `complaints`, `complaint_runs`, `shop_checks`, `operation_audit_logs`


### Stage 3 细化清单 (Phase 3A / 3B / 3C) - [已完成]

#### Phase 3A: 定价测算引擎与快照
- **涉及端点**：
  - `POST /api/v1/pricing-calculation/quote` (FBA / FBM 正向测算，包含佣金、头程、仓储、配置费)
  - `POST /api/v1/pricing-calculation/quote-fbm` (FBM 专用正向测算)
  - `POST /api/v1/pricing-calculation/reverse-price` (目标毛利反向倒推建议售价)
  - `POST /api/v1/pricing-calculation/reverse-cost` (目标毛利反向倒推采购/头程目标成本)
  - `POST /api/v1/pricing-calculation/eu-accounting` (欧洲站 VAT 与税后毛利核算)
  - `GET /api/v1/pricing-calculation/runs` (历史测算运行分页列表)
  - `GET /api/v1/pricing-calculation/runs/{run_id}` (单次测算运行详情)
  - `POST /api/v1/pricing-calculation/runs` (持久化保存测算运行记录)
  - `GET /api/v1/pricing-calculation-snapshots` (定价快照目录分页查询)
  - `GET /api/v1/pricing-calculation-snapshots/{snapshot_id}` (获取单张定价快照)
  - `POST /api/v1/pricing-calculation-snapshots` (新建定价快照，带审计日志)
  - `PATCH /api/v1/pricing-calculation-snapshots/{snapshot_id}` (更新定价快照，带审计日志)
  - `DELETE /api/v1/pricing-calculation-snapshots/{snapshot_id}` (软删除定价快照，204 语义)
- **数据库表**：`pricing_calculation_runs`, `pricing_calculation_snapshots`, `exchange_rates`, `projects`, `product_costs`, `operation_audit_logs`

#### Phase 3B: 新品测算与对比导出
- **涉及端点**：
  - `GET /api/v1/new-product-calculations` (新品核算分页列表)
  - `GET /api/v1/new-product-calculations/{project_id}/{sku}` (获取单个新品核算)
  - `POST /api/v1/new-product-calculations` (创建/更新新品核算快照 upsert，支持新商品无成本主数据模式与客户端预计算数据直存)
  - `DELETE /api/v1/new-product-calculations/{snapshot_id}` (删除新品核算，204 语义)
- **数据库表**：`new_product_calculations`, `projects`, `product_costs`, `operation_audit_logs`

#### Phase 3C: 店铺级综合测算模型
- **涉及端点**：
  - `GET /api/v1/shop-calculation` (当前生效店铺级利润测算模型)
  - `GET /api/v1/shop-calculation/history` (历史测算版本列表)
  - `POST /api/v1/shop-calculation` (保存/追加当前测算模型)
  - `DELETE /api/v1/shop-calculation/{id}` (删除测算快照)
  - `GET /api/v1/shop-calculation/aggregate` (总营收、总平台费用、采购成本、DDP、利润及综合毛利率聚合大盘)
- **数据库表**：`shop_calculations`, `projects`, `operation_audit_logs`

---

### Stage 4 细化清单 (Phase 4A / 4B / 4C) - [已完成]

#### Phase 4A: 每日分析与 KPI 大盘 (Gemini 3.8 Flash Max)
- **涉及端点**：
  - `GET /api/v1/daily-analysis`: 包含 project_id, start_date, end_date, country，聚合每日销售、广告费、退款与毛利趋势。
  - `GET /api/v1/daily-analysis/all`: 跨项目每日综合分析概览。
  - `GET /api/v1/daily-analysis/all-countries`: 按国家分组聚合运营数据。
  - `GET /api/v1/daily-analysis/all-projects-countries`: 项目与国家交叉分析矩阵。
  - `GET /api/v1/project-goals`: 项目目标列表与筛选。
  - `GET /api/v1/project-goals/progress`: 项目销售额与利润目标完成进度追踪。
  - `GET /api/v1/project-goals/{goal_id}`: 目标详情。
  - `POST /api/v1/project-goals`: 新增项目目标 (201 Created)。
  - `PUT /api/v1/project-goals/{goal_id}`: 更新项目目标。
  - `DELETE /api/v1/project-goals/{goal_id}`: 删除项目目标 (204 No Content)。
- **数据库表**：`analysis_sales_order_rows`, `project_goals`, `projects`, `operation_audit_logs`

#### Phase 4B: 广告分析、RPA 上报与投放 (Gemini 3.8 Flash Max)
- **涉及端点**：
  - `GET /api/v1/ad-analysis/overview`: 核心广告指标概览 (Spend, Sales, ACOS, ROAS, CPC, CTR)。
  - `GET /api/v1/ad-analysis/campaigns`: 广告活动明细与分页。
  - `GET /api/v1/ad-analysis/products`: 推广商品明细表现。
  - `GET /api/v1/ad-analysis/time-trend`: 广告多周期时间趋势。
  - `GET /api/v1/ad-analysis/purchased-products`: 购买商品报告表现。
  - `GET /api/v1/ad-analysis/search-terms`: 搜索词表现分析。
  - `GET /api/v1/ad-analysis/targets`: 定向投放分析。
  - `GET /api/v1/ad-analysis/budget`: 广告预算与消耗监控。
  - `GET /api/v1/ad-analysis/placements`: 广告位展示对比。
  - `GET /api/v1/ad-analysis/traffic-quality`: 广告流量质量健康度评分。
  - `GET /api/v1/rpa-reports/status`: 各大站点与店铺 RPA 报表抓取与处理最新状态。
  - `POST /api/v1/ad-upload/recognize`: 广告报表上传列预识别。
  - `POST /api/v1/ad-upload/commit`: 报表数据落库提交 (事务保证)。
  - `GET /api/v1/ad-upload/status`: 上传解析进度状态。
  - `GET /api/v1/internal/ad-data`: 内部服务抓取广告聚合数据。
- **数据库表**：广告明细表系列、`rpa_reports`, `projects`, `operation_audit_logs`

#### Phase 4C: 财务结算、税费与对账 (Gemini 3.8 Flash Max)
- **涉及端点**：
  - `GET /api/v1/platform-revenues`: 平台回款列表与筛选。
  - `GET /api/v1/platform-revenues/{revenue_id}`: 回款详情。
  - `POST /api/v1/platform-revenues`: 创建回款记录。
  - `PATCH /api/v1/platform-revenues/{revenue_id}`: 更新回款记录。
  - `DELETE /api/v1/platform-revenues/{revenue_id}`: 删除回款记录。
  - `POST /api/v1/platform-revenues/upload-image`: 上传银行水单凭证。
  - `GET /api/v1/platform-revenues/project-countries/{project_id}`: 获取项目有效国家列表。
  - `GET /api/v1/vat-entities`: 开票主体列表。
  - `POST /api/v1/vat-entities`: 创建开票主体 (201)。
  - `PATCH /api/v1/vat-entities/{entity_id}`: 修改开票主体。
  - `DELETE /api/v1/vat-entities/{entity_id}`: 删除开票主体 (204)。
  - `GET /api/v1/vat-invoices`: 发票列表。
  - `POST /api/v1/vat-invoices`: 开具发票 (201)。
  - `GET /api/v1/vat-invoices/{invoice_id}`: 发票详情。
  - `POST /api/v1/vat-invoices/{invoice_id}/pdf`: 发票 PDF 上传。
  - `GET /api/v1/vat-invoices/{invoice_id}/pdf`: 发票 PDF 预览/下载。
  - `POST /api/v1/vat-invoices/{invoice_id}/void`: 发票作废。
  - `GET /api/v1/report-reconciliation/available-reports`: 可对账报表列表。
  - `POST /api/v1/report-reconciliation/auto-reconcile`: 自动多方账单核验。
  - `GET /api/v1/report-reconciliation/history`: 对账历史。
  - `POST /api/v1/report-reconciliation/reconcile`: 执行对账。
  - `POST /api/v1/report-reconciliation/reports/{report_id}/pdf-upload`: 结算单 PDF 上传。
  - `POST /api/v1/report-reconciliation/reports/{report_id}/csv-upload`: 明细 CSV 上传。
  - `GET /api/v1/report-reconciliation/reports/{report_id}/export-pt3`: 导出 PT3 对账格式。
  - `GET /api/v1/return-analysis`: 退款率与退款原因聚类汇总。
  - `GET /api/v1/return-analysis/raw-rows`: 原始退货明细数据。
  - `GET /api/v1/category-research/datasets`: 类目数据集列表。
  - `POST /api/v1/category-research/datasets/import`: 导入类目数据。
  - `GET /api/v1/category-research/datasets/{dataset_id}`: 类目概览。
  - `POST /api/v1/category-research/datasets/{dataset_id}/recompute`: 重算类目指标。
  - `GET /api/v1/category-research/datasets/{dataset_id}/products`: 竞品排行。
  - `GET /api/v1/category-research/datasets/{dataset_id}/trend`: 类目价格与销量趋势。
  - `GET /api/v1/category-research/datasets/{dataset_id}/market-trend`: 市场容量趋势。
  - `GET /api/v1/category-research/datasets/{dataset_id}/exports`: 导出报表列表。
- **数据库表**：`platform_revenues`, `vat_entities`, `vat_invoices`, `reconciliation_reports`, `return_order_rows`, `category_research_datasets`, `category_research_products`, `projects`, `operation_audit_logs`

---

### Stage 5 细化清单 (Phase 5A / 5B) - [已完成]

#### Phase 5A: Agent 鉴权框架与安全门禁 (DeepSeek-V4.1-Flash Max)
- **核心模块**：`backend-go/internal/agentauth/`
- **能力清单**：
  - Bearer Token SHA-256 哈希查表鉴权 (`public.agent_api_keys`) 与 `X-Agent-Id` 严格核验；
  - `project_scope` 门禁：基于操作人已分配项目或 Scope 限制越权访问；
  - `business_scope` 门禁：支持精确业务域匹配（`*` 严格禁止隐式提权 `agent_provisioning`）；
  - `ConfirmRecord` 两步确认机制：绑定请求方法、资源路径指纹（`Method + Path`）、请求体 SHA-256、AgentID 及幂等键，彻底防范跨资源重放与篡改；
  - 内存/Redis 驱动的确认存储；
  - 固定窗口速率限制（`RequireRateLimit`），超额返回 429 与 `Retry-After` 响应头。
- **数据库表**：`agent_api_keys`, `operation_audit_logs`

#### Phase 5B: Agent 80+ 业务端点全量接管 (DeepSeek-V4.1-Flash Max)
- **核心模块**：`backend-go/internal/api/agent/`
- **能力清单**：
  - 完整接管 `/api/v1/agent/*` 下全部 80+ 条业务路由（涵盖项目、销售概览、库存概览、库存台账、发货排期、店铺测算、新品测算、定价快照、退货分析、补货分析、RPA 上报与广告原始数据）；
  - 核心业务底层 100% 复用已在 Stage 1 ~ Stage 4 交付的 Go Store；
  - 客诉中心项目作用域安全收敛（支持 `ProjectIDs` 联合查询与时效概览隔离）；
  - 确认预览阶段 DTO 解码预校验，防止非法载荷换取令牌；
  - 请求体 10MB `MaxBytesReader` 截流保护；
  - 货件、店铺测算与新品测算写操作全量写入 `operation_audit_logs` 并提供审计日志查询接口。
- **数据库表**：复用既有全部业务表与 `operation_audit_logs`

---

### Stage 6 细化清单 (Phase 6A / 6B / 6C) - [进行中]

#### Phase 6A: Asynq 队列架构与 18 个后台任务移植 (DeepSeek-V4.1-Flash Max)
- **核心模块**：`backend-go/internal/queue/`, `backend-go/internal/tasks/`
- **能力清单**：
  - 基于 Redis 的高性能 `hibiken/asynq` 队列客户端与消费服务端；
  - 5 级队列优先级调度权重严格对齐 Celery：`reports: 6`, `insights: 4`, `scheduled: 3`, `ai_summary: 2`, `default: 1`；
  - 完整移植 18 个后台任务（包含数据分析作业、月报草稿预构建、临时件清理、AI 洞察生成与执行、报告分发、告警检测、退货分析刷新与重建、CRM 公海回收/任务到期/无跟进/规则引擎/催办邮件、审计日志保留清理、AI Chat 用量统计）。
- **数据库表**：相关业务表与 Redis 队列

#### Phase 6B: 定时调度器与分布式锁移植 (DeepSeek-V4.1-Flash Max)
- **核心模块**：`backend-go/internal/scheduler/`
- **能力清单**：
  - 基于 `robfig/cron/v3` 的定时调度引擎，强制采用 `Asia/Shanghai` 时区；
  - Redis SETNX 分布式防重锁，确保集群部署下单次调度仅有单节点触发；
  - 完整配置 11 项定时作业对齐 Celery Beat 调度表。
- **数据库表**：Redis 锁与各业务表

#### Phase 6C: 月报系统与导出引擎移植 (DeepSeek-V4.1-Flash Max)
- **核心模块**：`backend-go/internal/api/monthly_reports/`, `backend-go/internal/store/monthly_reports.go`
- **能力清单**：
  - 月报历史版本列表、详情查询与草稿删除；
  - 异步/即时月报计算触发与进度状态轮询；
  - 月报版本定稿确认与审计记录；
  - Excel/CSV 与 PDF 报表文件流导出。
- **数据库表**：`monthly_reports`, `monthly_report_pt3_calculations`, `projects`, `operation_audit_logs`

---

## 6. Sub-Agent 任务卡标准模板 (Task Card Template)

在后续派发任务给 Sub-Agent 时，统一采用如下任务卡格式：

```markdown
# Sub-Agent Task Card: [模块名称，如 Phase 1B 项目域]

### 1. 任务边界 (Scope)
- **负责模块**：`projects`
- **目标目录**：
  - Handler: `backend-go/internal/api/projects/`
  - Store: `backend-go/internal/store/projects.go`
  - SQL: `backend-go/internal/store/queries/projects.sql`
  - 契约测试: `backend-go/tests/contract/projects_contract_test.go`
- **禁止修改**：除自身目录与本任务卡指定文件外，禁止碰触 `httpserver/routes.go` 与 `dependencies.go`。

### 2. 接口清单与数据表
- **HTTP 接口**：
  1. GET /api/v1/projects/manage
  2. POST /api/v1/projects
  3. PATCH /api/v1/projects/{project_id}
  4. GET /api/v1/projects/{project_id}/shops
  5. PUT /api/v1/projects/{project_id}/shops/{country}
- **相关表**：`projects`, `project_shops`, `operation_audit_logs`

### 3. 技术契约与规范要求
- **鉴权模型**：从 `auth.UserContextFromContext(r.Context())` 提取操作人 `Operator` 与 `IsAdmin`，严禁直接读 Header。
- **审计要求**：所有写操作通过 `audit.Service.LogAction` 记入 `operation_audit_logs`，包含 `before_json` 与 `after_json`。
- **字段风格**：严格保持与 FastAPI `app/schemas/project.py` 中的字段名完全一致（全 snake_case）。
- **时间格式**：使用 `httpapi.Timestamp`。

### 4. 交付与验收标准
1. `go test ./internal/api/projects/...` 单元测试覆盖率 > 85%。
2. `go test ./tests/contract/ -run TestProjectsContract` 契约测试通过。
3. 确保 `cd backend-go && go test ./...` 保持全局全绿。
```

---

## 7. 质量门禁与回滚机制 (Quality Gates & Rollback)

### 7.1 本地测试门禁
- **后端 T3 级全量要求**：每次合入新模块，执行：
  ```bash
  cd backend-go && go test ./...
  ```
- **Live Contract 测试**（可选集成）：
  ```bash
  cd backend-go && LIVE_CONTRACT_REQUIRED=1 ./scripts/run-live-contract.sh
  ```

### 7.2 环境红线与隔离边界（严禁生产部署）
- **本地环境唯一性**：本次重构与代码交付全部在本地隔离工作树及本地测试数据库（`BLF_test`）中推进并完成验证，严禁任何生产部署。
- **严禁生产部署与切流**：本计划严格禁止任何生产 VPS 部署、远程环境变更、或在生产 VPS 执行 Compose / 服务重启操作；所有验证必须通过本地单元测试、契约测试与离线集成测试完成。
- **配置回退边界**：网关模块接管开关（`GO_API_OWNED`）仅在本地工作树与本地测试环境配置生效，杜绝生产环境污染。
