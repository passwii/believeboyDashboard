# 后端 Payment Report 多套识别逻辑审查报告

> **生成时间**: 2026-05-15  
> **审查范围**: `backend/app/services/payment/` + `backend/app/services/report/` + `backend/app/utils/parsers.py` + `backend/app/services/product/persistence.py` + `backend/app/services/reconciliation_service.py`  
> **审查重点**: Payment Report 在多处的识别逻辑、国家识别、报表类型识别、多地方复用

---

## 一、总体架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Payment Report 数据流全景                        │
│                                                                     │
│  用户上传 CSV                                                       │
│      │                                                              │
│      ▼                                                              │
│  ① detect_payment_report_structure()  ← locale.py                   │
│      │  • 自动检测分隔符、编码、列映射                                │
│      │  • 国家 → locale 推断 (US→en, DE→de, UK→en)                 │
│      ▼                                                              │
│  ② read_payment_csv()  ← reader.py                                 │
│      │  • 读取 CSV，返回标准化 DataFrame                            │
│      │  • 列名统一为英文标准名                                       │
│      ▼                                                              │
│  ③ classify_rows()  ← classifier.py  (V1 分类)                     │
│      │  • 按 type/description/fulfillment 分为 23+ 类别             │
│      ▼                                                              │
│  ④ compute_metrics()  ← financial.py                               │
│      │  • 计算 PT3 (16收入+20支出) 和 PT4 (7收入+7支出) 指标        │
│      ▼                                                              │
│  ⑤ parse_to_db_rows()  ← parsing.py                                │
│      │  • CSV → DB 行 (AnalysisPaymentRow)                         │
│      └──────────────────────────────────────┐                       │
│                                             ▼                       │
│  ┌─────────────────────────────────────────┐│                       │
│  │       月度报告服务 (report/monthly.py)    ││                       │
│  │  validate_payment_report_project_match   ││                       │
│  │  → 国家验证 (Layer 1) + SKU→项目验证     ││                       │
│  │  → 持久化 → 月度任务 → PT3/PT4 重算     ││                       │
│  └─────────────────────────────────────────┘│                       │
│                                             ▼                       │
│  ┌─────────────────────────────────────────┐│                       │
│  │   产品分析服务 (product/persistence.py)   ││                       │
│  │  _persist_one_source_file("payment_report")│                     │
│  │  → parse_payment_rows() → DB 持久化     ││                       │
│  └─────────────────────────────────────────┘│                       │
│                                             ▼                       │
│  ┌─────────────────────────────────────────┐│                       │
│  │   对账服务 (reconciliation_service.py)    ││                       │
│  │  PT3 DB 值 vs PDF 提取值 逐字段对比      ││                       │
│  └─────────────────────────────────────────┘│                       │
│                                             ▼                       │
│  ┌─────────────────────────────────────────┐│                       │
│  │   数字大屏 (digital_display_service.py)   │◄─ 依赖聚合数据          │
│  └─────────────────────────────────────────┘│                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、多套识别逻辑详解

### 2.1 国家/地区识别（3 套独立机制）

| # | 位置 | 机制 | 粒度 | 可靠性 |
|---|------|------|------|--------|
| **A** | `locale.py:detect_payment_report_structure()` | 通过 `marketplace` 列值匹配 `amazon.com/.de/.co.uk` | 行级（取第一行非空值） | ⭐⭐⭐ |
| **B** | `validation.py:validate_project_match()` | 先用 A 方式检测，再与用户选择的国家对比 | 整文件 | ⭐⭐⭐ |
| **C** | `country.py:normalize_country()` | 将传入的国家字符串归一化为 US/DE/UK | 参数级 | ⭐⭐⭐ |

**关键代码片段 (A)**:
```python
# locale.py:91-96
if "amazon.com" in mkt_val:
    detected_country = "US"
elif "amazon.de" in mkt_val:
    detected_country = "DE"
elif "amazon.co.uk" in mkt_val:
    detected_country = "UK"
```

