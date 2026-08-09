# 销售数据（ASIN×日）Agent API 设计（sales/summary，前身 orders/summary）

> **状态**：v0.3（2026-08-09，BLF-569 路径/域 code 迁移定稿）。
> **结论摘要**：**方案 A — 扩展现有 `sales/summary`**（`group_by=asin|asin_day|day` + 派生指标；前身 `orders/summary`，BLF-569 按用户拍板迁移：路径 orders→sales、域 code orders→sales、旧路径双挂保留迁移提示期），**v0.2 新增两项**：
> ① **单项目多站点聚合进 V1**（`country` 支持逗号分隔多值，行按国家分组、按国家货币独立结算，**不做跨币种求和**——系统无通用汇率，仅 RMB→目标币）；
> ② **权限/控制门对齐**：sales/summary 从镜像族改造为**原生 agent 域**（新增 `business_scope("sales")`，挂 `require_business_scope` + `require_project_scope`，`_EXCLUDED_EXTERNAL_PATHS` 排除镜像）——与 account_health / return_analysis 等原生域同规。
> 仍不联表 sku_info（跨域）、不做跨项目聚合（v1，调用方自组）。**新 business_scope 取值 `sales`（字符串列无迁移，存量含 `orders` 的 key 上线时 UPDATE 为 `sales`）、无新表**。
> **v0.3（BLF-569）变更**：端点路径 `orders/summary` → `sales/summary`，域 code `orders` → `sales`；旧路径 `/orders/summary` 双挂保留（Deprecation + Sunset + Link successor 头），行为与 sales/summary 零漂移（对齐 BLF-459 三阶段：双挂 → 切换 → 下线）。

---

## 1. 文档目的与域定位

### 1.1 文档目的

从 BLF-479 下一阶段候选清单选定的「订单明细（ASIN×日）」方向（用户 2026-08-09 选定）做深度讨论与设计定稿：拍板 D1 重复性 / D2 单域标注 / D3 端点形态 / D4 必要元素 / D5 与月报体系边界。v0.2 依用户 2026-08-09 追加指示修订：**单项目多站点聚合进 V1**、**权限/控制门与其他 agent API 对齐**、**按新规则改造（存量不合规域需调整）**。v0.3（BLF-569）依用户 2026-08-09 拍板实施**端点路径 + 域 code 迁移**（orders→sales，板块定名「销售数据 Sales Data」，BLF-557 标题/§2.9 已同步）。本 spec 供实施子 issue 照做。

### 1.2 域定位（单域原则）

- **单域原则**（`docs/agent-api-design.md` §1.2 #7）：每个端点只服务一个业务域，**允许域内聚合**（§1.2 #7a 明文举例：「如 `orders/summary` 把订单行聚合成统计」），**不允许跨域返回**（对照 BLF-476 删除 business-summary 的先例）。
- 本域 = **sales 域（销售订单行，BLF-569 前称 orders 域）**，数据源唯一表 `analysis_sales_order_rows`。ASIN×日聚合是对同一张订单行表的**域内聚合**——落在单域原则允许的范围内。
- **单项目多站点聚合 = 域内聚合**：`country` 是订单行表自身的维度列（每行有 country），同一项目内跨站点聚合仍只读一张订单行表——不构成跨域。**唯一约束是货币**：不同站点币种不同（US=$ / DE=€ / UK=£），系统汇率服务仅支持 RMB→目标币（`convert_rmb_to_target_currency`），**无通用 FX** → **v1 不做跨币种求和**，按国家分组、按国家货币独立结算（§5.2）。
- **跨域明确不做**：与 `sku_info`（SKU 主数据）联表补成本/产品名属于「订单 + SKU 主数据」跨域 → 不允许；产品名已在订单行 `raw_row.product_name` 内（无需联表），成本（fob_unit_cost 等）由调用方通过既有 `/api/v1/agent/projects/{id}/sku-info` 单独获取后自组。

---

## 2. 现状底座清单（代码核实 2026-08-09）

### 2.1 数据模型 — `analysis_sales_order_rows`（`backend/app/models/product_analysis_source.py:356`）

