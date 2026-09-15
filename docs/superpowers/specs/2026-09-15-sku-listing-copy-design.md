# SKU Info 产品文案（Listing Copy）设计规格

> BLF-1080 · 2026-09-15 · 状态：Stage 1 实施中（随后端 PR 合入）
>
> 目标页面：`/dashboard/operations/sku-info`。本 spec 是「产品文案」这一新
> 业务块在 **数据层 / 内部 API / Agent API / 前端 Tab / 导出** 五个面的唯一
> 需求来源；冲突以本文件为准。
>
> 关联：`docs/superpowers/specs/2026-08-10-agent-sku-info-api.md`（SKU Info 主
> 数据 Agent API 既有规格，本块是其**新增字段组**）、`docs/agent-api-design.md`
> （confirm 流 §3 / 审计归因 §4.2 / 错误壳 §5）。

## 1. 背景与定位

### 1.1 现状

`product_costs`（模型 `SkuRecord`，`backend/app/models/sku_info.py`）当前承载
SKU 主数据：身份（sku/asin/fnsku）+ 成本（fob/first_leg）+ 包装尺寸 + 箱规 +
国家/上架态 + 工厂属性（`sku_factory_info` JSON）+ 图片/FNSKU 标签资源。
SKU Info 页面有 5 个 Tab：成本管理 / 尺寸管理 / 产品属性 / 产品标签 / 产品图片。

### 1.2 本次新增

增加第 6 个 Tab「产品文案」，承载亚马逊 Listing 的**文案信息**，作为 SKU Info
主表（`product_costs`）的一部分：

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 必要信息 | 标题 | Listing Title，单行文本 |
| 必要信息 | 5 点描述 | Bullet Points，**结构化 5 行**（不是一整段） |
| Description | 描述正文 | 一段文字（Amazon 商品描述） |
| 卖点提炼 | 纯文本 | 格式不限，内部提炼用，不直接上架 |

### 1.3 为什么不是一张新表

文案与 SKU 记录是 **1:1**（一个 project+sku+asin+country 对应一套文案），
且文案需要与成本/规格**同表同行读取**（Tab 共用一份列表数据、导出共用筛选、
Agent 一次性读写主数据）。独立表会引入 JOIN + 事务边界 + 孤儿行清理三类成本，
收益为零。故**直接加列到 `product_costs`**。

## 2. 数据层设计

### 2.1 字段与列定义

新增 5 列（全部可空，无 server_default —— 文案属自然缺失场景，空 ≠ 0）：

| 列名 | 类型 | 可空 | 语义 |
| --- | --- | --- | --- |
| `listing_title` | `String(500)` | ✓ | 标题 |
| `listing_bullet_1` | `Text` | ✓ | 5 点描述第 1 点 |
| `listing_bullet_2` | `Text` | ✓ | 5 点描述第 2 点 |
| `listing_bullet_3` | `Text` | ✓ | 5 点描述第 3 点 |
| `listing_bullet_4` | `Text` | ✓ | 5 点描述第 4 点 |
| `listing_bullet_5` | `Text` | ✓ | 5 点描述第 5 点 |
| `listing_description` | `Text` | ✓ | Description 一段文字 |
| `listing_selling_points` | `Text` | ✓ | 卖点提炼（纯文本，格式不限） |
| `listing_copy_updated_at` | `DateTime(tz)` | ✓ | 文案最后更新时间 |
| `listing_copy_updated_by` | `String(128)` | ✓ | 文案最后更新人（agent_id / 操作者） |

共 10 列（5 个 bullet 列 + title/description/selling_points + 2 个溯源列）。

### 2.2 为什么 bullet 拆 5 列而不是一个 JSON

- **导出**：Excel 天然是列，JSON 会逼前端拆包 → 导出逻辑复杂化；
- **筛选 / 校验**：单列可做「第 3 点为空」这类检查，JSON 做不到；
- **契约稳定性**：JSON 无 schema，Agent 写入易漂移；
- **对齐屋风**：仓库既有结构化字段一律独立列（如包装尺寸 3 列 / 箱规 4 列），
  `sku_factory_info` 用 JSON 是因为它是**任意键值对**，bullet 是**固定 5 槽位**。

### 2.3 溯源列

对齐 `sku_factory_info_updated_{at,by}` 先例：

- `listing_copy_updated_at`：写入即刷新（内部写 / Agent 写都刷新）；
- `listing_copy_updated_by`：内部写 = `X-Operator`；Agent 写 = `agent_id`。

**不新增** `listing_copy_status`（草稿/已发布）——本期无发布流需求，
状态列会变成无人维护的死列；未来要做发布态再单独设计。

### 2.4 迁移

`20260915_273_add_sku_listing_copy.py`，`down_revision='272'`。
纯 `add_column`（10 列），`downgrade` 反向 `drop_column`。
**无回填**（存量行为 NULL，语义即"未录入文案"）。

## 3. 内部 API 设计

在既有 `backend/app/api/v1/endpoints/sku_info.py` 上扩展，**不新增端点文件**。

### 3.1 读：随主列表返回

`GET /api/v1/sku-info` 的 `SkuRecordItem` 增加文案字段（含 `_updated_at` /
`_updated_by`）。**零新增请求**——前端切 Tab 用同一份已加载列表数据。
`_serialize_sku_record` 同步补 10 个 key。

### 3.2 写：新增批量文案端点

