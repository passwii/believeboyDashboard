# 表格规范（Table Spec）

> **适用版本：** v2（BLF-872 Terminal 收口，2026-08-28；v1 由 BLF-496 定稿，2026-08-07）
> **适用对象：** 在 `frontend/` 下新增 / 修改表格的工程师
> **目标：** 全站表格只有**一套配方**。新建表格照抄本节，改造旧表对齐本节。
> **展示页：** `app/dashboard/table-showcase/page.tsx`（基线 + 变体实机效果）
>
> **v2 变更（BLF-872）：** Table 原语默认密度下沉为 compact 档（表头 `h-9 px-3 text-[0.66rem]`、数据格 `px-3 py-2 text-[13px]`、`font-mono`）；表头/行 hover/选中态与 `STICKY_*` 常量全部改用 `term-*` 令牌（`term-raised / term-hover / term-panel / term-border / term-accent`），去除暗黑玻璃高光；`DataTableCard / DataCard / Card / StatCard` 外壳由 `dashboard-surface` 收敛为 `TERM_PANEL_SURFACE`（零圆角 / 零阴影 / 零渐变）。

---

## 1. 唯一配方（The Only Recipe）

任何业务表格 = **外壳**（`DataTableCard` 或 `DataTableFrame`）+ **原语**（`components/ui/table.tsx` 的 `Table/TableHeader/TableBody/TableRow/TableHead/TableCell`）+ **预设**（`components/ui/table-presets.tsx` 的 `densityHead/densityCell/numericHead/numericCell/StatusPill`）。

| 层 | 文件 | 职责 |
|---|---|---|
| 外壳 | `components/ui/data-card.tsx` | `DataTableCard`（卡片壳）/ `DataTableCardHeader` / `DataTableCardBody` / `DataTableCardStatBar` |
| 外壳（带工具栏槽） | `components/ui/table-presets.tsx` | `DataTableFrame`（标题条 + toolbar 槽 + 滚动体 + footer 槽），内部就是 DataTableCard |
| 原语 | `components/ui/table.tsx` | 基础 `<table>` 结构 + `STICKY_*` 常量 + `ColGroup`，**不承载业务样式** |
| 预设 | `components/ui/table-presets.tsx` | 密度档位 / 数字列 / 状态色 / `StatusPill` |

### 1.1 密度档位（density tiers）

| 档位 | 表头 `densityHead` | 数据格 `densityCell` | 用途 |
|---|---|---|---|
| `compact`（**默认**） | `!h-9 !px-3 !text-[0.66rem] !tracking-[0.14em]` | `!px-3 !py-2 !text-[13px]` | 数据密集型列表（财务 / 库存 / 报表 / 佣金） |
| `cozy`（变体） | `!h-11 !px-4 !text-[0.6875rem]` | `!px-4 !py-3 !text-sm` | 常规展示型列表、低密度场景 |

> 历史常量 `DENSE_HEAD` / `DENSE_CELL`（`data-card.tsx`）即 `densityHead.compact` / `densityCell.compact` 的**同源别名**（BLF-496 起收敛为同一定义），存量 100+ 处用法视觉向基线 compact 对齐。新代码请直接用 `densityHead.compact`。
>
> BLF-872 起 `Table` 原语默认密度即 compact 档（表头 `h-9 px-3 text-[0.66rem]`、数据格 `px-3 py-2 text-[13px]`、`font-mono`），compact 档位类成为显式声明（覆写值与基线一致）；cozy 档仍用 `!` 前缀覆写回宽松尺寸。

### 1.2 表头规则

- 表头默认态由 `TableHead` 原语提供：`uppercase` + `tracking-[0.14em]` + `bg-term-raised` + `text-term-muted`（BLF-872 起为 term 令牌），**不要手写背景**。
- 可排序列：点击表头切换排序，指示图标 `ArrowUpDown / ChevronUp / ChevronDown`（见 showcase 基线）。
- 多选列：首列 checkbox，`[&:has([role=checkbox])]:pr-0` 已内置于原语。

### 1.3 数字列对齐

- 数字 / 金额 / 数量 / 比率列：表头 `numericHead`（`!text-right tabular-nums font-medium`），数据格 `numericCell`（`text-right tabular-nums font-medium`）。
- `!text-right` 必须保留：表头原语自带 `text-left`（无 `!`），不用 `!` 会受 Tailwind 源码顺序影响。

