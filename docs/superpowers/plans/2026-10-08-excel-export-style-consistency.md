# Excel 导出表格样式统一实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改导出数据、工作表结构和业务语义的前提下，为适合的分析型 Excel 数据区统一白色 / 浅灰蓝交替底纹与完整细边框，并保留合计、状态和分组等既有强调。

**架构：** 在 `frontend/lib/excel-styles.ts` 增加仅负责数据行填充的轻量共享函数，调用方按数据顺序逐行调用；函数不设置边框、字体、对齐或格式，让现有业务样式继续负责这些属性。各导出只把该函数接入表格型数据行，非连续行（例如周报周期明细）由调用方按实际数据序号调用，不对分隔行、汇总行、合计行或空白行着色。

**技术栈：** Next.js / TypeScript、ExcelJS、Vitest。

---

## 书面审阅结论与范围

附件设计的原始目标（日报汇总、FBA 箱单明细、补货分析、库存分析）总体可行；颜色沿用 `EXCEL_COLORS.white` / `EXCEL_COLORS.altRowFill`，网格线、冻结窗格、数据与现有业务强调均应保持。审阅代码后，FBA 箱单明细已使用 `applyGroupBanding`，并在其后执行货件合并、图片锚点和 `applyTotalRowStyle`；本次只回归验证该工作表，不改共享 `applyGroupBanding` 或相邻 shipment-management 导出。

盘点结果显示，初始四项之外，以下分析型工作表也适合相同的行阅读节奏，纳入本计划：

| 导出入口 | 工作表 / 数据区 | 计划处理 |
|---|---|---|
| `frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.tsx` | `季节性补货` 数据行 | 纳入；精确保留 `筛选结果合计` 行，不纳入斑马序列。 |
| `frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.tsx` | `汇总` 周数据、`SKU明细` 原始明细 | 纳入；两层分组表头不动；汇总行、周期分隔行、说明行和空白间隔行不参与斑马序列；不完整周的黄色提示优先于斑马底纹。检查 worksheet view 覆盖时保留隐藏网格线及现有冻结坐标。 |
| `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx` | `退货排行`、`退货原因`、`商品状态`、`库存状态`、`顾客反馈`、`亚马逊原始数据` | 纳入六个 sheet 的数据行；各自表头、字段、冻结设置及空值边框保持。 |
| `frontend/app/dashboard/finance/platform-revenue/page.tsx` | `平台回款` 数据行 | 纳入；站点、币种、回款类型的专属单元格颜色覆盖斑马底色，合计行不变；工作表设置 `showGridLines: false`，不新增冻结行列。 |
| `frontend/lib/product-analysis-export.ts` | 产品分析导出的 `汇总` 周数据、`SKU明细` 原始明细 | 纳入；部分周期黄色、周期汇总、周期分隔及总计行优先，不将它们算作普通数据行。此函数被产品分析与月度 SKU 分析两个入口调用。 |
| `frontend/app/dashboard/reports/product-analysis/components/manual-calculation-panel.tsx` | `SKU明细` 结果行 | 纳入；`汇总` sheet 目前仅写周期数，不是表格数据区，不加斑马纹。该工作簿目前未配置 worksheet view；实施时隐藏网格线，不新增冻结行列。 |

**已满足或保持非目标：**

- `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx` 的 `SKU明细` 已有按日期分组带纹；只补 `日报汇总`。该导出函数也支持月度粒度，同一逻辑会使 `月报汇总` 采用同一行底纹；不改工作表名、字段或结构。
- `frontend/app/dashboard/operations/shipment-management/page.tsx` 的 `FBA箱单明细` 已有货件分组带纹、边框和合计样式。`船期批次总览`、`发货费用`、`SKU汇总` 已使用分组带纹与合计样式；`Create workflow – template` 是输入模板。均不重做、不改动。
- `frontend/app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx` 与 `frontend/components/dashboard/pricing-calculation/shop-calculation-us-section.tsx` 的计算结果数据行已有白 / 浅灰蓝交替底纹；保持。
- `frontend/app/dashboard/reports/pricing-calculation/new-product/new-product-client.tsx` 的比较矩阵是按行/指标分段着色，店铺 SKU 表按业务列组着色；全行斑马覆盖会破坏现有语义色，不纳入本次统一底色。
- `frontend/components/crm/crm-import-sea/template.ts` 与 `frontend/components/crm/crm-import-sea/index.tsx` 是导入模板/失败明细，不是分析表格导出，不纳入。
- **明确排除** `frontend/app/dashboard/reports/monthly-report/display/display-client.tsx`，不论其中包含几个 Excel sheet。`frontend/app/dashboard/reports/monthly-report/generate/generate-client.tsx` 下载后端生成的月报，`frontend/app/dashboard/operations/research-analysis/page.tsx` 下载后端生成的研究分析工作簿；它们不在前端 ExcelJS 样式实现边界内，本次不修改。后端 `openpyxl` 生成器也不纳入本前端计划，若希望这些文件同步统一样式，应另开后端范围评估。

