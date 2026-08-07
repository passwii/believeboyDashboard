# 图表与图例统一规范（Chart Unification Spec）

> 来源：BLF-495（BLF-493 审查产物）。本规范收口全站三套图表体系，定义唯一标准，
> 并登记当前无法收口的豁免项与原因。

## 1. 统一标准（唯一体系）

**所有 recharts 图表一律使用 `frontend/components/ui/chart.tsx` 提供的组件**，禁止绕过：

| 场景 | 必须使用 | 禁止 |
| --- | --- | --- |
| 容器 | `ChartContainer`（自带统一 CSS：tick 默认色、grid 色、dark 模式适配） | 裸 `ResponsiveContainer` |
| Tooltip | `ChartTooltip` + `ChartTooltipContent` | 裸 `<Tooltip contentStyle=... />`、自写 tooltip div |
| 图例 | `ChartLegend` + `ChartLegendContent` | 裸 `<Legend />`、`<Legend formatter=... />` |
| 系列色 | `hsl(var(--chart-1..7))` 或 ChartConfig `color` → `var(--color-<key>)` | 硬编码 hex |
| 坐标轴文字色 | 不写 `fill`（ChartContainer 默认 `--muted-foreground`），或显式 `fill: 'hsl(var(--muted-foreground))'` | `tick={{ fill: '#...' }}` |

`line-charts-6.tsx` 与 `chart.tsx` 组件同构（Tailwind3 适配版），本规范以 `chart.tsx`
为唯一入口；`line-charts-6` 仅存量 2 处使用者（见豁免表），**新代码禁止使用**。

### 1.1 容器

- 每个图表必须包在 `ChartContainer` 内，`className` 给高度（如 `h-[320px] w-full`）。
- 系列颜色优先通过 `config` 的 `color` 字段声明，系列元素用 `var(--color-<key>)`；
  简单场景（动态项目数、饼图 Cell）可直接 `fill/stroke={hsl(var(--chart-N))}`。

### 1.2 图例

- 一律 `<ChartLegend content={<ChartLegendContent />} />`，标签来自 config 的 `label`。
- 不要传 `formatter` 改字号/样式；需要控制位置用 `verticalAlign="top|bottom"`。
- 图例间距/字号由 `ChartLegendContent` 统一（`gap-4`、swatch 8px、`pt-3` 底部留白）。

### 1.3 Tooltip

- 一律 `<ChartTooltip content={<ChartTooltipContent ... />} />`。
- 数据格式化用 `formatter`（返回 JSX 或 `[value, name]`）；label 用 `labelFormatter`。
- 样式统一：圆角 `rounded-lg`、边框 `border-border/50`、字号 `text-xs`、
  暗色面板 `bg-[hsl(var(--surface-panel))]`——均由 ChartTooltipContent 内置。

### 1.4 颜色

- 系列色：`hsl(var(--chart-1..7))`（`globals.css` 定义了 light/dark 两套值）。
- 语义状态色（非系列）：成功 `hsl(var(--success))`、警告 `hsl(var(--warning))`、
  危险 `hsl(var(--destructive))`、目标未达成主色 `hsl(var(--chart-1))`。
- 坐标轴文字：`hsl(var(--muted-foreground))`（或省略 fill 交给 ChartContainer）。
- 网格线：`hsl(var(--border))` / `rgba(148,163,184,0.18)` 均可（现有两种并存，视觉近似）。
- **禁止**：任何硬编码 hex（`#71717a`、`#3b82f6` 等）出现在图表 fill/stroke/tick/legend。

### 1.5 默认值

- 柱圆角：`radius={[4, 4, 0, 0]}`（与 return-analysis 对齐）。
- 坐标轴字号：10–12px（`tick={{ fontSize: 11 }}` 常见，移动端可降 10）。
- 图表容器：外层卡片 `dashboard-surface rounded-xl p-4`（销售页）或 DataCard 均可。

## 2. 本次收口记录（BLF-495）