- **粒度 = 订单行**：唯一键 `(project_id, amazon_order_id, sku, country, purchase_date_pt)`（BEL-348 行级 upsert）→ **一行 = ASIN×SKU×日×数量×金额**。
- 关键列：`amazon_order_id / purchase_date_pt / order_status / sku / asin / quantity / item_price / shipping_price / item_tax / shipping_tax / currency / country / is_counted_sales` + `raw_row`（JSON，含 `product_name` / `fulfillment_channel`）。
- 行级过滤语义统一走 `counted_sales_where`（`backend/app/services/sales_query.py`）：`project_id + country + 日期窗口 + is_counted_sales`，可选排除 Cancelled / Pending。

### 2.2 现有端点 — `GET /api/v1/agent/projects/{id}/sales/summary`（BLF-558 已实现；BLF-569 迁移前为 `orders/summary`）

- 参数：`period`/`start_date`/`end_date`、`country`（必填单站点）、`include_cancelled`（默认 false）、`include_pending`（默认 true）、`group_by`（`asin`/`asin_day`/`day`，BLF-558 新增）、`order_by`/`order_dir`/`include_share`、`limit`/`offset`。
- 响应：`data`（原始行，非 group_by 模式）+ `aggregate`/`summary`；group_by 模式返回 `rows` + `total_rows` + `summary`（SQL 全量，修复页内汇总失真）。
- **当前挂载形态 = 原生域**：`agent/sales.py` 原生路由（BLF-569 前为 `agent/orders.py`），路由级挂 `require_project_scope` + 域级 `require_business_scope("sales")`；镜像侧 `_EXCLUDED_EXTERNAL_PATHS` 排除 `/external/projects/{id}/orders/summary`（external 源路由不动，仅作 handler 来源）——与 account_health 等原生域同规。旧路径 `/orders/summary` 双挂保留迁移提示期。
- BLF-558（PR #208）已合并 main（`06bc9f0a`）：`query_orders_summary_grouped` + 端点参数 + `OrdersGroupedRow/OrdersGroupedResponse` + 17 例契约测试。

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

## 3. 决策拍板（D1–D6）

| # | 决策点 | 结论 |
|---|---|---|
| **D1 重复性结论** | sales/summary 已有订单行原始数据，独立「销售数据域」是否重复？ | **原始行已覆盖（无重复价值），增量价值在「SQL 侧聚合 + 派生指标」**：现有 `aggregate` 是**页内汇总**（limit/offset 先于聚合，大周期 >limit 行时 total 失真，且 `total_orders` 是行数非去重订单数）；Agent 拉原始行做客户端聚合不可行（50k 行上限 + token 成本 + LLM 计算不可靠）。ASIN×日/ASIN 排名/占比是真正缺口（BLF-558 已落地） |
| **D2 单域标注** | ASIN×日聚合是「域内聚合」还是「跨域」？ | **域内聚合**（sales 域，同一张订单行表，`counted_sales_where` + `sales_amount_expr` 复用）→ §1.2 #7a 允许。**单项目多站点聚合同样域内**（country 是行内维度列）。**跨域部分（sku_info 联表补成本）显式不做**，调用方经 sku-info 端点自组 |
| **D3 端点形态** | A 扩展 orders/summary / B 新建独立域 / C 不加新端点 | **方案 A + v0.2 权限门改造**：① 继续扩展 `sales/summary`（`group_by` 已落地）；② **从镜像族改造为原生 agent 域**——域 code `orders` → `sales`（BLF-569），`agent/__init__.py` 挂 `require_business_scope("sales")`，`_EXCLUDED_EXTERNAL_PATHS` 排除 `/external/projects/{project_id}/orders/summary`（对齐 return_analysis / replenishment_analysis 原生化先例）。理由：与其他 agent API 权限门一致（用户 2026-08-09 决定 2）；镜像族无 business_scope 是历史缺口，本域先行对齐 |
| **D4 必要元素** | 逐端点字段表 | §5。期间复用 `parse_period_v2`；**`country` 支持逗号分隔多值（单项目多站点聚合，v0.2 新增）**；`group_by` 白名单；`order_by` 白名单；`share`（asin 模式可选）；`limit/offset` 作用于聚合行；`include_cancelled/include_pending` 语义不变 |
| **D5 与月报体系边界** | 订单行 vs `monthly_report_transactions` | §6：**销售发生口径（订单域）与财务入账口径（月报域）分离**。销量/销售额/TOP ASIN/趋势 → 本端点；利润/费用/回款 → 月报域（未来 finance_profit 独立域）。两口径不可混用 |
| **D6 存量不合规域调整** | 现有业务域不符合新规则的如何处置 | **本 issue 范围内**：orders/summary 先行对齐（D3）。**范围外**：其余镜像族域（ad_* 10 条、sku-info、inventory-ledger、shop-calculation-history、pricing-snapshots）同样缺 business_scope → 记录为**后续独立改造程序**（§10 #5），不在本 PR 扩大爆炸半径 |

