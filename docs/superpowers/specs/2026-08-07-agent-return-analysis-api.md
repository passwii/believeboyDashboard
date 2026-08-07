# Agent API · Return/Refund Analysis（退货分析）API 实施规格（设计草案 v0.1）

> **状态**：**设计草案 v0.1**（BLF-470 产出：后端整体 Review + API 规范与端点设计；决策 D1–D7 待拍板）。
> **配套文档**：[`docs/agent-api-design.md`](../../agent-api-design.md)（Agent API 设计稿 v0.5）、[`docs/superpowers/specs/2026-08-06-agent-new-product-calculation-api.md`](./2026-08-06-agent-new-product-calculation-api.md)（新品测算域 spec 定稿，本 spec 的模板）、[`docs/superpowers/specs/2026-08-05-agent-shop-calculation-api.md`](./2026-08-05-agent-shop-calculation-api.md)（店铺测算域 spec 定稿）、[`backend/docs/external-api.md`](../../backend/docs/external-api.md)（external 读契约 §9 Return Analysis）。
> **范围**：在 `/api/v1/agent/projects/{id}/return-analysis*` 开放**退货分析（Return/Refund Analysis）域**的读路由。**本 spec 只设计，不实施**（对齐 BLF-451 执行顺序：先 review + 设计，拍板后开执行子 issue）。
> **前提**：`require_project_scope`（commit `d5241993`）与 `require_business_scope`（commit `d94c7c90`）已合入 main；Agent 基建（鉴权/限流/响应壳/错误码/审计）全就绪，可直接复用。

---

## 0. 结论摘要

### 0.1 后端 Review 结论（BLF-470 第 1 步）

退货分析域的后端资产已**基本完整**，Agent 侧**读能力已覆盖一半**（镜像两条），但**最核心的「全量分析 overview」与「数据覆盖度/新鲜度」尚未对 Agent 开放**：

| 资产 | 内部端点 | Agent 侧现状（BLF-459 镜像） | 缺口 |
|---|---|---|---|
| 全量退货分析（ranking/reason/trend/disposition/status/weekday/FC 分布 + summary_text） | ✅ `GET /api/v1/return-analysis` | ❌ 未开放 | **R1 overview** |
| per-SKU 聚合（risk_level / wilson_lower / cycle / top 原因/处置/仓库） | ✅（内部无独立端点，由 overview 派生） | ✅ `/agent/projects/{id}/return-analysis`（镜像，external handler） | 契约较薄，无 `product_name`/`reason_top1_display` |
| raw 退货事件（PII 剥离） | ✅（overview 内部使用） | ✅ `/agent/projects/{id}/return-analysis-raw`（镜像） | 无 |
| 数据覆盖度 / 快照新鲜度 | ❌ 无独立端点（`is_snapshot_fresh_for_range` 是内部 helper） | ❌ 未开放 | **R5 coverage** |
| 单 SKU 钻取 | ✅ overview 带 `?sku=` 过滤 | ❌ 未开放 | **R1 + `?sku=`（或 R4 独立路由）** |
| reason/disposition/status 中文翻译 | ✅ 内部返回 `*_display` 字段 | ❌ 聚合端点只回 `reason_top1` 原文 | **R1/R2 补 display 字段** |

### 0.2 设计结论（BLF-470 第 2 步，待拍板）

退货分析是**纯读 / 分析域**（与店铺测算、新品测算不同——无 agent 可写的业务事实）：

- **路由面（推荐 5 条，全部读、无 confirm、无写桶）**：R1 overview（全量分析，`?sku=` 可钻取）/ R2 per-SKU 聚合（原生替换镜像，契约对齐 external §9 + 补 display 字段）/ R3 raw 事件（原生替换镜像，PII 剥离契约保持）/ R4 单 SKU 钻取（可选，或并入 R1）/ R5 数据覆盖度与新鲜度（**新增**）。
- **v1 不做写路由**（D2）：`analysis_return_rows` 是 Amazon 报表来源的不可变事实，无对应内部写操作；唯一写路径 `persist_return_report` 是文件上传，属另一个通道（autoReportUpload / 内部 upload），不在本域开口。未来候选（退货报表上传 / 事件标注 / 触发快照刷新）单独立项评估。
- **Refund 财务侧**（D7）：`analysis_pt_sku_details.actual_refund_amount/units` 与 `payment/aggregate.py` 的退款聚合属「支付报表分析（PT1）」域，**不在本 spec 核心范围**，作为相邻资产在 §1.6 记录，待独立评估是否补一条 refund 汇总读路由。
- **Agent 基建全部复用**：`require_business_scope("return_analysis")`（D3）+ 每路由 `require_project_scope`；读桶限流；`{ok, data}` 响应壳；无新审计（读不落审计）。