**关键代码片段 (B)** - 两层验证:
```python
# validation.py:56-82
# Layer 1: 国家一致性
if detected_country and detected_country != normalized_country:
    result["valid"] = False
    result["errors"].append(f"文件内容检测到站点为 {detected_zh}...")

# Layer 2: SKU → 项目匹配
matched_projects = db.execute(
    select(func.distinct(SkuRecord.project_name))
    .where(func.lower(SkuRecord.sku).in_(sku_lower))
    .where(SkuRecord.country == normalized_country)
)
```

**⚠️ 潜在问题**: 机制 A 只检查第一行 marketplace 值。如果文件混合了多个站点的数据，只会按第一行判定。

---

### 2.2 支付类型识别（2 套独立系统）

#### 系统 V1: `classifier.py` — 行分类器

- **输入**: 原始 CSV 行 (dict)
- **逻辑**: 按 `type` → `description` → `fulfillment` 优先级顺序匹配
- **输出**: 23 个预定义类别的字典
- **分类数**: 23 类

```python
# classifier.py:30-52
classified = {
    "order", "refund", "blank_type", "fba_customer_return_fee",
    "amazon_fees_reversal", "chargeback_refund", "liquidation",
    "adjustment", "service_fee", "fba_inventory_fee", "amazon_fees",
    "fee_adjustment", "deal_fee", "debt", "fba_transaction_fees",
    "fba_order", "fbm_order", "fba_refund", "fbm_refund",
    "adjustment_income", "adjustment_expense", "advertising",
    "agl_selection", "service_refund_for_advertiser",
    "amazon_fees_and_service_fee_without_ad", "price_discount",
    "fee_adjustment_weight_dim",
}
```

#### 系统 V2: `report/pt3.py:_classify_monthly_rows()` — 月度报告分类器

- **输入**: DB 中的 `MonthlyReportTransaction` 行
- **逻辑**: 按 `type` → `description` 匹配，仅 11 个类别
- **输出**: 11 个类别的字典
- **分类数**: 11 类

```python
# pt3.py:45-63
classified = {
    "order", "refund", "chargeback_refund", "liquidation",
    "fba_inventory_fee", "amazon_fees_and_service_fee_without_ad",
    "fba_transaction_fees", "fba_order", "fbm_order",
    "fba_refund", "fbm_refund", "adjustment_income",
    "adjustment_expense", "advertising", "service_refund_for_advertiser",
}
```

#### 类型别名归一化: `locale.py`

```python
# locale.py:69-82
PAYMENT_TYPE_ALIASES = {
    'Order': ['order', 'bestellung'],
    'Refund': ['refund', 'erstattung'],
    'Amazon Fees': ['amazon fees', 'gebuehren von amazon'],
    'Service Fee': ['service fee', 'servicegebuehr'],
    'FBA Inventory Fee': ['fba inventory fee', 'versand durch amazon lagergebuehr'],
    ...
}
```

**⚠️ 关键差异**:
| 对比维度 | V1 (classifier.py) | V2 (pt3.py) |
|---------|---------------------|-------------|
| 分类数 | 23 类 | 11 类 |
| 是否区分 FBA/FBM | ✅ 有 fba_order/fbm_order | ✅ 有 fba_order/fbm_order |
| blank_type 处理 | ✅ 单独分类 | ❌ 无处理 |
| price_discount | ✅ 单独分类 | ❌ 无处理 |
| fee_adjustment_weight_dim | ✅ 单独分类 | ❌ 无处理 |
| debt 处理 | ✅ 单独分类 | ❌ 无处理 |

**两个系统对同一 type 的分类逻辑不完全一致**，可能导致边际场景下结果不同。

---

### 2.3 报表类型识别（3 套系统）

#### (1) `report_type_service.py` — 归一化 + 别名
```python
REPORT_TYPE_ALIASES = {
    'ad_report': 'ad_product_report',  # 遗留类型映射
}

ALL_REPORT_TYPES = {
    'business_report', 'payment_report', 'ad_product_report',
    'sales_report', 'inventory_report', 'return_report'
}
```

#### (2) `product/persistence.py` — 持久化路由
```python
# persistence.py:134-152
if report_type == 'business_report':
    payloads, total, included = _parse_business_rows(...)
elif report_type == 'payment_report':
    payloads, total, included = _parse_payment_rows(...)
elif report_type == AD_PRODUCT_REPORT:
    payloads, total, included = _parse_ad_rows(...)
elif report_type == 'inventory_report':
    payloads, total, included = _parse_inventory_rows(...)
elif report_type == 'sales_report':
    payloads, total, included = _parse_sales_rows(...)
```

