# 顶部插槽全局改造实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development` 逐任务实现本计划。所有任务遵循 TDD：先补失败断言，再写最小实现，最后运行目标测试。

**目标：** 按已批准的 BLF-997 规范，将 Dashboard 顶部插槽统一为 h-10 / 四档宽度 / F1-F4 入槽 / F5-H-J 留正文，并完成存量页面与未迁移页面的全局收口。

**架构：** `TerminalHeader` 继续负责固定三段布局；页面通过 `useHeaderSlot` 提供桌面控件，通过 `useMobileFilterStrip` 提供移动端同源控件。所有插槽控件从 `header-filter-suite.tsx` 取共享原子，页面不再手写尺寸、刷新按钮或标题胶囊。

**技术栈：** Next.js App Router、React、TypeScript、Tailwind、Radix/shadcn、Vitest、Testing Library。

---

## 文件边界与职责

### 共享基建

- 修改：`frontend/components/terminal/header-filter-suite.tsx`
  - 增加 HeaderSlotInput、HeaderSlotButton、HeaderSlotBadge、必要的 MultiSelect 包装样式常量。
  - 保持现有全局四件套 API 不变。
- 修改：`frontend/components/terminal/header-filter-controls.tsx`
  - 桌面端继续单行裁切；移动分支保留兼容但改为零圆角 h-10 触发器，页面实际移动入口统一走 MobileFilterStrip。
- 修改：`frontend/components/terminal/header-filter-suite.test.tsx`
  - 锁定 h-10、宽度档、按钮变体、徽标契约。
- 修改：`frontend/components/terminal/header-filter-controls.test.tsx`
  - 锁定零圆角移动触发器和桌面单行契约。
- 修改：`frontend/components/terminal/mobile-filter-strip.test.tsx`
  - 锁定 44px 触控目标、摘要、宽控件整行契约。

### 存量插槽收口

- 修改：`frontend/app/dashboard/page.tsx`
- 修改：`frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx`
- 修改：`frontend/app/dashboard/finance/commission-management/page.tsx`
- 修改：`frontend/app/dashboard/finance/exchange-rate/page.tsx`
- 修改：`frontend/app/dashboard/finance/platform-revenue/page.tsx`
- 修改：`frontend/app/dashboard/reports/order-info/page.tsx`
- 修改：`frontend/components/dashboard/portfolio/portfolio-filters.tsx`
- 修改：`frontend/components/dashboard/ad-analysis/top-filters.tsx`
- 修改：`frontend/components/dashboard/ad-data/top-filters.tsx`

这些页面统一使用共享 h-10 原子、四档宽度、移动条；移除插槽内刷新；广告页补 MobileFilterStrip。

### 标题与刷新收口

- 修改：`frontend/app/dashboard/operations/complaint-center/complaint-center-client.tsx`
- 修改：`frontend/app/dashboard/operations/complaint-center/list/complaint-list-client.tsx`
- 修改：`frontend/app/dashboard/agent-center/overview/agent-overview-client.tsx`
- 修改：`frontend/app/dashboard/agent-center/employees/employees-client.tsx`
- 修改：对应既有测试文件

删除重复 PageHeader 胶囊和页内刷新入口；将日期、状态、分类、关键词等 F1/F2 控件迁移到 HeaderSlot，并同步移动端条。

### 未迁移页面

- 修改：`frontend/app/dashboard/system/operator-management/page.tsx`
- 修改：`frontend/app/dashboard/system/logs/page.tsx`
- 修改：`frontend/app/dashboard/ai/ad-analysis/page.tsx`
- 修改：`frontend/app/dashboard/reports/product-analysis/components/product-analysis-panel.tsx`
- 修改：对应既有测试文件或新增最小行为测试

先迁移低风险筛选/提交工作流；写操作、导出、执行核算保留正文。

### 后续工作流页

- 修改：`frontend/app/dashboard/reports/pricing-calculation/new-product/new-product-client.tsx`
- 修改：`frontend/app/dashboard/reports/pricing-calculation/shop-calculation/shop-calculation-client.tsx`

项目、SKU/产品搜索等 F1/F2 上移；快照选择、导出、生成/测算写操作保留正文。若插槽超过预算，低频测算结果选择器留正文。

---

## 任务 1：共享插槽原子与移动契约

**文件：** `header-filter-suite.tsx`、`header-filter-controls.tsx`、三组 terminal 测试。

