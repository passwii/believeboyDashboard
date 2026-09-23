# 前端 Terminal 共享组件首轮盘点

> **状态：** 首轮盘点完成。**范围：** 高复用共享控件的现状契约核对；只有可复现偏差才改生产实现。

## 设计边界

- `frontend/docs/design-spec.md` 登记的 V3 Terminal 规则适用于 term surfaces。
- `frontend/components/ui/tabs.tsx` 的 default variant 与 AI Chat V2 是独立设计表面，保留既有圆角/渐变/投影。本轮只核对 `variant="term"`，不把 Terminal 规则套到 default Tabs。
- `frontend/components/ui/table.tsx` 的 `STICKY_TOP_*` 使用单像素 inset 阴影作为边界线表达；这是 `frontend/docs/table-spec.md` 的既有约定，不属于卡片投影阴影，不作全局清理。
- 各组件的行为、业务数据含义与公共 API 保持不变。

## 基线盘点

| 组件 | 文件与验证 | 检查结果 | 首轮处理 |
|---|---|---|---|
| Button | `components/ui/button.tsx`、`button.test.tsx` | 圆角/尺寸档、disabled、u-press/u-focus/u-interactive 及有意的暗色 `u-btn` 变体均有契约 | 暂无可复现的共享组件缺口；不改 API |
| Input | `components/ui/input.tsx`、`input.test.tsx` | rounded-none、term 背景/边界、mono、`aria-invalid`、focus glow、尺寸档及 shadow-none 均有测试 | 登录页的专用输入高度/placeholder contrast 已局部完成；基础 Input 暂不改 |
| Tabs | `components/ui/tabs.tsx`、`tabs.test.tsx` | term variant 有 h-10/直角/选中态指示条测试；default variant 有意保持 V2 外观 | term 行为保持；default 外观不纳入 Terminal 重写 |
| Table | `components/ui/table.tsx`、`table.test.tsx` | sticky 背景使用实体 term 色；边界用 inset 1px separator token；移动端 max-content 横滑有契约 | 按页面使用场景继续验证，不改全局表格 API 或 inset 分隔线 |
| Terminal controls | `components/terminal/term-controls.tsx`、`term-controls.test.tsx` | TERM_BUTTON/INPUT/SELECT_NATIVE 尺寸阶梯、直角与 term token；TermTabBar selected ARIA 有基线 | 本轮基线保持，不新增重复的 term-shared 副本 |
| Terminal shell | Rail/SubNav/Header/Inspector/Footer + 同目录测试 | 56px/36px/顶部基准带常量已有引用；Header 状态和 Footer accessible name 已补回归；Rail 与 Footer Lucide stroke 收至 1.75 | 保留本轮明确修复；不为形成更大视觉改造而修改其他既有交互 |
| Dialog/Sheet | `components/ui/dialog.test.tsx`、`sheet.test.tsx` | `rounded-none`、`shadow-none`、term 背景/边界与 dark floating-glass 分离规则均有测试；Dialog title 实例提供标题 | 当前无新缺口；不改浮层公共 API |
| Empty states | `components/ui/empty-state.tsx` | 已使用 term-faint 图标、term-muted 文案与 term-raised 虚线容器 | 未发现会阻塞任务的复现差异；页面状态场景由后续页面批次覆盖 |

## 验证证据

- 外壳六组件基线：
  `pnpm exec vitest run components/terminal/terminal-rail.test.tsx components/terminal/terminal-subnav.test.tsx components/terminal/terminal-header.test.tsx components/terminal/terminal-inspector.test.tsx components/terminal/terminal-footer.test.tsx components/terminal/use-terminal-layout.test.ts --pool=threads --maxWorkers=1 --reporter=dot`
  最终基线 **6 files / 57 tests passed**。
- 共享 Button/Input/Tabs/Table/Term Controls：
  `pnpm exec vitest run components/ui/button.test.tsx components/ui/input.test.tsx components/ui/tabs.test.tsx components/ui/table.test.tsx components/terminal/term-controls.test.tsx --pool=threads --maxWorkers=1 --reporter=dot`
  **5 files / 34 tests passed**。
- Dialog/Sheet token 与标题基线：
  `pnpm exec vitest run components/ui/dialog.test.tsx components/ui/sheet.test.tsx --pool=threads --maxWorkers=1 --reporter=dot`
  **2 files / 4 tests passed**。
- Footer 状态语义、Header 尺寸/pressed 状态与 L1/Footer stroke 缺口均先通过失败测试复现，再以最小生产代码修正；针对 Header/Footer/Rail 的最后一组 targeted tests **44 tests passed**。

## daily-analysis 代表页（Task 6）审计更新