#### (3) `product_analysis_reports.py` (Endpoint 层)
```python
# 文件 ID 映射
file_ids = {
    'business_report': data.business_report_file_id,
    'payment_report': data.payment_report_file_id,
    'ad_report': data.ad_report_file_id,  # ← 仍用旧名
}
```

**⚠️ 不一致**: Endpoint 层仍用 `ad_report`，内部服务已归一化为 `ad_product_report`。虽通过 `_lookup_report_mapping_value` 做了兼容，但代码风格不统一。

---

### 2.4 描述字段多语言识别: `locale.py`

```python
PAYMENT_DESCRIPTION_ALIASES = {
    'Cost of Advertising': ['cost of advertising', 'werbekosten'],
    'Refund for Advertiser': ['refund for advertiser', 'werbekosten-erstattung', 'erstattung werbekosten'],
    'FBA Inventory Reimbursement - General Adjustment': [...],
    'Fee Adjustment - Weight and Dimension Change': [...],
    ...  # 18 个描述类型
}
```

**特殊处理**:
- 德文变音字符归一化: `ä→ae, ö→oe, ü→ue, ß→ss` (`_normalize_payment_token`)
- 德文待映射监控: `PAYMENT_DESCRIPTION_ALIASES_PENDING_DE` (预留空字典，有监控日志)
- 兜底策略: pattern 匹配 (`price discount`, `coupon redemption fee`, `retrocharge` 等)

---

## 三、多地方复用分析

### 3.1 `payment/locale.py` 被以下 5 个地方引用

| 消费者 | 引用内容 | 文件 |
|--------|---------|------|
| `payment/reader.py` | `read_payment_report_dataframe()` | `reader.py:12` |
| `payment/parsing.py` | `read_payment_report_dataframe()` | `parsing.py:10` |
| `payment/validation.py` | `read_payment_report_dataframe()` | `validation.py:12` |
| `payment/__init__.py` | 导出别名 `validate_payment_report_project_match` | `__init__.py:13` |
| `services/product/persistence.py` | `_read_payment_report_locale` | `persistence.py:24` |

### 3.2 `payment/classifier.py:classify_rows()` 被以下地方引用

| 消费者 | 引用方式 |
|--------|---------|
| `financial.py:compute_metrics()` | 直接调用，作为 PT3/PT4 计算输入 |

### 3.3 `payment/financial.py:compute_metrics()` 被以下地方引用

| 消费者 | 引用方式 |
|--------|---------|
| 月度报告运行时任务 | 通过 `analysis_report_runtime_service` → script handler |

### 3.4 `utils/parsers.py:parse_payment_rows()` 被以下地方引用

| 消费者 | 引用方式 |
|--------|---------|
| `payment/parsing.py:parse_to_db_rows()` | 直接调用 |
| `product/persistence.py:_persist_one_source_file()` | 直接调用 |
| `autoReportUpload/` | 直接调用（独立进程） |

### 3.5 `report/pt3.py` 函数复用

| 函数 | 被引用处 |
|------|---------|
| `_build_transaction_payloads()` | `monthly.py:persist_monthly_report_result()` |
| `_classify_monthly_rows()` | `export.py:export_financial_accounting_detail_workbook()` |
| `_build_accounting_rows()` | `export.py:export_financial_accounting_detail_workbook()` + `pt3.py` 自身导出 |
| `_load_transaction_raw_rows()` | `export.py:export_financial_accounting_detail_workbook()` |

---

## 四、重复/冗余逻辑识别

### 4.1 数字解析逻辑重复

**`locale.py:parse_localized_number()`** vs **`utils/__init__.py` 中的工具函数**:
- 两套数字解析逻辑存在（德文逗号/点号互换逻辑重复）
- 建议统一到 `utils` 模块

### 4.2 交易分类逻辑重复

