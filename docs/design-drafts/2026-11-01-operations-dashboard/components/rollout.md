# Warm Ledger 推广路线

> 状态：G0 已完成。生产直接使用 Warm Ledger，无 feature flag。
>
> 范围：先 `/dashboard`，再按业务类目逐页推广。
>
> 原则：页面先行，组件后置晋升；V4 Warm Ledger 是现行设计，V3 Terminal 仅继续服务未迁移路由。

## V4 current baseline (2026-11-04)

- V4 Warm Ledger replaces V3 Terminal as the current design authority. New migration work must follow `frontend/docs/design-spec.md` §0.4 and `components/foundations/spec.md`.
- V4 operations and business page migration is desktop-only. Do not add phone/tablet or multi-breakpoint page adaptation, and do not validate phone viewports in migration acceptance.
- The floating window uses equal 8px outer gutters on all four sides, fills the remaining desktop viewport, and retains its rounded shape.
- Page-specific UI remains local. Promote a Warm component only after a second real page has the same visual, state, and interaction contract.

## C1 Warm scope extension (2026-11-01)

The original G0 freeze scoped the first release to `/dashboard`. Damon has now approved reusing the unchanged Warm Ledger contract on these exact C1 paths, with no feature flag:

- `/dashboard/operations/daily-analysis`
- `/dashboard/operations/portfolio-overview`
- `/dashboard/operations/inventory-analysis`

Only these route roots receive the Warm shell. All other dashboard routes continue to use `TerminalShell`. The route frame preserves `TerminalGlobalFilterProvider`, `TerminalHeaderSlotProvider`, page header slots, refresh, mobile filter strips, search, notifications, and profile navigation. Date meaning remains page-owned: the homepage uses its seven-day PT operational window; Daily Analysis uses the selected marketplace calendar; Portfolio keeps its date picker's existing “近7天” preset as explicit filter state and uses the selected marketplace timezone; Inventory uses the chosen snapshot date. Token values, `--term-*`, and shared UI defaults remain unchanged.

## 1. 推荐结论

先构建 `/dashboard` 是正确的。

Damon 已确认整页方向、保留 `DiagnosticStrip` 与项目排序、订单组默认收起、首版深色-only；导航入口、直接发布和精确 `/dashboard` shell exception 也已确认。

但首页不能直接套一层新 CSS 就替换 `TerminalShell`。当前首页依赖：

- `useHeaderSlot`
- `useHeaderRefresh`
- `useMobileFilterStrip`
- `TerminalShell` 提供的 header-slot context

如果直接旁路 `TerminalShell`，这些 hook 会失去 Provider，项目筛选、刷新和移动筛选会失效。

因此第一阶段必须先拆出首页自己的数据层，再做 Warm Ledger shell。

## 2. 首站架构

### Shell 切换

推荐在 `frontend/app/dashboard/layout.tsx` 做精确路径分支：

```tsx
const isWarmLedgerHome = pathname === '/dashboard'

return (
  <ServerNotificationsProvider>
    {isWarmLedgerHome ? (
      <WarmLedgerShell>{children}</WarmLedgerShell>
    ) : (
      <TerminalShell>{children}</TerminalShell>
    )}
  </ServerNotificationsProvider>
)
```

约束：

- 只切换精确 `/dashboard`，不扩大到 `/dashboard/*`。
- 保留现有认证、登出、标题和通知 Provider。
- Warm shell 必须保留 `#main-content` 与 `#main-navigation`。
- 不修改 `TerminalShell` 默认结构或全局 `--term-*` token。
- 不通过 CSS 隐藏 TerminalShell；旧 shell 的副作用必须真正不挂载。

### 首页数据层

从 `frontend/app/dashboard/page.tsx` 提取：

```ts
useDashboardHomeData({
  projectId,
  dateRange,
})
```

职责：

- `/api/v1/daily-analysis/all` 当前与上一周期请求。
- 项目 breakdown。
- 跨国家数据。
- 刷新。
- 加载、错误、空状态。
- 保留现有并发保护和 latest-request 防竞态。

不包含：

- 页面 JSX。
- Terminal header portal。
- route metadata。
- 视觉格式化。

### Pending 口径

现有实现有两个字段来源：

- `summary_rows[].pending_order_qty`
- 订单流 count/list API

统一口径：