因此计划涉及六个新增前端导出模块（季节性补货、周产品分析、退货分析、平台回款、产品分析共享导出、手动产品核算），其中周产品分析、退货分析和产品分析共享导出各覆盖多张工作表；同时补齐日报、补货分析、库存分析三项样式，并只验证已有 FBA 箱单样式。

## 全仓导出盘点与范围边界

对前端 `ExcelJS` 写入（`workbook.xlsx.writeBuffer` / `addWorksheet`）、`.xlsx` 文件名与 dashboard 下载路径做了搜索。下表列出 15 行前端导出入口/入口组，其中 10 行属于本次样式处理或 FBA 回归检查范围（含只做回归的 shipment-management）；其余条目用于记录已具备样式或因特殊用途不纳入的判定，避免漏项或覆盖颜色语义。

| 页面 / 文件 | 导出工作表 | 判定 |
|---|---|---|
| `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx` | 日报汇总、SKU明细；复用 exporter 时有月报汇总、SKU月度明细 | 日报汇总纳入；SKU明细已有按日期分组的带纹，不重做；月报汇总同样接入共享逻辑。 |
| `frontend/app/dashboard/operations/inventory-replenishment/inventory-replenishment-client.tsx` | 补货分析 | 纳入；风险字体、26 列、批注与数值格式保留。 |
| `frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx` | 库存分析 | 纳入；状态字体和动态货件列保留。 |
| `frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.tsx` | 季节性补货 | 纳入；数据行交替，合计行单独强调。 |
| `frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.tsx` | 汇总、SKU明细 | 纳入；两张表都含不同类型的特殊行，按业务数据而非物理行序铺色。 |
| `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx` | 退货排行、退货原因、商品状态、库存状态、顾客反馈、亚马逊原始数据 | 六张表都纳入，空值边框按各自列定义补齐。 |
| `frontend/app/dashboard/operations/shipment-management/page.tsx` | 船期批次总览、发货费用、SKU汇总、FBA箱单明细、Create workflow – template | 三个汇总表已使用共享分组带纹；FBA 箱单已使用分组带纹/合并/图片/合计，本次只回归；工作流模板不是分析表，不套统一数据底纹。 |
| `frontend/app/dashboard/finance/platform-revenue/page.tsx` | 平台回款 | 纳入；保留站点/币种/回款类型专色及合计。 |
| `frontend/lib/product-analysis-export.ts` | 汇总、SKU明细 | 纳入；共享 builder 被产品分析与月度 SKU 分析两个入口使用。 |
| `frontend/app/dashboard/reports/product-analysis/components/manual-calculation-panel.tsx` | 汇总（仅写周期数）、SKU明细 | 仅 SKU 明细结果行纳入；汇总不是表格数据区。 |
| `frontend/app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx`、`frontend/components/dashboard/pricing-calculation/shop-calculation-us-section.tsx` | 店铺 SKU 测算 / 美国店铺 SKU 核算 | 数据行已有交替底纹，现状验收，不重复处理。 |
| `frontend/app/dashboard/reports/pricing-calculation/new-product/new-product-client.tsx` | 测算对比矩阵、店铺SKU核算表 | 分区/指标/业务列组已有语义底色，全行交替会冲突，保持现状。 |
| `frontend/components/crm/crm-import-sea/template.ts` | 客户导入模板、导入失败明细 | 导入模板及错误回执，不属于分析数据导出，不纳入。 |
| `frontend/app/dashboard/reports/monthly-report/display/display-client.tsx` | 月度财务总览、年度财务总览 | **用户明确排除，不修改。** |
| `frontend/app/dashboard/reports/monthly-report/generate/generate-client.tsx`、`frontend/app/dashboard/operations/research-analysis/page.tsx` | 服务端返回的月报 XLSX、研究分析工作簿 | 前端只下载后端生成的 Blob，样式必须在后端生成器改，不纳入本前端实现。 |

