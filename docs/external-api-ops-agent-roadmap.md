# External API · 运营 Agent 数据对接全景图

> **术语说明（2026-08）**：本文中的"external API"此后请按 **"Agent API · 读侧"**
> 理解——该命名空间已更名为 `/api/v1/agent/*` 并升级为读写 API
> （见 [`docs/agent-api-design.md`](./agent-api-design.md)）。文件名与正文保留历史表述。

> **状态**：规划中（先不落地，本图用于对内汇报 / 排期）
> **起草**：2026-08-02
> **定位**：external API 是**暴露层**，不是采集层。能不能给某个运营 Agent 开接口，取决于后端有没有结构化数据。本图按"消费方 Agent"组织，每个数据域标注成熟度。

---

## 背景

现有 external API 的消费方画像已清晰：

- **广告 Agent** —— 10 个广告域（ad_budgets / ad_campaigns / ad_invalid_traffic / ad_placements / ad_promoted_products / ad_purchased_products / ad_search_term_shares / ad_search_terms / ad_targets / ad_time_trends，均为 aggregate + raw 双端点）
- **供应链 Agent** —— inventory_ledger（库存台账，5 端点）/ replenishment_analysis（补货）/ sku_info（主数据）
- **通用** —— projects（项目列表）/ orders_summary（订单销售汇总）

> **BLF-476（2026-08-07）**：`business-summary` 已删除——跨域聚合端点不符合「单域」设计原则（见 `docs/agent-api-design.md` §1.2 #7）。

本轮扩展的本质：把消费方从广告 + 供应链，扩到**客服 / 财务 / 合规 / 选品 / 经营管理**。

**核心约束**：external API 只能暴露"已结构化进库"的数据。某域能否开端点，取决于后端数据落地情况，而非业务上想不想要。

---

## 成熟度图例

| 级别 | 含义 | 工作性质 |
|---|---|---|
| **L1 已就绪** | 数据已结构化进库 | 纯端点工作，沿用现有 external 模式（aggregate+raw / period / 白名单过滤）|
| **L2 在库待加工** | 数据在，但口径 / 粒度需确认，或后端需先算好 | 端点 + 计算口径工作 |
| **L3 需采集** | 数据没进库 | 先建 SP-API / 报告上传采集管道，**不是端点问题** |
| **L4 衍生聚合** | 跨域打包 | 面向 Agent 场景的复合端点，依赖 L1/L2 数据先齐 |

---

## 主矩阵：运营 Agent × 数据需求 × 现状 × 建议端点

| 运营 Agent | 数据需求 | 现状底座（后端模型）| 成熟度 | 建议端点 |
|---|---|---|---|---|
| **广告** | 投放 / 搜索词 / 预算 / 竞品份额 | 10 个广告域 | ✅ 已覆盖 | （已有，无需新增）|
| **供应链 / 库存** | 库存台账 / 补货 / 主数据 | `inventory_ledger` / `inventory_replenishment*` / `sku_info` | ✅ 已覆盖 | （已有）|
| **供应链 / 物流** | FBA 货件明细 + 异常预警 | `shipment_schedules` + `shipment_schedule_items` | 🟡 L1+L3 | `/shipments`（明细 L1）+ 超期靠日期推导；海关 / 货损需 Amazon 侧状态（L3）|
| **客服** | 退货 / 客诉（ASIN 维度）| `return_analysis_records` + `return_customer_comments` | 🟢 L1 | `/returns/analysis`（aggregate + raw）|
| **客服 / 舆情** | Review / Rating / 买家消息 | ❌ 无 | 🔴 L3 | 需 SP-API Reviews + Buyer-Seller 消息采集 |
| **财务** | 利润 / 财务（每月 / 每 SKU）| `monthly_report` PT3/PT4 + `monthly_report_transactions` | 🟡 L2 | `/finance/profit` —— 先定口径（见下）|
| **财务 / 税务** | VAT 申报 / 发票 | `vat_entity` / `vat_invoice` | 🟢 L1 | `/vat/*`（欧洲合规，内部税务数据）|
| **合规 / 风控** | 账户健康 / 绩效指标 / listing 状态 | ❌ 完全空白 | 🔴 L3 | 需 SP-API Account Health 采集（ODR / 迟发率 / 政策警告 / 抑制）|
| **选品 / 经营** | 销售明细（ASIN×日）| `monthly_report_transactions` / `AnalysisSalesOrderRow` | 🟡 L1/L2 | 先确认 `orders_summary` 是否已到 ASIN×日，避免重复 |
| **选品 / 竞品** | 类目研究 / 竞品 / SKU 损益 | `category_research_*` / `AnalysisPTSKUDetail` | 🟢 L1 | `/category-research`、`/product-analysis` |
| **经营 / 管理** | 店铺 KPI / 单品画像 | 跨域聚合 | 🟣 L4 | `/stores/{id}/kpi-snapshot`、`/products/{asin}/health` |
| **CRM / 客户** | 客户 / 线索 / 跟进 | `crm.py`（内部用）| ⚪ 未规划 | 内部系统，对外暴露需先定边界 |

