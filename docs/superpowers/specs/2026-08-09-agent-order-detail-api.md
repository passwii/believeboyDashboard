# 订单明细（ASIN×日）Agent API 设计（order_detail / orders/summary 扩展）

> **状态**：v0.1（2026-08-09，BLF-557 深度讨论定稿）。
> **结论摘要**：**方案 A — 扩展现有 `orders/summary`**，新增 `group_by` 参数提供 SQL 侧 ASIN×日/ASIN/日聚合 + 派生指标（TOP 排名 / 占比 / 去重订单数）；**不新建独立域**、不联表 sku_info（跨域，调用方自组）、不做跨国家/跨项目聚合（单域约束）。**不加新域 → 无新 business_scope 取值、无新表、无迁移**。

---

## 1. 文档目的与域定位

### 1.1 文档目的

从 BLF-479 下一阶段候选清单选定的「订单明细（ASIN×日）」方向（用户 2026-08-09 选定）做深度讨论与设计定稿：拍板 D1 重复性 / D2 单域标注 / D3 端点形态 / D4 必要元素 / D5 与月报体系边界。本 spec 供实施子 issue 照做。

### 1.2 域定位（单域原则）

- **单域原则**（`docs/agent-api-design.md` §1.2 #7）：每个端点只服务一个业务域，**允许域内聚合**（§1.2 #7a 明文举例：「如 `orders/summary` 把订单行聚合成统计」），**不允许跨域返回**（对照 BLF-476 删除 business-summary 的先例）。
- 本域 = **orders 域（销售订单行）**，数据源唯一表 `analysis_sales_order_rows`。ASIN×日聚合是对同一张订单行表的**域内聚合**——落在单域原则允许的范围内。
- **跨域明确不做**：与 `sku_info`（SKU 主数据）联表补成本/产品名属于「订单 + SKU 主数据」跨域 → 不允许；产品名已在订单行 `raw_row.product_name` 内（无需联表），成本（fob_unit_cost 等）由调用方通过既有 `/api/v1/agent/projects/{id}/sku-info` 单独获取后自组。

---

## 2. 现状底座清单（代码核实 2026-08-09）

### 2.1 数据模型 — `analysis_sales_order_rows`（`backend/app/models/product_analysis_source.py:356`）

- **粒度 = 订单行**：唯一键 `(project_id, amazon_order_id, sku, country, purchase_date_pt)`（BEL-348 行级 upsert）→ **一行 = ASIN×SKU×日×数量×金额**。
- 关键列：`amazon_order_id / purchase_date_pt / order_status / sku / asin / quantity / item_price / shipping_price / item_tax / shipping_tax / currency / country / is_counted_sales` + `raw_row`（JSON，含 `product_name` / `fulfillment_channel`）。
- 行级过滤语义统一走 `counted_sales_where`（`backend/app/services/sales_query.py`）：`project_id + country + 日期窗口 + is_counted_sales`，可选排除 Cancelled / Pending。

### 2.2 现有端点 — `GET /api/v1/agent/projects/{id}/orders/summary`（`backend/app/api/v1/endpoints/external/orders_summary.py` + 镜像）

- 参数：`period`/`start_date`/`end_date`、`country`（必填单站点）、`include_cancelled`（默认 false）、`include_pending`（默认 true）、`aggregate`（默认 true）、`limit`（默认 50000）、`offset`。
- 响应：`data`（原始行列表）+ `aggregate`/`summary` 汇总块（`total_orders / total_quantity / total_sales_amount / currency / fba_orders / fbm_orders`）。
- 经 `external_mirror.py` 程序化镜像为 `/api/v1/agent/projects/{id}/orders/summary`（已随 BLF-459 迁入 agent 命名空间；**镜像按原 handler 签名解析参数 → 加参数自动暴露，无需改镜像代码**，见 §3.3）。

### 2.3 内部 order_info（浏览器侧，不直接暴露给 Agent）

`backend/app/api/v1/endpoints/order_info.py`：`/page /list /stats /overview /filter-options /export`，支持 `asin_keyword`、日期范围、导出 CSV——面向 Dashboard 页面，非 Agent 契约。

### 2.4 月报体系 — `monthly_report_transactions`（`backend/app/models/monthly_report.py:105`）