---

## 4. 端点形态（方案 A + v0.2 权限门改造）设计

### 4.1 变更文件

| 文件 | 变更 |
|---|---|
| `backend/app/services/external/orders_summary.py` | **新增** `query_orders_summary_grouped(...)`（BLF-558 已落地）；**v0.2**：`country` 支持逗号分隔多值 → grouped 聚合按 (group 维度 × country) 分组，行带 `country` + `currency` 字段；**不改**现有 `query_orders_summary` 签名与行为 |
| `backend/app/api/v1/endpoints/external/orders_summary.py` | `country` 参数支持逗号分隔多值（向后兼容：单站点行为不变）；`group_by` 非空时转调 grouped 服务 |
| `backend/app/schemas/external/orders_summary.py` | `OrdersGroupedRow` 增加 `country`/`currency` 字段；`OrdersGroupedResponse.summary` 增加 `by_country` 子块 |
| `backend/app/api/v1/endpoints/agent/sales.py` | **v0.2 新增原生域路由**（BLF-569 由 `agent/orders.py` 改名迁移）：复用 external service（`query_orders_summary` / `query_orders_summary_grouped`）+ `_service_errors` 壳 + `agent_ok` 响应壳，挂 `require_project_scope`（对齐 return_analysis 原生化模板）；v0.3 主路径改 `/sales/summary`，旧 `/orders/summary` 双挂（Deprecation/Sunset/Link successor 头） |
| `backend/app/api/v1/endpoints/agent/__init__.py` | `include_router(sales_router, dependencies=[Depends(require_business_scope("sales"))])`（**必须插在兜底路由之前**） |
| `backend/app/api/v1/endpoints/agent/external_mirror.py` | `_EXCLUDED_EXTERNAL_PATHS` 增加 `/external/projects/{project_id}/orders/summary`（防止镜像与原生化双挂冲突） |
| `backend/tests/...` | 新增契约测试（见 §7） |

> **涉及**：`agent_api_keys.business_scope` 取值 `orders` → `sales`（字符串列，**无迁移**——对齐 account_health BLF-550 先例；存量含 `orders` 的 key 上线时 SQL UPDATE 为 `sales`，`*` 全放行不受影响）。**不涉及**：DB 迁移（无新表）、前端代码（BLF-555 纯后端，前端注册表需 @Seth 同步）。
> **既有消费者影响（BLF-569）**：路径 `orders/summary` → `sales/summary` 迁移 + 域 code `orders` → `sales`。旧路径 `/api/v1/agent/projects/{id}/orders/summary` 双挂保留（Deprecation + Sunset + Link successor-version 头，行为零漂移），消费者有时间切换（Sunset 前）；到期后执行 v3 下线。存量 agent key 若 `business_scope` 未含 `sales` 会 403（存量 key 的 business_scope 大多为 `*` 全放行，实际影响面需上线前核查，见 §10 #2）。

### 4.2 参数契约（全部向后兼容）

```
GET /api/v1/agent/projects/{project_id}/sales/summary
  ?period=7d | &start_date=&end_date=     # 期间（复用 parse_period_v2）
  &country=US[,DE[,UK]]                    # 单站点或多站点（逗号分隔，v0.2 新增多值；单站点行为不变）
  &include_cancelled=false &include_pending=true
  &group_by=asin|asin_day|day              # 缺省 = 现有原始行行为（不动）
  &order_by=sales_amount|quantity|order_count   # group_by 模式下生效，白名单校验
  &order_dir=desc|asc                      # 默认 desc
  &limit=500 &offset=0                     # 作用于聚合行（group_by 模式下默认 500）
  &include_share=false                     # 仅 group_by=asin 时返回 share 字段
```

