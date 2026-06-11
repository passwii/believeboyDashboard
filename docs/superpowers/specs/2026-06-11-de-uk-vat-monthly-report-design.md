# DE / UK 月报 VAT 口径适配 — 设计文档

- 日期：2026-06-11
- 作者：Claude (brainstorming + writing-plans 衔接)
- 状态：待用户审查 → 实施规划

## 1. 背景与目标

DE（德国，VAT 19%）和 UK（英国，VAT 20%）站点的 Amazon Settlement Report 与 US 不同：消费者支付价 = product sales（net）+ product sales tax（VAT）。当前 PT3 / PT4 核算只读 `product_sales`，把 product_sales_tax 完全忽略，导致：

- **DE / UK 报表的"收入合计"** 比消费者实际支付少 19% / 20%
- **DE / UK 报表的"亚马逊回款金额"（amazon_pay_back）** 公式错误（缺 VAT 销项）
- **与亚马逊后台 Settlement Report 的"Total / 结算金额"对不上**

本次改造目标：

1. DE / UK 项目使用 **tax-inclusive（gross）口径**：收入合计 = sales + sales tax
2. 报表中**显式增加 VAT 列**（PT3 收入侧、PT4 支出侧）
3. **回款公式**改为 `收入 + 支出 - VAT`（与亚马逊结算语义一致）
4. US 项目**完全保持现状**（product_sales_tax = 0，gross = net，自动兼容）
5. 历史 DE / UK 报表**通过 recalculate 重算**

## 2. 范围

| 维度 | 在范围内 | 不在范围内 |
|---|---|---|
| 国家 | DE、UK | US（保持原状） |
| 报表 | 月度财务（PT3 / PT4 / 财务序列） | 周报 / 日报 / 广告 |
| 税列 | product_sales + product_sales_tax | shipping_tax / giftwrap_tax / promo_tax / marketplace_withheld_tax（暂不处理） |
| 视图 | 财务数据页面、PT3 双栏核算、Excel 导出 | 旧报表浏览器 / PDF 模板 |

## 3. 业务口径（已与用户确认）

| 项 | 决定 |
|---|---|
| VAT 合计范围 | 只合并 `product_sales + product_sales_tax` |
| 收入合计 | Gross（含税） |
| Sales 子项显示 | 子项保持 net，合计行才显式含税 |
| 回款公式 | `income_total + expense_total - vat_total`（VAT 为正数） |
| PT3 拆多 Tax 列 | 暂不加 |
| PT4 VAT 位置 | 在 `expense_total` 之后 |
| US 是否同步改 | 不动（US 的 product_sales_tax = 0，gross ≡ net） |
| 历史数据 | recalculate 重算（US 不动） |

## 4. 数据模型

### 4.1 `MonthlyReportPT3Calculation` 新增字段

| 字段 | 类型 | 含义 | 默认 |
|---|---|---|---|
| `income_vat_total` | Numeric(18,2) | 销售税合计（Order + Refund 全量 sum `product_sales_tax`） | 0 |
| `income_sales_with_tax` | Numeric(18,2) | 含税销售额 = `sum(product_sales + product_sales_tax)` 跨所有 Order/Refund 行 | 0 |

**两个字段都加**：`income_sales_with_tax` 用于前端直接展示"含税销售额"行（减少前端计算负担），`income_vat_total` 用于"VAT (Sales Tax)"独立行展示。

### 4.2 `MonthlyReportPT4Calculation` 新增字段

| 字段 | 类型 | 含义 | 默认 |
|---|---|---|---|
| `expense_vat_total` | Numeric(18,2) | VAT 合计（与 PT3 `income_vat_total` 同值，正数） | 0 |

**命名说明**：用 `expense_vat_total`（而不是 `vat_total`）是为了与 PT4 现有 `expense_*` 命名风格保持一致；前端展示为"VAT (Sales Tax)"。

### 4.3 不变

- `MonthlyReportTransaction` 表的 `product_sales_tax` 等税列**已经持久化**（`pt3.py:432` 在 `_build_transaction_payloads` 写入），**不需要再迁移**
- 所有现有 PT3 / PT4 字段不变

## 5. 公式

### 5.1 PT3（按 country 分支）

```
country in {'US'}：保持原状
  income_total = sum(income_product_sales_non_fba, ..., income_chargebacks)
  income_vat_total = 0
  income_sales_with_tax = 0  # US 不展示

country in {'DE', 'UK'}：tax-inclusive 口径
  vat_total = sum(product_sales_tax for all rows where type in {Order, Refund})
  sales_with_tax = sum(product_sales + product_sales_tax for all rows where type in {Order, Refund})
  # 注意：退款为负数（product_sales 是负的），自然实现 net
  income_vat_total = vat_total
  income_sales_with_tax = sales_with_tax
  income_total = 原 income_total + income_vat_total  # gross 化
```

### 5.2 PT4

