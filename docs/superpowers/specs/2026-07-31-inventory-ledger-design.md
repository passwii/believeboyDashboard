# 库存盘点（Inventory Ledger）设计文档

> v1 · 2026-07-31 · BEL-364
> 状态：设计确认，待实施
> PRD 来源：`teamRock/DACAT-RICHFU-铨富/inventoryAnalysis/raw_2026-05-07/PRD-库存盘点-后端实施.md`

## 1. 概述

基于 Amazon「Detailed Inventory Ledger」月度 CSV（22 列），构建库存盘点功能：

- **数据入库**：接入现有 auto-upload 流水线，新增 report type `inventory_ledger`
- **后端查询**：Service-layer 聚合（不建 DB view），支持月度 / 自定义日期范围
- **内部 API**：`/api/v1/inventory-ledger/*`（带 auth）
- **External API**：`/api/v1/external/projects/{project_id}/inventory-ledger/*`（无 auth，网络隔离，供 Agent/脚本拉取）
- **前端页面**：`supply-chain/inventory-ledger`，独立于现有「库存分析」页面
- **多项目通用**：`project_id` 贯穿全链路

### 关键决策记录

| # | 决策 | 理由 |
|---|------|------|
| D1 | 独立页面，不合并到 inventory-analysis | 两个独立视角：实时快照 vs 历史流水 |
| D2 | 接入 auto-upload 流水线 | 复用 UI/日志/状态追踪，用户操作一致 |
| D3 | 多项目通用（project_id） | 现有系统已是多项目架构，额外成本小 |
| D4 | External API 给 Agent/脚本用 | Multica Agent 需要拉盘点数据生成周报 |
| D5 | 方案 A：Full ORM + Service-layer 查询 | 与代码库一致，可测试，数据量小无需 DB view |
| D6 | MVP 纯表格 + 状态徽章，图表 V2 | 6-7 个 SKU，表格足够，控制工期 |
| D7 | 不建 dim_sku / dim_warehouse | SKU 元数据反范式存 raw 表；仓库 region 映射不在范围 |
| D8 | 日期范围支持（report_month 是语法糖） | 当前月度导出，未来精确到天 |

## 2. 数据库

### 2.1 新表 `inventory_ledger_raw`

MVP 只建 1 张新表。不建 dim_sku（CSV 每行自带 fnsku/asin/title，反范式存储）；不建 dim_warehouse（region 映射不在范围）。

```
inventory_ledger_raw
├── id                    Integer PK (autoincrement)
├── project_id            Integer FK → projects.id (CASCADE)
├── report_month          Date NOT NULL          -- YYYY-MM-01，ETL 分区键
├── date                  Date NOT NULL          -- 业务日期
├── fnsku                 String(20) nullable
├── asin                  String(15) nullable
├── msku                  String(30) NOT NULL
├── title                 String(500) nullable
├── disposition           String(20) NOT NULL    -- SELLABLE / CUSTOMER_DAMAGED / CARRIER_DAMAGED / WAREHOUSE_DAMAGED
├── location              String(10) NOT NULL    -- FBA 仓代码
├── starting_balance      Integer default 0
├── in_transit_between    Integer default 0
├── receipts              Integer default 0
├── customer_shipments    Integer default 0      -- 负数
├── customer_returns      Integer default 0
├── vendor_returns        Integer default 0
├── warehouse_transfer_io Integer default 0
├── found                 Integer default 0
├── lost                  Integer default 0
├── damaged               Integer default 0
├── disposed              Integer default 0
├── other_events          Integer default 0
├── ending_balance        Integer default 0
├── unknown_events        Integer default 0
├── store                 String(50) nullable
└── loaded_at             DateTime(tz) server_default=now()
```

**唯一约束**（upsert 自然键）：
`(project_id, report_month, date, msku, disposition, location)`

**索引**：
- `(project_id, report_month)` — 主查询路径
- `(project_id, report_month, msku)` — SKU 级聚合
- `(project_id, report_month, location)` — 仓库级聚合

**Alembic 迁移**：按仓库规范 `YYYYMMDD_NNN_description.py`，纯数字短 rev-id。主键用 Integer（对齐仓库约定）。

### 2.2 数据语义

- **Sparse Ledger**：Amazon 只在 (Date × MSKU × Location × Disposition) 组合发生变化时写新行，不是每天都有行
- **取月末余额**：`ROW_NUMBER() OVER (PARTITION BY report_month, msku, location, disposition ORDER BY date DESC) rn=1`
- **数值符号**：Customer Shipments / Vendor Returns / Lost / Damaged / Disposed 是负数；Receipts / Customer Returns / Found 是正数
- **Disposition 流转**：SELLABLE 行 Damaged=-1 不改 disposition，Amazon 会在下一行给该 (MSKU, Location) 开 CUSTOMER_DAMAGED disposition