- 入口：`frontend/app/dashboard/operations/daily-analysis/page.tsx` → `DailyAnalysisPage` → `daily-analysis-client.tsx` 中默认导出的页面组件。
- 调用面：页面使用 `MetricSwitcherCard`、通用 `Table`/`table-presets`、`DataTableCard`、全局 Header 筛选槽及 `MobileFilterStrip`。`DailyAnalysisTable` CodeGraph callers 只有 dashboard-v2 主页，按例外不触及。
- 可复现偏差：daily-analysis 汇总/明细表面仍使用 `surface-panel` 透明背景、`surface-soft/strong` 与 `--primary` 斑马行；SKU 日期 sticky header cell 未走实体 term 色。新增 `mobile-filter-strip-pilot.spec.ts` 的桌面契约先失败（收到 `bg-[hsl(var(--surface-panel))]/94...`），随后改为实体 `bg-term-panel/raised/hover`；移动筛选的旧 6/6 浏览器回归保持通过。
- `MetricSwitcherCard` 两种选择控件存在真实 V3 偏差：图表形态 segmented control 为 h-7 圆角/默认色，指标选择活跃态以透明 `bg-primary` 和圆形指示条表达，且无专用键盘 focus-visible ring。新增单测先失败，修正为 h-9 零圆角 term 控件、明确 `role=group`/label、`aria-pressed`、term accent focus ring、term-raised active surface 和方形 accent 指示条。
- 验证：`PLAYWRIGHT_PORT=3248 pnpm exec playwright test tests/dashboard/mobile-filter-strip-pilot.spec.ts --project=mobile` **7 passed**，包含 dark reload 与 reduced-motion 下图表形态选择交互；截图已在同一次检查中目视对比，未保留临时文件。`pnpm exec vitest run components/dashboard/metric-switcher-card.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts components/terminal/daily-analysis-table.test.tsx --pool=threads --maxWorkers=1 --reporter=dot` **4 files / 22 passed**；`pnpm lint` 0 errors / 27 warnings；单独重跑 `pnpm build` 通过（一次与并行 dev server 同跑时发生 font resolver 失败，未复现）；Impeccable detector 输出 `[]`。

## order-info 代表页（Task 7）审计更新

- 入口：`frontend/app/dashboard/reports/order-info/page.tsx` → `OrderInfoPage` → `OrderInfoPageInner`；`TermTable` / `TermTHead` 源自 `frontend/components/terminal/term-table.tsx`，共 20 个调用页面。具体 numeric 行仅修正 shared primitive 的 `numeric` 分支，保持 API 不变。
- 页面表格已有实体 `bg-term-raised` sticky header、`term-panel` 面板、零圆角、内部滚动容器；新增 mobile fixture 检查手机端筛选折叠展开、2 列网格、宽表仅在自身区域横滑、页面不整体溢出，并在 light/dark 验证 sticky 背景不透明。视觉复核另捕获四尺寸/主题截图；移动筛选调整为两列 filter 组 + 三条全宽搜索与清空按钮，避免固定 130/150px 触发器嵌在全局 2 列 grid 造成不均匀布局。
- 发现并复现 shared 数字列缺口：`TermHead numeric` / `TermCell numeric` 只 `text-right`，没有显式 tabular number treatment。`page.test.tsx` 新契约先失败，分别捕获 header 与 cell 缺失；已在 primitive 两个 numeric 分支补齐 `tabular-nums`，金额与数量调用增加显式数值类。
- BLF-616 订单移动端既有测试因直接寻找折叠面板中的项目 combobox 而基线超时；page snapshot 确认订单表已渲染、MobileFilterStrip 未展开。测试已适配 BLF-940 现状，检查真实的类型/状态/币种 3 个页面筛选项、两列短筛选、全宽关键词输入、表格内部横滑和页面无溢出；截图审查促使移动筛选控件按两列/全宽分组，避免固定宽 Select 撑出网格。
- 验证：订单移动浏览器用例在 mobile project **1/1 passed**（包含 light/dark reload、sticky header 实体背景、折叠筛选展开和表内横滑）；vitest `app/dashboard/reports/order-info/page.test.tsx components/dashboard/ad-data/ad-data-explorer.test.tsx app/dashboard/finance/exchange-rate/page.test.tsx components/terminal/daily-analysis-table.test.tsx` **4 files / 28 passed**；lint 0 errors / 27 warnings；单独运行 build 通过；Impeccable detector 输出 `[]`。
- 同一 BLF-616 文件另外 5 个旧 report page 用例仍失败于缺失的旧标题/站点 Group 选择器，快照确认页面内容已渲染（如 heading 实为“可核对月报”/“核算参数”、站点以全局折叠条呈现）。它们不触及 OrderInfoPage/TermTable 修改，本批记为既有 e2e selector/路由假设漂移，不计入订单用例通过数。

## Task 8 全局验证状态

- 全量 `pnpm test -- --pool=threads --maxWorkers=4 --reporter=dot`：后台 runner 尚未返回完整汇总；此前历史执行超过 runner 时限。本轮不得据局部结果声明全量 suite 全绿。
- 本轮相关 Playwright：`operations-mobile-blf614.spec.ts` 与 `mobile-filter-strip-pilot.spec.ts` 已完成；order-info mobile fixture 1/1 通过。整个 `reports-mobile-blf616.spec.ts` 当前 5 个非订单页用例仍按旧 title / 旧直接可见筛选器语义断言，页面 snapshot 显示真实路由内容已挂载，但既有 selector 漂移造成超时；订单用例单独通过。
- reduced-motion spec 的 route-switch 用例本身因 auth fixture 在 CI 被 `test.skip`；order-info 页面移动浏览器用例包含 reduced-motion 下图表选择操作验证（daily-analysis 页面测试亦含此项）。reduced-transparency 页面级 spec 不可在无登录账号的本地 fixture 下作为完整 shell 登录验收证据。
- 视觉批量检查：外壳/daily-analysis/order-info light/dark 目标截图在 bounded pass 中目视审查；截图未保留为仓库产物。
- lint：0 errors / 27 warnings；build：单独运行通过；detector：受影响 UI 返回 `[]`。

## 后续组件修正准入

目前首轮其余 Button/Input/term Tabs/Table/Dialog/Sheet 缺口没有经验证的 bug，因此不安排无目标的共享组件重写。default Tabs、dashboard-v2 与表格 separator 的既有例外继续保留。