`POST /api/v1/sku-info/batch-update-listing-copy`

对齐既有 `POST /api/v1/sku-info/batch-update-factory-info`（同域批量写样板）：

请求：

```json
{
  "items": [
    {
      "id": 123,
      "listing_title": "…",
      "listing_bullet_1": "…",
      "listing_bullet_2": "…",
      "listing_bullet_3": "…",
      "listing_bullet_4": "…",
      "listing_bullet_5": "…",
      "listing_description": "…",
      "listing_selling_points": "…"
    }
  ]
}
```

响应：`{"updated": 2, "updated_ids": [123, 456]}`

语义要点：

- **按 id 逐条更新**，缺 id / id 不存在 → 计入 `skipped`（不整批失败，对齐
  factory-info 批量端点语义）；
- 只写**显式提供**的字段（`model_fields_set`）——未提供的字段保持原值，
  这样「只改标题」不会清空 bullets；
- 显式传 `null` / 空串 = **清空该字段**（文案可被清空的真实需求）；
- 写入即刷新 `listing_copy_updated_at` / `listing_copy_updated_by`（operator）；
- 审计 `sku_info.batch_update_listing_copy`；
- L1 缓存失效（`domains=["sku_info"]`），对齐同域其它写端点。

### 3.3 导出：新增 `export_type=listing`

`GET /api/v1/sku-info/export?export_type=listing` 返回 CSV（BOM + UTF-8），
表头（**可直接回传导入**，与成本/尺寸 模板同风格）：

```text
project_name, SKU, ASIN(可留空), FNSKU(可留空), 品名(可留空), 国家,
标题, 五点描述1, 五点描述2, 五点描述3, 五点描述4, 五点描述5,
Description, 卖点提炼
```

文件名：`${项目}_${中文站点}-SKU信息-产品文案批量修改模板-${timestamp}.csv`

> **Excel 由前端生成**（既有 `exceljs` 依赖，见 §4.2）：后端只出 CSV 模板，
> 与成本/尺寸 Tab 完全一致——不引入后端 openpyxl 导出这条平行路径。

## 4. 前端设计（转交前端工程师 Seth）

### 4.1 新 Tab

- Tab 键 `'listing'`，文案「产品文案」，加入 `ActiveTab` 与 `ACTIVE_TAB_ORDER`
  （排在 `image` 之前或之后由前端定，建议末位）；
- 表格列：SKU / ASIN / 品名 / 标题（截断 + tooltip）/ 五点（已填 n/5）/
  Description（截断）/ 卖点（截断）/ 更新时间 / 操作；
- 数据源：复用页面已加载的 `items`（后端主列表已带文案字段）；
- 编辑：单行 Sheet（对齐 `factory-info-sheet.tsx` 先例）写
  `POST /sku-info/batch-update-listing-copy`（单条也走批量端点）；
- 搜索：复用页面级 SKU / ASIN / 品名搜索。

### 4.2 导出

「导出批量修改模板」按钮：`fetch('/api/backend/api/v1/sku-info/export?export_type=listing&…')`
→ blob 下载 CSV（**照抄成本 Tab 的 `handleExportCurrentFiltered` 实现**，
只需把 `tabSegment` 扩成三分支）。

> 需求原文说"支持导出 Excel 表格"。现状 SKU Info 页所有模块导出均为 **CSV**
> （成本/尺寸模板），前端另有 `exceljs` 用于报表类导出。为保持同页一致，
> 本 Tab **先对齐 CSV**；若需 xlsx，由前端在拿到 CSV 后转 xlsx（前端侧改动，
> 无需后端配合）。

## 5. Agent API 设计（Stage 2）

基础工作（§2–§4）落地后推进，详见 plan §Stage 2。要点：

- **不新增业务域**，复用既有 `sku_info` 域（`business_scope("sku_info")`）——
  文案是主数据字段组，不是独立业务域；新域会逼所有既有 SKU key 重签；
- 读：R1/R2 的序列化函数补文案字段（**已随 §3.1 免费获得**）；
- 写：W1/W2 的 agent schema 补文案字段，**W2 走既有读-改-写合并**（只更新显式
  提供的字段），文案字段天然纳入——**零新端点**；
- 新增 W6「批量文案写入」端点，供 Agent 一次写多 SKU 的文案
  （批量场景 Agent 侧真实存在：一次拉 listing 写多个 SKU）；
- 溯源沿用既有 D4：`source` 枚举必填 + `source_file` 派生 `agent:<agent_id>`。

## 6. 影响面与风险

| 面 | 影响 | 结论 |
| --- | --- | --- |
| 下游消费 | 文案字段**零下游消费**（PT4 财务 / 货件 / 补货 / 报表都不读） | 无回归风险 |
| 缓存 | 文案写走 L1 失效（既有 `sku_info` 域） | 无需新域 |
| 主列表序列化 | `_serialize_sku_record` 加 key；`SkuRecordItem` 加字段 | 纯新增，向后兼容 |
| Agent 契约 | R1/R2 响应新增字段（**新增 key，非破坏性**）；W1/W2 请求新增可选字段 | 向后兼容 |
| 内部 CSV 导入 | 成本/尺寸模板**不变** | 无影响 |
| 导出 | 新增 `export_type=listing` 分支 | 既有两分支不变 |

**风险等级：normal**（无破坏性变更；唯一高风险面是 DB 迁移，已用
nullable + 无回填 + 纯 add_column 降到最低）。