- KPI“待处理订单”和 OrderFlow headline 使用同一个 count/list API family，并传入完全相同的项目筛选和 7 天 PT 日期范围；count total 与展开列表的 `total` 必须一致。
- `summary_rows[].pending_order_qty` 只作为逐日快照，日表列标成“待处理（日快照）”，不得求和、回填 KPI 或伪装成 live Pending。
- 首版不展示项目级 Pending count / share；只展示 KPI 与订单流共用的 Pending 总数。完整 per-project API 就绪后再补。

### 日期窗口

当前首页请求为 7 天。

首版统一使用 7 天标题，不为了匹配旧的“近 14 天明细”而扩大请求。是否改 14 天另开数据口径任务。

### 导航入口

当前“数据流总览”指向 `/dashboard/agent-center/overview`。

已确认：

- 新增“运营总览” → `/dashboard`。
- 保留“数据流总览” → `/dashboard/agent-center/overview`。
- QuickLinks 使用销售数据、订单信息、库存分析、客户消息。

## 3. 发布方式

### 发布

Damon 已确认生产直接使用新设计，不设 feature flag：

1. `/dashboard` 与 shell exception 同批上线。
2. 不保留运行时双 UI 分支。
3. 回滚使用正常代码回滚。
4. 后续页面仍逐页迁移、逐页验收。

## 4. 组件晋升规则

只有 Dashboard 一个真实使用方时：

- 放在 `frontend/components/dashboard-v2/`。
- 不建立全局 Button/Table/Chart 抽象。

第二个真实页面使用同一交互契约时：

- 先确认两个调用契约一致。
- 再晋升到 `frontend/components/warm-ledger/`。
- 晋升 PR 必须列出两个调用方和测试。

不满足以下任一条件就不晋升：

- 两个真实页面已排期或已实现。
- 视觉、状态和交互契约一致。
- API 不含页面路由、接口请求或业务聚合公式。
- 不会迫使 V3 Terminal 采用 Warm Ledger。

## 5. Dashboard 首批组件与 Owner

| 组件 / 契约 | Owner | 消费或复用约束 |
| --- | --- | --- |
| `WarmLedgerShell` / `DashboardSidebar` / `DashboardTopbar` | A1 | 导航数据来自 `sidebar-config.ts`；精确 `/dashboard` shell exception 已批准 |
| Warm controls wrapper（Button、IconButton、ProjectSelect、FilterControl、SortControl、Badge、Input） | A1 | A2–A5 只消费 A1 wrapper，不各自实现控件 |
| `--warm-ledger-*` tokens 的 Dashboard 使用 | A1 | foundations 文件是冻结输入；A1–A5 只读，不改值 |
| 跨组件共享 props types | A6 | 由 A6 定义并接入；A1–A5 不复制共享类型 |
| `MetricStrip` / `MetricCard` / `DiagnosticStrip` | A2 | 沿用 `computeStats()` 语义；保留 DiagnosticStrip |
| `SalesTrendPanel` | A3 | 当前 / 对比 `summary_rows` |
| `ProjectRankTable` / `DailyLedgerTable` | A4 | `computeTopProjects()` / `DailyAnalysisRow`；保留排序；Pending 标成日快照 |
| `OrderFlowCard` | A5 | count/list + live stream；默认收起；项目级数量待 API 确认 |

首批控件只存在于 A1-owned 的 Dashboard Warm controls wrapper，不晋升为全局组件：

- 万能 LedgerTable。
- Chart Panel/ Axis / Tooltip。
- 页面级 Panel note、分隔线、标签堆叠。

## 6. 类目推进顺序

| 批次 | 类目 | 代表页面 | 进入条件 |
| --- | --- | --- | --- |
| D0 | Dashboard 基准 | `/dashboard` | **已完成（2026-11-01）**：数据层拆分、Warm shell、真实 API 与交互门禁通过；2026-11-04 起按 V4 desktop geometry 维护 |
| C1 | 运营分析 | `daily-analysis`、`portfolio-overview`、`inventory-analysis` | 已完成（2026-11-02；最终 Luna max review PASS） |
| C2 | 运营执行 / 库存 | `inventory-ledger`、`shipping-plan`、`shipment-management`、`sku-info` | **已完成（2026-11-04）**：27 Vitest files / 199 tests、build、focused ESLint、78/78 Playwright、最终独立 review PASS；授权/技术 follow-ups 保留 |
| C3 | 报表 / 订单 | `order-info`、`product-analysis`、`monthly-report/display` | 表格与导出契约稳定后开始；本 C2 closeout 不进入 C3 |
| C4 | 广告 | `ad-analysis/overview`、`ad-data` | 图表 / 筛选契约已验证 |
| C5 | 财务 | `platform-revenue`、`exchange-rate`、`commission-management` | 账期、币种、汇总口径明确 |
| C6 | CRM | `crm/dashboard`、`customers`、`follow-ups`、`tasks` | 页面壳稳定；CRM 状态不并入订单状态 |
| C7 | AI / 工具 / 系统 | `ai/*`、`tools/*`、`system/*` | 前面批次稳定；权限与操作安全单独评审 |

