# Dashboard Head 刷新与页面加载基线（Stage 1）

> 快照日期：2026-10-10；Stage 2 增量更新：2026-10-10；Stage 3 骨架核查：2026-10-17。本文记录静态证据、自动化结果与运行时验证边界，不把静态或测试结果当作浏览器验收。路由清单按 `frontend/app/dashboard/**/page.tsx` 静态盘点；本快照涵盖 90 条既有 Dashboard 路由。2026-10-17 静态扫描发现另有 2 条 CRM 客户方案路由，清单待补列（见 Stage 3 发现）。

## 结论摘要

- Head 刷新按钮在 `TerminalHeader` 中常驻。当前路由注册了 `useHeaderRefresh` 时调用页面 callback；否则调用 `router.refresh()`。按钮/图标存在不等于页面数据已经刷新。
- Stage 1 静态导入链检查发现 **28 个页面路由注册了 callback**。Stage 2 已为 CRM 任务页增加页面 callback 与回归用例；其余 50 条 Stage 1 标记路由本阶段逐条复核来源和交互，按下方「Stage 2 增量盘点」记录刷新候选或仍待后续处理。对上传、编辑器、静态内容等页面不机械增加形式 callback。
- 对未注册 callback 的 client-only 页面，点击当前仅能确认走 RSC `router.refresh()` 兜底；该操作**不能作为客户端 `useEffect` / 本地请求必定重新执行的证据**。本阶段静态盘点出 23 条 client 数据加载路由尚无明确 Head callback，需继续修复。
- 当前扫描到的 Dashboard 页面都能沿路由树找到最近的 `loading.tsx`（根 Dashboard loading 作为继承兜底）。这只证明静态边界存在；**不证明导航时一定显示、骨架与页面结构匹配，也不证明页面内 callback 刷新会触发该 loading 边界**。
- Stage 3 复核确认：CRM 任务、CRM dashboard、库存分类账、项目启动台/模板编辑、站点导航、发货规划、补货、巡检、项目目标、客诉列表、船期管理、SKU 管理、月报生成、Agent 员工/活动矩阵及 AI 洞察的旧骨架有可从页面结构静态确认的错配；已提供专用骨架或更近边界。其余未专门调整的 Operations 路由仍共享分析骨架，本轮不宣称视觉匹配通过。所有慢导航显示、响应式间距与边界触发仍需浏览器观察。

## 证据等级与检查口径

- **S（静态证据）**：检查 `page.tsx`、静态 import 链、`useHeaderRefresh` 调用及最近的 `loading.tsx`。表中 `C` = 客户端页面/请求；`H` = 服务端入口或客户端 layout 与客户端内容/请求混合；`RSC` = 页面可见内容主要由服务端/静态输出提供；`重定向` = alias，不是数据页面。对 scheduled-reports 3 个子 URL，数据 owner 是父级 client layout，因此标为 H。
- **A（自动化）**：本阶段未执行 Vitest / Playwright，也未据已有测试文件宣称行为通过。代码中已有的测试只代表测试资产存在，不能作为本阶段的运行结果。
- **B（浏览器）**：本阶段未做浏览器实测。表中 `B-nav` 是待执行的慢请求导航观察（是否出现 boundary、骨架轮廓/布局/响应式是否贴合）；`B-refresh` 是待执行的 Head 点击观察（请求、数据变化、筛选保留、反馈及错误恢复）。对于重定向使用 `B-redirect`；静态/只读页面使用 `B-readonly` 验证实际行为和刷新是否具有可感知意义。
- 页面的 `loading.tsx` 是路由级加载边界；页面内部的数据 callback 往往自行维护 `loading`。路由级骨架不得被写成 callback 刷新时已经展示。
- “刷新完成”须由真实数据请求/服务端 payload 完成确定，不以按钮点击、`router.refresh()` 调用或 spinner 消失单独证明。无服务端/客户端数据的静态页应记录为静态刷新或不适用，而不能声称数据重取成功。

## Dashboard 路由清单

> Stage 1 表格保留 90 条既有路由基线。Stage 3 从当前 App Router 另行发现 `/dashboard/crm/proposals` 与 `/dashboard/crm/proposals/[id]` 两条新路由；两者数据来源均为 C（客户端请求），建议后续清单合并时单列。列表页注册 Head refresh callback，初载最近边界为 `crm/proposals/loading.tsx`（列表筛选 + 7 列表格骨架）；详情页已注册 `useHeaderRefresh(() => refreshRef.current(), { loading })`，仅重取 `detail`、不触碰编辑表单草稿，初载最近边界为 `crm/proposals/[id]/loading.tsx`（宽预览 + 窄版时间线骨架）。