| 文件 | 改动 |
| --- | --- |
| `components/dashboard/portfolio/portfolio-trend-chart.tsx` | 裸 `ResponsiveContainer` + `<Legend />` + 裸 `Tooltip` → `ChartContainer` + `ChartLegendContent` + `ChartTooltipContent` |
| `components/dashboard/portfolio/portfolio-pie-chart.tsx` | 同上；自写 CustomTooltip → `ChartTooltipContent` |
| `app/dashboard/operations/return-analysis/return-analysis-client.tsx` | `tick={{ fill: '#71717a' }}` ×3 → `hsl(var(--muted-foreground))` |
| `components/dashboard/dashboard-sales-chart.tsx` | `tick={{ fill: '#71717a' }}` ×3 → `hsl(var(--muted-foreground))` |
| `components/dashboard/dashboard-ad-spend-chart.tsx` | `tick={{ fill: '#71717a' }}` ×3 → `hsl(var(--muted-foreground))` |
| `app/dashboard/operations/daily-analysis/daily-analysis-client.tsx` | 目标进度条 hex（`#22c55e`/`#3b82f6`/`#8b5cf6`）→ `--success`/`--chart-1`/`--chart-7` |
| `components/dashboard/inventory-replenishment/calendar-view.tsx` | Gantt 状态色 hex → `--destructive`/`--warning`/`--success`/`--chart-1` |
| `app/dashboard/supply-chain/inventory-ledger/ledger-summary-tab.tsx` | SKU 线色裸 `var(--chart-N)`（无 hsl，SVG attribute 不解析 var）→ `hsl(var(--chart-N))` |

## 3. 登记豁免表（无法收口，含原因）

| 位置 | 内容 | 豁免原因 |
| --- | --- | --- |
| `app/dashboard/ai/insights/page.tsx` | SVG data-URL 图表内 hex（`#3b82f6`/`#e2e8f0`/`#94a3b8` 等，17 处） | SVG data-URL 是独立图片，无法解析 CSS 变量；`CHART_COLORS_HEX` 已按 chart-1..5 逐项映射并注释，代码内有说明 |
| `components/dashboard-v2/v2-*.tsx`（6 个） | chartConfig `color: '#2563eb'/'#60a5fa'/'#1d4ed8'/'#93c5fd'` | dashboard-v2 为 Dashboard 主页独立蓝色单色设计体系（卡片 hover/图标均 blue 系），套 chart-1..8 会引入绿色等异色破坏整体；已用 ChartContainer/ChartLegendContent/ChartTooltipContent，仅色板刻意独立，随 v2 后续收口 |
| `app/dashboard/system/digital-display/page.tsx` | 裸 recharts + hex 系列色 + 自写 Tooltip contentStyle | 全屏数字展示页，独立视觉（大字号 tooltip、白色网格、TV 场景），非销售页；如需统一另立任务 |
| `components/ui/demo.tsx`、`components/dashboard/metric-switcher-card.tsx` | 从 `line-charts-6.tsx` 导入 | 组件展示页 + Dashboard 主页 metric 切换卡片，与 chart.tsx 同构无行为差异，登记后逐步迁移 |
| `components/ai-chat-message-content.tsx` | Prism 行号 `color: '#6b7280'` | 代码高亮行号色，非图表 |

> 豁免 ≠ 永久。dashboard-v2 与 line-charts-6 两处随对应页面重构收口。

## 4. 验收基线（BLF-495 验收命令）

```bash
# 1. 无裸 <Legend 用法（components + app）
grep -rn "<Legend" frontend/components frontend/app --include="*.tsx" \
  | grep -v "ChartLegendContent"          # → 无输出

# 2. app 下 tick={{ 无硬编码 hex
grep -rn "tick={{" frontend/app --include="*.tsx" | grep "#[0-9a-fA-F]"  # → 无输出

# 3. 构建与测试
cd frontend && pnpm lint && pnpm build && pnpm test
```

销售类页面（operations / finance / supply-chain / ai-insights / ad-analysis）图表均已
走 `ChartContainer` + `ChartTooltipContent`（finance/ad-analysis 无图表，为纯表格）。
