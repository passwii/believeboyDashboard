# Dashboard Head 刷新与页面加载基线（Stage 1）

> 快照日期：2026-10-10。本文是后续 BLF-1308 Stage 2–4 的可复核基线，不是运行时验收报告。路由清单按 `frontend/app/dashboard/**/page.tsx` 静态盘点；共 90 个 page 文件/URL（含重定向别名）。

## 结论摘要

- Head 刷新按钮在 `TerminalHeader` 中常驻。当前路由注册了 `useHeaderRefresh` 时调用页面 callback；否则调用 `router.refresh()`。按钮/图标存在不等于页面数据已经刷新。
- 静态导入链检查发现 **28 个页面路由注册了 callback**。其余回退到 `router.refresh()`。在 79 个 page 导入链含 Client Component 的路由中，**51 个未发现页面 callback**；另有 scheduled-reports 的 3 个 URL 实际由 client `layout.tsx` 管理，同样没有 callback。它们是 Stage 2 的重点核查集合，但对上传、编辑器、静态内容等页面应先定义“可刷新”或“不适用”的明确契约，不应机械地加按钮回调。
- 未注册 callback 的 client-only 页面只能确认点击会走 RSC `router.refresh()` 兜底；该操作**不能作为客户端 `useEffect` / 本地请求必定重新执行的证据**。因此 CRM 任务页等路径存在明确的刷新契约缺口，需 Stage 2 优先处理。
- 当前扫描到的 Dashboard 页面都能沿路由树找到最近的 `loading.tsx`（根 Dashboard loading 作为继承兜底）。这只证明静态边界存在；**不证明导航时一定显示、骨架与页面结构匹配，也不证明页面内 callback 刷新会触发该 loading 边界**。
- 静态结构已经暴露出需优先复核的骨架疑点：`/dashboard/crm/tasks` 是看板/列表，却继承表格骨架；`/dashboard/crm/dashboard` 是 KPI/漏斗图/表格，却继承表格骨架；整个 operations 域共用分析型骨架，其中台账、编辑表单、导航卡片等页面结构明显不同。以下只标为“静态疑点”，最终匹配度须浏览器慢请求验证。

## 证据等级与检查口径

- **S（静态证据）**：检查 `page.tsx`、静态 import 链、`useHeaderRefresh` 调用及最近的 `loading.tsx`。表中 `C` = 客户端页面/请求；`H` = 服务端入口或客户端 layout 与客户端内容/请求混合；`RSC` = 页面可见内容主要由服务端/静态输出提供；`重定向` = alias，不是数据页面。对 scheduled-reports 3 个子 URL，数据 owner 是父级 client layout，因此标为 H。
- **A（自动化）**：本阶段未执行 Vitest / Playwright，也未据已有测试文件宣称行为通过。代码中已有的测试只代表测试资产存在，不能作为本阶段的运行结果。
- **B（浏览器）**：本阶段未做浏览器实测。表中 `B-nav` 是待执行的慢请求导航观察（是否出现 boundary、骨架轮廓/布局/响应式是否贴合）；`B-refresh` 是待执行的 Head 点击观察（请求、数据变化、筛选保留、反馈及错误恢复）。对于重定向使用 `B-redirect`；静态/只读页面使用 `B-readonly` 验证实际行为和刷新是否具有可感知意义。
- 页面的 `loading.tsx` 是路由级加载边界；页面内部的数据 callback 往往自行维护 `loading`。路由级骨架不得被写成 callback 刷新时已经展示。
- “刷新完成”须由真实数据请求/服务端 payload 完成确定，不以按钮点击、`router.refresh()` 调用或 spinner 消失单独证明。无服务端/客户端数据的静态页应记录为静态刷新或不适用，而不能声称数据重取成功。

