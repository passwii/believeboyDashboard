# 库存分类账分析扩展与统一 Excel 导出设计

## 1. 背景

库存分类账页面已有 Summary / Detail 双表、月度 Snapshot、近 6 月 Trend、
跨表 Consistency、批次元数据与基础总览图。但当前有两个限制：

1. 页面通过 `/summary` 与 `/detail` 取数，分别默认截断到 5,000 / 2,000 行；
   大月份的项目会出现页面分析口径不完整。
2. 两个数据表分别导出 CSV，没有统一工作簿，也没有把总览分析、专项派生分析和
   原始数据放进同一份可复核文件。

本设计新增一个“所选自然月全量”聚合读取接口，并让页面与 Excel 导出共用该接口。
页面展示和后端 API 继续保留既有独立端点，不破坏 Agent 契约。

## 2. 目标

- 所选月份的分析和导出不受页面行数上限影响。
- 页面与 Excel 使用同一份全量数据，不出现口径漂移。
- 统一 Excel 采用项目既有 ExcelJS 样式体系。
- Excel 第一张 Sheet 为分析总览，最后两张固定为 Summary / Detail 原始数据。
- 移除库存分类账页面两个 CSV 导出按钮，只保留一个 Excel 导出入口。
- 扩展总览、Summary、Detail 的分析能力，但不改变原始字段含义。

## 3. 非目标

- 不修改 Amazon Summary / Detail 的上传格式和入库表结构。
- 不新增成本、库龄、补货建议等当前数据源没有的字段。
- 不改变既有 `/snapshot`、`/summary`、`/detail` 等 API 的默认行为。
- 不新增 Agent 导出路由；本阶段只服务 Dashboard。

## 4. 数据架构

### 4.1 新接口

`GET /api/v1/inventory-ledger/month-analysis?project_id=&period=`

约束：

- `period` 必须解析为完整自然月，例如 `2026-08` / `2026-08-01`。
- 部分月份窗口直接返回 400。
- 返回所选项目、所选月份的全量数据，不应用 MSKU / 仓库 / 状态 / 事件筛选。
- period 只接受一个自然月；Trend 额外返回最近 6 个月。

响应 `LedgerMonthAnalysisResponse`：

```text
project_id
project_name
country
report_month
start_date
end_date
generated_at
summary_rows[]       # 全量 LedgerSummaryRow
detail_rows[]        # 全量 LedgerDetailRow
snapshot             # 全量月度 Snapshot + Integrity
trend                # 最近 6 个月 Trend
consistency          # 该月双表对账
batches[]            # 该月批次元数据
```

### 4.2 服务层

`get_ledger_detail_rows` 与 `get_ledger_summary_rows` 的 `limit` 扩展为
`int | None`：

- 默认值保持 2,000 / 5,000，既有调用不变。
- `limit=None` 时不追加 SQL LIMIT，供月度分析接口使用。

`list_ingest_batches` 增加可选 `report_month` 过滤，供月度分析接口只返回所选月批次。

### 4.3 页面数据流

页面不再并行请求六个端点，而是请求一次 `month-analysis`：

- Summary 原始行、Detail 原始行用于两个 Tab 与客户端派生。
- Snapshot / Trend / Consistency / Batches 直接写入现有状态。
- 全局筛选仍只影响页面展示，不影响导出数据范围。
- `month-analysis` 加入 Next 后端代理的 60 秒档，避免大月份被默认 5 秒截断。

## 5. Excel 工作簿

文件名：`库存分类账分析-{项目名}-{YYYY-MM}.xlsx`。

Sheet 顺序固定如下：

1. `分析总览`
2. `盘库`
3. `SKU期末与环比`
4. `SKU事件汇总`
5. `仓库状态库存`
6. `每日事件分析`
7. `数据质量与批次`
8. `Summary原始数据`
9. `Detail原始数据`

### 5.1 分析总览

使用“指标 / 数值 / 说明”三列结构，包含：

- 报表信息：项目、月份、导出时间、数据范围。
- 核心 KPI：SKU 数、期末总库存、可售库存、损坏库存、损坏占比、
  事件净变动、事件数、环比变动。