另外后端检索到 `openpyxl` 生成点：`backend/app/services/category/export.py`、`backend/app/services/new_product_calculation_export.py`、`backend/app/services/shop_calculation_export.py`、`backend/app/services/shipment/fba_box_export.py`、`backend/app/services/shipment/fba_template.py`、`backend/app/tasks/scripts/product_analysis.py`、`backend/app/tasks/scripts/monthly_report.py`、`backend/app/services/report/export.py`，以及 `backend/app/api/v1/endpoints/report_reconciliation.py` 中 `GET /report-reconciliation/reports/{id}/export-pt3`（工作表「数据库数据」）。其中有分类分析、测算、shipment、报表及对账数据等独立业务文件；需后端 owner 逐个映射对应用户入口与样式契约。本计划不更改 `backend/`；若本需求的“所有导出”也覆盖这些服务端 XLSX，需另行委派/拆分后端工作，不能将其误报成已经纳入前端方案。

## 文件职责

- 修改 `frontend/lib/excel-styles.ts`：提供仅设置行填充的共享交替底纹函数；不得改写 `applyGroupBanding`、`applyRowBorder`、`applyTotalRowStyle` 的既有行为。
- 修改 `frontend/lib/excel-styles.test.ts`：覆盖白/浅灰蓝顺序、空单元格覆盖、只改变 fill、零列/单行边界。
- 修改以下导出实现及其现有测试；只在页面测试难以稳定触发导出时，按设计说明从现有模块提取最小 workbook 构建辅助函数，不创建新的导出框架：
  - `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`
  - `frontend/app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts`
  - `frontend/app/dashboard/operations/inventory-replenishment/inventory-replenishment-client.tsx`
  - `frontend/app/dashboard/operations/inventory-replenishment/inventory-replenishment-client.test.tsx`
  - `frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx`
  - `frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-client.test.tsx`
  - `frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.tsx`
  - `frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.test.tsx`
  - `frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.tsx`
  - `frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.test.tsx`
  - `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx`
  - `frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx`
  - `frontend/app/dashboard/finance/platform-revenue/page.tsx`
  - `frontend/app/dashboard/finance/platform-revenue/page.test.tsx`
  - `frontend/lib/product-analysis-export.ts` 及新增的 `frontend/lib/product-analysis-export.test.ts`（若导出辅助可稳定单测）
  - `frontend/app/dashboard/reports/product-analysis/components/manual-calculation-panel.tsx`（仅在找到可稳定的既有测试入口或可抽出小构建函数时增加对应测试）
- `frontend/app/dashboard/operations/shipment-management/page.tsx` 不作为样式实现文件修改；如单测可稳定捕获现有导出工作簿，再补一项针对 FBA 不变量的回归测试。否则由 `excel-styles.test.ts` 对共享分组函数的现有断言加上本计划既有断言作为回归证据，不为测试而改造导出架构。

## 任务 1：共享交替底纹函数与契约测试

**文件：** `frontend/lib/excel-styles.ts`、`frontend/lib/excel-styles.test.ts`

- [ ] **步骤 1：先写失败测试**。测试提供 ExcelJS 行与 `columnCount`，数据序号 `0` 为白色、序号 `1` 为 `EXCEL_COLORS.altRowFill`；第三个空值单元格也应有 fill。预先设置的字体、边框、对齐、`numFmt` 不得变化。对 `columnCount = 0` 不抛错。
- [ ] **步骤 2：运行测试确认失败**：`cd frontend && pnpm exec vitest run lib/excel-styles.test.ts`。预期新测试因共享函数不存在而失败。
- [ ] **步骤 3：编写最小实现**：新增 `applyAlternatingRowFill(row: Row, dataRowIndex: number, columnCount: number)`；仅循环列 `1..columnCount` 并设置 `fill`，偶数数据序号为 `EXCEL_COLORS.white`，奇数为 `EXCEL_COLORS.altRowFill`。实现形状：

```ts
export function applyAlternatingRowFill(row: Row, dataRowIndex: number, columnCount: number) {
  const argb = dataRowIndex % 2 === 0 ? EXCEL_COLORS.white : EXCEL_COLORS.altRowFill
  for (let col = 1; col <= columnCount; col += 1) {
    row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
  }
}
```