## 3. ETL / Auto-upload 集成

### 3.1 新增 report type：`inventory_ledger`

区别于现有 `inventory_report`（.txt 格式的 FBA 库存报告）。

### 3.2 数据流

```
用户上传 CSV → /report-upload/recognize → 识别为 inventory_ledger
→ 用户确认项目 + 月份 → /report-upload/commit
→ persistence handler 解析 22 列 CSV → bulk upsert inventory_ledger_raw
→ 写 report_upload_logs 记录
```

### 3.3 改动点

**前端 `components/report-upload/types.ts`**：
- `ReportType` 联合类型加 `'inventory_ledger'`
- `DATE_REQUIRED_REPORT_TYPES` 加入（日期从文件名自动提取，用户可覆盖）

**后端 `upload_service.py`**：
- `TYPE_ALLOWED_EXTENSIONS` 加 `'inventory_ledger': {'.csv'}`

**后端 `services/data/upload/recognition.py`**：
- 识别逻辑：读 CSV 第一行 header，匹配 22 列签名
- 项目识别：从 Title 列提取品牌前缀（如 `DACAT-RICHFU`）→ 匹配 projects 表
- 日期识别：从文件名提取 report_month；fallback 到 Date 列 min 值所在月

**后端 `services/data/upload/persistence.py`**：
- 新增 `if report_type == "inventory_ledger":` 分支
- 调用 `services/inventory/ledger.py` 的 `ingest_ledger_csv()` 函数
- Python csv 模块逐行解析 → 批量 `INSERT ... ON CONFLICT DO UPDATE`
- 返回 `row_count` 写入 upload log

**后端 `services/data/upload/status.py`**：
- report type 列表加 `'inventory_ledger'`

### 3.4 识别签名（22 列 header）

```
Date, FNSKU, ASIN, MSKU, Title, Disposition,
Starting Warehouse Balance, In Transit Between Warehouses,
Receipts, Customer Shipments, Customer Returns, Vendor Returns,
Warehouse Transfer In/Out, Found, Lost, Damaged, Disposed,
Other Events, Ending Warehouse Balance, Unknown Events, Location, Store
```

匹配策略：normalize header（lowercase + strip + 空格→下划线），检查必须列集合 ⊆ 实际列集合。容忍列顺序变化和额外列。

### 3.5 文件名 → report_month 映射

| 文件名模式 | 提取规则 |
|---|---|
| `20260501-0531.csv` | 前 8 位 → `2026-05-01` |
| `库存分类账 2026-0601-0630.csv` | 正则 `\d{4}-?\d{4}` → `2026-06-01` |
| 无法提取 | fallback 到 Date 列 min 值所在月的 1 号 |

### 3.6 幂等性

同一文件重复上传 → upsert 按自然键覆盖，不产生重复行。

## 4. Service 层

### 4.1 文件：`backend/app/services/inventory/ledger.py`

PRD 的 7 个 SQL view 变成 7 个 service 函数。所有函数签名统一为 `(db, project_id, start_date, end_date)`，`report_month` 是 API 层语法糖。

| # | 函数 | 对应 PRD view | 返回 |
|---|---|---|---|
| 1 | `get_sku_month_eom()` | v_sku_month_eom | 每 SKU 期末总库存 |
| 2 | `get_sku_location_eom()` | v_sku_location_eom | SKU × Location × Disposition 期末明细 |
| 3 | `get_sku_disp_eom()` | v_sku_disp_eom | SKU × Disposition 期末 |
| 4 | `get_month_disposition_summary()` | v_month_disposition_summary | Disposition 汇总 + 占比 |
| 5 | `get_receipt_clusters()` | v_receipt_clusters_v2 | 入库簇（date × location × SKU 集合） |
| 6 | `get_sku_month_events()` | v_sku_month_events | SKU 事件汇总 |
| 7 | `check_ledger_integrity()` | v_ledger_integrity | 跨月连续性校验 |
| 8 | `get_available_months()` | — | 有数据的月份列表 |
| 9 | `get_trend()` | — | 多月聚合趋势（EOM/事件/损坏占比） |

**实现要点**：
- Sparse Ledger 取月末：`func.row_number().over(partition_by=..., order_by=desc(date))` 取 rn=1
- `check_ledger_integrity`：查两个月数据，对比 ending → starting 连续性
- `get_receipt_clusters`：`func.string_agg(msku, ',' order by msku)` + `func.md5()` 生成 cluster_id
- `get_trend`：遍历最近 N 个月，每月聚合 EOM 总量 + 事件 + 损坏占比
- `parse_report_month`：接受 `YYYY-MM` 或 `YYYY-MM-DD` 字符串，统一转为月初 date
- 入库函数 `ingest_ledger_csv()`：csv 模块解析 → bulk upsert

