# BelieveBoy 前端 Terminal 模块扩展路线图

> **状态：** 首轮登录、外壳、共享原子组件盘点、daily-analysis、order-info 已完成；以下为后续独立批次计划，按真实 sidebar 路由与现有测试建立，不代表这些页面均已重新验收。
>
> **路由来源：** `frontend/lib/sidebar-config.ts` 的 `SIDEBAR_TOP_GROUPS`；嵌套路由按 `frontend/app/dashboard/**/page.tsx` 复核。测试文件均由 `frontend/tests/dashboard/` 实际存在路径确认。

## 扩展边界

- 每批实现前重新用 CodeGraph 定位路由入口、组件调用者、相关共享 UI；不得从此表推定后续实现细节。
- 保持页面的筛选/URL/API/权限/排序/导出/编辑流程与数据语义；测试 fixture 不依赖真实 VPS。
- 新批次沿用 V3 Terminal、`term-controls`、现有移动筛选与表格配方。`dashboard-v2` 首页与 design-spec 中的 AI Chat 独立设计面是例外；除用户另行批准，不纳入模块迁移。
- 本路线不扩展登录页；登录批次已有独立实施记录与提交。

## 推荐批次

### A. Operations 存量页面

**排序理由：** daily-analysis 是已完成的代表样板，运营域覆盖面最大；先处理已有独立移动回归、再沿相同结构按页面族扩展。

**已核实导航路由（`operations` 分组）：**

- `/dashboard/agent-center/overview`
- `/dashboard/agent-center/employees`
- `/dashboard/operations/site-navigation`
- `/dashboard/operations/store-navigation`
- `/dashboard/operations/daily-analysis`（代表样板，已完成）
- `/dashboard/operations/return-analysis`
- `/dashboard/operations/project-goals`
- `/dashboard/operations/research-analysis`
- `/dashboard/operations/complaint-center`
- `/dashboard/operations/platform-inspection`
- `/dashboard/operations/inventory-analysis`
- `/dashboard/operations/weekly-product-analysis`
- `/dashboard/operations/portfolio-overview`
- `/dashboard/operations/sku-info`
- `/dashboard/operations/inventory-replenishment`
- `/dashboard/operations/inventory-ledger`
- `/dashboard/operations/seasonal-replenishment`
- `/dashboard/operations/shipment-management`
- `/dashboard/system/agent-management`（由运营组 Agent 接入管理入口链接）
- 附属嵌套路由：`/dashboard/operations/complaint-center/list`

**已有主要浏览器回归：**

- `frontend/tests/dashboard/ops-mobile-blf613.spec.ts`（核心销售/运营工作台移动路径）
- `frontend/tests/dashboard/operations-mobile-blf614.spec.ts`（组合分析、周商品分析、平台巡检）
- `frontend/tests/dashboard/operations-mobile-blf615.spec.ts`（站点/店铺导航）
- `frontend/tests/dashboard/mobile-filter-strip-pilot.spec.ts`（首页与 daily-analysis BLF-930；主页只做既有例外回归，不迁移其 V2 卡片体系）
- `frontend/tests/dashboard/home-mobile-blf621.spec.ts`（dashboard-v2 主页例外；仅在外壳公共变化时回归）

### B. Reports 与订单/核算工作区

**排序理由：** order-info 已验证 shared TermTable numeric 合约；报表有较高的数据表/筛选复用，后续能验证实体 sticky 表头、导出与复杂空/错态。

**已核实导航路由（`reports` 分组）：**

- `/dashboard/reports/monthly-report/display`
- `/dashboard/reports/monthly-report/generate`
- `/dashboard/reports/monthly-report/reconcile`
- `/dashboard/reports/product-analysis`
- `/dashboard/reports/pricing-calculation/new-product`
- `/dashboard/reports/pricing-calculation/shop-calculation`
- `/dashboard/reports/pricing-calculation`（共享导向入口）
- `/dashboard/reports/scheduled-reports`
- `/dashboard/reports/scheduled-reports/ledger`
- `/dashboard/reports/scheduled-reports/subscriptions`
- `/dashboard/reports/auto-upload`
- `/dashboard/reports/order-info`（代表样板，已完成）
- `/dashboard/reports/report-reconciliation`（旧路由仍存在，回归前确认导航与重定向现状）

**已有主要浏览器回归：**

- `frontend/tests/dashboard/reports-mobile-blf616.spec.ts`（订单、月报核对、产品分析、定价；订单用例在移动筛选折叠、三类页面筛选、2 列/全宽输入、表格横滑与主题回归下通过。5 个非订单用例仍使用失效的 heading/group 假设，单独修正前不把整文件结果当通过）
- `frontend/tests/dashboard/reports-mobile-blf617.spec.ts`（定时报告）
- 该域有 `page.test.tsx` / `daily-analysis-table.test.tsx` 可复用的 Vitest 范式；各新页面任务前用 CodeGraph 确认准确单测位置。