---

## 1. 后端 Review：退货分析域资产盘点（代码核实 2026-08-07）

### 1.1 数据表（4 张核心）

| 表 | 模型 | 粒度 | 关键字段 | 说明 |
|---|---|---|---|---|
| `analysis_return_rows` | `AnalysisReturnRow`（`models/product_analysis_source.py:308`） | 每个退货事件一行 | `return_date` / `order_id` / `sku` / `asin` / `fnsku` / `product_name` / `quantity` / `fulfillment_center_id` / `detailed_disposition` / `reason` / `status` / `license_plate_number` / `original_return_datetime` / `customer_comments`(PII) / `raw_row`(PII) | **退货事实源**；`uq_return_event`(project,country,order_id,sku,return_date,lpn) 防重；报表上传 upsert |
| `analysis_return_aggregates` | `AnalysisReturnAggregate`（`models/analysis_return_aggregate.py:38`） | 每日每 `(project, country, sku, data_date)` 一行 | `return_count` / `return_quantity` / `sales_quantity` / `return_rate` / `wilson_lower` / `risk_level`(critical/warning/normal/no_data) / `cycle_avg/min/max_days` / `reason_top1(+_pct/_display)` / `disposition_top1(+_display)` / `dominant_fc_id` / `data_version` / `computed_at` | **物化快照**；Celery 每日 03:00 UTC 刷新近 90 天；risk_level 由 Wilson 95% 下界判定 |
| `analysis_sales_order_rows` | `AnalysisSalesOrderRow`（`models/product_analysis_source.py:356`） | 每个销售订单行 | `amazon_order_id` / `sku` / `country` / `purchase_date_pt` / `quantity` / `item_price` / `order_status` / `is_counted_sales` | 退货率**分母** + 退货周期（原单日期）匹配源 |
| `analysis_source_files` | `AnalysisSourceFile`（`models/product_analysis_source.py:31`） | 每次报表上传一个版本 | `report_type`(含 `return_report`) / `version` / `is_current` / `period_start_date` / `period_end_date` / `ingestion_status` / `row_count_total` / `original_filename` / `created_by` | **覆盖度/新鲜度**查询源 |

> **遗留表**：`return_analysis_records` + `return_customer_comments`（`models/return_analysis.py`）——**已不再写入**（`persistence.py` 注释明确 "The old return_analysis_records table is no longer used for new writes"），新数据只走 `analysis_return_rows`。本 spec 不涉及。

### 1.2 服务层

| 服务 / 函数 | 位置 | 能力 | Agent 复用方式 |
|---|---|---|---|
| `build_return_analysis(db, *, project_id, country, start_date, end_date, sku=None)` | `services/analysis/return_analysis/analysis.py:628` | 全量退货分析（含 `summary_text` 模板总结）；按 (order_id, sku) 去重算 return_count | **R1/R4 核心** |
| `build_return_analysis_from_snapshot(...)` | `analysis.py:1153` | snapshot 路径：rank 从 aggregate 重聚合，分布维退回 raw，输出 schema 与 fallback 完全一致 | R1 双路径之一 |
| `is_snapshot_fresh_for_range(...)` / `get_snapshot_last_computed_at(...)` | `analysis.py:1109` / `:1085` | 25h 新鲜度阈值判断 / 最近 computed_at | **R5 核心** |
| `query_return_analysis_aggregate(...)` | `services/external/return_analysis_query.py:299` | per-SKU 聚合（Python 侧 collapse）+ sku/min_return_rate/risk_level 过滤 + 排序分页 | **R2 核心** |
| `query_return_analysis_raw(...)` | `return_analysis_query.py:363` | raw 事件分页查询（Pydantic 剥离 PII） | **R3 核心** |
| `build_aggregate_summary(...)` | `return_analysis_query.py:441` | per-SKU 聚合 summary（当前页口径） | R2 复用 |
| `persist_return_report(...)` | `services/analysis/return_analysis/persistence.py:36` | 退货报表入库（文件 → `analysis_return_rows`） | v1 **不开放**（文件上传通道，D2） |
| `get/set_return_analysis_v2_cache(...)` | `services/infra/inventory_cache.py` | Redis v2 缓存（5min TTL） | R1 复用（与内部端点共享缓存） |
| `wilson_lower_bound` / `compute_risk_level` | `utils/stats.py` | Wilson 下界 / risk_level 判定 | 已有函数，R2 重算用 |
| `translate_return_field(...)` | `constants/return_translations.py` | reason/disposition/status → zh/en | R1/R2 补 `*_display` 字段用 |

