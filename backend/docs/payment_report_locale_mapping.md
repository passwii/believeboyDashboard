# Payment Report 德美站点对照表

> 本文档记录 Payment Report 在德国站（DE）和美国站（US）之间的字段映射关系
> 
> 最后更新: $(date '+%Y-%m-%d')
> 对应代码文件: `app/services/payment_report_locale.py`

---

## 🎯 核心设计原则：Graceful Degradation

**重要说明**：本系统采用 "优雅降级" 设计，确保德国站映射不完整时不会影响业务逻辑：

1. **英文作为 Fallback**：对于尚未映射的 Description，系统会保留英文值
2. **业务逻辑使用标准化值**：所有业务判断都基于标准化后的英文描述
3. **监控机制**：自动记录未识别的德文描述，便于后续补充

---

## 一、列名（表头）对照表

| 标准英文名 | 美国站列名 | 德国站列名 | 德国站中文翻译 | 映射状态 |
|-----------|-----------|-----------|--------------|---------|
| date/time | date/time | Datum/Uhrzeit | 日期/时间 | ✅ 已映射 |
| settlement id | settlement id | Abrechnungsnummer | 结算编号 | ✅ 已映射 |
| type | type | Typ | 类型 | ✅ 已映射 |
| order id | order id | Bestellnummer | 订单号 | ✅ 已映射 |
| sku | sku | SKU | SKU | ✅ 已映射 |
| description | description | Beschreibung | 描述 | ✅ 已映射 |
| quantity | quantity | Menge | 数量 | ✅ 已映射 |
| marketplace | marketplace | Marketplace | 商城 | ✅ 已映射 |
| account type | account type | ❌ **无对应** | - | ⚠️ 仅US |
| fulfillment | fulfillment | Versand | 配送 | ✅ 已映射 |
| order city | order city | Ort der Bestellung | 订单城市 | ✅ 已映射 |
| order state | order state | Bundesland | 州/省 | ✅ 已映射 |
| order postal | order postal | Postleitzahl | 邮编 | ✅ 已映射 |
| tax collection model | tax collection model | Steuererhebungsmodell | 税收模式 | ✅ 已映射 |
| product sales | product sales | Umsätze | 销售额 | ✅ 已映射 |
| product sales tax | product sales tax | Produktumsatzsteuer | 产品销售税 | ✅ 已映射 |
| shipping credits | shipping credits | Gutschrift für Versandkosten | 运费积分 | ✅ 已映射 |
| shipping credits tax | shipping credits tax | Steuer auf Versandgutschrift | 运费税 | ✅ 已映射 |
| gift wrap credits | gift wrap credits | Gutschrift für Geschenkverpackung | 礼品包装积分 | ✅ 已映射 |
| giftwrap credits tax | giftwrap credits tax | Steuer auf Geschenkverpackungsgutschriften | 礼品包装税 | ✅ 已映射 |
| regulatory fee | Regulatory Fee | ❌ **无此列** | - | ⚠️ 仅US |
| tax on regulatory fee | Tax On Regulatory Fee | ❌ **无此列** | - | ⚠️ 仅US |
| promotional rebates | promotional rebates | Rabatte aus Werbeaktionen | 促销折扣 | ✅ 已映射 |
| promotional rebates tax | promotional rebates tax | Steuer auf Aktionsrabatte | 促销折扣税 | ✅ 已映射 |
| marketplace withheld tax | marketplace withheld tax | Einbehaltene Steuer auf Marketplace | 商城代扣税 | ✅ 已映射 |
| selling fees | selling fees | Verkaufsgebühren | 销售费用 | ✅ 已映射 |
| fba fees | fba fees | Gebühren zu Versand durch Amazon | FBA费用 | ✅ 已映射 |
| other transaction fees | other transaction fees | Andere Transaktionsgebühren | 其他交易费 | ✅ 已映射 |
| other | other | Andere | 其他 | ✅ 已映射 |
| total | total | Gesamt | 总计 | ✅ 已映射 |
| transaction status | Transaction Status | Transaktionsstatus | 交易状态 | ✅ 可选列 (存 raw_row) |
| transaction release date | Transaction Release Date | Freigabedatum der Transaktion | 交易释放日期 | ✅ 可选列 (存 raw_row) |

### 列分类说明

#### 1. 核心列（业务逻辑必需）
- `date/time`, `settlement id`, `type`, `order id`, `sku`, `description`
- `quantity`, `product sales`, `selling fees`, `fba fees`, `total`
- 这些列有专用的数据库字段，必须存在

#### 2. 可选列（存入 raw_row JSON）
- ✅ `transaction status` / `Transaktionsstatus` 
- ✅ `transaction release date` / `Freigabedatum der Transaktion`