- 财务口径流水：`product_sales / selling_fees / fba_fees / 各税项 / total`，按月 `report_month`、按结算 `settlement_id` 组织，SKU 级。
- 与订单行是**两套口径**（销售发生 vs 财务入账），见 §6（D5）。

### 2.5 生产库 / 代码既有聚合先例

- `report_builder_daily._query_top_skus`（`backend/app/services/scheduled_report/report_builder_daily.py:567`）：**已存在 SQL 侧 TOP SKU 聚合先例**（`group_by sku` + `sum(quantity)` + `sales_amount_expr(country)`）。
- `sales_amount_expr(country)`（`backend/app/services/scheduled_report/_sales_amount.py`）：**统一销售额口径**——DE/UK 含税（item+shipping+tax），其余站点净额（item+shipping）。所有日/周/月定时报告共用，防止口径漂移。
- `ai_insight_aggregator._aggregate_sales_by_date_sql`：按日聚合 + `count(distinct asin)` 先例。

---

## 3. 决策拍板（D1–D5）

| # | 决策点 | 结论 |
|---|---|---|
| **D1 重复性结论** | orders/summary 已有订单行原始数据，独立「订单明细域」是否重复？ | **原始行已覆盖（无重复价值），增量价值在「SQL 侧聚合 + 派生指标」**：现有 `aggregate` 是**页内汇总**（limit/offset 先于聚合，大周期 >limit 行时 total 失真，且 `total_orders` 是行数非去重订单数）；Agent 拉原始行做客户端聚合不可行（50k 行上限 + token 成本 + LLM 计算不可靠）。ASIN×日/ASIN 排名/占比是真正缺口 |
| **D2 单域标注** | ASIN×日聚合是「域内聚合」还是「跨域」？ | **域内聚合**（orders 域，同一张订单行表，`counted_sales_where` + `sales_amount_expr` 复用）→ §1.2 #7a 允许。**跨域部分（sku_info 联表补成本、跨国家汇总）显式不做**，调用方经 sku-info 端点自组 |
| **D3 端点形态** | A 扩展 orders/summary / B 新建独立域 / C 不加新端点 | **方案 A**：`orders/summary` 加 `group_by` 参数（`asin`/`asin_day`/`day`）。理由：复用计数/口径/期间解析全部基建；**镜像自动暴露新参数零改造**；不产生与 orders/summary 边界模糊的第二域（B 的问题）；C 无法满足真实缺口（客户端聚合不可行 + 现有 aggregate 页内失真）。**不新建域 → 无新 business_scope 取值、无迁移** |
| **D4 必要元素** | 逐端点字段表 | §5。期间复用 `parse_period_v2`；`country` 保持必填单站点；`group_by` 白名单；`order_by` 白名单；`share`（asin 模式可选）；`limit/offset` 作用于聚合行；`include_cancelled/include_pending` 语义不变 |
| **D5 与月报体系边界** | 订单行 vs `monthly_report_transactions` | §6：**销售发生口径（订单域）与财务入账口径（月报域）分离**。销量/销售额/TOP ASIN/趋势 → 本端点；利润/费用/回款 → 月报域（未来 finance_profit 独立域）。两口径不可混用 |

---

## 4. 端点形态（方案 A）设计

### 4.1 变更文件

| 文件 | 变更 |
|---|---|
| `backend/app/services/external/orders_summary.py` | **新增** `query_orders_summary_grouped(...)`（SQL 侧 group-by）；**不改**现有 `query_orders_summary` 签名与行为（存量消费者零影响） |
| `backend/app/api/v1/endpoints/external/orders_summary.py` | `get_external_orders_summary` **加参数** `group_by` / `order_by`（默认值 = 现有行为，向后兼容）；`group_by` 非空时转调 grouped 服务 |
| `backend/app/schemas/external/orders_summary.py` | **新增** `OrdersGroupedRow` / `OrdersGroupedResponse`（或扩展 `OrdersSummaryResponse` 加可选 `grouped` 块） |
| `backend/app/api/v1/endpoints/agent/external_mirror.py` | **零改动**（镜像沿 `__wrapped__` 保留原签名，新参数自动暴露） |
| `backend/tests/...` | 新增契约测试（见 §7） |

> **不涉及**：`agent/__init__.py`（无新 include_router）、`agent_api_keys.business_scope`（无新取值）、DB 迁移（无新表）、前端（纯后端，BLF-555）。

### 4.2 参数契约（全部向后兼容）