首批 8 页：

1. `/dashboard`
2. `/dashboard/operations/daily-analysis`
3. `/dashboard/reports/order-info`
4. `/dashboard/operations/portfolio-overview`
5. `/dashboard/advertising/ad-analysis/overview`
6. `/dashboard/operations/inventory-analysis`
7. `/dashboard/reports/product-analysis`
8. `/dashboard/reports/monthly-report/display`

## 7. DeepSeek Max Agent Team

自 2026-11-04 起，新任务的实现 Agent 与最终审阅 Agent 统一使用 `believeboy/DeepSeek-V4.1-Flash` + `max` reasoning。Luna 不再用于后续 V4 任务；历史批次记录中的 Luna review 保留原事实。

不按任务难度降档，A0–A7 与 R1 全部采用 max think。R1 必须是独立只读审阅，不能复用实现 Agent 的会话判断。

| Agent | 模型 / 推理档 | 写作用域 | 交付 |
| --- | --- | --- | --- |
| A0 设计系统 | DeepSeek / max | `components/` 设计文档、Warm token 契约 | foundations、状态矩阵、目录冻结 |
| A1 Shell | DeepSeek / max | 新增 Warm shell/sidebar/topbar 与 Warm controls wrapper 文件 | 外壳、导航、focus trap、共享控件、token 使用 |
| A2 指标 | DeepSeek / max | 新增 metric/diagnostic 文件 | MetricStrip、DiagnosticStrip；只消费 A1 controls |
| A3 图表 | DeepSeek / max | 新增 sales-trend 文件 | 曲线、图例、轴、摘要；只消费 A1 controls |
| A4 表格 | DeepSeek / max | 新增 rank/daily-ledger 文件 | 排行、日明细；只消费 A1 controls |
| A5 订单流 | DeepSeek / max | 新增 order-flow wrapper | 订单展开、移动 Sheet；默认收起，只消费 A1 controls |
| A6 集成 | DeepSeek / max | `app/dashboard/page.tsx`、必要 layout 与 integration contracts | 共享 props types、数据接线、整页 QA |
| A7 类目试点 | DeepSeek / max | 仅分配的单页面目录 | C1 页面试点 |
| R1 审阅 | DeepSeek / max | 只读 | 规范、代码、视觉、a11y review |

### 并行边界

```text
A0 冻结
├── A1
├── A2
├── A3
├── A4
└── A5
       ↓
      A6
       ↓
 R1 / D0 merge
       ↓
 A7 C1 → C2 → C3 ...
```

A1 owns Warm controls wrapper and Dashboard token consumption. A2–A5 may work in parallel against that shared contract, but only consume the A1 wrapper and never implement controls of their own. A6 owns shared cross-component props types and integration. A1–A5 must treat all four `components/foundations/` files as read-only.

冻结只读：

- `frontend/components/ui/button.tsx`
- `frontend/components/ui/select.tsx`
- `frontend/components/ui/table.tsx`
- `frontend/components/terminal/*`
- `frontend/lib/sidebar-config.ts`
- 全局 theme/token

## 8. Merge Gates

| Gate | 条件 |
| --- | --- |
| G0 契约冻结 | 已完成：Pending 同口径、7 天 PT、导航共存、无 flag、项目级 Pending 暂不展示、精确 `/dashboard` shell exception |
| G1 组件门 | 类型、loading/empty/error、长内容、键盘状态通过 |
| G2 Dashboard 门 | 真实 API；项目筛选联动；订单流 / 排序 / 刷新正常；断点与 a11y 全部通过 |
| G3 晋升门 | 第二个真实消费者出现，契约一致，测试归属明确 |
| G4 类目门 | 单页业务交互和口径通过后才扩下一页 |

## 9. 每页推广验收