- Disposition 构成。
- 仓库 Top 5。
- 事件类型构成。
- Integrity / Consistency 状态。

### 5.2 专项分析

- `盘库`：按 MSKU × 仓库 × Disposition 对照上月期末与本月期初，
  显式标记一致、差异、本月新增、上月遗留，并保留近 6 个月趋势。
- `SKU期末与环比`：期末总库存、可售、损坏、损坏占比、上月期末、环比变动与比例。
- `SKU事件汇总`：各事件列合计与净变动。
- `仓库状态库存`：仓库 × Disposition 的期初、期末与事件合计。
- `每日事件分析`：日期级事件数、净数量及各事件类型数量。
- `数据质量与批次`：双表对账问题、所选月上传批次。

### 5.3 原始数据

最后两张 Sheet 使用 Amazon 原始英文列名，并附内部 `Record ID` / `Batch ID`：

- Summary：22 个 Amazon 字段 + Record ID + Batch ID。
- Detail：16 个 Amazon 字段 + Record ID + Batch ID。

原始 Sheet 不做聚合、排序（保持接口返回顺序）、过滤或字段改名。

### 5.4 样式

复用 `frontend/lib/excel-styles.ts`：

- Microsoft YaHei；
- 统一浅灰蓝表头、细边框、斑马纹；
- 冻结表头、启用筛选；
- 数值格式 `#,##0;[Red]-#,##0`，百分比 `0.0%`；
- 自动列宽但设置最小/最大宽度；
- 分析总览分区之间保留空行和加粗分区标题。

## 6. 页面分析扩展

### 6.1 总览

- KPI 从 4 个扩展到 8 个：SKU 数、期末总库存、可售库存、损坏库存、
  损坏占比、事件净变动、事件数、环比变动。
- 保留近 6 月趋势、事件构成、Disposition 构成、Top 仓库。
- 新增 `SKU 期末库存 Top 10`。
- 新增 `每日事件活动`，展示日期级事件数与净数量。

### 6.2 Summary Tab

- 文案从“每日水位”修正为“月度水位”，避免月粒度源数据误导。
- 在原始水位表上方新增 `SKU 月度汇总`：每个 MSKU 的期末、可售、损坏。

### 6.3 Detail Tab

- 在原始事件表上方新增 `每日事件汇总`：日期、事件数、净数量。
- 保留原始事件行、分页和事件类型筛选。

### 6.4 导出入口

- 删除 Summary / Detail 的 CSV 按钮与 `ExportCsvButton` 依赖。
- 在总览区右上角新增 `导出库存分析 Excel`。
- 导出中显示 loading，失败时展示可操作错误；成功后下载统一工作簿。

## 7. 错误处理

- Month analysis 非整月 → 400。
- 项目无该月数据 → 200，空数组和 `PENDING` 状态，Excel 仍可导出说明与空原始表。
- ExcelJS 生成失败 → 捕获错误并展示“导出 Excel 失败”。
- 文件名中的项目名清理 `/ \ : * ? " < > |`。
- 页面单次聚合请求失败 → 显示真实错误，不伪装成“暂无数据”。

## 8. 测试策略

后端：

- 服务层 `limit=None` 返回超过默认上限的行。
- Month analysis 整月契约、字段完整性、批次过滤、空数据。
- 非整月 period 返回 400。

前端：

- 页面只请求 `month-analysis`，六类数据状态正确落位。
- 8 个 KPI、SKU Top 10、每日事件活动、Summary 汇总、Detail 日汇总渲染。
- 两个 CSV 按钮消失，Excel 按钮存在且失败有提示。
- Excel 工作簿 Sheet 顺序、表头、原始列、数值、样式、文件名。
- 大行数 fixture 不截断。

命令：

```bash
cd backend && pytest tests/services/inventory tests/api -q
cd frontend && pnpm vitest run app/dashboard/operations/inventory-ledger
cd frontend && pnpm lint
cd frontend && pnpm build
```

## 9. 上线顺序

1. 后端月分析接口先上线，保留旧端点。
2. 前端切换页面数据源与 Excel 导出。
3. 移除 CSV 按钮。
4. 合并后由 VPS 部署 workflow 自动部署后端。
