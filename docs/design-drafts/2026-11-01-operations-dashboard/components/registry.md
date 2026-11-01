# 组件 Registry

| 层级 | 组件 | 当前范围 | Owner / 消费边界 |
| --- | --- | --- | --- |
| Foundation | Warm Ledger tokens / type / focus / motion | `/dashboard` 的冻结 B0 输入 | A1 owns token consumption；A1–A5 只读 `components/foundations/*`，不改 token 值 |
| Shell | WarmLedgerShell / Sidebar / Topbar | Dashboard-local | A1 owns shell、scope、响应式与 drawer focus |
| Navigation | NavItem / WorkspaceScope / MobileNavDrawer | Dashboard-local | A1 owns；使用真实路由数据，不重写 `sidebar-config` |
| Control | WarmControls wrapper、Button、IconButton、ProjectSelect、SortControl、Badge、Input | Dashboard-local | A1 owns implementation and shared wrapper；A2–A5 consume, no duplicates |
| Data | MetricCard / MetricStrip / Delta / DiagnosticStrip | Dashboard-local | A2 owns presentation; 保留 DiagnosticStrip；只消费 scoped props 与 A1 controls |
| Chart | ChartPanel / SalesTrend / Legend / ChartSummary | Dashboard-local | A3 owns chart presentation; 不接管 page fetching |
| Table | LedgerTable / NumericCell / DeltaCell / ProjectRankRow / DailyLedgerTable | Dashboard-local | A4 owns; 保留项目排序；日表 Pending 明确为“日快照” |
| Order | OrderFlowCard / ProjectOrderGroup / PendingOrderItem / LiveEventRow | Dashboard-local business composite | A5 owns; groups default collapsed; headline follows shared count/list contract |
| Feedback | EmptyState / ErrorState / Skeleton / RefreshFeedback | Dashboard-local usage | A2–A5 compose their required states and consume A1 controls |
| Overlay | MobileScrim / FocusTrap / order Sheet | Dashboard-local usage | A1 owns nav drawer; A5 owns order Sheet composition; do not change shared defaults |
| Shared props | Cross-component props types and data contracts | Dashboard integration boundary | A6 owns definitions and data wiring; A1–A5 consume |

## 不组件化

- `dashboard/page.tsx` 的取数、筛选和刷新编排。
- `V2Stats` 的业务聚合公式。
- `V2OrderFlowPanel` 的 Pending 轮询规则。
- 一次性 Panel note、图例短线、分隔符和文本堆叠。
- 为四个 diagnostic 各自创建组件；统一使用 `DiagnosticItem` 数据驱动。
- A2–A5 各自实现 Button、IconButton、ProjectSelect、FilterControl、SortControl、Badge 或 Input。
- 在 A1–A5 的实现目录复制共享跨组件 props types；这些类型由 A6 维护。
- 从 daily snapshot 或部分订单列表推导项目 Pending 数量 / 占比；per-project API 等 G0 确认。

所有首批组件留在 Dashboard-local 实现区域。只有第二个真实页面已使用相同视觉、状态和接口契约，并移除路由 / 业务依赖后，才提交组件晋升评审；计划中的页面不算第二个消费者。