- `group_by` 白名单：`asin`（TOP ASIN 排名）/ `asin_day`（ASIN×日明细）/ `day`（日趋势）。非法值 → 400 `VALIDATION_FAILED`。
- `order_by` 白名单：`sales_amount`（默认）/ `quantity` / `order_count`。非法值 → 400。
- `order_dir`：`desc`（默认）/ `asc`。
- **`country` 多值语义（v0.2）**：逗号分隔（如 `country=US,DE`），解析后按列表过滤；空值行为不变（单站点必填契约；多站点时至少 1 个，非法国家 → 400）。**多站点时 group 键 = (group_by 维度 × country)**，行带 `country` + `currency`；单站点时行结构与 v0.1 一致（`country` 字段仍返回，兼容增量）。
- **`aggregate` 语义修正（仅 group_by 模式）**：`summary` 为 **SQL 全量汇总**（不受 limit/offset 影响），修复现有模式「页内汇总」失真问题；非 group_by 模式保持现状不动（存量消费者零变化）。
- **销售额口径**：聚合金额统一走 `sales_amount_expr(country)`（DE/UK 含税，其余净额）——与定时报告体系对齐，**与现有 aggregate 的 `item_price*quantity` 简化口径不同**（spec 显式选择，§5.2 说明）。

### 4.3 响应结构（group_by 模式）

```
{ ok: true, data: {
    project_id, period, countries: ["US","DE"], group_by,
    rows: [ OrdersGroupedRow ... ],        # 按 order_by/order_dir 排序；多站点时按 (维度×country) 分组
    total_rows,                            # 全量聚合行数（不受 limit 影响）
    summary: {
        total_orders, total_quantity,      # 跨站点合计（订单数/数量可直接求和）
        by_country: {                      # 多站点平行展示：金额逐站独立列出（币种独立，不做跨币种求和）
            "US": { currency, total_sales_amount, total_orders, total_quantity },
            "DE": { currency, total_sales_amount, total_orders, total_quantity }
        }
    }
} }
```

> `summary.by_country`：**v0.2 金额语义核心——「多站点金额不做跨币种求和，多站点平行展示」**（用户 2026-08-09 拍板）：跨站点 `total_sales_amount` 不提供（币种不可加），改为**逐站点平行列出**（每站独立货币、独立金额）；`total_orders`/`total_quantity` 可跨站点直接求和（数量/去重订单数无量纲）。行结构同样平行：多站点时每行带 `country`+`currency`，Agent 按国家取对应金额。

---

## 5. 必要元素定稿（D4）

### 5.1 行结构

```
group_by=asin      → { country, currency, asin, product_name, quantity, sales_amount, order_count, share? }
group_by=asin_day  → { country, currency, date, asin, product_name, quantity, sales_amount, order_count }
group_by=day       → { country, currency, date, quantity, sales_amount, order_count, unique_asins }
```

- `country`/`currency`：**v0.2 新增**（`currency` 取该组 `max(row.currency)`，同一国家内一致）。单站点时仍返回（增量字段，向后兼容）。
- `product_name`：取该组 `raw_row->>'product_name'` 任一非空值（订单行内已有，**不联表 sku_info**）。
- `sales_amount`：`sales_amount_expr(country)` 聚合（`sum(item_price + shipping_price [+ tax, DE/UK])`），金额按 `round_money` 两位小数。**按国家独立结算，不做跨币种求和**。
- `order_count`：`count(distinct amazon_order_id)`（**去重订单数**，与现有 `total_orders` 的行数语义不同）。
- `share`（仅 `group_by=asin&include_share=true`）：**按国家内** `sales_amount / Σ(同国家 sales_amount)`，保留 4 位小数。
- `unique_asins`（仅 `group_by=day`）：`count(distinct asin)`（按国家维度）。

### 5.2 口径决策（显式标注）

| 口径点 | 决策 | 依据 |
|---|---|---|
| 销售额 | `sales_amount_expr(country)`（DE/UK 含税） | 与日/周/月定时报告统一（BLF-475），避免 Agent 与报表数字对不上 |
| **跨站点金额** | **不做跨币种求和，多站点平行展示**：`summary.by_country` 逐站独立列出 | 系统汇率服务仅 RMB→目标币（`convert_rmb_to_target_currency`），无通用 FX（USD→EUR 等）；跨币种求和会产生无意义数字（§1.2）；用户 2026-08-09 拍板「平行展示」 |
| 订单数 | `count(distinct amazon_order_id)` | 语义正确；现有 aggregate 的 `total_orders` 是**行数**（多 SKU 订单计多行），spec 显式修正（仅 group_by 模式） |
| 空值/空结果 | 数值 `0`（聚合天然无 null）；空结果 → **200 + 空 rows**（非 404） | 对齐 account_health 约定：只有资源不存在（项目）→ 404 |
| 过滤 | `counted_sales_where`（is_counted_sales + 状态），country 用 `IN (...)` | 与 sales/summary 一致 |