| 路由 | 数据来源（S） | Head 刷新路径（S） | 最近 loading boundary → 骨架 | 每路由验证方式 / 静态备注 |
| --- | --- | --- | --- | --- |
| `/dashboard/advertising/ad-analysis` | 重定向 | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/advertising/ad-analysis/budget` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/campaigns` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/overview` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/placements` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/products` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/purchased-products` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/search-terms` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/targets` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/time-trend` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-analysis/traffic-quality` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/ad-analysis/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/advertising/ad-data` | H（服务端入口 + 客户端子树） | router.refresh fallback | `advertising/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失待 Stage 2 明确契约 |
| `/dashboard/agent-center/employees` | H（服务端入口 + 客户端子树） | callback：`employees-client.tsx` | `agent-center/employees/loading.tsx` → `AgentTablePageLoading(8 列)` | S；按员工表真实列数建表格骨架；B-nav + B-refresh 未验证 |
| `/dashboard/agent-center/overview` | H（服务端入口 + 客户端子树） | callback：`agent-overview-client.tsx` | `agent-center/overview/loading.tsx` → `AgentTablePageLoading(11 列)` | S；按业务域活动矩阵真实列数建超宽表骨架；B-nav + B-refresh 未验证 |
| `/dashboard/ai` | C（客户端页面/请求） | callback：`AIChatWindow` 重取会话列表、当前会话消息与 AI 配置；发送流中不触发刷新 | `ai/loading.tsx` → `SimplePageLoading` | S + A：共享 AIChatWindow callback；B-nav + B-refresh 未验证 |
| `/dashboard/ai/ad-analysis` | C（客户端页面/请求） | callback：按当前 History/Schedule Tab 刷新其真实数据 owner | `ai/loading.tsx` → `SimplePageLoading` | S + A：活动 Tab owner 已接线；B-nav + B-refresh 未验证 |
| `/dashboard/ai/chat` | C（客户端页面/请求） | callback：共享 `AIChatWindow` 重取会话列表、当前会话消息与 AI 配置；发送流中不触发刷新 | `ai/chat/loading.tsx` → `ChatPageLoading` | S + A：回归覆盖会话/消息请求与失败保留；B-nav + B-refresh 未验证 |
| `/dashboard/ai/believeboy-models` | H（服务端入口 + 客户端子树） | router.refresh fallback（RSC 重读文件） | `ai/loading.tsx` → `SimplePageLoading` | S；B-nav + B-readonly；只读文件刷新行为待确认，Simple 与文档布局待核对 |
| `/dashboard/ai/customer-service` | C（客户端页面/请求） | callback：强刷场景配置并保留有效选中场景与 sessionStorage 草稿 | `ai/loading.tsx` → `SimplePageLoading` | S + A：场景更新/失败反馈回归；B-nav + B-refresh 未验证 |
| `/dashboard/ai/digital-employees` | C（客户端页面/请求） | callback：`ai/digital-employees/page.tsx`，调用列表 hook `mutate()` | `ai/digital-employees/loading.tsx` → `SimplePageLoading` | S；Head callback 复用已有强刷；B-nav + B-refresh 未验证，列表/卡片骨架待核对 |
| `/dashboard/ai/digital-employees/office` | C（SSE 实时流） | callback：重连 SSE 并在首个 snapshot 到达时完成刷新，不重置展示模式/时钟 | `ai/digital-employees/loading.tsx` → `SimplePageLoading` | S；浏览器验证 SSE snapshot 与 callback 反馈未执行 |
| `/dashboard/ai/digital-employees/[id]` | C（客户端页面/请求） | callback：详情页 `load()` 重取员工及任务，15 秒轮询保留 | `ai/digital-employees/loading.tsx` → `SimplePageLoading` | S；刷新保留旧详情；B-nav + B-refresh 未验证，详情结构与 Simple 骨架待核对 |
| `/dashboard/ai/insights` | C（客户端页面/请求） | callback：`ai/insights/page.tsx`，按当前项目重取洞察列表 | `ai/insights/loading.tsx` → 洞察工作区/筛选 + 6 列列表骨架 | S；按页面列表主结构修正分析骨架错配；B-nav + B-refresh 未验证 |
| `/dashboard/ai/inventory-health` | C（客户端页面/请求） | callback：`ai/inventory-health/page.tsx`，强刷项目选项列表，不重置已提交的分析 run | `ai/loading.tsx` → `SimplePageLoading` | S；Head 刷新仅重取读模型，保留当前口径与生成状态；B-nav + B-refresh 未验证；骨架待核对 |
| `/dashboard/change-password` | C（本地表单；提交时才请求） | 不适用：Head refresh 不重置/重提密码表单，保留未提交输入；无独立读模型 | `change-password/loading.tsx` → `SimplePageLoading` | S；无 client 数据 loader；导航 skeleton B-nav 待验证 |
| `/dashboard/crm` | 重定向 | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/crm/audit` | C（客户端页面/请求） | callback：`crm/audit/page.tsx` | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；Table 骨架待与实际筛选/表格比对 |
| `/dashboard/crm/customers` | C（客户端页面/请求） | callback：`CrmCustomerTable` → `CrmTable/useCrmTable.refresh` | `crm/loading.tsx` → `TablePageLoading` | S + A：客户数据 owner 桥接；B-nav + B-refresh 未验证 |
| `/dashboard/crm/dashboard` | C（客户端页面/请求） | callback：`crm/dashboard/page.tsx` | `crm/dashboard/loading.tsx` → `CrmDashboardPageLoading` | S；新近边界与 KPI/漏斗/负责人业绩/生命周期骨架按页面结构实现；B-nav 未验证 |
| `/dashboard/crm/follow-ups` | C（客户端页面/请求） | callback：`CrmFollowUpList`，重取当前 scope 跟进分组 | `crm/loading.tsx` → `TablePageLoading` | S + A：数据 owner 桥接；B-nav + B-refresh 未验证 |
| `/dashboard/crm/leads` | C（客户端页面/请求） | callback：`CrmLeadTable` → `CrmTable/useCrmTable.refresh` | `crm/loading.tsx` → `TablePageLoading` | S + A：线索数据 owner 桥接；B-nav + B-refresh 未验证 |
| `/dashboard/crm/sea` | C（客户端页面/请求） | callback：`CrmSeaTable` → `CrmTable/useCrmTable.refresh` | `crm/loading.tsx` → `TablePageLoading` | S + A：公海客户数据重取，不重置导入/选择状态；B-nav + B-refresh 未验证 |
| `/dashboard/crm/settings` | C（客户端页面/请求） | callback：`crm/settings/page.tsx`，重取工作流设置而保留未提交天数输入 | `crm/loading.tsx` → `TablePageLoading` | S + A：Head refresh 回归覆盖设置重取与本地草稿保留；B-nav + B-refresh 未验证 |
| `/dashboard/crm/tasks` | C（客户端页面/请求） | callback：`crm/tasks/page.tsx`，直接调用 `load()`，保留类型/视图筛选 | `crm/tasks/loading.tsx` → `CrmTaskBoardPageLoading`（工具行 + 三列任务看板） | S + A：Head 请求/筛选保留/失败保留旧任务有测试；专用初载骨架结构回归本轮通过；B-nav + B-refresh 未执行 |
| `/dashboard/crm/workbench` | 重定向 | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/feature-updates` | C（静态常量内容） | 不适用：版本说明随应用发布，不存在客户端读请求 | `feature-updates/loading.tsx` → `SimplePageLoading` | S；静态内容，骨架 B-nav 待验证 |
| `/dashboard/finance/commission-management` | C（客户端页面/请求） | callback：`finance/commission-management/page.tsx` | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；多面板/汇总骨架待逐视图核对 |
| `/dashboard/finance/exchange-rate` | C（客户端页面/请求） | callback：`finance/exchange-rate/page.tsx` | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；Table 骨架待与筛选/表格核对 |
| `/dashboard/finance/platform-revenue` | C（客户端页面/请求） | callback：`finance/platform-revenue/page.tsx` | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；Table 骨架待与 KPI/筛选/表格核对 |
| `/dashboard/finance/vat-invoice` | H（服务端入口 + 客户端子树） | router.refresh fallback | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；RSC refresh 是否带动客户端请求待验证；Stage 2 明确契约 |
| `/dashboard/finance/vat-invoices` | 重定向 | router.refresh fallback | `finance/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/operations/complaint-center` | H（服务端入口 + 客户端子树） | callback：`complaint-center-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；分析骨架与客诉工作区逐屏核对 |
| `/dashboard/operations/complaint-center/list` | H（服务端入口 + 客户端子树） | callback：`complaint-list-client.tsx` | `operations/complaint-center/list/loading.tsx` → `ComplaintListPageLoading` | S；按 7 列列表与筛选占位修正；B-nav + B-refresh 未验证 |
| `/dashboard/operations/daily-analysis` | H（服务端入口 + 客户端子树） | callback：`daily-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对实际首屏筛选/指标/表格比例 |
| `/dashboard/operations/inventory-analysis` | H（服务端入口 + 客户端子树） | callback：`inventory-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对筛选/库存表结构 |
| `/dashboard/operations/inventory-ledger` | H（服务端入口 + 客户端子树） | callback：`inventory-ledger-client.tsx` | `operations/inventory-ledger/loading.tsx` → `InventoryLedgerPageLoading` | S；专用骨架含 6 控件、KPI、四分图表区、Tab 与明细表；B-nav + B-refresh 未验证 |
| `/dashboard/operations/inventory-replenishment` | H（服务端入口 + 客户端子树） | callback：`inventory-replenishment-client.tsx` | `operations/inventory-replenishment/loading.tsx` → `InventoryReplenishmentPageLoading` | S；Tab、指标、图表和宽表专用组合；B-nav + B-refresh 未验证 |
| `/dashboard/operations/platform-inspection` | H（服务端入口 + 客户端子树） | callback：`inspection-client.tsx` | `operations/platform-inspection/loading.tsx` → `PlatformInspectionPageLoading` | S；活动 Tab、状态卡与巡检表单/历史表专用结构；B-nav + B-refresh 未验证 |
| `/dashboard/operations/portfolio-overview` | C（客户端页面/请求） | callback：`portfolio-overview-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；图表概览与 Analytics 骨架待核对 |
| `/dashboard/operations/project-goals` | C（客户端页面/请求） | callback：`project-goals/page.tsx` | `operations/project-goals/loading.tsx` → `ProjectGoalsPageLoading` | S；筛选、KPI、图表、Tab 与表格专用组合；B-nav + B-refresh 未验证 |
| `/dashboard/operations/project-launch` | H（服务端入口 + 客户端子树） | callback：`project-launch-client.tsx` | `operations/project-launch/loading.tsx` → `ProjectLaunchPageLoading` | S；项目列表 + 详情/流程 Tab 专用双栏骨架；B-nav + B-refresh 未验证 |
| `/dashboard/operations/project-launch/templates` | H（服务端入口 + client 编辑器） | callback：重取模板列表及当前选中详情，保留编辑草稿并刷新保存后的详情 | `operations/project-launch/templates/loading.tsx` → `WorkflowTemplateEditorPageLoading` | S + A：目录/编辑区双栏骨架和既有编辑器测试；浏览器刷新与未保存草稿语义待验证 |
| `/dashboard/operations/research-analysis` | C（客户端页面/请求） | callback：按当前关键词/数据集重取概览与趋势 owner | `operations/loading.tsx` → `AnalyticsPageLoading` | S + A：读数据 owner callback 已接线；浏览器刷新与骨架待验证 |
| `/dashboard/operations/return-analysis` | H（服务端入口 + 客户端子树） | callback：`return-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对筛选/多表格/导出区域骨架 |
| `/dashboard/operations/seasonal-replenishment` | H（服务端入口 + 客户端子树） | callback：`seasonal-replenishment-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；补货列表/表格与 Analytics 骨架待核对 |
| `/dashboard/operations/shipment-management` | C（客户端页面/请求） | callback：`shipment-management/page.tsx` | `operations/shipment-management/loading.tsx` → `ShipmentManagementPageLoading` | S；四个工作 Tab、操作工具栏与 10 列表格占位；B-nav + B-refresh 未验证 |
| `/dashboard/operations/shipping-plan` | H（服务端入口 + client 规划表） | callback：`reload()` 强刷当前项目/国家 scope | `operations/shipping-plan/loading.tsx` → `ShippingPlanPageLoading` | S + A：首屏 KPI、SKU 预测清单与表单双栏骨架；浏览器导航/刷新待验证 |
| `/dashboard/operations/site-navigation` | RSC（服务端/静态） | router.refresh fallback（无业务数据 callback） | `operations/site-navigation/loading.tsx` → `OperationsNavigationPageLoading` | S；三项概览 + 分组外链卡片网格专用骨架；RSC 可感知刷新意义/B-nav 待浏览器确认 |
| `/dashboard/operations/sku-info` | C（客户端页面/请求） | callback：`sku-info/page.tsx` | `operations/sku-info/loading.tsx` → `SkuInfoPageLoading` | S；六个 Tab、查询栏、9 列宽表占位专用骨架；B-nav + B-refresh 未验证 |
| `/dashboard/operations/store-navigation` | C（客户端页面/请求） | callback：`store-navigation/page.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；店铺导航与 Analytics 骨架待核对 |
| `/dashboard/operations/weekly-product-analysis` | H（服务端入口 + 客户端子树） | callback：`weekly-product-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对实际周分析图表/表格布局 |
| `/dashboard` | C（客户端页面/请求） | callback：`app/dashboard/page.tsx` | `dashboard/loading.tsx` → `DashboardV2Loading`（内联） | S；B-nav + B-refresh；按首页图表/指标骨架实测；另有既有首页单测但本阶段未运行 |
| `/dashboard/profile` | H（服务端入口 + 客户端子树） | router.refresh fallback | `profile/loading.tsx` → `ProfileInfoSkeleton`（内联） | S；B-nav + B-refresh；client 请求是否随 RSC 刷新待核对，callback 缺失 |
| `/dashboard/reports/auto-upload` | C（状态矩阵 + 上传流程） | callback：按活动 Tab 刷新当前日期/站点状态，或强刷项目选项；不清上传队列、识别/提交进度 | `reports/loading.tsx` → `TablePageLoading` | S + A：当前状态视图请求回归；浏览器点击与上传 Tab 验证未执行 |
| `/dashboard/reports/monthly-report/display` | H（服务端入口 + 客户端子树） | callback：`display-client.tsx` | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；核对报告展示/表格实际结构 |
| `/dashboard/reports/monthly-report/generate` | H（client 上传/生成工作流；入口仅提供 dynamic 路由） | 不适用：保留本地文件、映射、上传和任务进度；无独立读列表 | `reports/monthly-report/generate/loading.tsx` → `MonthlyReportGeneratePageLoading` | S；左侧文件/上传 + 右侧任务进度专用骨架；B-nav 待验证 |
| `/dashboard/reports/monthly-report/reconcile` | C（客户端页面/请求） | callback：`reconcile/page.tsx` | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；对账布局与表格骨架核对 |
| `/dashboard/reports/order-info` | C（客户端页面/请求） | callback：`order-info/page.tsx` | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；可验证代表路由：确认请求、筛选保留和数据更新 |
| `/dashboard/reports/pricing-calculation` | 重定向 | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/reports/pricing-calculation/new-product` | H（服务端入口 + 客户端子树） | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；计算表单与通用表格骨架待核对；callback 缺失 |
| `/dashboard/reports/pricing-calculation/shop-calculation` | H（服务端入口 + 客户端子树） | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；计算分区/表格与通用表格骨架待核对；callback 缺失 |
| `/dashboard/reports/product-analysis` | C（客户端页面/请求） | callback：主面板强刷项目目录，保留当前核算/上传状态 | `reports/loading.tsx` → `TablePageLoading` | S；其余 tab 的项目目录仍由各自 owner mount 加载；B-nav + B-refresh 未验证 |
| `/dashboard/reports/report-reconciliation` | 重定向 | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/reports/scheduled-reports` | H（客户端 layout + 客户端数据视图） | callback：layout 按当前 tab 调用订阅或台账 owner | `reports/loading.tsx` → `TablePageLoading` | S + A：按 active tab 重取真实数据 owner；B-nav + B-refresh 未验证 |
| `/dashboard/reports/scheduled-reports/ledger` | H（客户端 layout + 客户端数据视图） | callback：`LedgerView.loadLedger()` 当前日期/筛选 | `reports/loading.tsx` → `TablePageLoading` | S + A：筛选状态保留；B-nav + B-refresh 未验证 |
| `/dashboard/reports/scheduled-reports/subscriptions` | H（客户端 layout + 客户端数据视图） | callback：`SubscriptionsView.refreshSubscriptions()` | `reports/loading.tsx` → `TablePageLoading` | S + A：订阅筛选/选中态保留；HTTP/网络失败保留现有数据并提示可见错误；B-nav + B-refresh 未验证 |
| `/dashboard/system/account-management` | C（客户端页面/请求） | callback：`system/account-management/page.tsx`，重取用户列表 | `system/loading.tsx` → `TablePageLoading` | S；保留页面对话框与编辑状态；B-nav + B-refresh 未验证 |
| `/dashboard/system/agent-management` | H（服务端入口 + 客户端子树） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失；RSC 是否触发客户端数据重取待确认 |
| `/dashboard/system/alerts` | C（客户端页面/请求） | callback：刷新告警统计/项目元数据及当前活动 Tab 数据 owner | `system/loading.tsx` → `TablePageLoading` | S + A：活动 Tab 重取自身数据且保留筛选；失败保留上次成功统计/项目并提示错误，Header busy 状态覆盖刷新全程；B-nav + B-refresh 未验证 |
| `/dashboard/system/changelog` | 静态发布 snapshot | 不适用：无客户端读请求；内容随发布更新，RSC fallback 不作为客户端数据刷新契约 | `system/changelog/loading.tsx` → `SimplePageLoading` | S；静态 snapshot；B-nav 待验证 |
| `/dashboard/system/data-management` | C（客户端页面/请求） | callback：页面 `refreshAll()` 同时重取状态与详情 | `system/loading.tsx` → `TablePageLoading` | S；操作面板与骨架待核对；B-nav + B-refresh 未验证 |
| `/dashboard/system/digital-display` | C（客户端页面/请求） | callback：`system/digital-display/page.tsx`，按当前选中项目重取大屏数据 | `system/loading.tsx` → `TablePageLoading` | S；保留大屏项目选择并复用请求态；B-nav + B-refresh 未验证 |
| `/dashboard/system/logs` | C（客户端页面/请求） | callback：按当前 Tab 重取审计日志或登录日志；Agent 日志由独立 owner 处理 | `system/loading.tsx` → `TablePageLoading` | S；保留当前 Tab/筛选/分页；B-nav + B-refresh 未验证 |
| `/dashboard/system/operator-management` | C（客户端页面/请求） | callback：`operator-management/page.tsx` | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；核对多表/操作区骨架和 loading 状态 |
| `/dashboard/system/project-info` | C（客户端页面/请求） | callback：强刷项目缓存并重取启动流程概要 | `system/loading.tsx` → `TablePageLoading` | S + A：项目列表与启动状态共同更新；保留本地编辑交互；B-nav + B-refresh 未验证 |
| `/dashboard/table-showcase` | C（静态 mock 数据） | 不适用：组件规范展示，无服务端/客户端业务数据读模型 | `table-showcase/loading.tsx` → `TablePageLoading` | S；静态 demo，骨架 B-nav 待验证 |
| `/dashboard/tools/brand-registration-example` | RSC（服务端/静态） | router.refresh fallback（无业务数据 callback） | `tools/loading.tsx` → `SimplePageLoading` | S；B-nav + B-readonly；核对图文布局；Head 刷新可标为静态/不适用 |
| `/dashboard/tools/markdown-to-word` | H（客户端本地编辑/转换） | 不适用：本地内容不因 Head refresh 重置；无独立读模型 | `tools/loading.tsx` → `SimplePageLoading` | S；本地工作流，骨架 B-nav 待验证 |
| `/dashboard/tools/page-render` | H（历史列表 API + 本地编辑/预览） | callback：强刷服务端历史列表，保留文件预览、标题和上传流程 | `tools/page-render/loading.tsx` → `SimplePageLoading` | S + A：历史列表 owner callback；浏览器验证未执行 |
| `/dashboard/tools/product-label` | H（本地 PDF 文案/生成流程） | 不适用：文件、文案与生成结果均为本地工作流状态，无读模型 | `tools/loading.tsx` → `SimplePageLoading` | S；本地流程，骨架 B-nav 待验证 |

