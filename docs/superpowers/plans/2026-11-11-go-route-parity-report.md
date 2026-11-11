# Go 路由对账报告（GET · 无路径参数）

> 日期：2026-11-11  
> 命令：`go run ./cmd/routeparity --fastapi http://127.0.0.1:18100 --go http://127.0.0.1:18200 --state-dir .local-cutover --env-file backend/.env.test`  
> 环境：FastAPI 18100（BLF_TEST，ENABLE_SCHEDULER=false）vs Go 18200（`GO_API_OWNED=all`，BLF_TEST），同一 API key / `X-User-Id: 1`。

## 总览

| 指标 | 数值 |
| --- | ---: |
| 对比路由 | 174 |
| 一致 | 127 |
| 不一致 | 47 |
| 跳过 | 160 条含路径参数 + 3 条 SSE |

对比口径：status code 必须一致；2xx 时 JSON 结构（key 集合与嵌套）必须一致，数据值不比较。

## 1. Status 不一致（43 条）

| FastAPI → Go | 路由 |
| --- | --- |
| 422 → 403 | `/api/v1/crm/dashboard/funnel` |
| 422 → 200 | `/api/v1/inventory-analysis` |
| 422 → 400 | `/api/v1/inventory-ledger/batches` |
| 422 → 400 | `/api/v1/inventory-ledger/consistency` |
| 422 → 400 | `/api/v1/inventory-ledger/detail` |
| 422 → 400 | `/api/v1/inventory-ledger/events` |
| 422 → 400 | `/api/v1/inventory-ledger/location-detail` |
| 422 → 400 | `/api/v1/inventory-ledger/month-analysis` |
| 422 → 400 | `/api/v1/inventory-ledger/months` |
| 422 → 400 | `/api/v1/inventory-ledger/receipt-clusters` |
| 422 → 400 | `/api/v1/inventory-ledger/snapshot` |
| 422 → 400 | `/api/v1/inventory-ledger/summary` |
| 422 → 400 | `/api/v1/inventory-ledger/trend` |
| 422 → 200 | `/api/v1/inventory-replenishment-analysis` |
| 422 → 200 | `/api/v1/inventory-replenishment-calendar` |
| 422 → 200 | `/api/v1/inventory-replenishment-shipments` |
| 422 → 200 | `/api/v1/inventory-replenishment-snapshots` |
| 422 → 200 | `/api/v1/inventory-snapshot-options` |
| 500 → 200 | `/api/v1/product-analysis/sources` |
| 422 → 200 | `/api/v1/seasonal-replenishment-analysis` |
| 422 → 200 | `/api/v1/shipment-schedules/batches` |
| 422 → 200 | `/api/v1/shipment-schedules/fba-box-details` |
| 422 → 400 | `/api/v1/shipping-plan/batches` |
| 422 → 400 | `/api/v1/shipping-plan/forecast` |
| 422 → 400 | `/api/v1/shipping-plan/shipment-history` |
| 422 → 400 | `/api/v1/shipping-plan/skus` |
| 200 → 403 | `/api/v1/system-management/agent-access-logs` |
| 200 → 403 | `/api/v1/system-management/agent-access-logs/summary` |
| 200 → 403 | `/api/v1/system-management/agent-operation-logs` |
| 200 → 403 | `/api/v1/system-management/agent-operation-logs/summary` |
| 200 → 403 | `/api/v1/system-management/audit-logs` |
| 200 → 403 | `/api/v1/system-management/audit-logs/summary` |
| 422 → 403 | `/api/v1/system-management/commission-management/project-months` |
| 422 → 403 | `/api/v1/system-management/commission-management/ratio-overrides` |
| 422 → 403 | `/api/v1/system-management/commission-management/records` |
| 200 → 403 | `/api/v1/system-management/commission-management/role-assignments` |
| 422 → 403 | `/api/v1/system-management/commission-management/summary/monthly` |
| 422 → 403 | `/api/v1/system-management/commission-management/summary/project` |
| 200 → 403 | `/api/v1/system-management/data-management/overview` |
| 200 → 403 | `/api/v1/system-management/data-management/status` |
| 422 → 403 | `/api/v1/system-management/operator-management/performance` |
| 200 → 403 | `/api/v1/system-management/users` |
| 200 → 500 | `/api/v1/vat-invoices` |

## 2. JSON 形状不一致（4 条）

| 路由 |
| --- |
| `/api/v1/complaints/overview` |
| `/api/v1/shipment-schedules` |
| `/api/v1/shipment-schedules/sku-summary` |
| `/api/v1/sku-info/sync-first-leg-from-shipment` |

## 3. 关键发现

1. **Go `GET /api/v1/vat-invoices` 500**：`internal/store/vat_invoices.go:405` 使用 `i.buyer->>"name"`，BLF_TEST 报 `column "name" does not exist`。切流后发票列表直接不可用，需要先修 SQL（对齐 FastAPI 的 buyer 取名字段）。
2. **system-management 全族 403（10 条）→ 已确认为对账头缺失，非 Go 缺陷**：Go 侧 `requireAdminOperator`（`internal/api/system_management/helpers.go:67`）从 `X-Is-Admin` 头判定管理员（与 Next.js 代理注入一致）；首轮对账没带该头，所以 403。带上 `X-Is-Admin: true` 后应恢复 200。**反向发现**：FastAPI 该族 router 只有 `Depends(protected)`（API key 保护），没有管理员校验——Go 更严格，切流后安全水位提升，但需要产品确认这是期望行为。
3. **缺参校验漂移（约 20 条）**：FastAPI 对缺失必填 query 返回 422 Pydantic 数组；Go 分两种：返回 400 `{"detail":"..."}`（inventory-ledger / shipping-plan 等），或直接 200 返回数据（inventory-analysis / inventory-replenishment / shipment-schedules/batches / seasonal 等）。**200 的一类风险更高**：前端带参数时行为一致，但任何漏参调用会静默返回全量数据而不是报错。
4. **形状漂移（4 条）**：`complaints/overview`、`shipment-schedules`、`shipment-schedules/sku-summary`、`sku-info/sync-first-leg-from-shipment`（Go 多返回 `country` / `project_name` 等字段）。多字段一般向后兼容，但需逐条确认是否契约内。
5. **FastAPI 反向问题**：`GET /api/v1/product-analysis/sources` FastAPI 500、Go 200——FastAPI 侧已有 bug，Go 反而正常。

## 4. 下一步

1. 修 `vat-invoices` SQL（P0）。
2. 确认 system-management 权限语义，补 Go/FastAPI 对齐或记录为有意收紧。
3. 统一缺参校验：Go 统一 422 + Pydantic 风格错误体（或至少 400 且文档化）；把“缺参仍 200”的接口逐个补 required 校验。
4. 处理 4 条形状漂移；`complaints/overview` 与 `shipment-schedules` 是高频页面，优先。
5. 扩展对账到带路径参数的 GET（需要样例 ID 生成器）与写接口契约测试。