**处理策略**：
- 不创建单独的数据库列（无需 Alembic 迁移）
- 数据会保留在 `raw_row` JSON 字段中
- 如果报表中有这些列，数据会被自动保存
- 如果报表中没有，不影响解析

#### 3. 德国站缺少的列
- ❌ `regulatory fee` / `tax on regulatory fee` (仅美国站)
- ❌ `account type` (仅美国站)

#### 4. 数值格式差异
   - 美国站：使用逗号作为千位分隔符，点作为小数点（如 `1,234.56`）
   - 德国站：使用点作为千位分隔符，逗号作为小数点（如 `1.234,56`）

---

## 二、Type 字段对照表

| 标准英文 Type | 美国站 Type | 德国站 Type | 德国站中文翻译 | 映射状态 |
|-------------|------------|------------|--------------|---------|
| Order | Order | Bestellung | 订单 | ✅ 已映射 |
| Refund | Refund | Erstattung | 退款 | ✅ 已映射 |
| Amazon Fees | Amazon Fees | Gebühren von Amazon | 亚马逊费用 | ✅ 已映射 |
| Service Fee | Service Fee | Servicegebühr | 服务费 | ✅ 已映射 |
| FBA Inventory Fee | FBA Inventory Fee | Versand durch Amazon Lagergebühr | FBA库存费 | ✅ 已映射 |
| Transfer | Transfer | Übertrag | 转账 | ✅ 已映射 |
| FBA Transaction Fees | FBA Transaction Fees | ❌ **待确认** | - | ⚠️ 预留 |
| Chargeback Refund | Chargeback Refund | ❌ **待确认** | - | ⚠️ 预留 |
| Liquidations | Liquidations | ❌ **待确认** | - | ⚠️ 预留 |
| Adjustment | Adjustment | ❌ **待确认** | - | ⚠️ 预留 |
| Deal Fee | Deal Fee | ❌ **待确认** | - | ⚠️ 预留 |
| Debt | Debt | ❌ **待确认** | - | ⚠️ 预留 |
| Fee Adjustment | Fee Adjustment | ❌ **待确认** | - | ⚠️ 预留 |

---

## 三、Description 字段对照表

### ✅ 已确认映射（德文已验证）

| 标准英文名 | 用途/业务逻辑 | 美国站 Description | 德国站对应值 | 中文翻译 |
|-----------|-------------|-------------------|-------------|---------|
| Cost of Advertising | 广告费用识别 | Cost of Advertising | Werbekosten | 广告费用 |
| Deal Participation Fee | Deal 参与费 | Deal Participation Fee | Teilnahmegebühr für das Angebot | 交易参与费 |
| Deal Performance Based Fee | Deal 性能费 | Deal Performance Based Fee | Leistungsbasierte Angebotsgebühr | 基于性能的报价费 |
| Coupon Participation Fee | Coupon 参与费 | Coupon Participation Fee | Coupon-Teilnahmegebühr | 优惠券参与费 |
| Coupon Performance Based Fee | Coupon 性能费 | Coupon Performance Based Fee | Leistungsbasierte Coupon-Gebühr | 基于性能的优惠券费 |
| Vine Enrollment Fee | Vine 注册费 | Vine Enrollment Fee | Vine-Registrierungsgebühr | Vine注册费 |
| FBA storage fee | FBA 库存费 | FBA storage fee | FBA-Lagergebühr | FBA仓储费 |
| FBA Removal Order: Disposal Fee | FBA 处置费 | FBA Removal Order: Disposal Fee | Versand durch Amazon Gebühr für Entsorgung | FBA处理费 |

### 🔧 预留映射（使用英文作为 Fallback）

**设计说明**：以下 Description 在德国站报表中尚未出现，因此暂时没有德文映射。系统会使用英文作为 fallback，确保业务逻辑不受影响。

当这些 Description 的德文版本出现时：
1. 监控系统会记录日志
2. 业务逻辑仍然正常工作（使用英文判断）
3. 你可以后续补充德文映射