```
US:
  expense_vat_total = 0
  income_total = 原值
  amazon_pay_back = income_total + expense_total

DE/UK:
  expense_vat_total = income_vat_total  # 与 PT3 同值
  income_total = 原值 + income_vat_total
  amazon_pay_back = income_total + expense_total - expense_vat_total
  # 等价于：原 net amazon_pay_back + 0（因 expense_vat_total = income_vat_total，与原 income_total 的增项对消）
  # 但前端展示"含税视角"下，amazon_pay_back 数字不变（自动正确）
```

**重要洞察**：用 `income + expense - vat` 的公式，**US 实际值 = 原值**（vat=0），**DE/UK 实际值 = 原值**（因为新增的 `+vat` 在 income 与 `expense_vat_total` 抵消），所以**回款总额不变**。变化的只是报表展示的结构。

### 5.3 PT3 双栏明细新增行

`pt3.py:_build_accounting_rows` 在 `income_lines` 末尾的"Total_Income"行**之前**插入两行：

| 英文 | 中文 | 来源 | country 条件 |
|---|---|---|---|
| Product sales tax (gross) | 销售税（gross） | `pt3.income_vat_total` | 全部 |
| (gap) | (空) | — | US 仍可保留行但值为 0 |

US 同样展示但值为 0，**保持报表结构一致**（不需要 country 条件渲染，避免 UI 分叉）。

**US 字段值计算说明**：
- `income_vat_total` 在 US = 0（US CSV 中 product_sales_tax 通常为 0）
- `income_sales_with_tax` 在 US = `income_total`（含税≡net，US 公式不区分）
- `expense_vat_total` 在 US = 0
- PT3 报表"含税销售额"行：US 也展示，金额 = income_total（与下面各子项加和相同）
- PT4 报表"VAT (Sales Tax)"行：US 也展示，金额 = 0

## 6. 实现拆解

### 6.1 后端

**重要发现**：PT3/PT4 计算有**两条独立的代码路径**，必须**同时改**：

| 路径 | 文件 | 触发场景 |
|---|---|---|
| 新上传 | `backend/app/tasks/scripts/monthly_report.py:run()` | 用户上传新报表 → 后台线程跑 |
| 重算 | `backend/app/services/payment/financial.py:compute_metrics()` → `monthly.py:rebuild_pt3_pt4_for_report` | 用户点"重算"按钮 |

两个文件**逻辑几乎一样**（财务指标计算），但**不共享代码**。需要在两处分别加 VAT 字段。**改动表如下**：

| 文件 | 改动 |
|---|---|
| `backend/app/models/monthly_report.py` | `MonthlyReportPT3Calculation` 加 `income_vat_total`、`income_sales_with_tax`；`MonthlyReportPT4Calculation` 加 `expense_vat_total` |
| `backend/alembic/versions/20260611_160_add_de_uk_vat_total.py` | 新迁移：PT3 +2 列、PT4 +1 列，server_default='0' |
| `backend/app/services/payment/financial.py:compute_metrics()` | **新 VAT 计算逻辑**（重算路径）。`_load_transaction_raw_rows` 读 `raw_row["product sales tax"]`，传入 `classified` 字典供 compute_metrics 消费。`pt3_payload` / `pt4_payload` 加新字段；`amazon_pay_back` 用新公式 |
| `backend/app/tasks/scripts/monthly_report.py:run()` | **同样 VAT 计算逻辑**（新上传路径，与 compute_metrics 保持一致） |
| `backend/app/services/report/pt3.py` | `_classify_monthly_rows` 在 `Order` / `Refund` 分支多读 `product sales tax` 进分类；`_build_accounting_rows` 在 `income_lines` 末尾插入 2 行（"Product sales tax (gross) / 销售税（gross）" + "Sales tax / VAT (Sales Tax) / 销售税"）；`_normalize_pt3_payload` 透传新字段 |
| `backend/app/services/report/pt4.py` | `_normalize_pt4_payload` 接受 `expense_vat_total` |
| `backend/app/services/report/export.py` | 核算明细 Excel 导出加新行 + 底部合计行同步 |
| `backend/app/schemas/monthly_report.py` | `MonthlyFinancialSeriesRow` 加 `income_vat_total` / `income_sales_with_tax` / `expense_vat_total`；`MonthlyFinancialTrendPoint` 加 `vat_total` |

**共享计算**：把 VAT 计算逻辑抽到 `app/services/payment/financial.py` 的一个新函数 `_compute_vat_metrics(classified, country)`，让 `compute_metrics` 和 `tasks/scripts/monthly_report.py:run()` 都调它。这样 DE/UK 公式只写一次，US 走 country='US' 分支时返回 0。

### 6.2 前端

**前端原则**：所有金额由后端算好，**前端只读取字段不重算**。前端 type 同步加字段，UI 多展示几行/几条线。

