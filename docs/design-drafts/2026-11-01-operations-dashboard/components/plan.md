# 组件设计 Agent Plan

## B0 基础契约

- Owner：A0；基础文件冻结后，A1–A5 只读。
- 输入：整页稿、现有 token、字体、focus、motion。
- 输出：`foundations/spec.md`、`tokens.css`、`states.html`、`freeze.md`。
- 验收：4px 节奏、文字层级、对比度、focus、reduced motion。
- G0 未关闭项：导航入口、production flag、per-project Pending API、精确 `/dashboard` shell exception。

## B1 外壳与导航

- Owner：A1。
- 输出：AppWindow、Sidebar、Topbar 容器、Breadcrumb、WorkspaceScope、MobileNavDrawer。
- 验收：真实路由、键盘、focus trap、长项目名、移动抽屉。
- 依赖：B0。

## B2 Warm controls wrapper

- Owner：A1；与 Warm Ledger shell 一起实现，不另派一个组件 Agent。
- 输出：A1-owned `WarmControls` wrapper：Button、IconButton、ProjectSelect、FilterControl、SortControl、Badge、Input。
- 验收：default/hover/focus/active/disabled/loading，触控 44px。
- 依赖：B0。A2–A5 只消费此 wrapper，不各自实现副本。

## B3 数据展示

- Owner：A2。
- 输出：MetricCard、MetricStrip、Delta、DiagnosticItem、ProgressBar、Empty/Error/Skeleton。
- 验收：零值、负值、缺比较值、超长金额、骨架同构。
- 依赖：B0、A1 的 WarmControls 契约；保留 `DiagnosticStrip`。

## B4 图表

- Owner：A3。
- 输出：ChartPanel、SalesTrend、Legend、Axis、Tooltip、ChartSummary。
- 验收：无数据、单点、极端值、移动端、图例换行、无障碍摘要。
- 依赖：B0、B3；控件只消费 A1 的 WarmControls。

## B5 表格与排行

- Owner：A4。
- 输出：LedgerTable、NumericCell、DeltaCell、ProjectRankRow、DailyLedgerTable。
- 验收：排序、长项目名、横向滚动、focus、空/错/加载行。
- 依赖：B0、B3；保留项目排序，日表 Pending 标“待处理（日快照）”；控件只消费 A1 的 WarmControls。

## B6 订单流

- Owner：A5。
- 输出：OrderFlowCard、ProjectOrderGroup、PendingOrderItem、LiveEventRow、mobile Sheet。
- 验收：默认收起、展开/折叠、count/list loading、零值、empty/error、重试、长 Order ID/SKU。
- 依赖：B0、A1 WarmControls、B3/B5 props 契约；headline 与 KPI 使用相同 count/list API 筛选，per-project totals 等 G0 确认。

## B7 集成与 QA

- Owner：A6。
- 输出：`integration/assembly.html`、`qa.md`、组件 registry 更新。
- 验收：1440/1024/768/390/320；keyboard；reduced motion；状态覆盖。
- 依赖：B0–B6；A6 定义共享跨组件 props types 并负责页面数据接线。

## 并行边界

```text
B0
A1: B1 Shell + B2 Warm controls wrapper
├── A2 / B3 Metrics
├── A3 / B4 Chart
├── A4 / B5 Tables
└── A5 / B6 Order flow
    (consume A1 WarmControls; shared props types from A6)
A6 / B7 integration, shared props types, data wiring and QA (last)
```

B1/B2 归 A1；A2–A5 可并行消费固定的 B0 props / visual contracts 与 A1 WarmControls wrapper，不得创建平行控件。A1 owns token consumption；A6 owns shared props types。A2–A5 不得修改任何 `components/foundations/` 文件。B7 由 A6 写 integration、共享类型与接线。