使用 `row.getCell(col)` 以覆盖空单元格。调用者保证合计、说明、分隔与空白行不传入。
- [ ] **步骤 4：运行共享样式测试确认通过**：`cd frontend && pnpm exec vitest run lib/excel-styles.test.ts`。
- [ ] **步骤 5：确认调用影响面**：对新增符号运行 CodeGraph `callers` / `impact`，并在实施 PR 说明 helper 是纯 fill 行为；本计划的共享工具改动按 T3 验证。
- [ ] **步骤 6：提交独立共享工具变更**：`git add frontend/lib/excel-styles.ts frontend/lib/excel-styles.test.ts && git commit -m "feat(导出样式): 增加交替行底纹工具"`。

## 任务 2：日报汇总、补货分析与库存分析

**文件：** 上述三个 client 与对应目标测试。

- [ ] **步骤 1：为目标导出补/扩导出测试**。复用 daily-analysis 现有的 ExcelJS 写入后重新载入 workbook 测试；库存与补货测试以现有页面 fixture 驱动导出，验证实际导出 sheet 的相邻数据行颜色、空值尾列边框和原有值。现有 Vitest 文件多数只测页面呈现且 export 函数位于组件内部；优先抽取纯 worksheet builder，不在测试中驱动 React hook 导出。
- [ ] **步骤 2：运行这些目标测试确认新增断言失败**：`cd frontend && pnpm exec vitest run app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts app/dashboard/operations/inventory-analysis/inventory-analysis-client.test.tsx app/dashboard/operations/inventory-replenishment/inventory-replenishment-client.test.tsx`。
- [ ] **步骤 3：接入逐数据行样式**：日报仅处理 `日报汇总` 数据行，按 `summaryCols.length` 遍历每格铺底纹并应用细边框；库存分析与补货分析只处理数据区，分别按 `columns.length`、26 列遍历，包括空值单元格。日分析既有 `SKU明细` 分组处理、库存状态字体色、补货风险字体色、注释与数字格式不变。补货分析合计行保留当前值与 `numFmt`，最后调用 `applyTotalRowStyle(totalRow, 26, { numericColumns: [3, 4, 5, 6, 7, 8, 9, 11, 20] })` 以应用统一浅灰蓝和顶部强调；库存分析合计行沿用当前轻量样式。
- [ ] **步骤 4：运行目标测试确认通过**：重复步骤 2 的命令，且检查重新载入的工作簿数据值、sheet 名、冻结设置、`showGridLines: false` 与样式。
- [ ] **步骤 5：记录月度行为决策**：同一个 exporter 的 `monthly` 粒度会复用 `日报汇总` 的填充逻辑，测试需明确 `月报汇总` 同样斑马化；不得改工作表名或列结构。
- [ ] **步骤 6：提交目标导出改动**：`git add frontend/app/dashboard/operations/daily-analysis frontend/app/dashboard/operations/inventory-analysis frontend/app/dashboard/operations/inventory-replenishment && git commit -m "fix(运营导出): 统一日分析与库存分析行样式"`。

## 任务 3：季节性补货

**文件：** `frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.tsx`、`frontend/app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.test.tsx`

- [ ] **步骤 1：写导出工作簿样式回归测试**：覆盖两条数据行底色不同，空列有连续边框；精确验证 `筛选结果合计` 不属于数据序列，字段值、`numFmt`、批注和冻结参数不变。
- [ ] **步骤 2：运行 `cd frontend && pnpm exec vitest run app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.test.tsx` 确认新增测试先失败。**
- [ ] **步骤 3：在行数据和状态/数字样式建立后调用共享 helper**，对数据行全列填充；最后沿用原合计样式，不改导出函数名、列数、数据或审计。
- [ ] **步骤 4：重复目标 Vitest 命令确认通过。**
- [ ] **步骤 5：提交季节补货导出改动**：`git add frontend/app/dashboard/operations/seasonal-replenishment && git commit -m "fix(补货导出): 为季节性数据行增加交替底纹"`。

## 任务 4：周产品分析的两张表

**审查发现的数据结构疑点：** `fillSummaryWorksheet` 先用 `rowIndex` 写合计行，随后以相同的 `rowIndex` 创建说明行并合并整行。该行为可能导致合计被覆盖，需在实施回归时确认。它属于既存数据结构问题而非样式修改；不能为了通过样式测试而默默改写工作簿结构。若复现，先向 issue 提出单独修复决策或拆分后续任务。

**文件：** `frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.tsx`、`frontend/app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.test.tsx`