| 标准英文名 | 业务逻辑用途 | 当前映射 | 预计德文（参考） | 状态 |
|-----------|-------------|---------|-----------------|------|
| Refund for Advertiser | 广告商退款 | `['refund for advertiser']` | Werbekosten-Erstattung? | 🔧 预留 |
| FBA Inventory Reimbursement - General Adjustment | Adjustment 费用 | `['fba inventory reimbursement - general adjustment']` | FBA-Bestandsentschädigung - Allgemeine Anpassung? | 🔧 预留 |
| Non-subscription Fee Adjustment | Adjustment 费用 | `['non-subscription fee adjustment']` | Nicht-Abonnement-Gebührenanpassung? | 🔧 预留 |
| FBA International Freight Shipping Charge | AGL 运费 | `['fba international freight shipping charge']` | FBA internationale Frachtversandkosten? | 🔧 预留 |
| FBA International Freight Duties and Taxes Charge | AGL 税费 | `['fba international freight duties and taxes charge']` | FBA internationale Frachtzölle und Steuern? | 🔧 预留 |
| Fee Adjustment - Weight and Dimension Change | 重量调整费 | `['fee adjustment - weight and dimension change']` | Gebührenanpassung - Gewichts- und Maßänderung? | 🔧 预留 |
| FBA Removal Order: Return Fee | FBA 退货费 | `['fba removal order: return fee']` | Versand durch Amazon Gebühr für Rücksendung? | 🔧 预留 |
| FBA Long-Term Storage Fee | FBA 长期仓储费 | `['fba long-term storage fee']` | FBA Langzeitlagergebühr? | 🔧 预留 |
| Subscription | 订阅费 | `['subscription']` | Abonnement? | 🔧 预留 |
| Failed disbursement | 付款失败 | `['failed disbursement']` | Fehlgeschlagene Auszahlung? | 🔧 预留 |
| Micro Deposit | 小额存款验证 | `['micro deposit']` | Micro-Einzahlung? | 🔧 预留 |

### 🔄 模式匹配处理

以下 Description 使用模式匹配而非精确匹配：

| 模式类型 | 匹配规则 | 示例 |
|---------|---------|------|
| Price Discount | `price discount*` | "Price Discount - a0d3f453-..." |
| Coupon Redemption Fee | `*coupon redemption fee*` | "Coupon Redemption Fee: Save 10% on..." |
| FBA Customer Returns Fee | `*fba customer returns fee*` | "FBA Customer Returns Fee for ASIN:..." |
| Transfer | `*to your account ending in*` | "To your account ending in: 062..." |
| Retrocharge | `*retrocharge*` | "retrocharge for orderid 111-..." |
| FBA Inventory Reimbursement | `*fba inventory reimbursement*` | 多种子类型自动识别 |

### 📝 产品名称类 Description

**说明**：产品名称（如 "GOBOBE Plüsch-Hundebett"）是实际的产品标题，不需要映射。德国站使用德文产品名，美国站使用英文产品名，系统会保留原始值。

---

## 四、监控与扩展机制

### 🔍 自动监控

系统会自动监控并记录以下情况：

1. **疑似未映射的德文描述**：当德文描述与某个预留的英文 canonical name 相似时
2. **未知的德文系统描述**：排除产品名后，未知的系统级描述

日志示例：
```
WARNING: [DE Mapping Monitor] Potential unmapped German description detected: 
  'Werbekosten-Erstattung' (similar to 'Refund for Advertiser'). 
  Expected pattern: Likely: Werbekosten-Erstattung or similar. 
  Consider adding to PAYMENT_DESCRIPTION_ALIASES.
```

### 📝 如何补充新的德文映射

当你在德国站报表中发现新的德文描述时：

**步骤 1**: 在 `PAYMENT_DESCRIPTION_ALIASES` 中找到对应的 canonical name

**步骤 2**: 添加德文映射
```python
PAYMENT_DESCRIPTION_ALIASES = {
    'Refund for Advertiser': [
        'refund for advertiser',
        'werbekosten-erstattung',  # ← 添加德文映射
    ],
}
```

**步骤 3**: 从 `PAYMENT_DESCRIPTION_ALIASES_PENDING_DE` 中移除该条目

**步骤 4**: 更新本文档，将状态从 "🔧 预留" 改为 "✅ 已映射"

---

## 五、业务逻辑兼容性保证

### ✅ 当前业务逻辑如何使用 Description

以 `monthly_report_service.py` 为例：

```python
# 业务逻辑代码使用标准化后的英文描述进行判断
adjustment_expense_descriptions = {
    "FBA Inventory Reimbursement - General Adjustment",
    "Non-subscription Fee Adjustment",
}

ad_excluded_descriptions = {"Cost of Advertising", "Refund for Advertiser"}

# 德国站的德文描述已经被 normalize_payment_description() 转换为英文
# 所以业务逻辑判断不受影响
if description in adjustment_expense_descriptions:
    classified["adjustment_expense"].append(row)
```

### ✅ 三种场景的处理方式

| 场景 | 德国站报表中的值 | 标准化后的值 | 业务逻辑判断 | 结果 |
|-----|-----------------|-------------|-------------|------|
| **场景 A**: 已映射的德文 | "Werbekosten" | "Cost of Advertising" | `== "Cost of Advertising"` | ✅ 正确 |
| **场景 B**: 预留的英文 | "Refund for Advertiser" | "Refund for Advertiser" | `== "Refund for Advertiser"` | ✅ 正确 |
| **场景 C**: 未知的德文 | "???" | "???" (原样返回) | 不匹配任何条件 | ⚠️ 未分类，记录日志 |

---

## 六、实施进度

### ✅ 已完成