### 5.3 不做（YAGNI / 单域约束）

- **环比变化率（change rate）**：v1 不做（需要上一期间对比查询，复杂度翻倍）；Agent 可两次调用 `group_by=asin`（本期/上期）自行计算——编排归调用方（§1.2 #7b）。
- **跨项目聚合**：不做（v1；`project_id` 保持路径单值）；Agent 循环项目调用后自组。
- **跨币种换算**：不做（无通用 FX）；如需统一币种由调用方用汇率自组。
- **成本/毛利**：不做（跨域 sku_info 联表）；走既有 sku-info 端点。

---

## 6. 与月报体系边界（D5）

| 维度 | 订单域（本端点） | 月报域（`monthly_report_transactions`） |
|---|---|---|
| 口径 | **销售发生**（订单事件，`is_counted_sales` 过滤，`purchase_date_pt` 日期） | **财务入账**（结算 settlement，`transaction_date`，含费用/税/退款） |
| 粒度 | 订单行 / ASIN×日（×国家） | SKU × 结算月 |
| 用途 | 销量、销售额、TOP ASIN、趋势、占比 | 利润、费用、净回款、对账（PT3/PT4，未来 finance_profit 域） |
| Agent 消费 | 运营分析 | 财务分析（**独立域，不并入本端点**） |

边界结论：**两套数据不可在同一端点混用**；`monthly_report_transactions` 的 `product_sales` 与订单域 `sales_amount` 数字对不上是正常现象（含税口径/费用/结算时点差异），spec 显式声明避免 Agent 误判。

---

## 7. 测试清单（供实施子 issue）

1. **group_by=asin**：TOP 排名正确（销量/销售额/order_count 排序）；`include_share=true` 出 share 且同国家 Σshare=1（±1e-4）；金额走 `sales_amount_expr`（DE/UK 含税用例）。
2. **group_by=asin_day**：行 = ASIN×日（×国家）；多 SKU 同 ASIN 聚合；`order_count` 去重正确。
3. **group_by=day**：日趋势 + `unique_asins`。
4. **多站点 `country=US,DE`（v0.2）**：行按 (维度×country) 分组且带 `country`/`currency`；`summary.by_country` 各站金额独立（US=$ / DE=€ 不混加）；`total_orders`/`total_quantity` 跨站求和正确；单站点 `country=US` 行为与 v0.1 一致（回归锁）。
5. **白名单校验**：`group_by`/`order_by` 非法值 → 400 `VALIDATION_FAILED`；`order_dir` 非法值 → 400；多站点含非法国家 → 400。
6. **summary SQL 全量**：limit=1 时 `summary` 仍是全期间总量（修复页内汇总失真）；现有非 group_by 模式 aggregate 行为不变（回归锁）。
7. **向后兼容**：不带 `group_by` 的请求响应结构与现状完全一致。
8. **权限门（v0.2 + BLF-569）**：原生路由 `/api/v1/agent/projects/{id}/sales/summary` 挂 `business_scope("sales")`——key 无 `sales` 域 → 403 `AGENT_BUSINESS_OUT_OF_SCOPE`；`business_scope="*"` → 放行；project_scope 越界 → 403；镜像排除后 `_EXCLUDED_EXTERNAL_PATHS` 无双挂冲突（test_external_mirror 全量回归）。
9. **迁移提示（v0.3）**：旧路径 `/api/v1/agent/projects/{id}/orders/summary` 双挂保留——行为与 sales/summary 零漂移（group_by / 非 group_by 各验），响应带 `Deprecation: true` + `Sunset` + `Link: </.../sales/summary>; rel="successor-version"`；新路径不带 Deprecation 头。
10. **回归**：`test_external_mirror.py` 全量 + 现有 sales/summary 相关测试零改动通过。

---

## 8. 影响面结论（BEL-93，CodeGraph 核实 2026-08-09）