- [ ] 先写失败测试：HeaderSlotInput 输出 h-10 + 指定宽档；HeaderSlotButton 的 primary/muted 变体同高；HeaderSlotBadge 为 h-10 只读容器；移动触发器无圆角。
- [ ] 运行目标测试，确认因导出不存在或类名缺失而失败。
- [ ] 实现最小共享原子，不引入新依赖，不改变现有全局四件套。
- [ ] 运行目标测试，确认通过。
- [ ] 使用 CodeGraph 复查共享导出调用面。

## 任务 2：存量页面尺寸与重复入口收口

**文件：** 首页、inventory-analysis、finance 三页、order-info、portfolio-filters。

- [ ] 为每页先补最小失败断言：插槽节点存在、控件使用 h-10/标准宽度、portfolio 不再出现刷新按钮、order-info 不再使用 h-9 本地常量。
- [ ] 将手写 Select/Input/Button 替换为共享原子；项目/站点/月份/年份/枚举按 W_SM/W_MD/W_LG/W_XL 取档。
- [ ] 删除 PortfolioFilters 的 RefreshButton，保持页面 `useHeaderRefresh` 语义。
- [ ] 保持现有 URL、筛选状态、数据加载和移动端行为不变。
- [ ] 运行每个页面既有测试与共享 slot 测试。

## 任务 3：广告页移动端与共享 layout 收口

**文件：**两处 ad top-filters 及对应测试。

- [ ] 先写失败测试：移动视口下 render 后 `terminal-mobile-strip` 获得过滤摘要和控件；桌面仍只使用 HeaderSlot。
- [ ] 把广告控件抽成同一 `controls` 节点，桌面 `useHeaderSlot(HeaderFilterControls isMobileView={false})`，移动 `useMobileFilterStrip(MobileFilterStrip)`。
- [ ] 保留下钻 token、清空下钻、项目加载错误和 URL 参数契约。
- [ ] 运行 ad top-filters 目标测试与移动挂载测试。

## 任务 4：标题与刷新唯一入口收口

**文件：** complaint center 两页、agent center 两页及测试。

- [ ] 先写失败测试：不再出现 PageHeader 标题胶囊；页内不再有名为“刷新”的按钮；插槽包含日期/状态/分类/关键词；移动摘要可见。
- [ ] 将可查询控件迁移为 F1/F2/F3；保留查看明细、新建/垃圾处理等 F5 写操作在正文。
- [ ] 删除 PageHeader 和重复刷新按钮；保留 `useHeaderRefresh`，用 ref 维持最新闭包。
- [ ] 运行四页目标测试和相关通知/表格测试。

## 任务 5：系统与 AI 低风险页面迁移

**文件：** operator-management、logs、ai/ad-analysis。

- [ ] 先写失败测试：月份/日志筛选/AI 生成参数出现在 HeaderSlot；移动端摘要可见；刷新仅由全局按钮触发。
- [ ] operator-management：月份入 F1，注册 `useHeaderRefresh`，删除页内 RefreshButton。
- [ ] logs：关键词/操作人/分类入 F2，查询/重置按 F3 进入插槽；日志详情与分页留正文。
- [ ] ai/ad-analysis：项目/国家/日期入 F1；立即生成保留正文作为 F5 写操作；Tabs 留正文。
- [ ] 运行对应页面测试；无测试的页面补最小可观察行为测试，不测试实现细节。

## 任务 6：工作流页面部分迁移

**文件：** product-analysis panel、new-product、shop-calculation。

- [ ] 先写失败测试：F1/F2 控件不再出现在正文控制台壳；F5 快照/导出/执行按钮仍可见且行为不变；插槽过宽时低频选择器留正文。
- [ ] product-analysis：项目/站点/日期进入插槽；检查数据保留为提交动作，执行核算留正文写操作。
- [ ] new-product：产品搜索进入插槽；测算结果多选若超过预算留正文；测算输入表单不移动。
- [ ] shop-calculation：项目/SKU 搜索/站点进入插槽；PricingSnapshotSelector、导出和测算结果留正文。
- [ ] 运行目标测试；保留现有写入、导出、快照审计语义。

## 任务 7：统一回归与真实页面验证

- [ ] 运行共享 slot、mobile strip、terminal header 测试。
- [ ] 运行所有改动路由的既有测试。
- [ ] 启动真实 frontend dev server，使用浏览器验证 1280/1440 桌面与移动视口：插槽裁切、移动条、刷新唯一入口、面包屑与右段不被挤坏。
- [ ] 运行 `pnpm lint`、`pnpm build`、`pnpm test`，记录真实 errors/warnings/passed/failed。
- [ ] 复查 `git diff`，确认无 `TODO`、`console.log`、debugger、后端改动和平台注入 AGENTS.md。
- [ ] 请求最终代码审查，修复 Critical/Important 问题后再提交 PR。