```
GET /api/v1/agent/projects/{project_id}/orders/summary
  ?period=7d | &start_date=&end_date=     # 期间（复用 parse_period_v2）
  &country=US                              # 必填，单站点（维持现有契约）
  &include_cancelled=false &include_pending=true
  &group_by=asin|asin_day|day              # 新增；缺省 = 现有原始行行为（不动）
  &order_by=sales_amount|quantity|order_count   # 新增；group_by 模式下生效，白名单校验
  &order_dir=desc|asc                      # 新增；默认 desc
  &limit=500 &offset=0                     # 作用于聚合行（group_by 模式下默认 500）
  &include_share=false                     # 新增；仅 group_by=asin 时返回 share 字段
```

- `group_by` 白名单：`asin`（TOP ASIN 排名）/ `asin_day`（ASIN×日明细）/ `day`（日趋势）。非法值 → 400 `VALIDATION_FAILED`。
- `order_by` 白名单：`sales_amount`（默认）/ `quantity` / `order_count`。非法值 → 400。
- `order_dir`：`desc`（默认）/ `asc`。
- **`aggregate` 语义修正（仅 group_by 模式）**：`summary` 为 **SQL 全量汇总**（不受 limit/offset 影响），修复现有模式「页内汇总」失真问题；非 group_by 模式保持现状不动（存量消费者零变化）。
- **销售额口径**：聚合金额统一走 `sales_amount_expr(country)`（DE/UK 含税，其余净额）——与定时报告体系对齐，**与现有 aggregate 的 `item_price*quantity` 简化口径不同**（spec 显式选择，§5.2 说明）。

### 4.3 响应结构（group_by 模式）

```
{ ok: true, data: {
    project_id, period, country, group_by,
    rows: [ OrdersGroupedRow ... ],        # 按 order_by/order_dir 排序
    total_rows,                            # 全量聚合行数（不受 limit 影响）
    summary: { total_orders, total_quantity, total_sales_amount, currency, fba_orders, fbm_orders }
} }
```

---

## 5. 必要元素定稿（D4）

### 5.1 行结构

```
group_by=asin      → { asin, product_name, quantity, sales_amount, order_count, share? }
group_by=asin_day  → { date, asin, product_name, quantity, sales_amount, order_count }
group_by=day       → { date, quantity, sales_amount, order_count, unique_asins }
```

- `product_name`：取该组 `raw_row->>'product_name'` 任一非空值（订单行内已有，**不联表 sku_info**）。
- `sales_amount`：`sales_amount_expr(country)` 聚合（`sum(item_price + shipping_price [+ tax, DE/UK])`），金额按 `round_money` 两位小数。
- `order_count`：`count(distinct amazon_order_id)`（**去重订单数**，与现有 `total_orders` 的行数语义不同）。
- `share`（仅 `group_by=asin&include_share=true`）：`sales_amount / Σsales_amount`，保留 4 位小数。
- `unique_asins`（仅 `group_by=day`）：`count(distinct asin)`。

### 5.2 口径决策（显式标注）

| 口径点 | 决策 | 依据 |
|---|---|---|
| 销售额 | `sales_amount_expr(country)`（DE/UK 含税） | 与日/周/月定时报告统一（BLF-475），避免 Agent 与报表数字对不上 |
| 订单数 | `count(distinct amazon_order_id)` | 语义正确；现有 aggregate 的 `total_orders` 是**行数**（多 SKU 订单计多行），spec 显式修正（仅 group_by 模式） |
| 空值/空结果 | 数值 `0`（聚合天然无 null）；空结果 → **200 + 空 rows**（非 404） | 对齐 account_health 约定：只有资源不存在（项目）→ 404 |
| 过滤 | `counted_sales_where`（is_counted_sales + 状态） | 与 orders/summary 一致 |

### 5.3 不做（YAGNI / 单域约束）

- **环比变化率（change rate）**：v1 不做（需要上一期间对比查询，复杂度翻倍）；Agent 可两次调用 `group_by=asin`（本期/上期）自行计算——编排归调用方（§1.2 #7b）。
- **跨国家/跨项目汇总**：不做（单域 + `country` 必填契约不变）；Agent 循环站点/项目调用后自组。
- **成本/毛利**：不做（跨域 sku_info 联表）；走既有 sku-info 端点。

---

## 6. 与月报体系边界（D5）