- 真实数据，无硬编码业务值。
- 项目 / 日期 / 站点筛选口径与旧页一致。
- Loading / Empty / Error 可区分。
- 1440、1280×600、1024、821、820、460、390、320。
- 无页面级横向溢出。
- 键盘 focus、Esc、焦点恢复。
- 颜色不是唯一语义。
- reduced motion 生效。
- T1/T2/T3 按仓库测试规则执行。
- 回滚使用正常代码回滚，不维护双 UI flag。

## 10. 不要做

- 不要先抽全局组件再找使用方。
- 不要把 Warm Ledger token 写进 `--term-*`。
- 不要直接修改 `TerminalShell`、`ui/button.tsx` 或 `ui/table.tsx` 的默认样式。
- 不要让多个 Agent 同时改 `page.tsx`、layout、theme 或 sidebar config。
- 不要用 CSS 隐藏旧 shell 来冒充切换。
- 不要把日快照当成 Pending KPI 或订单流 headline，也不要在 per-project Pending API 未确认前展示项目总数 / 占比。
- 不要让 A2–A5 各自实现 Warm controls，也不要让 A1–A5 修改 foundations 文件或复制共享 props types。
- 不要为了视觉一致抹平不同业务页面的数据口径。

## 11. C1 implementation QA (2026-11-02; final review PASS)

- Warm route frame is limited to `/dashboard/operations/daily-analysis`, `/dashboard/operations/portfolio-overview`, and `/dashboard/operations/inventory-analysis`; other dashboard routes retain `TerminalShell`.
- Portfolio keeps the existing date picker's `近7天` selection as explicit filter state. The initial US range uses the US marketplace calendar; the date control uses the selected marketplace timezone. This is distinct from the homepage's explicitly labeled PT operational window. Inventory remains snapshot-date based.
- Portfolio detail navigation now carries the selected project, site, and date range in page/global query state and seeds the global context/local storage before SPA navigation. Daily Analysis waits for global-filter hydration and page-state alignment before loading scope-dependent data; goal progress also uses the resolved global project/site while that sync completes.
- Daily Analysis fallback filters are hidden at `xl` while the global project/country/date controls are active; the page-local SKU control remains available. The global project selector can be used when its initial value is empty, including when the page-local project request fails.
- Inventory's empty/loading/error project states are visible, project-list retry is actionable, the snapshot-options request follows the selector's actual open/close events, and unrelated URL filter changes do not refetch the project list.
- Responsive breakpoint record: the compact Warm topbar and 44px touch targets apply through 820px; Daily Analysis uses its fallback filter controls from 768px up to `xl`, and the shared mobile filter strip appears below 768px. Browser inspection confirmed fallback controls at 820px and the mobile strip at 767px, with no page-level horizontal overflow; the 820px capture is `assets/daily-analysis-production-820.png`.
- Browser inspection used isolated API fixtures at 1440, 1280, 1279, 1024, 821, 820, 390, and 320px for Daily Analysis, and 1440, 390, and 320px for Portfolio and Inventory. No page-level horizontal overflow was observed; tables keep their own horizontal scroll containers.
- Interactions inspected: snapshot selector Escape close; project-list 503 error and retry control; Portfolio project selection, sorting, trend/contribution tabs, and detail navigation while the stored global project/site/date differed from Portfolio's active scope. The destination URL and Daily Analysis requests used the Portfolio project/site/date. A direct Daily Analysis URL with page site US and global site DE sent only DE requests after synchronization; no pre-sync US request was observed. Also checked global/fallback filter handoff and long SKU/product-name option wrapping.
- Updated browser captures are in `assets/` with `*-production-*` names. The browser used mock API responses; the 503 was an intentional error-state fixture. Local Vercel Analytics/Speed Insights returned 404, with no uncaught page errors.
- `pnpm lint`: 0 errors, 17 warnings in unchanged files. `pnpm build` and `git diff --check` passed. Tests were not run under this batch's approved validation rule.
- The post-fix Luna max review returned PASS with no blocking findings. It was a source-only review; the browser and build evidence above were captured separately. C1's exit gate is closed and C2 inventory/fulfillment planning may proceed.

## 12. C2 kickoff (2026-11-02)