1. **列名映射表** - 已更新 `PAYMENT_REPORT_COLUMN_ALIASES`
   - 所有德国站列名已添加
   - 标记了德国站缺失的列

2. **Type 映射表** - 已更新 `PAYMENT_TYPE_ALIASES`
   - 基础 Type 映射已完成
   - 德国站已确认的 Type 已添加

3. **Description 映射表** - 已创建 `PAYMENT_DESCRIPTION_ALIASES`
   - 已确认的映射已添加
   - 预留的映射使用英文 fallback
   - 创建 `PAYMENT_DESCRIPTION_ALIASES_PENDING_DE` 追踪待补充项

4. **标准化函数** - 已创建 `normalize_payment_description()`
   - 支持精确匹配和模式匹配
   - 自动处理动态 Description
   - **新增监控日志功能**
   - 已集成到 `read_payment_report_dataframe()`

### 🔧 预留（不影响当前业务）

- **11 个 Description 映射**：使用英文 fallback，业务逻辑正常工作
- **7 个 Type 映射**：德国站报表中暂未出现，出现时默认为英文

---

## 七、如何使用

### 解析德国站报表

```python
from app.services.payment_report_locale import read_payment_report_dataframe

# 解析德国站报表
df = read_payment_report_dataframe(
    path='/path/to/DE-2026AprMonthlyTransaction.csv',
    country='DE'  # 指定国家为德国
)

# Description 和 Type 会自动标准化为英文
print(df['type'].unique())  # 输出: ['Order', 'Refund', ...]
print(df['description'].unique())  # 输出标准化的英文描述
```

### 查看监控日志

当处理德国站报表时，如果发现有未映射的德文描述，会在日志中记录：

```python
import logging

# 确保日志级别设置为 INFO 或 DEBUG
logging.basicConfig(level=logging.INFO)

# 处理报表时会自动输出监控日志
df = read_payment_report_dataframe(path='DE-2026AprMonthlyTransaction.csv', country='DE')
```

---

## 八、附录：德国站 CSV 样本分析

基于 `DE-2026AprMonthlyTransaction.csv` 和 `DE-2026MarMonthlyTransaction.csv`：

### 发现的 Type 值
- Bestellung (Order)
- Erstattung (Refund)
- Gebühren von Amazon (Amazon Fees)
- Servicegebühr (Service Fee)
- Versand durch Amazon Lagergebühr (FBA Inventory Fee)
- Übertrag (Transfer)

### 发现的 Description 值
- Werbekosten
- FBA-Lagergebühr
- Versand durch Amazon Gebühr für Entsorgung
- Teilnahmegebühr für das Angebot
- Leistungsbasierte Angebotsgebühr
- Coupon-Teilnahmegebühr
- Leistungsbasierte Coupon-Gebühr
- Vine-Registrierungsgebühr
- Für Konten mit folgenden Endziffern: 515 (转账说明)
- GOBOBE Plüsch-Hundebett (产品名)

---

## 九、技术实现附录

### 可选列的存储机制

对于 `transaction status` 和 `transaction release date` 等可选列：

#### 为什么不需要 Alembic 迁移？

```python
# 数据库表结构
monthly_report_transactions:
  - id: bigint
  - transaction_date: timestamp
  - transaction_type: varchar  # 核心列 - 有专用字段
  - ...
  - raw_row: json  # ← 所有原始数据都存这里
```

**存储流程**：
1. CSV 解析时读取所有列（包括可选列）
2. 核心列 → 专用数据库字段
3. **所有列（包括可选列）→ `raw_row` JSON**

#### 代码实现

```python
# payment_report_locale.py
PAYMENT_REPORT_COLUMN_ALIASES = {
    # 核心列
    'type': ['type', 'typ'],
    'description': ['description', 'beschreibung'],
    # ...
    
    # 可选列 - 也会存入 raw_row
    'transaction status': ['transaction status', 'transaktionsstatus'],
    'transaction release date': ['transaction release date', 'freigabedatum der transaktion'],
}

# 读取时会包含所有映射的列
for canonical_name, source_name in structure.column_mapping.items():
    raw_value = row.get(source_name)
    mapped[canonical_name] = raw_value  # 这包括可选列

# DataFrame 会包含所有列，最终存入 raw_row
```

#### 如何访问可选列数据

```python
# 从数据库读取后
record = db.query(MonthlyReportTransaction).first()

# 访问可选列（从 raw_row JSON）
transaction_status = record.raw_row.get('transaction status')
transaction_release_date = record.raw_row.get('transaction release date')
```

### 添加新的可选列

如果将来需要添加更多可选列：

1. **更新 `PAYMENT_REPORT_COLUMN_ALIASES`**
```python
'new optional column': ['new optional column', 'german translation'],
```

2. **不需要数据库迁移** - 数据会自动存入 `raw_row`

3. **更新本文档** - 在"可选列"部分添加说明

EOF