| 维度 | 订单域（本端点） | 月报域（`monthly_report_transactions`） |
|---|---|---|
| 口径 | **销售发生**（订单事件，`is_counted_sales` 过滤，`purchase_date_pt` 日期） | **财务入账**（结算 settlement，`transaction_date`，含费用/税/退款） |
| 粒度 | 订单行 / ASIN×日 | SKU × 结算月 |
| 用途 | 销量、销售额、TOP ASIN、趋势、占比 | 利润、费用、净回款、对账（PT3/PT4，未来 finance_profit 域） |
| Agent 消费 | 运营分析 | 财务分析（**独立域，不并入本端点**） |

边界结论：**两套数据不可在同一端点混用**；`monthly_report_transactions` 的 `product_sales` 与订单域 `sales_amount` 数字对不上是正常现象（含税口径/费用/结算时点差异），spec 显式声明避免 Agent 误判。

---

## 7. 测试清单（供实施子 issue）

1. **group_by=asin**：TOP 排名正确（销量/销售额/order_count 排序）；`include_share=true` 出 share 且 Σshare=1（±1e-4）；金额走 `sales_amount_expr`（DE/UK 含税用例）。
2. **group_by=asin_day**：行 = ASIN×日；多 SKU 同 ASIN 聚合；`order_count` 去重正确。
3. **group_by=day**：日趋势 + `unique_asins`。
4. **白名单校验**：`group_by`/`order_by` 非法值 → 400 `VALIDATION_FAILED`；`order_dir` 非法值 → 400。
5. **summary SQL 全量**：limit=1 时 `summary.total_quantity` 仍是全期间总量（修复页内汇总失真）；现有非 group_by 模式 aggregate 行为不变（回归锁）。
6. **向后兼容**：不带 `group_by` 的请求响应结构与现状完全一致（镜像 + external 双通道）。
7. **镜像暴露**：`/api/v1/agent/projects/{id}/orders/summary?group_by=asin&country=US` 在 agent 侧可调用（镜像签名解析测试）。
8. **鉴权/壳**：未鉴权 401 壳；项目不存在 404；project_scope 越界 403。
9. **回归**：`test_external_mirror.py` 全量 + 现有 orders/summary 相关测试零改动通过。

---

## 8. 影响面结论（BEL-93，CodeGraph 核实 2026-08-09）

- `query_orders_summary` / `get_external_orders_summary`：**0 调用方**（纯端点路径）→ 新增 grouped 服务函数不改现有签名，存量零影响。
- `counted_sales_where`（10 调用方）：**只读复用，不改**。
- `sales_amount_expr`（11 调用方，全在 scheduled_report）：**只读复用，不改**。
- `external_mirror._make_wrapper`：镜像沿 `__wrapped__` 保留原 handler 签名 → `group_by`/`order_by` 参数**自动暴露**到 agent 侧，镜像代码零改动。
- 前端：无改动（BLF-555 纯后端）。

## 9. 阶段规划

| 阶段 | issue | 范围 |
|---|---|---|
| **讨论定稿** | BLF-557（本 issue） | D1–D5 拍板 + 本 spec |
| **实施** | 实施子 issue（todo） | 照 §4/§5/§7：新增 grouped 服务 + 端点参数 + schema + 契约测试；无迁移 |

## 10. 风险与开放问题

1. **现有 `aggregate` 页内汇总失真**（>limit 行时 total 偏小）：v1 只修 group_by 模式（SQL 全量），不改存量行为——避免破坏现有消费者；存量修正可单列后续 issue。
2. **`total_orders` 语义**：group_by 模式为去重订单数，与存量 aggregate 的行数语义不同——spec 显式标注，避免 Agent 混用。
3. **DE/UK 含税口径**：group_by 模式金额与存量 aggregate（item_price*quantity）可能不同——spec 显式选择含税口径（对齐报表体系），风险为「存量消费者若依赖旧简化口径需知晓」；存量不提供含税列时（US）两者一致。
4. **大周期性能**：`count(distinct amazon_order_id)` + group-by 在百万行级仍需走索引（`idx_analysis_sales_order_project_country_date`）；v1 不预聚合缓存，观察生产用量后再定。

## 版本记录

- v0.1（2026-08-09）：BLF-557 深度讨论定稿——D1–D5 拍板 + 方案 A 端点设计 + 必要元素表 + 测试清单。