### 1.3 内部端点现状

- `GET /api/v1/return-analysis`（`endpoints/return_analysis.py:27`）——`Depends(protected)` + `ensure_project_access`；**双段式**：Redis v2 缓存（5min TTL）→ 命中直接返回；未命中走 snapshot-or-fallback（25h 阈值）。响应 `ReturnAnalysisResponse`（`schemas/return_analysis.py:97`）：`summary` / `summary_text` / `ranking_rows`(top20) / `reason_rows` / `trend_rows` / `disposition_rows` / `status_rows` / `feedback_rows`(含 `customer_comment`) / `weekday_rows` / `fulfillment_center_rows` / `multi_item_return_count/_quantity`。
- **无独立内部 per-SKU 聚合端点**——per-SKU 视图只存在于 external 通道（§1.4）。

### 1.4 Agent 侧现状（BLF-459 镜像）与契约偏差

`external_mirror.py` 程序化镜像了 external_router 的全部 GET 路由，退货分析两条已在：
- `GET /agent/projects/{id}/return-analysis` —— external handler `get_external_return_analysis_aggregate`（`endpoints/external/return_analysis.py:82`）：`period/country/start_date/end_date/sku/min_return_rate/risk_level/limit/offset/order_by/order_dir`，响应 `ReturnAnalysisAggregateResponse`。
- `GET /agent/projects/{id}/return-analysis-raw` —— external handler `get_external_return_analysis_raw`（`:185`）：raw 事件，`customer_comments`/`raw_row`/`fnsku`/`license_plate_number` **永不返回**。

**契约偏差（review 发现）**：`backend/docs/external-api.md §9` 文档示例展示了 `product_name` / `reason_top1_display` / `disposition_top1_display` / `risk_trend` / `pagination` 字段，但**代码实现的 `ReturnAnalysisAggregateRow`（`schemas/external/return_analysis.py:35`）并没有这些字段**（实际 13 字段：sku/return_count/return_quantity/sales_quantity/return_rate/wilson_lower/cycle_avg/min/max_days/reason_top1/disposition_top1/dominant_fc_id/risk_level）。文档滞后于代码——原生化 R2 时**以代码契约为基准，补上 display 字段**（reason/disposition 翻译由 `return_translations` 提供），不承诺文档里的 `risk_trend`（需新算法，不在本 spec）。

### 1.5 Agent 基建（已就绪，直接复用）

- `require_project_scope(project_id)`（`app/api/agent/scope.py:46`）——`*` 放行 / 白名单校验 / 越权 403 `AGENT_PROJECT_OUT_OF_SCOPE`。
- `require_business_scope("return_analysis")`（`scope.py:85`，工厂）——域 code 白名单，越权 403 `AGENT_BUSINESS_OUT_OF_SCOPE`；**域 code 预留 `return_analysis`**（新码，无需 DB 迁移——`business_scope` 是逗号分隔字符串列）。
- 读限流 `require_agent_read_rate_limit`（300 req/min/agent）；响应壳 `agent_ok`（`{ok, data}`）；错误码注册表 `app/api/agent/errors.py`；`_service_errors()` 壳翻译（HTTPException → AgentApiError，mirror 与店铺/新品域通用模板）。

### 1.6 相邻资产（已开放 / 可协同，不在本域核心）