## 统一刷新验收约定（Stage 2–4）

### 页面刷新契约

1. 每条可见数据路由明确选择一种契约：**页面 callback 强刷**（重新请求当前筛选/分页/激活 tab 的数据，按约定绕过客户端/API 缓存）、**RSC 重取**（刷新服务端实际读取的数据），或**不适用**（纯静态只读、编辑器/上传流程等无独立读模型）。不允许仅凭 Head 按钮常驻宣称刷新完成。
2. 对 callback 路由，callback 必须作用于页面实际数据 owner；不能只刷新某个附属下拉列表而让主内容保持旧数据。重取后保留用户筛选、分页/选中项等非数据状态，除非页面明确规定重置。
3. 对 fallback 路由，须以浏览器网络面板/可控 mock 证明 `router.refresh()` 重新请求并更新该路由真实使用的 RSC 数据。若数据只在客户端 `useEffect`、client layout 或本地缓存中获取，则改为显式 callback/刷新机制，或记录“不适用”及其理由。
4. Head 刷新开始后才进入 busy 状态；busy 时显示 spinner、禁用重复点击并有可访问的状态名。成功时停止 busy，保留筛选并能观察到新结果/最后更新时间（若页面有此概念）；避免无意义成功 toast 与重复播报。
5. 失败时停止 busy、保留既有数据和筛选，向用户提供可理解的错误反馈/重试入口；不得只写 console、静默清空旧数据或留下未处理 rejection。Stage 4 再统一 live announcement、主题 token 与 reduced-motion。
6. 初次路由加载与数据已有时的手动刷新分开：初载可展示与主体同构的 skeleton；手动刷新优先保留可读旧内容并展示局部 busy/progress，不应用路由 loading 骨架遮盖页面，除非明确设计并验证。