### C. Advertising

**排序理由：** 范围集中，存在自包含广告手机回归，可在扩展全量报表之前先验证密集图表/表格和日期筛选组合。

**已核实导航路由：**

- `/dashboard/advertising/ad-analysis/overview`
- `/dashboard/advertising/ad-analysis`
- `/dashboard/advertising/ad-analysis/budget`
- `/dashboard/advertising/ad-analysis/campaigns`
- `/dashboard/advertising/ad-analysis/placements`
- `/dashboard/advertising/ad-analysis/products`
- `/dashboard/advertising/ad-analysis/purchased-products`
- `/dashboard/advertising/ad-analysis/search-terms`
- `/dashboard/advertising/ad-analysis/targets`
- `/dashboard/advertising/ad-analysis/time-trend`
- `/dashboard/advertising/ad-analysis/traffic-quality`
- `/dashboard/advertising/ad-data`

**已有主要浏览器回归：** `frontend/tests/dashboard/ad-mobile-blf611.spec.ts`。桌面各子页如需视觉验收，按实际路由新增目标断言，不将 mobile 单测外推成整域桌面覆盖。

### D. Finance

**排序理由：** 高密度 ledger/numeric tables 很适合验证已改进的 `TermHead/TermCell numeric` shared contract；先复用近期 currency/commission table 调用方，再扩展发票。

**已核实导航路由：**

- `/dashboard/finance/platform-revenue`
- `/dashboard/finance/exchange-rate`
- `/dashboard/finance/vat-invoice`
- `/dashboard/finance/vat-invoices`
- `/dashboard/finance/commission-management`

**已有主要浏览器回归：** 当前未发现覆盖整个 Finance 域的专用 mobile Playwright 文件；应在独立页面计划中新增关键表格横滑/数值列断言，并运行现有 `frontend/app/dashboard/finance/exchange-rate/page.test.tsx` 与 `commission-management` 下页面/组件测试。

### E. CRM 客户与合作伙伴

**排序理由：** 典型的宽表格、工作台双栏、任务操作流；待 Reports/Finance 共用筛选与 table 样板通过后再扩展，控制业务交互回归风险。

**已核实导航路由：**

- `/dashboard/crm/dashboard`
- `/dashboard/crm/follow-ups`
- `/dashboard/crm/customers`
- `/dashboard/crm/sea`（customers 子入口，当前子路径仍在导航 active prefixes）
- `/dashboard/crm/leads`
- `/dashboard/crm/tasks`
- `/dashboard/crm/audit`
- `/dashboard/crm/settings`
- `/dashboard/crm`（CRM 根入口）
- `/dashboard/crm/workbench`

**已有主要浏览器回归：** `frontend/tests/dashboard/crm-mobile-blf618.spec.ts`；已有页面单测集中于 `frontend/lib/crm/**` 和部分 `components/crm/**`，其准确调用关系由后续批次 CodeGraph 补充。

### F. System

**排序理由：** 账号/项目/日志/告警有各自权限与状态面；作为最后一批处理，确保独立业务状态与 V3 token 收口不混淆。

**已核实导航路由：**

- `/dashboard/system/changelog`
- `/dashboard/system/project-info`
- `/dashboard/system/data-management`
- `/dashboard/system/account-management`
- `/dashboard/system/operator-management`
- `/dashboard/system/alerts`
- `/dashboard/system/logs`
- `/dashboard/system/agent-management`（运营分组快捷入口）
- `/dashboard/system/digital-display`（侧栏未列导航入口，为恒暗投屏例外）

**已有主要浏览器回归：** `frontend/tests/dashboard/system-mobile-blf620.spec.ts`。digital-display 是恒暗展示表面；新增任何颜色/主题约束前先查 `frontend/docs/design-spec.md` §1.3。

## 例外与排除面

- `/dashboard` 使用 `components/dashboard-v2/` 蓝色单色卡片体系，保留设计例外。
- `/dashboard/ai/chat`、`/dashboard/ai` 与 `components/chat/*` 使用独立 AI Chat 设计面；路线批次不自动套用 V3 五条规则。
- 数字大屏 `/dashboard/system/digital-display` 与办公室 `?mode=presentation` 为恒暗投屏例外。
- `reports-mobile-blf616` 当前 5 个非订单旧用例页面已有内容但期望旧 heading/group trigger；需后续单独校正 fixture/断言，不能用跳过测试掩盖。

## 每批准入清单

每批开始前记录：真实 route、`page.tsx`/client entry、CodeGraph callers、页面/共用组件、对应 Vitest 与 Playwright 文件、light/dark 及 reduced-motion 验证入口、设计例外。只在发现一个可复现差异后按“失败断言 → 单点修复 → 同类调用方回归 → 主题/响应式检查”推进；无问题的区域标记“现状符合”。