| 资产 | 位置 | Agent 侧 | 与退货分析的关系 |
|---|---|---|---|
| SKU 主数据 | `SkuRecord`（`models/sku_info.py:20`，表 `product_costs`） | ✅ `/agent/projects/{id}/sku-info`（镜像） | R1/R2 的 `product_name` 溯源（`_build_sku_product_name_map` 已用） |
| 经营汇总 | `services/external/business_summary.py` | ✅ `/agent/projects/{id}/business-summary`（镜像） | 退货金额对利润的影响上下文 |
| 订单汇总 | `services/external/orders_summary.py` | ✅ `/agent/projects/{id}/orders/summary`（镜像） | 销售分母上下文 |
| 库存分类账 | `services/external/inventory_ledger.py` | ✅ `/agent/projects/{id}/inventory-ledger/*`（镜像） | 退货回库 / 不可售库存上下文 |
| **Refund 财务数据** | `AnalysisPTSKUDetail.actual_refund_amount/_units`（`product_analysis_source.py:513`）、`services/payment/aggregate.py:10` | ❌ 未开放 | 「Refund」侧：实际退款量/额、平台佣金、FBA 费——**属支付报表分析（PT1）域**，D7 待拍板是否纳入 |

---

## 2. Agent 可调用资产 → API 家族分类

按**元素所有权 + 读语义**把退货分析域拆成 3 个读家族 + 1 个覆盖家族：

| 家族 | 端点 | 数据源 | 语义 | confirm | 限流 | 审计 |
|---|---|---|---|---|---|---|
| **F1 全量分析**（dashboard） | `GET /return-analysis/overview` | `build_return_analysis` 双路径 + Redis v2 缓存 | 与内部 `/return-analysis` 同构的完整分析（含 summary_text 模板总结） | ❌ | 读 | 不落 |
| **F2 per-SKU 聚合**（风险清单） | `GET /return-analysis` | `query_return_analysis_aggregate`（snapshot 物化表） | per-SKU rollup + `risk_level`/`min_return_rate` 过滤——Agent 的「哪些 SKU 该处理」清单 | ❌ | 读 | 不落 |
| **F3 raw 事件**（明细追溯） | `GET /return-analysis-raw` | `query_return_analysis_raw` | 退货事件明细；`customer_comments`/`raw_row`/`fnsku`/`license_plate_number` **永不返回** | ❌ | 读 | 不落 |
| **F4 覆盖度**（数据可信度） | `GET /return-analysis/coverage` | `analysis_source_files` + `get_snapshot_last_computed_at` | 报表上传历史 / 数据跨度 / 快照新鲜度——Agent 判断「当前分析是否可信」 | ❌ | 读 | 不落 |

**分类理由**：

1. **纯读域，无写家族**。`analysis_return_rows` 是 Amazon 报表来源的不可变事实；没有「Agent 修改退货事件」的内部对应操作。店铺/新品域的写路由模式（confirm + 写桶 + 审计）在退货分析域**没有可写目标**——这是与先前 3 个域最本质的差异（D2）。
2. **F1 与 F2 分工**：F1 是「全量多维度」（dashboard 语义，重，双路径+缓存），F2 是「per-SKU 风险清单」（轻，snapshot 物化表，可过滤分页）。两者源数据不同（F1 分布维走 raw，F2 全走 aggregate），互补不重复。
3. **F4 是退货分析域特有的新增能力**：退货分析强烈依赖数据新鲜度（报表按周期上传、snapshot 每日刷新）。Agent 拿到 overview 前应能自查「这份数据覆盖到哪天、快照是否过期」——`is_snapshot_fresh_for_range` / `get_snapshot_last_computed_at` 已现成，包装成读路由即可。

---

## 3. 完整路由表（5 条）

> 统一挂 `/api/v1/agent/projects/{project_id}`（router prefix），命名空间级鉴权（Bearer + X-Agent-Id + 读限流）由 `agent_router` 承担。
> **全部路由挂 `Depends(require_project_scope)`**；**域级再挂 `require_business_scope("return_analysis")`**（D3 待拍板，推荐挂——与 shipments/shop_calculations 对齐）。