### 骨架适配验收

- 慢速网络下从邻接路由导航进入，确认最近 `loading.tsx` 是否真的出现；对照页面第一屏的标题、筛选器、卡片/图表/看板/表格列数与响应式排列检查形态和占位尺寸。
- 仅 `loading.tsx` 文件存在或单测能渲染骨架组件，不算视觉匹配通过。所有“疑似不匹配”需修正为专用组合骨架或记录经实际对照接受的理由；补充针对性组件/路由测试。
- callback 刷新与 RSC 导航分开验收。callback 若没有导航，不要求路由级 skeleton 出现；验证其局部加载反馈。RSC fallback 是否展示 boundary 由浏览器实测记录，不由文件存在性推断。

## Stage 2 增量盘点（静态证据；自动化/浏览器仅按实际执行标注）

Stage 1 的 51 条 C/H + fallback 路由及 scheduled-reports 的 3 个 URL 已逐条核对入口/数据 owner。表中路由类型按静态页面形态，以下分类细化 Head 刷新行为：

- **服务端/RSC 刷新候选（不是已验证完成）**：`/dashboard/advertising/ad-analysis/{budget,campaigns,overview,placements,products,purchased-products,search-terms,targets,time-trend,traffic-quality}`、`/dashboard/advertising/ad-data`、`/dashboard/ai/believeboy-models`、`/dashboard/finance/vat-invoice`、`/dashboard/profile`、`/dashboard/reports/pricing-calculation/new-product`、`/dashboard/reports/pricing-calculation/shop-calculation` 的路由入口是 RSC/server props 或由其加载 client subtree；这是 fallback 应触发 server route refresh 的候选，但是否重取真实服务端 payload 仍须浏览器网络验证。`/dashboard/operations/project-launch/templates` 的 client 编辑器已接 callback：刷新模板列表及当前选中详情，保留本地编辑草稿（详情更新会替换当前所选 template 内容，此语义仍待确认/浏览器验证）。`/dashboard/operations/shipping-plan` 主数据由 client `reload()` 强刷当前项目/国家 scope。
- **静态/流程状态契约候选（已按 client 数据 owner 细化；浏览器仍未验证）**：`/dashboard/ai` 与 `/dashboard/ai/chat` 共用 `AIChatWindow` callback，重取会话列表、当前会话消息与 AI 配置，避免中断正在进行的流；`/dashboard/ai/customer-service` callback 强刷场景配置并保留仍有效的场景选择及草稿；`/dashboard/ai/digital-employees/office` callback 重连 SSE，并等首个 snapshot 同步实时状态，不重置展示/投屏模式；`/dashboard/reports/auto-upload` 只刷新当前活动视图的数据（RPA 状态矩阵重取当前日期/站点，上传 Tab 只强刷项目选项），不清队列/识别/上传进度；`/dashboard/tools/page-render` 只强刷历史列表，保留本地预览与待上传草稿。`/dashboard/change-password`（仅本地表单）、`/dashboard/feature-updates`（静态发布说明）、`/dashboard/reports/monthly-report/generate`（上传/生成工作流）、`/dashboard/system/changelog`（服务端 changelog snapshot）、`/dashboard/table-showcase`（静态组件示例）、`/dashboard/tools/brand-registration-example`（静态参考页）、`/dashboard/tools/markdown-to-word`（本地编辑/转换）及 `/dashboard/tools/product-label`（标签编辑/生成流程）仍采用 RSC fallback/不修改本地内容；本轮未做浏览器验证，需后续实际确认其 RSC 行为及不适用边界。
- **Stage 2 初始静态盘点（23 条缺口）**：最初确认 `/dashboard/ai/ad-analysis`、`/dashboard/ai/digital-employees`、`/dashboard/ai/digital-employees/[id]`、`/dashboard/ai/insights`、`/dashboard/ai/inventory-health`、`/dashboard/crm/customers`、`/dashboard/crm/follow-ups`、`/dashboard/crm/leads`、`/dashboard/crm/sea`、`/dashboard/crm/settings`、`/dashboard/operations/project-launch/templates`、`/dashboard/operations/research-analysis`、`/dashboard/operations/shipping-plan`、`/dashboard/reports/product-analysis`、`/dashboard/reports/scheduled-reports`、`/dashboard/reports/scheduled-reports/ledger`、`/dashboard/reports/scheduled-reports/subscriptions`、`/dashboard/system/account-management`、`/dashboard/system/alerts`、`/dashboard/system/data-management`、`/dashboard/system/digital-display`、`/dashboard/system/logs`、`/dashboard/system/project-info` 存在客户端读数据而无 callback。Stage 2 后续修复情况见下方状态；CRM customers/leads owner 为共享 `CrmTable/useCrmTable`，follow-ups 为 `CrmFollowUpList`，公海为 `CrmSeaTable`，均已桥接到实际数据 owner。
- **需确认非数据流程契约的边界**：`/dashboard/ai/digital-employees/office` 的页面数据为 SSE snapshot/chatter；刷新仅重连实时通道并等待 snapshot，不应重置投屏/时钟状态。`/dashboard/ai`、`/dashboard/ai/chat` 共用会话数据 owner；发送期间忽略手动刷新以免打断流。`/dashboard/ai/ad-analysis` 有子组件/列表刷新路径，`ai/insights` 有客户端 list loader，均已列入 23 条缺口。
- **当前 Stage 2 补齐状态**：初始静态盘点的 23 个 client 数据缺口现已全部接入明确 callback（含研究分析当前关键词/数据集/概览/趋势 owner；产品分析主面板仅刷新项目目录并保留核算/上传流程；scheduled-reports 按活动 Tab 重取对应 owner）。代码级目标回归见下方；浏览器 Head 点击仍未执行。
- **Stage 2 本轮扩展实施（静态代码）**：除 CRM tasks 和共享 CRM customers/leads/follow-ups/sea 数据 owner 外，已接入数字员工列表与详情、AI 广告分析历史/定时任务 Tab、洞察列表、库存健康项目选项、CRM 规则/类目管理、账号管理、告警中心活动 Tab owner、系统数据管理、数字大屏、系统日志审计/登录 Tab、系统 Agent 管理密钥列表与访问/写入日志、项目启动模板当前阶段保存后重取详情、发货规划数据、scheduled-reports 当前活动 Tab owner、系统项目资料的 Head callback；本轮续补 AI 对话/客户服务配置、虚拟办公室 SSE snapshot、自动报表当前活动 Tab 与 page-render 历史列表刷新 callback。上传/生成内容及本地编辑/预览草稿均保留。新增目标测试覆盖 CRM owner、配置刷新、AI 对话数据请求、RPA 当前视图与 CRM/项目启动刷新桥接。
- CRM tasks callback 在 `page.tsx` 调用相同 `load(true)`，强刷当前 scope/type，刷新期间上报 `loading`，刷新时失败保留已加载任务并显示错误；初载失败仍清空空数据并显示错误。回归用例断言请求参数、视图/筛选保留及失败旧数据保留。
- Review 修复：告警通知偏好 Head refresh 会比较当前草稿与最近保存值，仅在没有未保存编辑时才同步远端值；保存成功后更新基准，避免静默覆盖草稿。订阅列表遇 HTTP 非 2xx、无效响应或网络失败时保留订阅/项目数据并通过通知提示原因。告警中心统计/项目元数据刷新按数据源独立更新成功项，失败时保留各自上次成功值并提示错误，Header busy 状态覆盖活动 Tab 与元数据刷新全过程。

