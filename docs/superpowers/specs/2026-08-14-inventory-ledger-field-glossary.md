# 库存分类账字段英中文对照表（Summary + Detail）

> BLF-431 · 2026-08-14 · 状态：实施中（随 PR 合入）
>
> 本 spec 是 BEL-428 双表（`inventory_ledger_summary` / `inventory_ledger_detail`）
> **所有字段**的英文列名 → 中文 label 唯一权威对照，供：
> - 前端表格列头（中文 label + 英文列名 tooltip）
> - 后端 Pydantic schema 的 `Field(description=...)`
> - 文档 / 报错信息 / 通知消息的中文表述
>
> 机器可读校验：`backend/tests/schemas/test_inventory_ledger_field_glossary.py`
> （38 个业务字段 + 2 个技术字段的 description 与 DB 列名全量锁定，防止 doc 漂移）。

## 范围与边界

- **在范围**：38 个业务字段（Summary 22 + Detail 16）的英文列名 → 中文 label 对照。
- **不在范围**：不翻译亚马逊原生枚举值（`SELLABLE` / `CUSTOMER_DAMAGED` / 事件类型值
  `WhseTransfers` 等保留，属于 BEL-428 前端 `EVENT_TYPE_LABELS` / `DISPOSITION_LABELS` 的职责）；
  不做全文翻译；不涉及数据库迁移。
- **列名事实来源**：`backend/alembic/versions/20260805_235_inventory_ledger_dual_tables.py`
  （BEL-428 已部署的迁移 235）。本表列名与该迁移**逐列一致**。

## Summary 表（22 业务字段）— `inventory_ledger_summary`

对应 Amazon FBA Inventory Ledger **一览视图**（Summary view）表头。真相源：
1 行 = 1 个（FNSKU × 仓库 × 处置 × 日期）日快照（稀疏账本，有变化才发一行）。

| # | Amazon 英文列名 | Pydantic/DB 字段 | 中文 label | 类型 | 说明 |
|---|----------------|------------------|-----------|------|------|
| 1 | Date | `date` | 日期 | date | 业务日期（来自 CSV） |
| 2 | FNSKU | `fnsku` | FNSKU | string | 亚马逊 FNSKU（保留英文） |
| 3 | ASIN | `asin` | ASIN | string | 亚马逊 ASIN（保留英文） |
| 4 | MSKU | `msku` | MSKU | string | 卖家 SKU（保留英文） |
| 5 | Title | `title` | 品名 | string | 商品名称 |
| 6 | Disposition | `disposition` | 处置状态 | string | SELLABLE / CUSTOMER_DAMAGED 等（值不翻译） |
| 7 | Location | `location` | 仓库 | string | 履约中心/库位代码（如 XLX7） |
| 8 | Starting Warehouse Balance | `starting_balance` | 期初库存 | int | 当日开始时库存量 |
| 9 | In Transit Between Warehouses | `in_transit_between` | 在途库存 | int | 仓库间在途调拨量 |
| 10 | Receipts | `receipts` | 入库 | int | 收货入库量 |
| 11 | Customer Shipments | `customer_shipments` | 客户发货 | int | 客户订单发货量 |
| 12 | Customer Returns | `customer_returns` | 客户退货 | int | 客户退货量 |
| 13 | Vendor Returns | `vendor_returns` | 供应商退货 | int | 供应商退货量 |
| 14 | Warehouse Transfer In/Out | `warehouse_transfer_io` | 仓库调拨 | int | 仓库间调拨（入/出合并列） |
| 15 | Found | `found` | 盘盈 | int | 盘库多出（Found） |
| 16 | Lost | `lost` | 盘亏 | int | 盘库丢失（Lost） |
| 17 | Damaged | `damaged` | 损坏 | int | 损坏量 |
| 18 | Disposed | `disposed` | 报废 | int | 报废量 |
| 19 | Other Events | `other_events` | 其他事件 | int | 其他事件量 |
| 20 | Ending Warehouse Balance | `ending_balance` | 期末库存 | int | 当日结束时库存量 |
| 21 | Unknown Events | `unknown_events` | 未知事件 | int | 未识别事件量 |
| 22 | Store | `store` | 店铺 | string | 店铺标识（当前数据中多为空） |

## Detail 表（16 业务字段）— `inventory_ledger_detail`

对应 Amazon FBA Inventory Ledger **详细视图**（Detailed view）表头，事件级账本：
1 行 = 1 笔事件。