### 4.2 Schemas：`backend/app/schemas/inventory_ledger.py`

```python
class SkuMonthEom(BaseModel):
    msku: str
    title: str | None
    qty_eom: int
    prev_qty_eom: int | None
    change: int | None

class DispositionSummary(BaseModel):
    disposition: str
    qty_eom: int
    pct_of_total: float

class ReceiptCluster(BaseModel):
    date: date
    location: str
    sku_set: str
    sku_count: int
    total_qty: int
    cluster_id: str

class SkuMonthEvents(BaseModel):
    msku: str
    title: str | None
    total_receipts: int
    total_shipments: int
    total_returns: int
    total_damaged: int
    total_lost: int
    total_disposed: int
    net_change: int

class IntegrityMismatch(BaseModel):
    msku: str
    location: str
    disposition: str
    prev_ending: int
    curr_starting: int
    diff: int

class IntegrityCheckResult(BaseModel):
    report_month: date
    status: Literal["OK", "MISMATCH", "PENDING"]
    mismatch_count: int
    mismatches: list[IntegrityMismatch]
    checked_at: datetime

class MonthlySnapshotResponse(BaseModel):
    report_month: date
    sku_count: int
    total_qty: int
    disposition_summary: list[DispositionSummary]
    skus: list[SkuMonthEom]
    integrity: IntegrityCheckResult

class TrendMonthItem(BaseModel):
    report_month: str  # YYYY-MM
    sku_count: int
    total_qty_eom: int
    total_receipts: int
    total_shipments: int
    total_returns: int
    total_damaged: int
    total_lost: int
    total_disposed: int
    damaged_pct: float

class TrendResponse(BaseModel):
    project_id: int
    months: list[TrendMonthItem]
```

## 5. 内部 API

文件：`backend/app/api/v1/endpoints/inventory_ledger.py`
路由前缀：`/inventory-ledger`，需要 auth（`Depends(protected)`）

| 端点 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/inventory-ledger/months` | GET | `project_id` | 有数据的月份列表 |
| `/inventory-ledger/snapshot` | GET | `project_id` + (`report_month` 或 `start_date, end_date`) | 月度/周期快照 |
| `/inventory-ledger/events` | GET | 同上 | SKU 事件流水 |
| `/inventory-ledger/receipt-clusters` | GET | 同上 | 入库簇 |
| `/inventory-ledger/location-detail` | GET | 同上 + `msku?` | 仓库级明细 |
| `/inventory-ledger/trend` | GET | `project_id` + `months?` (默认 6, 1-24) | 多月聚合趋势 |

**参数逻辑**：
- `report_month` 接受 `YYYY-MM`（如 `2026-07`）或 `YYYY-MM-DD`（如 `2026-07-01`），后端统一转为月初 → 自动算月末
- 传 `start_date + end_date` → 直接用（精确到天）
- 两者互斥，同时传报 400

**注册**：`router.py` 加 `include_router(inventory_ledger_router, prefix="/inventory-ledger", tags=["inventory-ledger"])`

## 6. External API

文件：`backend/app/api/v1/endpoints/external/inventory_ledger.py`
无 auth，网络隔离，`project_id` 在路径里。

| 端点 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/external/projects/{project_id}/inventory-ledger/months` | GET | — | 月份列表 |
| `/external/projects/{project_id}/inventory-ledger/snapshot` | GET | `report_month` 或 `start_date, end_date` | 快照 |
| `/external/projects/{project_id}/inventory-ledger/events` | GET | 同上 | 事件流水 |
| `/external/projects/{project_id}/inventory-ledger/receipt-clusters` | GET | 同上 | 入库簇 |
| `/external/projects/{project_id}/inventory-ledger/integrity` | GET | `report_month` | 完整性校验 |
| `/external/projects/{project_id}/inventory-ledger/trend` | GET | `months?` (默认 6) | 多月聚合趋势 |

响应 schema 复用内部 API 的 Pydantic model。注册到 `external/__init__.py` 的 `external_router`。

## 7. 前端

### 7.1 路由与导航

- 页面：`app/dashboard/supply-chain/inventory-ledger/page.tsx`
- Sidebar：supply-chain 组，"库存分析"之后：
  ```ts
  { title: '库存盘点', url: '/dashboard/supply-chain/inventory-ledger', icon: IconMap.ClipboardCheck }
  ```

### 7.2 页面布局

```
┌─────────────────────────────────────────────────────────┐
│ [Project Selector ▾]   [Month Picker ▾]   [🔄 Refresh]  │
├─────────────────────────────────────────────────────────┤
│ Integrity Badge: ✅ OK / ❌ MISMATCH (3) / ⏳ PENDING   │
├─────────────────────────────────────────────────────────┤
│ Tabs: [月度总览] [事件流水] [入库记录] [仓库明细]        │
├─────────────────────────────────────────────────────────┤
│  Tab content (DataTableCard)                            │
└─────────────────────────────────────────────────────────┘
```