| # | Method | Path | 复用 service | confirm | 限流桶 | 审计 |
|---|---|---|---|---|---|---|
| R1 | GET | `/projects/{pid}/return-analysis/overview` | `build_return_analysis` / `build_return_analysis_from_snapshot` + `get/set_return_analysis_v2_cache` | ❌ | 读 | 不落 |
| R2 | GET | `/projects/{pid}/return-analysis` | `query_return_analysis_aggregate` + `build_aggregate_summary` | ❌ | 读 | 不落 |
| R3 | GET | `/projects/{pid}/return-analysis-raw` | `query_return_analysis_raw` | ❌ | 读 | 不落 |
| R4 | GET | `/projects/{pid}/return-analysis/skus/{sku}` | `build_return_analysis(sku=...)`（R1 薄切片） | ❌ | 读 | 不落 |
| R5 | GET | `/projects/{pid}/return-analysis/coverage` | `analysis_source_files` 查询 + `get_snapshot_last_computed_at` + `is_snapshot_fresh_for_range` | ❌ | 读 | 不落 |

**关键实现事实（代码已核实）**：

- **与镜像的关系（D1）**：R2/R3 与当前镜像路径（`/return-analysis`、`/return-analysis-raw`）**同路径冲突**——实施时把这两个 external 路径加入 `external_mirror.py` 的 `_EXCLUDED_EXTERNAL_PATHS`（对齐 new-product-calculations 的 precedent），原生实现**保持 external §9 的查询契约**（period/start_date/end_date/country/limit/offset/order_by/order_dir + R2 的 sku/min_return_rate/risk_level），既有 agent 消费者无感；R1/R4/R5 是全新路径，无冲突。
- **R1 走与内部端点完全相同的双段式**：Redis v2 缓存（5min TTL，key 含 sku）→ snapshot-or-fallback（25h 阈值）。**复用同一个缓存 key**，Agent 读与 UI 读共享缓存，天然一致、成本为 0。
- **R2 的 `order_by` 白名单**：external `_whitelist.py` 的 `parse_aggregate_order_by(model=AnalysisReturnAggregate)` 已覆盖 13 列：`sku/return_count/return_quantity/sales_quantity/return_rate/wilson_lower/cycle_avg_days/cycle_min_days/cycle_max_days/reason_top1/disposition_top1/dominant_fc_id/risk_level`（`_whitelist.py:392` 起；external-api.md §9 文档只列了 8 项，属文档滞后）。原生化可原样复用。
- **R3 的 `order_by` 白名单**：`parse_order_by(model=AnalysisReturnRow)` 已覆盖 12 列：`id/return_date/order_id/sku/asin/product_name/quantity/fulfillment_center_id/detailed_disposition/reason/status/original_return_datetime`（`_whitelist.py:203` 起；`customer_comments`/`raw_row` 不在白名单内，`?order_by=` 直接 400——防御纵深 + Pydantic 静态剥离）。PII 剥离由 `ReturnAnalysisRawRow` schema 保证。
- **R4**：`build_return_analysis(..., sku=sku)` 输出与 R1 同构（records 过滤到单 SKU，ranking_rows 只含该 SKU 有退货的条目）。**D5 决策**：R4 可作为独立路由（Agent 工具定义更清晰），也可只留 R1 `?sku=`。本 spec 推荐**保留独立 R4**（与店铺域 R2 `skus/{sku}` 的路径风格一致），实施时薄封装。
- **该域 1 个 Redis 缓存**（R1 复用 v2 缓存）；纯读不落审计；无新迁移（唯一"新字段"是 `business_scope` 值字符串，无 schema 变更）。

---

## 4. 请求 / 响应 schema 草案

### 4.1 R1 overview 请求 / 响应

```
GET /api/v1/agent/projects/{pid}/return-analysis/overview?country=US&start_date=2026-06-01&end_date=2026-06-30[&sku=SKU-001]
```