### Stage 2 验证记录

- **静态检查（已执行）**：Stage 1 路由清单中全部 51 条 callback 缺失项和 scheduled-reports 3 个 URL 核对页面/client layout 及主要数据 owner；其中 23 条有明确的客户端数据 loader 而无 Head callback。其余 RSC、静态/流程状态路由已在对应行记录 callback 或“不适用”契约；RSC 实际 payload 行为仍待浏览器验证。
- **目标 Vitest（续做）**：6 文件 / 57 例通过，覆盖 AIChatWindow、customer-service、RPA auto-upload、Project Info、project-launch、project-startup-status；此前运行的 CRM/AI/系统/报表目标集见前一轮历史。
- **全量前端 Vitest（本轮重新执行，已通过）**：`pnpm test` 通过，251 文件 / 1830 例；unstable-mock 检查扫描 251 个测试文件、0 命中。此前的全量失败记录属于前一轮补 mock 前的历史，不代表本轮结果。
- **Lint（已执行）**：`pnpm lint` 完成，0 errors / 27 warnings；新增续做文件 ESLint 无问题。
- **类型检查（历史结果，非本轮重跑）**：上一轮 `pnpm exec tsc --noEmit` 报 61 errors / 25 files，数字员工详情 `useRef` import 与 alerts test mock 类型错误已修复；剩余错误尚未分类，本轮没有重跑类型检查。
- **构建（未执行）**：本轮不是构建敏感面；按仓库口径交 Vercel Preview 执行 `pnpm build`。
- **浏览器点击验证（未执行）**：未启动 Dashboard 前后端服务，也未对任何代表路由实际点击 Head 刷新。Stage 1 标记的所有 `B-*` 仍待执行，不构成浏览器验收通过。