### 1.4 状态色

- 一律用 `StatusPill`（`table-presets.tsx`）：`success / warning / negative / neutral / info`，映射 `--data-*` token，**自动适配 dark**。
- 或 `Badge` 内置 variant（`success / warning / info / destructive / outline`，自带 dark 变体）。
- 禁止在业务页手写状态色类（如 `bg-slate-100 text-slate-800`）。

### 1.5 Sticky 行为

常量在 `components/ui/table.tsx`，**禁止手写 sticky 类**：

| 常量 | 类值要点 | 场景 |
|---|---|---|
| `STICKY_TOP_ROW` | `sticky top-0 z-40` + term-raised | 单行表头纵向吸顶（配 `maxHeight` 滚动体） |
| `STICKY_TOP_GROUP_ROW` / `STICKY_TOP_SUB_ROW` | z-50 / `top-[37px]` z-40 | 两行表头场景（offset = 默认表头 h-9 + 1px 边框） |
| `STICKY_LEFT_HEAD_CELL` | `sticky left-0 z-50` + term-raised + inset 分隔线 | 第一列表头（横向滚动吸左） |
| `STICKY_LEFT_CELL` | `sticky left-0 z-30` + term-panel 实体不透明 + inset 分隔线 | 第一列数据格 |
| `STICKY_LEFT_CELL_HOVER` | 同上 + hover 变亮（term-hover） | 第一列可点击行 |

要点：sticky 单元格背景必须**实体不透明 term 令牌**（`term-raised` / `term-panel`），否则暗黑模式滚动时出现浅色带（见 `design-spec.md` §2.2）。

### 1.6 空状态

- 表格空态：`EmptyTableState`（`components/ui/empty-state.tsx`），`<EmptyTableState colSpan={N} message="..." />`，**禁止**手写 `<tr><td colSpan ... h-24 text-center>`。
- 图表空态：`EmptyChartState`（`height` 必传）。
- 加载态（loading）不属于空态：保留现有 Skeleton / spinner 模式，不要混用空态组件。

### 1.7 Mobile 降级

- 表格容器自带 `overflow-x-auto`（`Table` 原语），窄屏横向滚动即降级方案，**不需要**改竖排。
- 关键列（如单据号）可加 `STICKY_LEFT_*` 保持可见；操作列保留在末列。
- 工具栏在 `sm` 断点纵向堆叠（参考 showcase 基线 toolbar 的 `flex-col sm:flex-row`）。

---

## 2. 基线 vs 变体（选型）

| 维度 | **基线 · 高密度数据网格**（默认） | 变体 A · 宽松密度 | 变体 C · 动效增强 |
|---|---|---|---|
| 定位 | 全站默认 | 展示型列表 | 可选增强（需 21st.dev 参考精修） |
| 密度 | `compact` | `cozy` | `cozy` |
| 排序 / 多选 | 支持 | — | — |
| Sticky 表头 | 支持 | — | 支持 |
| 行展开动效 | — | — | 支持 |
| 适用场景 | 财务 / 库存 / 报表 / 佣金 | 常规列表 | 需交互反馈的列表 |

新页面默认按**基线**实现；确实需要宽松密度用变体 A；动效增强（变体 C）在拿到具体 21st.dev 参考链接前**不作为默认**。

---

## 3. 已退役 / 废弃

- **`components/dashboard/data-table.tsx`（旧版自研 @tanstack/react-table 封装）已删除**（BLF-496，全仓零引用）。需要排序/分页/多选能力时，用 `@tanstack/react-table` 直接组合 `Table` 原语 + `table-presets` 预设（参考 showcase 基线），不要恢复旧封装。
- `DENSE_HEAD` / `DENSE_CELL` 保留为兼容别名，语义与 `densityHead.compact` / `densityCell.compact` 完全一致，新代码不新增引用。

---

## 4. 验收红线（lint/build 之外）

1. 全仓无手写 `sticky left-0 z-30 bg-slate-100` 类残留（一律 `STICKY_*` 常量）。
2. 全仓无手写 `<td colSpan h-24 text-center>` 空态（一律 `EmptyTableState`）。
3. 业务表格页（commission-management / ledger / inventory）密度、对齐、状态徽章、暗黑模式视觉一致。
4. `table-presets` / `data-card` 相关测试保持全绿。
