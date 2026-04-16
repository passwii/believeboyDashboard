# Data-Analysis 模块业务逻辑

## 模块概述

Data-Analysis 是跨境外电商运营数据分析平台的核心分析模块，负责处理多种报表类型的分析计算。

### 支持的报表类型
- `business_report` - 业务报告
- `payment_report` - 支付报告
- `ad_product_report` - 广告产品报告
- `sales_report` - 销售报告
- `inventory_report` - 库存报告

### 支持的分析周期
- **日分析** - Daily Analysis
- **周度 PT1** - 周产品分析
- **月度 PT3/PT4** - 月度收支明细与汇总

---

## 核心处理流程

### 1. PT1 周度产品分析流程

```
┌─────────────────────────────────────────────────────────────┐
│                      上传文件                                │
│  business_report + payment_report + ad_report               │
│  + optional inventory_report                                │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│         persist_product_analysis_sources()                  │
│  → 创建 AnalysisSourceFile 记录                             │
│  → 行数据摄入 Analysis* 表                                   │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            product_analysis_script.run()                    │
│  → 合并: cost_df + ad_df + business_df + payment_aggregate  │
│  → 每 SKU 计算约 40 个指标                                   │
│  → 存储 AnalysisPT1Calculation + AnalysisPTSKUDetail       │
└─────────────────────────────────────────────────────────────┘
```

### 2. 月度报表 PT3/PT4 流程

```
┌─────────────────────────────────────────────────────────────┐
│                      上传文件                                │
│  payment_transaction_file + optional monthly_summary_pdf   │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│     monthly_report_runtime_service.create_task()            │
│  → 创建后台任务                                              │
│  → 后台 job 运行 monthly_report_script                      │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            monthly_report_script 分类处理                    │
│  分类所有 payment 行按类型:                                  │
│  Order, Refund, Service Fee, etc.                          │
│                                                             │
│  → PT3: 详细收支明细 (40+ 字段)                              │
│  → PT4: 简化汇总 (销售, 费用, amazon_pay_back)               │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│          persist_monthly_report_result()                    │
│  → 存储 MonthlyReport                                       │
│  → 存储 MonthlyReportTransaction                            │
│  → 存储 PT3 + PT4                                           │
│  → 失效 financial_series 缓存                               │
└─────────────────────────────────────────────────────────────┘
```

### 3. 日分析聚合流程

```
┌─────────────────────────────────────────────────────────────┐
│                      查询数据                                 │
│  sales_report + ad_product_report + inventory_report        │
│  (指定日期范围)                                              │
└─────────────────────┬───────────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────┐
│           daily_analysis_service.build_daily_analysis()     │
│                                                             │
│  → 加载销售指标 (order_qty, sales_amount)                   │
│  → 加载广告指标 (impressions, clicks, spend, ad_orders)     │
│  → 加载库存 (available_qty per SKU)                        │
│  → 聚合为 summary_rows (按日期)                             │
│  → 聚合为 detail_rows (按日期 + SKU)                        │
│  → Redis 缓存结果                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 月度处理逻辑要点

### 月份标识
- 使用 `YYYY-MM` 格式的 `report_month` 标识月份

### 收入分类
| 类型 | 说明 |
|------|------|
| FBA 销售 | FBA 订单收入 |
| FBM 销售 | 自发货订单收入 |
| 退款 | 包含 FBA "other" 列的退款 |
| 调整项 | 其他调整收入 |
| 运费 | 运费收入 |
| 促销回扣 | 促销相关回扣 |

### 支出分类
| 类型 | 说明 |
|------|------|
| 平台佣金 | 平台收取的佣金 |
| FBA 费用 | FBA 仓储和配送费用 |
| 交易费 | 交易手续费 |
| 服务费 | 平台服务费 |
| 广告费 | 广告投放费用 |

### PT4 核心公式
```
amazon_pay_back = income_total + expense_total
（其中 expense_total 为负数）
```

---

## 关键计算公式（PT1）

### 广告相关指标
```python
广告点击率 = ad_clicks / ad_impressions
广告单占比 = ad_orders / 总销量
广告转化率 = ad_orders / ad_clicks
CPC = ad_spend / ad_clicks
ACOS = ad_spend / ad_sales_amount
```

### 流量计算
```python
自然流量 = 页面浏览量 - 广告点击量
自然单 = 总销量 - 广告订单量
```

### 利润计算
```python
利润 = 实际销售额 - 总成本 - 广告花费 - 实际退款额
利润率 = 利润 / 实际销售额
```

---

## 公共关联模块

### ProductCost - 产品成本
- **FOB 成本** - 离岸价成本
- **头程成本 (RMB)** - 运费成本，按 `exchange_rate` 转换

### ExchangeRate - 汇率
- 按 `yyyy-mm` 年月对应汇率
- 用于成本货币转换

### Project - 项目
- 用于项目访问控制

---

## 多站点处理（payment_report_locale）

### 支持站点
- **US** - 英语站点
- **DE** - 德语站点
- **UK** - 英语站点

### DE 站点特殊处理

#### 列名映射
```python
"Typ" → "type"
"Umsaetze" → "product sales"
```

#### 数字格式
- 使用 **逗号** 作为小数点
- 例如：`12,34` 表示 `12.34`