- The C2 page contracts are recorded in `components/c2-page-contracts.md`, and the task sequence is in `docs/superpowers/plans/2026-11-02-warm-ledger-c2/2026-11-02-warm-ledger-c2.md`.
- C2 exact routes are `inventory-ledger`, `shipping-plan`, `shipment-management`, and `sku-info`. The shell/sidebar work must expose those pages without a feature flag and keep all other routes on `TerminalShell`.
- Task 1 exact-route/title/sidebar integration is complete and passed an independent Luna max review; focused ESLint and `git diff --check` passed.
- Task 2 Inventory Ledger is implemented and passed the final Luna max R1 review. It preserves full-month export semantics, URL keys, formulas, filter scopes, and 50-row paging. It also keeps scope-matched data visible after same-scope refresh failures, hides prior-scope rows/options during project/month changes, and maps supported month aliases to the canonical response month for display.
- Inventory Ledger validation: directory ESLint, `git diff --check`, and CodeGraph sync passed. A 320px browser screenshot verified the daily event summary table and contained detail view; the Summary tab's table containment was verified from its local scroll CSS. No tests/build/browser matrix was run in this page task; those are deferred to Task 6 integration.
- Task 3 Shipping Plan passed the fifth-round independent Luna max R1. Task 4 Shipment Management also passed final independent source-only Luna max R1 after several remediation rounds. Both preserve their API and write contracts; Task 4 includes keyboard-accessible imports, focus-returning dialogs, portal-scoped Warm overlays, accessible batch hiding/clearing, and protected date selection. Tests/build/browser evidence and all six viewport/interaction checks remain in Task 6. C2 Task 5 SKU Info may begin.
- Page contracts preserve each route's URL filters, dates, APIs, formula/supply scopes, write actions, import/export behavior, and error states. New page panels, tables, and dialogs stay page-local until a second consumer proves the same interaction contract.
- Security follow-up: source-verified SKU Info project-name search and record-ID write scope gaps, plus Shipment Management write routes without operator project checks, are documented in [`2026-11-02-warm-ledger-c2-security-follow-up.md`](../../../superpowers/plans/2026-11-02-warm-ledger-c2-security-follow-up.md). C2 is a UI migration and does not claim or implement backend authorization fixes.

## 13. C2 stage checkpoint (2026-11-03)

- C2 Tasks 1–5 completed their implementation and independent Luna max source-review gates: exact route/navigation frame, Inventory Ledger, Shipping Plan, Shipment Management, and SKU Info. Task 5's final focused re-review passed after fixing the member-search focus ring and preserving selected review-group IDs absent from current candidate results.
- **Task 6 complete.** Focused Vitest coverage for the four C2 routes and affected helpers: 27 files / 199 tests passed (`--maxWorkers=4`). Changed-file ESLint, `pnpm.cmd build`, `git diff --check`, mock-stability check, and CodeGraph sync passed. The final independent Luna max integration review returned PASS with no remaining P2 findings. Build emitted Next workspace-root/NFT and stale Browserslist warnings but exited successfully.
- The self-contained Playwright matrix passed 78/78 across Chromium and mobile projects for the four exact C2 routes at 1440, 1024, 820, 767, 390, and 320px. Page-level horizontal overflow was absent, wide tables scrolled inside their own containers, and the 44px touch targets passed. Browser workflows covered inventory dimension filtering/full-month Excel export/month retry, Shipping Plan growth-factor PUT plus one scoped forecast refresh, Shipment Management cost writeback/export/dialog focus, SKU query/export/record-ID PATCH, and FactoryInfo/ImageLightbox keyboard focus return. Backend traffic and declared writes were intercepted by `page.route`; no request reached a real backend. The Inventory Ledger Batches tab is read-only history in this route (no file input/upload handler); its browser check confirms the archived record, and the existing page unit test covers the tab content.
- Task 6 also repaired two confirmed behavior gaps: saving a Shipping Plan growth factor now triggers a fresh forecast request for the same scope/SKU, and stale Shipment Management list responses can no longer overwrite the latest filter's rows, paging, error, or loading state. Both have regression coverage.
- SKU Info and Shipment Management project-scope authorization findings remain open in the security follow-up. C2 UI work does not establish backend project isolation. SKU pagination/10,000-row behavior, label ZIP response headers, and R2 image replacement order remain separate technical follow-ups.
- Promote a page-local component only after a second real route demonstrates the same behavior and accessibility contract. Keep unproven controls and layouts local during the next category audits.
- **Next stage after this C2 closeout:** C3 orders and reports (`order-info`, `product-analysis`, `monthly-report/display`). Run/extend the documented contract audits, confirm product/security scope, then implement only after a separate kickoff.
- Stage handoff and detailed Task 6 closeout are recorded in [`2026-11-03-warm-ledger-c2-stage-checkpoint.md`](../../../superpowers/plans/2026-11-02-warm-ledger-c2/2026-11-03-warm-ledger-c2-stage-checkpoint.md).