- 参数与内部端点对齐：`project_id`(路径)、`start_date`/`end_date`(必填, `YYYY-MM-DD`)、`country`(默认 `US`)、`sku`(可选)。
- 响应 `data` = `ReturnAnalysisResponse` 同构（`schemas/return_analysis.py:97`）：
  - `project_id / project_name / country / start_date / end_date`
  - `summary`（total_returns/total_quantity/unique_skus/top_return_sku/top_return_reason/total_sales_quantity/total_sales_amount/overall_return_rate）
  - `summary_text`（模板化文字总结——Agent 可直接复述给用户）
  - `ranking_rows`（sku/asin/product_name/total_quantity/return_count/sales_quantity/return_rate/avg·min·max_return_cycle_days）
  - `reason_rows` / `trend_rows` / `disposition_rows` / `status_rows` / `weekday_rows` / `fulfillment_center_rows` / `multi_item_return_count/_quantity`
  - `feedback_rows`（sku/order_id/reason/reason_display/return_date + `customer_comment`）——**D4 待拍板**：是否对 Agent 剥离 `customer_comment`（PII；external 契约"永远不返回"）。推荐：默认剥离，`?include_comments=true` 显式开启（Agent 通道直连后端、凭据可控，与 external 网关通道信任模型不同，可开可关）。
- `_service_errors()` 壳翻译：项目不存在 → 404 `RESOURCE_NOT_FOUND`；非法日期/country → 400 `VALIDATION_FAILED`。

### 4.2 R2 per-SKU 聚合（原生替换镜像）

```
GET /api/v1/agent/projects/{pid}/return-analysis?period=30d&country=US[&sku=][&min_return_rate=5][&risk_level=critical][&limit=50][&offset=0][&order_by=return_quantity][&order_dir=desc]
```

- **查询契约与 external §9 完全一致**（保持既有 agent 消费者兼容）：`period`（7d/14d/30d/60d/90d/this_month/last_month/ytd/custom）+ `start_date`/`end_date`（custom only）+ `country` + `sku`/`min_return_rate`/`risk_level` 过滤 + `limit`(≤500)/`offset` + `order_by`/`order_dir`。
- 响应 `data` = `ReturnAnalysisAggregateResponse` 同构（`schemas/external/return_analysis.py:65`）：`project_id / period / country / summary / data`。
- **原生化增强（review 结论）**：`data[]` 每行补 `product_name`（join `SkuRecord`，同 `_build_sku_product_name_map` 逻辑）与 `reason_top1_display` / `disposition_top1_display`（`return_translations` 翻译）——文档 §9 承诺过但代码未实现，原生化时补上；`risk_trend` 需新算法，**不承诺**。

### 4.3 R3 raw 事件（原生替换镜像）

```
GET /api/v1/agent/projects/{pid}/return-analysis-raw?period=30d&country=US[&limit=10000][&offset=0][&order_by=return_date][&order_dir=desc]
```

- 查询契约与 external §9.2 一致；响应 `data` = `ReturnAnalysisRawResponse` 同构（`schemas/external/return_analysis.py:137`）。
- **PII 剥离契约保持不变**（`customer_comments`/`raw_row`/`fnsku`/`license_plate_number` 永不返回）——由 `ReturnAnalysisRawRow` schema 静态保证。

### 4.4 R4 单 SKU 钻取

```
GET /api/v1/agent/projects/{pid}/return-analysis/skus/{sku}?country=US&start_date=2026-06-01&end_date=2026-06-30
```

- 薄封装 `build_return_analysis(..., sku=sku)`，响应 = R1 overview 同构但**只含该 SKU**（无该 SKU 退货数据 → `data.summary.total_returns = 0` + 空分布行，而非 404——**与店铺域 R2 的 404 语义不同**：这里是"查询结果为空"，不是"资源不存在"；D6 待拍板，推荐 200 空结果）。

### 4.5 R5 数据覆盖度 / 新鲜度（新增）

```
GET /api/v1/agent/projects/{pid}/return-analysis/coverage?country=US
```

响应 `data`（草案）：

```json
{
  "project_id": 1,
  "country": "US",
  "report_uploads": [
    {
      "source_file_id": 123,
      "version": 2,
      "is_current": true,
      "period_start_date": "2026-06-01",
      "period_end_date": "2026-06-30",
      "ingestion_status": "success",
      "row_count": 1280,
      "original_filename": "return_202606.csv",
      "created_by": "admin",
      "created_at": "2026-07-02T03:00:00Z"
    }
  ],
  "snapshot": {
    "last_computed_at": "2026-08-06T03:00:00Z",
    "fresh": true,
    "staleness_threshold_hours": 25
  },
  "data_span": { "min_return_date": "2026-01-01", "max_return_date": "2026-06-30" }
}
```