**`classifier.py:classify_rows()`** vs **`pt3.py:_classify_monthly_rows()`**:
- 两套分类逻辑独立维护，规则不完全一致
- V1 (classifier) 有 23 类，V2 (pt3) 有 11 类
- V2 的 `advertising` 和 `service_refund_for_advertiser` 分类逻辑与 V1 一致但代码重复

### 4.3 月份解析重复

**`report/utils.py:_parse_report_month()`** vs **`export.py:_parse_report_month()`**:
- 两个完全相同的函数存在于不同模块
- 建议只保留一处导出

### 4.4 报告类型归一化分散

```
report_type_service.py:normalize_report_type()
persistence.py:normalize_report_type() (通过 import)
parsers.py:normalize_report_type() (通过 import)
```

归一化逻辑已统一到 `report_type_service.py`，其他地方通过 import 引用 ✅

---

## 五、关键数据流识别总结

### 5.1 Payment Report 处理的完整路径

```
upload CSV
  │
  ├─► [同步] validate_payment_report_project_match()
  │       ├─ locale.py: read_payment_report_dataframe() → 检测国家
  │       ├─ marketplace 列 → 国家推断
  │       └─ SKU → project_name 匹配
  │
  ├─► [异步/同步] monthly_report_runtime_service → task script
  │       ├─ read_payment_csv() → locale.py → DataFrame
  │       ├─ classify_rows() → classifier.py → 23类
  │       └─ compute_metrics() → financial.py → PT3 + PT4
  │
  └─► [异步] persist_monthly_report_result()
          ├─ _build_transaction_payloads() → DB insert
          ├─ _normalize_pt3_payload() → DB insert
          └─ _normalize_pt4_payload() → DB insert
```

### 5.2 Product Analysis 路径中的 Payment Report

```
upload source files
  │
  ├─► persist_product_analysis_sources()
  │       └─ payment_report → _persist_one_source_file()
  │               ├─ _read_payment_report_locale() → DataFrame
  │               └─ parse_payment_rows() → DB rows
  │
  └─► (可选) calculation run → list_weekly_product_analysis_from_details()
```

---

## 六、建议优化项

| # | 优先级 | 建议 | 影响范围 |
|---|--------|------|---------|
| 1 | 🔴 高 | 合并 `classifier.py` 和 `pt3.py` 的分类逻辑，消除重复并确保一致性 | financial.py, pt3.py, export.py |
| 2 | 🔴 高 | 统一 `_parse_report_month()` 定义，去除 `export.py` 中的副本 | report/utils.py, export.py |
| 3 | 🟡 中 | `locale.py` 数字解析逻辑抽取为独立工具，与 `utils` 共享 | locale.py, parsers.py |
| 4 | 🟡 中 | `detected_country` 逻辑应扫描全文件而非仅第一行，提高混合文件容错 | validation.py |
| 5 | 🟡 中 | endpoint 层 `ad_report` 应迁移为 `ad_product_report` 统一命名 | product_analysis_reports.py |
| 6 | 🟢 低 | `PAYMENT_DESCRIPTION_ALIASES_PENDING_DE` 空字典应移除或补充 | locale.py |
| 7 | 🟢 低 | 考虑将 `PaymentReportStructure` 的 encoding 检测抽取为独立函数 | locale.py |

---

## 七、文件依赖关系图

```
locale.py ←────── reader.py
    │                │
    │                ├── parsing.py ──→ (autoReportUpload)
    │                │
    │                └── validation.py ──→ (monthly_reports endpoint)
    │
    ├── classifier.py ──→ financial.py ──→ (monthly_report task script)
    │
    └── (export.py imports from pt3.py, which has its own classifier)

parsers.py ──→ persistence.py ──→ product endpoints
parsers.py ──→ parsing.py ──→ payment.__init__.py

report_type_service.py ──→ persistence.py, parsers.py
```

---

## 八、结论

Payment Report 的核心识别逻辑分布在 **3 层**、**6 个文件** 中，存在 **2 套独立的分类系统** 和 **1 处函数重复定义**。虽然通过接口归一化（`__init__.py` 导出别名、`report_type_service.py` 统一类型名）做了部分整合，但分类逻辑的重复是最值得关注的维护风险点。建议优先合并 classifier 和 pt3 的分类体系，确保所有消费端使用同一套识别规则。