- `query_orders_summary` / `get_external_orders_summary`：**仅测试调用方**（CodeGraph 核实 2026-08-09：3 例 service 测试 + 1 例镜像 parity 测试）→ sales 原生路由复用同一 service，无双实现。
- `query_orders_summary_grouped`：**0 调用方**（纯端点路径）→ BLF-569 迁移不改签名。
- `counted_sales_where`（10 调用方）：**只读复用，不改**。
- `sales_amount_expr`（11 调用方，全在 scheduled_report）：**只读复用，不改**。
- `agent/__init__.py`：追加一个 `include_router`（必须插在兜底路由之前）——纯增量；`external_mirror._EXCLUDED_EXTERNAL_PATHS` 加一条——纯增量。
- `agent_api_keys.business_scope`：取值 `orders` → `sales`（BLF-569 迁移，字符串列无 alembic 迁移；存量含 `orders` 的 key 上线时 SQL UPDATE 为 `sales`，`*` 全放行不受影响——BLF-550 account_health 同款先例）。
- 前端：无改动（BLF-555 纯后端）。

## 9. 阶段规划

| 阶段 | issue | 范围 |
|---|---|---|
| **讨论定稿** | BLF-557（本 issue） | D1–D6 拍板 + 本 spec（v0.1 已落库 PR #207；v0.2 修订本 PR） |
| **实施 v1（已交付）** | BLF-558（done） | group_by 单站点聚合（PR #208 已合 main） |
| **实施 v1 扩展** | BLF-560（done） | 多站点聚合（country 多值）+ 原生域路由 + business_scope("orders") + 测试；无迁移 |
| **实施 v0.3 迁移** | BLF-569（本 issue） | 路径 orders/summary → sales/summary + 域 code orders → sales；旧路径双挂（Deprecation/Sunset/Link successor）；测试 + 无迁移 |

## 10. 风险与开放问题

1. **现有 `aggregate` 页内汇总失真**（>limit 行时 total 偏小）：v1 只修 group_by 模式（SQL 全量），不改存量行为——避免破坏现有消费者；存量修正可单列后续 issue。
2. **存量 agent key 的 business_scope 影响面**（v0.2 + BLF-569）：原生后新增 `sales` 域校验，且域 code 由 `orders` 迁移为 `sales`。存量 key `business_scope` 为 `*` 全放行的不受影响；**若存在含 `orders` 的白名单 key，上线后 sales/summary 会 403——实施前须核查 `agent_api_keys.business_scope` 分布，存量含 `orders` 的 key 同步 UPDATE 为 `sales`（上线清单项）。
3. **`total_orders` 语义**：group_by 模式为去重订单数，与存量 aggregate 的行数语义不同——spec 显式标注，避免 Agent 混用。
4. **DE/UK 含税口径**：group_by 模式金额与存量 aggregate（item_price*quantity）可能不同——spec 显式选择含税口径（对齐报表体系）；存量不提供含税列时（US）两者一致。
5. **存量镜像族域缺 business_scope（D6）**：ad_*（10 条）、sku-info、inventory-ledger、shop-calculation-history、pricing-snapshots 同样无 business_scope——本 PR 不动（爆炸半径控制），记录为**后续独立改造程序**（可在 BLF-479 下开子 issue，逐域对齐）。
6. **大周期性能**：`count(distinct amazon_order_id)` + group-by 在百万行级仍需走索引（`idx_analysis_sales_order_project_country_date`）；多站点 `country IN (...)` 仍命中该索引；v1 不预聚合缓存，观察生产用量后再定。

## 版本记录

- v0.1（2026-08-09）：BLF-557 深度讨论定稿——D1–D5 拍板 + 方案 A 端点设计 + 必要元素表 + 测试清单。
- v0.2（2026-08-09）：用户追加拍板——① 单项目多站点聚合进 V1（country 多值 + by_country 平行展示，**不做跨币种求和**）；② orders/summary 镜像族→原生 agent 域 + `business_scope("orders")` 权限门；③ 按新规则改造、存量不合规域调整（D6 记录，爆炸半径外）。
- v0.3（2026-08-09）：用户拍板（BLF-557 命名讨论）——① 板块定名「销售数据（Sales Data）」；② 端点路径迁移 `orders/summary` → `sales/summary`；③ 域 code 迁移 `orders` → `sales`（用户明确不用担 scope 问题，可接受破坏性变更）；④ 旧路径双挂保留（Deprecation + Sunset + Link successor 头，对齐 BLF-459 三阶段），文件改名 `agent-sales-data-api.md`。