## Dashboard 路由清单

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
| `/dashboard/agent-center/employees` | H（服务端入口 + 客户端子树） | callback：`employees-client.tsx` | `agent-center/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；Simple 卡片骨架与员工页结构待核对 |
| `/dashboard/agent-center/overview` | H（服务端入口 + 客户端子树） | callback：`agent-overview-client.tsx` | `agent-center/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；概览与 Simple 卡片骨架待核对 |
| `/dashboard/ai` | C（客户端页面/请求） | router.refresh fallback | `ai/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；callback 缺失，Stage 2 确认数据刷新是否适用 |
| `/dashboard/ai/ad-analysis` | C（客户端页面/请求） | router.refresh fallback | `ai/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；分析页与 Simple 骨架待核对；callback 缺失 |
| `/dashboard/ai/believeboy-models` | H（服务端入口 + 客户端子树） | router.refresh fallback（RSC 重读文件） | `ai/loading.tsx` → `SimplePageLoading` | S；B-nav + B-readonly；只读文件刷新行为待确认，Simple 与文档布局待核对 |
| `/dashboard/ai/chat` | C（客户端页面/请求） | router.refresh fallback | `ai/chat/loading.tsx` → `ChatPageLoading` | S；B-nav + B-refresh；会话刷新是否应重载由 Stage 2 定义 |
| `/dashboard/ai/customer-service` | C（客户端页面/请求） | router.refresh fallback | `ai/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；工作区与 Simple 骨架待核对；callback 缺失 |
| `/dashboard/ai/digital-employees` | C（客户端页面/请求） | router.refresh fallback | `ai/digital-employees/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；列表/卡片骨架待核对；callback 缺失 |
| `/dashboard/ai/digital-employees/office` | C（客户端页面/请求） | router.refresh fallback | `ai/digital-employees/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；办公室网格与 Simple 骨架待核对；callback 缺失 |
| `/dashboard/ai/digital-employees/[id]` | C（客户端页面/请求） | router.refresh fallback | `ai/digital-employees/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；详情结构与 Simple 骨架待核对；callback 缺失 |
| `/dashboard/ai/insights` | C（客户端页面/请求） | router.refresh fallback | `ai/insights/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失；分析骨架结构待浏览器核对 |
| `/dashboard/ai/inventory-health` | C（客户端页面/请求） | router.refresh fallback | `ai/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；健康分析页与 Simple 骨架待核对；callback 缺失 |
| `/dashboard/change-password` | C（客户端页面/请求） | router.refresh fallback | `change-password/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；确认刷新是否适用及未提交表单处理 |
| `/dashboard/crm` | 重定向 | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/crm/audit` | C（客户端页面/请求） | callback：`crm/audit/page.tsx` | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；Table 骨架待与实际筛选/表格比对 |
| `/dashboard/crm/customers` | C（客户端页面/请求） | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失，Stage 2 明确列表重取契约 |
| `/dashboard/crm/dashboard` | C（客户端页面/请求） | callback：`crm/dashboard/page.tsx` | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；KPI/漏斗与通用表格骨架存在结构疑点 |
| `/dashboard/crm/follow-ups` | C（客户端页面/请求） | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失，Stage 2 明确数据刷新契约 |
| `/dashboard/crm/leads` | C（客户端页面/请求） | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失，Stage 2 明确列表重取契约 |
| `/dashboard/crm/sea` | C（客户端页面/请求） | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失，导入状态与刷新语义待定义 |
| `/dashboard/crm/settings` | C（客户端页面/请求） | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失，确认设置页刷新/未保存状态语义 |
| `/dashboard/crm/tasks` | C（客户端页面/请求） | router.refresh fallback；无页面 callback | `crm/loading.tsx` → `TablePageLoading` | **Stage 2 优先**；S：`page.tsx` 的 `useEffect` 调 `load()`；B-nav + B-refresh；Table 骨架与看板/列表明显待核对 |
| `/dashboard/crm/workbench` | 重定向 | router.refresh fallback | `crm/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/feature-updates` | C（客户端页面/请求） | router.refresh fallback | `feature-updates/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；callback 缺失，确认是静态内容还是可重取数据 |
| `/dashboard/finance/commission-management` | C（客户端页面/请求） | callback：`finance/commission-management/page.tsx` | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；多面板/汇总骨架待逐视图核对 |
| `/dashboard/finance/exchange-rate` | C（客户端页面/请求） | callback：`finance/exchange-rate/page.tsx` | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；Table 骨架待与筛选/表格核对 |
| `/dashboard/finance/platform-revenue` | C（客户端页面/请求） | callback：`finance/platform-revenue/page.tsx` | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；Table 骨架待与 KPI/筛选/表格核对 |
| `/dashboard/finance/vat-invoice` | H（服务端入口 + 客户端子树） | router.refresh fallback | `finance/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；RSC refresh 是否带动客户端请求待验证；Stage 2 明确契约 |
| `/dashboard/finance/vat-invoices` | 重定向 | router.refresh fallback | `finance/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/operations/complaint-center` | H（服务端入口 + 客户端子树） | callback：`complaint-center-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；分析骨架与客诉工作区逐屏核对 |
| `/dashboard/operations/complaint-center/list` | H（服务端入口 + 客户端子树） | callback：`complaint-list-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；列表页与 Analytics 骨架疑似不匹配 |
| `/dashboard/operations/daily-analysis` | H（服务端入口 + 客户端子树） | callback：`daily-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对实际首屏筛选/指标/表格比例 |
| `/dashboard/operations/inventory-analysis` | H（服务端入口 + 客户端子树） | callback：`inventory-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对筛选/库存表结构 |
| `/dashboard/operations/inventory-ledger` | H（服务端入口 + 客户端子树） | callback：`inventory-ledger-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；台账表格与 Analytics 骨架明显待核对 |
| `/dashboard/operations/inventory-replenishment` | H（服务端入口 + 客户端子树） | callback：`inventory-replenishment-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；cockpit/日历/表格与 Analytics 骨架待核对 |
| `/dashboard/operations/platform-inspection` | H（服务端入口 + 客户端子树） | callback：`inspection-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；巡检卡片/表单与 Analytics 骨架待核对 |
| `/dashboard/operations/portfolio-overview` | C（客户端页面/请求） | callback：`portfolio-overview-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；图表概览与 Analytics 骨架待核对 |
| `/dashboard/operations/project-goals` | C（客户端页面/请求） | callback：`project-goals/page.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；目标卡片/图表与 Analytics 骨架待核对 |
| `/dashboard/operations/project-launch` | H（服务端入口 + 客户端子树） | callback：`project-launch-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；流程管理结构与 Analytics 骨架存在疑点 |
| `/dashboard/operations/project-launch/templates` | H（服务端入口 + 客户端子树） | router.refresh fallback | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；编辑器与 Analytics 骨架明显待核对；callback 缺失 |
| `/dashboard/operations/research-analysis` | C（客户端页面/请求） | router.refresh fallback | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失；确认数据请求重取及骨架细节 |
| `/dashboard/operations/return-analysis` | H（服务端入口 + 客户端子树） | callback：`return-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对筛选/多表格/导出区域骨架 |
| `/dashboard/operations/seasonal-replenishment` | H（服务端入口 + 客户端子树） | callback：`seasonal-replenishment-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；补货列表/表格与 Analytics 骨架待核对 |
| `/dashboard/operations/shipment-management` | C（客户端页面/请求） | callback：`shipment-management/page.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；多 tab/表格工作区与 Analytics 骨架待核对 |
| `/dashboard/operations/shipping-plan` | H（服务端入口 + 客户端子树） | router.refresh fallback | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；callback 缺失；图表+SKU表与 Analytics 骨架待核对 |
| `/dashboard/operations/site-navigation` | RSC（服务端/静态） | router.refresh fallback（无业务数据 callback） | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-readonly；静态卡片网格与 Analytics 骨架明显待核对；明确“不适用”或静态刷新 |
| `/dashboard/operations/sku-info` | C（客户端页面/请求） | callback：`sku-info/page.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；SKU 表格/工具栏与 Analytics 骨架明显待核对 |
| `/dashboard/operations/store-navigation` | C（客户端页面/请求） | callback：`store-navigation/page.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；店铺导航与 Analytics 骨架待核对 |
| `/dashboard/operations/weekly-product-analysis` | H（服务端入口 + 客户端子树） | callback：`weekly-product-analysis-client.tsx` | `operations/loading.tsx` → `AnalyticsPageLoading` | S；B-nav + B-refresh；需核对实际周分析图表/表格布局 |
| `/dashboard` | C（客户端页面/请求） | callback：`app/dashboard/page.tsx` | `dashboard/loading.tsx` → `DashboardV2Loading`（内联） | S；B-nav + B-refresh；按首页图表/指标骨架实测；另有既有首页单测但本阶段未运行 |
| `/dashboard/profile` | H（服务端入口 + 客户端子树） | router.refresh fallback | `profile/loading.tsx` → `ProfileInfoSkeleton`（内联） | S；B-nav + B-refresh；client 请求是否随 RSC 刷新待核对，callback 缺失 |
| `/dashboard/reports/auto-upload` | C（客户端页面/请求） | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；上传工作区与表格骨架待核对；callback 缺失 |
| `/dashboard/reports/monthly-report/display` | H（服务端入口 + 客户端子树） | callback：`display-client.tsx` | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；核对报告展示/表格实际结构 |
| `/dashboard/reports/monthly-report/generate` | H（服务端入口 + 客户端子树） | router.refresh fallback；页面注释说明无刷新语义 | `reports/loading.tsx` → `TablePageLoading` | S；B-nav；检查生成表单/上传反馈骨架；Head 行为须明确“不适用”或定义恢复语义 |
| `/dashboard/reports/monthly-report/reconcile` | C（客户端页面/请求） | callback：`reconcile/page.tsx` | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；对账布局与表格骨架核对 |
| `/dashboard/reports/order-info` | C（客户端页面/请求） | callback：`order-info/page.tsx` | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；可验证代表路由：确认请求、筛选保留和数据更新 |
| `/dashboard/reports/pricing-calculation` | 重定向 | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/reports/pricing-calculation/new-product` | H（服务端入口 + 客户端子树） | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；计算表单与通用表格骨架待核对；callback 缺失 |
| `/dashboard/reports/pricing-calculation/shop-calculation` | H（服务端入口 + 客户端子树） | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；计算分区/表格与通用表格骨架待核对；callback 缺失 |
| `/dashboard/reports/product-analysis` | C（客户端页面/请求） | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；tab/图表与通用表格骨架待核对；callback 缺失 |
| `/dashboard/reports/report-reconciliation` | 重定向 | router.refresh fallback | `reports/loading.tsx` → `TablePageLoading` | S；B-redirect，目标页再做 B-nav/B-refresh |
| `/dashboard/reports/scheduled-reports` | H（客户端 layout + 客户端数据视图） | router.refresh fallback；layout 未发现 callback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；需核对 layout 内数据请求能否被触发；callback 缺失 |
| `/dashboard/reports/scheduled-reports/ledger` | H（客户端 layout + 客户端数据视图） | router.refresh fallback；layout 未发现 callback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；layout 已激活 tab 的数据刷新待验证；callback 缺失 |
| `/dashboard/reports/scheduled-reports/subscriptions` | H（客户端 layout + 客户端数据视图） | router.refresh fallback；layout 未发现 callback | `reports/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；layout 已激活 tab 的数据刷新待验证；callback 缺失 |
| `/dashboard/system/account-management` | C（客户端页面/请求） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失，核对用户表与未保存编辑处理 |
| `/dashboard/system/agent-management` | H（服务端入口 + 客户端子树） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失；RSC 是否触发客户端数据重取待确认 |
| `/dashboard/system/alerts` | C（客户端页面/请求） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失；明确告警列表强刷/筛选保持 |
| `/dashboard/system/changelog` | C（客户端页面/请求） | router.refresh fallback | `system/changelog/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；callback 缺失，核对列表/内容骨架 |
| `/dashboard/system/data-management` | C（客户端页面/请求） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；操作面板与通用表格骨架待核对；callback 缺失 |
| `/dashboard/system/digital-display` | C（客户端页面/请求） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；页面展示结构与通用表格骨架待核对；callback 缺失 |
| `/dashboard/system/logs` | C（客户端页面/请求） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失；明确日志请求是否重取 |
| `/dashboard/system/operator-management` | C（客户端页面/请求） | callback：`operator-management/page.tsx` | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；核对多表/操作区骨架和 loading 状态 |
| `/dashboard/system/project-info` | C（客户端页面/请求） | router.refresh fallback | `system/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；callback 缺失；列表/编辑交互骨架待核对 |
| `/dashboard/table-showcase` | C（客户端页面/请求） | router.refresh fallback | `table-showcase/loading.tsx` → `TablePageLoading` | S；B-nav + B-refresh；确认 demo 是否有可刷数据及骨架用途 |
| `/dashboard/tools/brand-registration-example` | RSC（服务端/静态） | router.refresh fallback（无业务数据 callback） | `tools/loading.tsx` → `SimplePageLoading` | S；B-nav + B-readonly；核对图文布局；Head 刷新可标为静态/不适用 |
| `/dashboard/tools/markdown-to-word` | H（服务端入口 + 客户端子树） | router.refresh fallback | `tools/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；确认是否有可重取数据，核对工具表单骨架 |
| `/dashboard/tools/page-render` | H（服务端入口 + 客户端子树） | router.refresh fallback | `tools/page-render/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；工具编辑/预览结构与 Simple 骨架待核对 |
| `/dashboard/tools/product-label` | H（服务端入口 + 客户端子树） | router.refresh fallback | `tools/loading.tsx` → `SimplePageLoading` | S；B-nav + B-refresh；核对产品选择/标签工作区骨架及刷新是否适用 |

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

## Stage 2–4 可执行范围

- **Stage 2（优先）**：逐项核查本表中 C/H + `router.refresh fallback` 的 51 条路由，以及 scheduled-reports client layout 管理的 3 个 URL。优先 CRM tasks（`listTasks` 由 effect/load 驱动，页面为看板/列表）；随后 CRM customers/leads/follow-ups/SEA/settings、AI/员工与洞察、research-analysis、shipping-plan、报告/系统管理等真实客户端读数据页面。对上传/生成/编辑/静态页判定 callback、RSC 重取或不适用，禁止只加形式 callback。每条变更补 callback handler 请求断言、loading/错误状态测试，并更新本清单。
- **Stage 3**：复核其余 callback 路由是否确实覆盖主数据源；验证 RSC-only/redirect/static 页面；按域修复本表骨架疑点。优先审视 operations 域通用 `AnalyticsPageLoading`，其次 CRM tasks/dashboard、Agent Center、报告生成/定价、System 操作页等。
- **Stage 4**：统一开始/成功/失败可访问反馈、spinner/loading 语义、错误恢复、明暗主题与 reduced-motion；检查阅读期间是否有不必要的全页禁用，并做跨路由回归。

## 本阶段验证记录

- **静态检查（已执行）**：CodeGraph 索引健康；枚举 `frontend/app/dashboard/**/page.tsx` 得到 90 条路由记录；对页面与相对/别名导入链检查 `useHeaderRefresh` 和最近的 loading 边界。静态结论仅描述当前代码结构。
- **自动化测试（未执行）**：本阶段只新增维护文档，按 T0 不运行 Vitest/lint。仓库现存 `terminal-header.test.tsx`、`page-skeletons.test.tsx`、`crm/tasks/page.test.tsx` 等未在本阶段运行，不能视为本次测试通过。
- **浏览器验证（未执行）**：未启动 Dashboard 服务，也未点击 Head 刷新；本清单中所有 `B-*` 均为待执行验收，不构成已通过声明。
