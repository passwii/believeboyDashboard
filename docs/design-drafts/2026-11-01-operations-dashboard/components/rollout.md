# Warm Ledger 推广路线

> 状态：G0 已完成。生产直接使用 Warm Ledger，无 feature flag。
>
> 范围：先 `/dashboard`，再按业务类目逐页推广。
>
> 原则：页面先行，组件后置晋升；V3 Terminal 继续服务其他路由。

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
| D0 | Dashboard 基准 | `/dashboard` | **已完成（2026-11-01）**：数据层拆分、Warm shell、真实 API、响应式与交互门禁通过 |
| C1 | 运营分析 | `daily-analysis`、`portfolio-overview`、`inventory-analysis` | D0 全部门禁通过 |
| C2 | 运营执行 / 库存 | `inventory-ledger`、`shipping-plan`、`shipment-management`、`sku-info` | C1 至少两页证明可复用 |
| C3 | 报表 / 订单 | `order-info`、`product-analysis`、`monthly-report` | 表格与导出契约稳定 |
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

## 7. GPT Luna Agent Team

所有实现与审阅 Agent 统一使用 `believeboy/GPT-6-Luna` + `max` reasoning。

不按任务难度降档，A0–A7 与 R1 全部采用 max think。

| Agent | 推理档 | 写作用域 | 交付 |
| --- | --- | --- | --- |
| A0 设计系统 | max | `components/` 设计文档、Warm token 契约 | foundations、状态矩阵、目录冻结 |
| A1 Shell | max | 新增 Warm shell/sidebar/topbar 与 Warm controls wrapper 文件 | 外壳、导航、focus trap、共享控件、token 使用 |
| A2 指标 | max | 新增 metric/diagnostic 文件 | MetricStrip、DiagnosticStrip；只消费 A1 controls |
| A3 图表 | max | 新增 sales-trend 文件 | 曲线、图例、轴、摘要；只消费 A1 controls |
| A4 表格 | max | 新增 rank/daily-ledger 文件 | 排行、日明细；只消费 A1 controls |
| A5 订单流 | max | 新增 order-flow wrapper | 订单展开、移动 Sheet；默认收起，只消费 A1 controls |
| A6 集成 | max | `app/dashboard/page.tsx`、必要 layout 与 integration contracts | 共享 props types、数据接线、整页 QA |
| A7 类目试点 | max | 仅分配的单页面目录 | C1 页面试点 |
| R1 审阅 | max | 只读 | 规范、代码、视觉、a11y review |

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