| # | Amazon 英文列名 | Pydantic/DB 字段 | 中文 label | 类型 | 说明 |
|---|----------------|------------------|-----------|------|------|
| 1 | Date | `date` | 日期 | date | 事件日期（来自 CSV） |
| 2 | FNSKU | `fnsku` | FNSKU | string | 亚马逊 FNSKU（保留英文） |
| 3 | ASIN | `asin` | ASIN | string | 亚马逊 ASIN（保留英文） |
| 4 | MSKU | `msku` | MSKU | string | 卖家 SKU（保留英文） |
| 5 | Title | `title` | 品名 | string | 商品名称 |
| 6 | Event Type | `event_type` | 事件类型 | string | 事件类型（值不翻译） |
| 7 | Reference ID | `reference_id` | 参考编号 | string | 参考单号（如 FBA 收货单号） |
| 8 | Quantity | `quantity` | 数量 | int | 事件数量（正=入，负=出） |
| 9 | Fulfillment Center | `fulfillment_center` | 履约中心 | string | 履约中心代码（如 XLX7） |
| 10 | Disposition | `disposition` | 处置状态 | string | SELLABLE / CUSTOMER_DAMAGED 等（值不翻译） |
| 11 | Reason | `reason` | 原因 | string | 事件原因（多数行空） |
| 12 | Country | `country` | 国家/地区 | string | 国家（当前数据全部为 US） |
| 13 | Reconciled Quantity | `reconciled_quantity` | 已对账数量 | int | 已对账数量（当前数据为空） |
| 14 | Unreconciled Quantity | `unreconciled_quantity` | 未对账数量 | int | 未对账数量（当前数据为空） |
| 15 | Date and Time | `date_and_time` | 日期时间 | datetime | ISO 8601 含时区，与 Date 一一对应 |
| 16 | Store | `store` | 店铺 | string | 店铺标识（当前数据中多为空） |

## 技术字段（非业务列，出现在 JSON schema 输出中）

两张表各含 2 个技术字段，不属于 38 业务字段，但也纳入 Pydantic description：

| 字段 | 中文 label | 说明 |
|------|-----------|------|
| `id` | 记录 ID | 主键 |
| `batch_id` | 上传批次 ID | 关联 `inventory_ledger_ingest_batch.id`（上传溯源） |

## 两表共享列

`date` / `fnsku` / `asin` / `msku` / `title` / `disposition` / `store` 共 7 列在
Summary 与 Detail 中同名同义，label 完全一致。两表合计 22 + 16 = 38 业务字段，
去重后 31 个唯一字段名。

## 后端实现位置

`backend/app/schemas/inventory_ledger.py`：

- `LedgerSummaryRow` / `LedgerDetailRow` 每个字段加 `Field(description="中文 label")`。
- 注意：`date` 字段名与 `datetime.date` 类型同名，必须用
  `date: Annotated[date, Field(description="日期")]` 写法（纯 `= Field(...)` 会触发
  Pydantic 的 unevaluable-type-annotation 错误）。
- 刻意**不加** `alias`：字段名/类型/序列化行为不变，只改 OpenAPI/`model_json_schema()`
  输出的 description（验收标准），避免破坏 API 契约。
- `fnsku` / `asin` / `msku` 三个标识符字段 description 保留英文大写（不做翻译）。

## 前端 i18n 字典（交给前端 @Seth 落库）

仓库当前**无 i18n 基础设施**（无 next-intl / locales 目录），现有列头是
`ledger-summary-tab.tsx` / `ledger-detail-tab.tsx` 里硬编码的中文短标签（期初/期末/
入库/出库…）。本 issue 交付的权威词典如下，前端侧统一落到
`frontend/locales/zh-CN/inventory-ledger.json`（键 = 后端字段名）：

```json
{
  "summary": {
    "date": "日期", "fnsku": "FNSKU", "asin": "ASIN", "msku": "MSKU",
    "title": "品名", "disposition": "处置状态", "location": "仓库",
    "starting_balance": "期初库存", "in_transit_between": "在途库存",
    "receipts": "入库", "customer_shipments": "客户发货",
    "customer_returns": "客户退货", "vendor_returns": "供应商退货",
    "warehouse_transfer_io": "仓库调拨", "found": "盘盈", "lost": "盘亏",
    "damaged": "损坏", "disposed": "报废", "other_events": "其他事件",
    "ending_balance": "期末库存", "unknown_events": "未知事件", "store": "店铺"
  },
  "detail": {
    "date": "日期", "fnsku": "FNSKU", "asin": "ASIN", "msku": "MSKU",
    "title": "品名", "event_type": "事件类型", "reference_id": "参考编号",
    "quantity": "数量", "fulfillment_center": "履约中心", "disposition": "处置状态",
    "reason": "原因", "country": "国家/地区", "reconciled_quantity": "已对账数量",
    "unreconciled_quantity": "未对账数量", "date_and_time": "日期时间", "store": "店铺"
  },
  "technical": { "id": "记录 ID", "batch_id": "上传批次 ID" }
}
```

若前端坚持使用现有短标签（`期初`/`期末`/`出库`/`调拨` 等），可把本表 label 视为完整
语义、短标签视为表格列头缩写——二者不冲突，但**英文列名 tooltip 一律以本表为准**。

## 与 BEL-428 实施的一致性

- 字段名来源：迁移 `20260805_235_inventory_ledger_dual_tables.py`（已部署 prod）。
- 校验：`backend/tests/schemas/test_inventory_ledger_field_glossary.py` 全量断言
  Pydantic 模型字段集合 == 本表字段集合，description == 本表中文 label；
  `model_json_schema()` 输出 description 为中文。任何重命名/删 label 都会红测。
- 影响面（CodeGraph `impact` depth=2）：仅 `LedgerSummaryRow`/`LedgerDetailRow`
  的 JSON schema 输出变化；后端消费方（`services/inventory/ledger.py` 行构造、
  两个 `inventory_ledger.py` 端点 response_model）与前端 TS 类型均不受影响。