### 7.3 Tab 1: 月度总览

| SKU | 品名 | 期末库存 | 上月库存 | 环比 | 可售 | 损坏 | 损坏占比 |

- 环比：`change > 0` 绿色 ↑，`< 0` 红色 ↓，`= 0` 灰色 —
- 损坏占比 > 5% 行标红色背景
- 底部汇总行

### 7.4 Tab 2: 事件流水

| SKU | 品名 | 入库 | 出库 | 退货 | 损坏 | 丢失 | 报废 | 净变动 |

- 出库显示为负数，红色
- 底部汇总行

### 7.5 Tab 3: 入库记录

| 日期 | 仓库 | SKU 集合 | SKU 数 | 总数量 | Cluster ID |

- Cluster ID 截断前 8 位，hover 全文
- 按日期降序

### 7.6 Tab 4: 仓库明细

| SKU | 品名 | 仓库 | Disposition | 期末数量 |

- 可选 SKU 过滤器
- 按 SKU → 数量降序

### 7.7 组件复用

- `DataTableCard` / `DataTableCardHeader` / `DataTableCardBody`
- `Select`（项目 + 月份选择器）
- `Badge`（完整性状态）
- `Skeleton` / `EmptyTableState`
- `fetchManagedProjectsCached` / `useAutoSelectFirstProject` / `useUrlParam`

### 7.8 Excel 导出

每个 tab 一个导出按钮（`FileDown` icon），复用 `applyBorder / applyHeaderBorder / applyRowBorder`。

## 8. 范围边界

### 做

- 原始事件层（A 组 1-6）：receipts / shipments / returns / damaged / lost / disposed
- 状态层（B 组 7-9）：EOM 快照 / disposition 汇总 / 簇识别 v2
- 完整性校验（D 15）：跨月连续性

### 不做

- C 组分析指标（DoH / 周转 / hit freq / 退货率）→ 由 inventory-analysis 或独立模块承接
- D 14 库龄 → 现有 inventory-analysis 已有
- 跨源关联（shipment/ 匹配）→ 簇识别 v2 留好 cluster_id 扩展点
- dim_warehouse.region 自动映射 → 可选增强
- 图表（趋势折线、仓库分布饼图）→ V2
- 周频次 / 阈值预警

## 9. 文件清单

### 后端新增

| 文件 | 说明 |
|---|---|
| `app/models/inventory_ledger.py` | InventoryLedgerRaw ORM model |
| `app/schemas/inventory_ledger.py` | Pydantic schemas |
| `app/services/inventory/ledger.py` | 7 个查询函数 + ingest_ledger_csv |
| `app/api/v1/endpoints/inventory_ledger.py` | 内部 API 5 个端点 |
| `app/api/v1/endpoints/external/inventory_ledger.py` | External API 5 个端点 |
| `alembic/versions/YYYYMMDD_NNN_*.py` | 建表迁移 |
| `tests/inventory/test_ledger.py` | Service + API 测试 |

### 后端修改

| 文件 | 改动 |
|---|---|
| `app/models/__init__.py` | 注册 InventoryLedgerRaw |
| `app/api/v1/router.py` | include inventory_ledger_router |
| `app/api/v1/endpoints/external/__init__.py` | include external inventory_ledger_router |
| `app/services/upload_service.py` | TYPE_ALLOWED_EXTENSIONS 加 inventory_ledger |
| `app/services/data/upload/recognition.py` | 识别 inventory_ledger CSV |
| `app/services/data/upload/persistence.py` | commit 分支 |
| `app/services/data/upload/status.py` | report type 列表 |

### 前端新增

| 文件 | 说明 |
|---|---|
| `app/dashboard/supply-chain/inventory-ledger/page.tsx` | 盘点页面 |

### 前端修改

| 文件 | 改动 |
|---|---|
| `lib/sidebar-config.ts` | 加库存盘点导航项 |
| `components/report-upload/types.ts` | ReportType 加 inventory_ledger |

## 10. 验收清单

- [ ] Alembic 迁移落地，`inventory_ledger_raw` 表可写入
- [ ] auto-upload 识别 inventory_ledger CSV 并入库（3 份历史 CSV 验证）
- [ ] 重复上传幂等（upsert 不重复）
- [ ] 7 个 service 函数全部可查（pytest 覆盖）
- [ ] 内部 API 5 个端点 + auth
- [ ] External API 5 个端点（无 auth）
- [ ] 完整性校验：5→6 月、6→7 月跨月连续性 OK
- [ ] 前端页面 4 个 tab 渲染正确
- [ ] 损坏占比 > 5% 红色标记
- [ ] Excel 导出可用