- 查询：`analysis_source_files`（`report_type='return_report'` + country + `is_current=True`，按 period 倒序）+ `get_snapshot_last_computed_at(project_id, country)` + `is_snapshot_fresh_for_range(...)` 包装 `fresh` 布尔。
- **服务层新增**：一个小薄查询（放 `services/analysis/return_analysis/` 或端点模块内）；无新表、无迁移。

---

## 5. 错误码注册（`app/api/agent/errors.py`）

**v1 建议零新增错误码**——全部复用既有：

| 场景 | code | HTTP |
|---|---|---|
| 项目不存在 | `RESOURCE_NOT_FOUND` | 404 |
| 非法 period / date / country / order_by | `VALIDATION_FAILED`（external handler 已抛 HTTPException 400 → `_service_errors` 翻译） | 400 |
| 越权项目 / 越权域 | `AGENT_PROJECT_OUT_OF_SCOPE` / `AGENT_BUSINESS_OUT_OF_SCOPE` | 403 |
| 鉴权失败 / 限流 | `AGENT_AUTH_FAILED` / `AGENT_RATE_LIMIT_EXCEEDED` | 401 / 429 |

> 若 D6 拍板 R4 空结果返回 404（对齐店铺域），需新增 `RETURN_ANALYSIS_NO_DATA`——**本 spec 默认推荐 200 空结果**，不新增码。

---

## 6. 权限矩阵

| 能力 | 人类用户（内部端点） | Agent（`/agent/*`） | 备注 |
|---|---|---|---|
| 全量退货分析 | ✅ `GET /api/v1/return-analysis` | ✅ R1（受 project_scope + business_scope 限制） | 双路径 + 缓存与内部共享 |
| per-SKU 风险清单 | ❌ 内部无独立端点（overview 派生） | ✅ R2（risk_level/min_return_rate 过滤） | 原生替换镜像 |
| raw 事件明细 | ✅（overview 内部使用） | ✅ R3（PII 剥离） | 原生替换镜像 |
| 单 SKU 钻取 | ✅ `GET /api/v1/return-analysis?sku=` | ✅ R4（或 R1 `?sku=`） | D5 |
| 数据覆盖度/新鲜度 | ❌ 无独立端点 | ✅ R5（**新增**） | 仅 Agent 通道 |
| 退货报表上传 | ✅ 内部 upload / autoReportUpload | ❌ 不开放 | 文件通道，D2 立项评估 |
| 修改退货事件 | ❌ 无内部操作 | ❌ 不开放 | raw 行不可变事实 |

---

## 7. 测试清单（供执行子 issue）

| 文件 | 覆盖 |
|---|---|
| `backend/tests/api/agent/test_return_read.py` | R1 overview（参数校验/项目 404/`?sku=` 钻取/空数据 200）；R4 单 SKU；R2/R3 与 external handler 的**契约 parity**（同参数同结果，对齐 test_external_mirror 做法）；读不落审计 |
| `backend/tests/api/agent/test_return_coverage.py` | R5 覆盖度（报表上传列表/snapshot fresh 两分支/无数据时的 `last_computed_at=null`） |
| `backend/tests/api/agent/test_business_scope.py`（已有） | `business_scope` 含 `return_analysis` 放行 / 不含 403 |
| `backend/tests/api/agent/test_project_scope.py`（已有） | 退货域路由挂载后回归（`*` 放行 / 白名单命中 / 未命中 403） |
| `backend/tests/api/agent/test_external_mirror.py`（已有） | 断言 return-analysis 两路径已从 mirror 排除（镜像路由数减 2） |
| 前端 | 无新增（本域纯后端；若开放 `include_comments`，需在 Agent 调用说明文档标注） |

运行顺序（AGENTS.md 约定）：`cd backend && pytest -q tests/api/agent` → 全量无新增失败。

---

## 8. 与既有 contract / 文档的协同