| 文件 | 改动 |
|---|---|
| `frontend/lib/monthly-report-types.ts`（或对应类型文件） | `MonthlyFinancialSeriesRow`、`MonthlyFinancialAccountingLine` 同步加 `income_vat_total` / `income_sales_with_tax` / `expense_vat_total` |
| `frontend/app/dashboard/data-analysis/financial-data/financial-data-client.tsx` | 财务序列 tab：chart 多一条 VAT 趋势线（与 income_total / expense_total 同色系）；明细 tab：双栏多 2 行（"含税销售额" + "VAT (Sales Tax)"） |
| `frontend/app/dashboard/data-analysis/financial-data/page.tsx` | 服务端初始化数据透传新字段 |
| `frontend/app/dashboard/data-reporting/monthly-report/*` | 上传后报表预览若展示 amazon_pay_back，**前端不重算公式**（直接显示后端算好的值） |

### 6.3 不在范围内

- 自动重算历史 DE/UK 报表：需在前端加一个"重算全部历史"按钮，或后端写一次性脚本。本次**只做按需重算**（用户在财务页面点"重算"）
- PDF 月度汇总报表：当前 PDF 模板未读取 PT3 / PT4 字段，**不动**
- 财务序列缓存：recalculate 已有 `invalidate_financial_series_cache`，**不动**

## 7. 数据流（按操作）

### 7.1 新上传报表（DE / UK 项目）

```
CSV 上传
  → read_payment_csv (locale=en)
  → 解析 product_sales / product_sales_tax 各自进入列
  → _build_transaction_payloads 持久化到 monthly_report_transactions
  → tasks/scripts/monthly_report.py:run() 计算 PT3/PT4
  → country='DE'/'UK' 走 tax-inclusive 分支
  → income_vat_total = sum(product_sales_tax)
  → income_total += income_vat_total
  → amazon_pay_back = income_total + expense_total - expense_vat_total
  → 落库
```

### 7.2 历史 DE / UK 报表重算

```
用户在财务页点"重算"
  → POST /api/v1/monthly-reports/financial-series/recalculate?project_id=X&country=DE
  → rebuild_pt3_pt4_for_report (monthly.py:680)
    → _load_transaction_raw_rows 从 monthly_report_transactions 表读 raw_row
    → raw_row["product sales tax"] 已存在（之前就持久化了）
    → 调 classify_rows
    → 调 PT3 / PT4 计算器（本次同步改动）
  → 落库（calculation_version 自增）
```

**关键点**：**历史数据**在 `monthly_report_transactions.raw_row` 里**已经存了** `product sales tax`（CSV 解析时已写入），所以重算**完全可用**，不需要回查 CSV 原始文件。

## 8. 错误处理

- 模型字段缺省值 0，存量报表读到 None 时 `_to_decimal(0)` 兜底
- `country == 'US'` 时 VAT 字段恒为 0，前端显示无变化
- `recalculate` 失败时事务回滚，旧 `calculation_version` 保留

## 9. 测试

### 9.1 技术测试

```bash
cd backend && pytest
cd frontend && pnpm lint && pnpm build
```

### 9.2 业务测试清单（提交给用户）

| 场景 | 操作 | 期望 |
|---|---|---|
| US 1 月报表重算 | 选 US 项目、1 月、点"重算" | income_total / amazon_pay_back 与重算前完全一致 |
| DE 1 月报表重算 | 选 DE 项目、1 月、点"重算" | 收入合计 + VAT 合计 = 含税总额，amazon_pay_back = 净回款 |
| UK 5 月报表上传 | 选 UK 项目、5 月、上传你提供的 CSV | 报表展示 "Sales tax (gross)" 行，金额 ≈ 已知 5 月 VAT |
| 财务序列 trend | 在财务页面查看 DE 项目趋势线 | 多一条 "VAT (Sales Tax)" 折线，与 income_total / expense_total 平行 |
| Excel 导出 | 在核算明细 tab 点"导出" | 报表核算 sheet 多一行"VAT (Sales Tax)"，金额与 UI 一致 |

## 10. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 历史 DE 报表 `monthly_report_transactions.raw_row` 中 product sales tax 为空（旧 CSV 解析版本） | 实施前查一两个 DE 项目的样本 row 验证；缺失则 VAT 字段 = 0，等同 US 行为但用户可见数字不变（仅展示少一行） |
| alembic 迁移在生产失败 | server_default='0' + nullable=False，新增列零风险 |
| 前端类型与后端不同步 | `pnpm build` 会强制类型检查 |
| 业务方对 VAT 口径有不同解读 | recalculate 后旧 `calculation_version` 仍可对比；UI 上保留旧报表版本切换 |

## 11. 后续（不在本轮）

- shipping_credits_tax / giftwrap_credits_tax / promotional_rebates_tax 也合并入 VAT 合计
- VAT 多档税率（19% / 20% / 7% 等）拆分
- PDF 月报模板同步展示 VAT
- 自动批量化重算历史 DE/UK 报表（一次性脚本）