- [ ] **步骤 1：增加工作簿样式用例**：验证 `汇总` 连续周数据行与 `SKU明细` 的原始明细行按各自数据序号交替；合计、部分周期提示、周期汇总、分隔行、说明行与 spacer 不参与序列；部分周期保留黄色；合并表头、数据、数值格式和冻结参数不变。
- [ ] **步骤 2：运行 `cd frontend && pnpm exec vitest run app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.test.tsx` 确认新增断言失败。**
- [ ] **步骤 3：在两个 worksheet builder 中对普通数据记录调用 helper**。`SKU明细` 在写原始详情的循环里按详情序号调用；不能按 worksheet 物理行号奇偶，否则周期标题、汇总和 spacer 会打乱数据行节奏。周数据黄色提示最后覆盖标准斑马填充。显式设置 `showGridLines: false` 并保留 `ySplit: 2, xSplit: 2` 冻结坐标。
- [ ] **步骤 4：重复目标 Vitest 命令确认通过，检查合并范围、冻结坐标与隐藏网格线。**
- [ ] **步骤 5：提交周分析导出改动**：`git add frontend/app/dashboard/operations/weekly-product-analysis && git commit -m "fix(周分析导出): 统一工作表数据行底纹"`。

## 任务 5：退货分析六个工作表

**文件：** `frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx`、`frontend/app/dashboard/operations/return-analysis/return-analysis-client.test.tsx`

- [ ] **步骤 1：扩展 ExcelJS 测试替身或抽取最小 workbook builder**，使测试能检查六个 sheet 的数据/样式而不只检查 `addWorksheet` 名称。用真实 ExcelJS workbook 重新载入作首选；保留目前用于组件其它行为的轻量 mock 契约。
- [ ] **步骤 2：运行 `cd frontend && pnpm exec vitest run app/dashboard/operations/return-analysis/return-analysis-client.test.tsx` 确认新增样式断言失败。**
- [ ] **步骤 3：在六个 sheet 的各自数据循环中按数据序号铺底纹；使用 header 数量/worksheet 列定义遍历所有列，为空值单元格补细边框**。不改 header、日期/数值/文本、不插入额外数据；反馈与原始明细也按行序交替。
- [ ] **步骤 4：重复目标 Vitest 命令确认通过，检查六个 sheet 名、字段值、冻结表头和隐藏网格线。**
- [ ] **步骤 5：提交退货导出改动**：`git add frontend/app/dashboard/operations/return-analysis && git commit -m "fix(退货导出): 为分析明细增加交替底纹"`。

## 任务 6：平台回款表

**文件：** `frontend/app/dashboard/finance/platform-revenue/page.tsx`、`frontend/app/dashboard/finance/platform-revenue/page.test.tsx`

- [ ] **步骤 1：添加测试驱动的导出工作簿检查**，覆盖普通行底色、站点/币种/回款类型彩色单元格、全 7 列细边框、合计行强调和原数值。
- [ ] **步骤 2：运行 `cd frontend && pnpm exec vitest run app/dashboard/finance/platform-revenue/page.test.tsx` 确认新断言失败。**
- [ ] **步骤 3：在设置类型、站点、币种专属填充之前对每行应用交替填充**，让语义色自然覆盖基础行色；为 `平台回款` 工作表设置 `showGridLines: false`，不新增冻结行列；不要改合计行和分页获取逻辑。
- [ ] **步骤 4：重复目标 Vitest 命令确认通过。**
- [ ] **步骤 5：提交平台回款导出改动**：`git add frontend/app/dashboard/finance/platform-revenue && git commit -m "fix(回款导出): 统一数据行底纹"`。

## 任务 7：产品分析共享工作簿与手动核算明细

**文件：** `frontend/lib/product-analysis-export.ts`、必要时新增 `frontend/lib/product-analysis-export.test.ts`、`frontend/app/dashboard/reports/product-analysis/components/manual-calculation-panel.tsx` 与可测辅助。