## Stage 2–4 可执行范围

- **Stage 2（本轮已接通静态缺口）**：上方初始盘点出的 client 数据 loader 缺口均已连接到对应数据 owner；运行时 Head 点击、生产网络行为仍需浏览器验收。对上传/生成/编辑/静态页维持不适用契约，不可为了覆盖率丢弃用户草稿/文件状态。
- **Stage 3**：复核其余 callback 路由是否确实覆盖主数据源；验证 RSC-only/redirect/static 页面；按域修复本表骨架疑点。优先审视 operations 域通用 `AnalyticsPageLoading`，其次 CRM tasks/dashboard、Agent Center、报告生成/定价、System 操作页等。
- **Stage 4**：统一开始/成功/失败可访问反馈、spinner/loading 语义、错误恢复、明暗主题与 reduced-motion；检查阅读期间是否有不必要的全页禁用，并做跨路由回归。

## 本阶段验证记录

- **Stage 1 静态基线**：CodeGraph 索引健康；枚举 `frontend/app/dashboard/**/page.tsx` 得到 90 条路由记录；当时对页面及相对/别名导入链检查 callback 和 loading 边界。结论仅描述静态代码。
- **Stage 1 自动化测试**：未运行；Stage 1 文件原记录的测试资产不代表当时通过。
- **Stage 1 浏览器验证**：未执行；所有 `B-*` 待执行。
- **Stage 2 lint / 静态 mock 检查（已执行）**：针对 `crm/tasks/page.tsx` 与测试文件 ESLint 通过；`node scripts/check-unstable-mocks.mjs` 扫描 248 个测试文件，0 命中。
- **Stage 2 review 修复自动化验证（本轮）**：目标 Vitest 5 文件 / 40 例通过（告警中心 6、偏好草稿 1、scheduled-reports 11、项目资料 4、CRM Head header 9）；全量 `pnpm test` 252 文件 / 1855 例通过；全量 `pnpm lint` 0 errors / 27 warnings；`pnpm check:mocks` 扫描 252 个测试文件 / 0 命中；`git diff --check` 通过。修复包含告警中心元数据刷新失败保留数据与 busy 覆盖、偏好草稿不被 Head 覆盖、订阅刷新 HTTP/网络失败保留旧列表并提示；并修正一条 CRM Head 按钮异步初始 busy 状态下的脆弱测试时序断言。`pnpm exec tsc --noEmit` 报 61 errors / 25 files，错误集中在其他测试/路由；本轮修改文件未见类型检查报错。浏览器点击验证仍未执行。
- **PR #717 当前状态（更新于 2026-10-11）**：已基于最新 `origin/main` rebase 并解决项目资料页面冲突；本轮全量 `pnpm test` 252 文件 / 1855 例通过；`pnpm lint` 0 errors / 27 warnings；`pnpm check:mocks` 扫描 252 个测试文件 / 0 命中。`pnpm exec tsc --noEmit` 报 61 errors / 25 files，错误分布在其他测试/现有路由，本轮修改的相关文件未再报告类型错误。准备推送 PR 修复；此前 Vercel required check 失败，新的 Preview 结果须由推送后检查，不得视为当前可合并。