1. **镜像排除**：`external_mirror.py` `_EXCLUDED_EXTERNAL_PATHS` 增加 `/external/projects/{project_id}/return-analysis` 与 `/external/projects/{project_id}/return-analysis-raw`（对齐 new-product-calculations precedent）。external 模块保留为 handler 来源，不再挂载（现状已如此）。
2. **openapi 再生成**：落地后重跑 `scripts/openapi_export.py` 并同步 `frontend/lib/api/api.d.ts`（BLF-465 流程），清除 external 残留类型、加入原生退货分析路由。
3. **external-api.md §9 契约偏差**：代码实现为准；原生 R2 补 `product_name`/`*_display` 字段时同步更新该文档 §9.1 示例（若 external 通道仍保留文档，标记 deprecated）。
4. **Refund 财务侧（D7）**：`analysis_pt_sku_details.actual_refund_amount/_units` 属支付报表分析（PT1）域。若拍板纳入退货分析域，需先核实 PT1 计算服务（`recompute_pt1_for_period` 等）与 agent 通道的连接成本——**本 spec 推荐不纳入**，单独立域（refund_analysis）或并入财务分析 Agent 后续设计。

---

## 9. 决策记录（待拍板）

| # | 决策点 | 默认建议 | 实施影响 |
|---|---|---|---|
| **D1** | **镜像去留**：R2/R3 与镜像路径冲突。A=原生迁移（mirror 排除 2 路径，原生保持 external §9 契约 + 增强）；B=保留镜像两条，仅新增 R1/R4/R5 | **A（原生迁移）**：契约 parity + display 增强 + 统一挂 business_scope | mirror 排除 2 路径；原生模块 `endpoints/agent/return_analysis.py`；openapi 再生成 |
| **D2** | **写路由**：退货分析域 v1 是否开放任何写能力 | **v1 全部读（推荐）**：raw 行不可变、无内部写操作对应；上传/标注/触发刷新立项评估 | 路由表 5 条全读；无 confirm/写桶/新错误码 |
| **D3** | **business_scope**：是否挂 `require_business_scope("return_analysis")` | **挂（推荐）**：与 shipments/shop_calculations 对齐，域 code 预留 | 新域 code 字符串，无迁移；`errors.py` 已有 `AGENT_BUSINESS_OUT_OF_SCOPE` |
| **D4** | **feedback_rows 顾客评论**：R1 overview 是否对 Agent 暴露 `customer_comment` 原文（PII） | **默认剥离 + `?include_comments=true` 显式开关（推荐）**；或完全剥离（对齐 external） | schema 加开关参数；Agent 调用说明文档标注 PII 注意 |
| **D5** | **R4 单 SKU 钻取**：独立路由 vs 并入 R1 `?sku=` | **独立 R4（推荐）**：路径风格对齐店铺域 `skus/{sku}`，Agent 工具定义更清晰 | 路由表 +1（薄封装） |
| **D6** | **R4 空结果语义**：无该 SKU 退货数据时 200 空 vs 404 | **200 空结果（推荐）**：查询结果为空 ≠ 资源不存在 | 不新增 `RETURN_ANALYSIS_NO_DATA` 错误码 |
| **D7** | **Refund 财务侧范围**：`actual_refund_amount/_units`（PT1）是否纳入本域 | **不纳入（推荐）**：属支付报表分析（PT1）域，单独立项 | 本 spec 范围保持 return 核心；§1.6 记录相邻资产 |

---

## 10. 执行前置（writing-plans 前确认）

- [ ] D1–D7 拍板（reviewer / 用户）；推荐组合：D1=A / D2=全读 / D3=挂 / D4=开关 / D5=独立 R4 / D6=200 空 / D7=不纳入
- [ ] 开执行子 issue：路由 5 条 + mirror 排除 2 路径 + R2/R3 原生化（契约 parity + display 增强）+ R5 覆盖度薄查询 + openapi 再生成 + 测试（§7 清单）
- [ ] 仓库当前 main 已含：P2 货件域、店铺测算域、新品测算域、project_scope、business_scope、`_EXCLUDED_EXTERNAL_PATHS` precedent——本 spec 引用的复用函数均为真实存在的符号

---

## 修订记录

- **v0.1（2026-08-07）**：BLF-470 产出。后端整体 review（退货分析域 4 表 + 服务层 + 内部/镜像端点 + 契约偏差 `product_name`/`*_display` 未实现）；可给 Agent 的资产盘点（§1.1–1.6）；API 分类 4 家族 + 路由表 5 条（R1 overview / R2 per-SKU / R3 raw / R4 单 SKU / R5 coverage）；schema 草案；错误码零新增；权限矩阵；测试清单；D1–D7 待拍板。