- [ ] **步骤 1：先检查产品分析共享导出的两个调用点与现有测试；为共享导出增加 ExcelJS workbook 回读断言**，至少覆盖每张表普通数据行、特殊周期/合计行及数据值。为手动核算导出只测试明细表数据区，不把单一周期数的汇总表当作表格。
- [ ] **步骤 2：运行目标 Vitest 文件确认新断言失败**：`cd frontend && pnpm exec vitest run lib/product-analysis-export.test.ts app/dashboard/reports/product-analysis/page.test.tsx`（如手动核算单测不能稳定从现有页面驱动，新增最小导出 builder 测试而非整个页面重构）。
- [ ] **步骤 3：接入斑马样式**。产品分析汇总只对周数据行处理；SKU 明细只对普通 SKU 详情处理，周期分隔/周期汇总/空白 spacer 不处理；部分周期黄色与既有周期汇总强调优先。手动核算仅为 `SKU明细` 的详情行铺色，并对明确数据列（含空值）补全细边框；设置 `showGridLines: false`，不增加冻结行列。保持数值、公式/格式、周期标记和其它冻结设置不变。
- [ ] **步骤 4：重复目标 Vitest 命令，确认普通行交替、空值边框、隐藏网格线且语义色优先。**
- [ ] **步骤 5：提交产品分析导出改动**：`git add frontend/lib/product-analysis-export.ts frontend/lib/product-analysis-export.test.ts frontend/app/dashboard/reports/product-analysis/components/manual-calculation-panel.tsx && git commit -m "fix(产品分析导出): 统一工作表数据行样式"`。

## 任务 8：FBA 箱单与全量回归收口

**文件：** 如需仅修改 `frontend/app/dashboard/operations/shipment-management/page.test.tsx`；不修改 FBA 生产导出实现。

- [ ] **步骤 1：验证 FBA 工作簿已有 `applyGroupBanding`，且合计样式位于图片与合并操作之后/原有顺序内；回归应覆盖同货件同底色、不同货件异色、图片锚点/合并区域、总计数值、冻结首行与隐藏网格线。**
- [ ] **步骤 2：运行受影响的全部定向测试**：`cd frontend && pnpm exec vitest run lib/excel-styles.test.ts app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts app/dashboard/operations/inventory-analysis/inventory-analysis-client.test.tsx app/dashboard/operations/inventory-replenishment/inventory-replenishment-client.test.tsx app/dashboard/operations/seasonal-replenishment/seasonal-replenishment-client.test.tsx app/dashboard/operations/weekly-product-analysis/weekly-product-analysis-client.test.tsx app/dashboard/operations/return-analysis/return-analysis-client.test.tsx app/dashboard/finance/platform-revenue/page.test.tsx app/dashboard/operations/shipment-management/page.test.tsx lib/product-analysis-export.test.ts`。不存在的测试文件应在对应任务新增后才包含。
- [ ] **步骤 3：按 T3 跑 `cd frontend && pnpm test` 与 `cd frontend && pnpm lint`**，记录 Vitest / lint 实际 passed、failed、errors、warnings 数；有新增失败先修复，既有失败按仓库失败集对账规则处理。
- [ ] **步骤 4：不改构建敏感面，`pnpm build` 交由 Vercel preview**；PR body 按模板写真实测试结果，未跑的命令不打勾。

## 验收清单

- [ ] 所有纳入的普通分析数据行按其数据序号以 `FFFFFFFF` / `FFF8FAFC` 交替，边框覆盖数据范围内的空值单元格。
- [ ] 合计行、周期汇总/分隔、说明、间隔、黄色不完整提示、状态字体色及其它单元格语义填充都保留；特殊行不计入数据斑马序号。
- [ ] 所有原有 sheet 名、列/行顺序、值、公式、格式、合并范围、图片、冻结坐标与导出入口保持；目标工作表隐藏网格线。周产品分析保留既有冻结设置；对原先未配置 worksheet view 的平台回款与手动核算工作簿只增加 `showGridLines: false`，不新增冻结行列。
- [ ] FBA 箱单仅验证已存在的货件组底纹与图片/合并/总计不变量；相邻 shipment-management sheet 不被本次改动。
- [ ] `dashboard/reports/monthly-report/display` 没有文件改动。
- [ ] `pnpm test` 与 `pnpm lint` 实际结果记录在 PR / issue 交付中。

## 审阅后需确认的边界

1. 日分析的月度模式共用同一导出 builder；行底纹也应用于 `月报汇总`，但不涉及明确排除的 monthly-report/display 页面。
2. 两个产品分析导出入口属于分析型表格，建议纳入；pricing calculation 对比矩阵/颜色分组表、CRM 导入模板则因其不同用途与现有语义色明确不纳入。
3. 共享样式函数是跨多个导出模块的新增公共符号；实现前用 CodeGraph 确认调用影响面，按 T3 做全量前端测试与 lint。