---

## 用户候选 5 项 · 逐一定位

| 候选 | 定位 | 结论 |
|---|---|---|
| 销售明细（ASIN×日）| L1/L2 | 大概率已有数据，**先查 `orders_summary` 粒度**再决定开不开 |
| 退货 / 客诉（ASIN）| **L1** | 字段最全（含顾客评论文本），客服 Agent 可直接跑，**最该先做** |
| 利润 / 财务（每月 / 每 SKU）| **L2** | 月度损益在**项目×国家**粒度；SKU 级只有流水。**真利润缺 COGS 口径**，要先拍 |
| FBA 货件 + 异常预警 | L1+L3 | 内部排期明细可开；**"海关卡住 / 货损"做不了**（无 Amazon 侧货件状态字段）|
| 账户健康 / 合规 | **L3** | 价值最高、成本最高 —— 是个**采集项目**，不是端点 |

### 关键数据底座说明

- **退货客诉（L1，字段最全）**：`return_analysis_records` 有 return_date / order_id / sku / asin / fnsku / quantity / detailed_disposition / reason / status / fulfillment_center_id；关联 `return_customer_comments` 存**顾客评论文本**。客服 Agent 可直接做退货归因。
- **FBA 货件（L1+L3）**：`shipment_schedules` 有 shipment_no / tracking_no / ETD / ETA / actual_inbound_date / shipment_status(draft/in_transit/completed) / 物流成本；`items` 有 SKU / 数量 / 箱数 / 体积重量。"超期"可由 ETA 已过未入库推导；但**海关卡住 / 货损属 Amazon 侧 FBA_INBOUND 货件状态，库里没有**。
- **利润财务（L2）**：PT3/PT4 月度损益在**项目×国家**粒度（income_total / expense_total / amazon_pay_back）；SKU 级只有交易流水（product_sales / selling_fees / fba_fees / 广告费）。`sku_info` 有 fob_unit_cost / first_leg_cost_rmb，但**没有"已算好的 SKU 利润"表**。
- **账户健康（L3，完全空白）**：Account Health Rating / 政策警告 / listing 抑制 / 绩效指标（ODR、迟发率、有效追踪率）均未采集。

---

## 建议优先级（ROI × 成本）

```
第一梯队（L1，零采集，先让 Agent 跑起来）
  退货客诉  →  选品/竞品  →  VAT税务

第二梯队（L2，先定口径再开）
  利润财务（定 COGS 口径）  →  销售明细（确认是否与 orders_summary 重复）

第三梯队（L3，采集项目，单独立项）
  账户健康/合规（最高价值）  →  Review舆情  →  FBA Amazon侧状态

贯穿（L4，等第一二梯队数据齐了再打包）
  单品健康画像  →  店铺KPI快照
```

---

## 落地前需拍板的口径问题

1. **利润口径**：暴露交易流水让 Agent 自算，还是后端先算好 SKU 级利润（需把 `sku_info` 的 fob_unit_cost + first_leg_cost 摊进成本）？
2. **异常预警归属**：FBA"超期"这类推导逻辑，放后端算好暴露，还是暴露原始日期让 Agent 自判？

---

## 附：现有 external API 端点清单（基线）

- 广告 10 域：`ad-budgets` / `ad-campaigns` / `ad-invalid-traffic` / `ad-placements` / `ad-promoted-products` / `ad-purchased-products` / `ad-search-term-shares` / `ad-search-terms` / `ad-targets` / `ad-time-trends`（aggregate + raw）
- 库存：`inventory-ledger`（months / snapshot / events / receipt-clusters / integrity）
- 补货：`replenishment-analysis`
- 主数据：`sku-info`、`projects`
- 汇总：`orders/summary`

设计模式约定：aggregate + raw 双端点、`period` / `start_date` / `end_date` 时间窗、`country` 过滤、白名单 `order_by`、`limit` / `offset` 分页、`include_total`。新增 L1 端点沿用此模式。
