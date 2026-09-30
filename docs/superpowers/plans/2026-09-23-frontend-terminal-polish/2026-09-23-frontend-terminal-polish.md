# BelieveBoy 前端 Terminal 体验打磨实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 V3 Terminal 数据呈现和业务行为的前提下，先统一正式后台外壳、共享交互/动效基线及代表性运营页面，再按模块逐批扩展打磨。

**Architecture:** 先以现有规范和测试建立可验证的视觉/交互基线；优先修复 Terminal 外壳与共享原子组件，再以 `operations/daily-analysis` 和 `reports/order-info` 验证页面层模式。每批只改有清晰边界的共享组件或页面，沿用现有 `--term-*` 令牌、`components/motion/*` 原语和页面测试；dashboard-v2 主页例外不在默认迁移范围。

**Tech Stack:** Next.js 16 App Router、React 18、TypeScript、Tailwind CSS、Radix UI、Vitest/Testing Library、Playwright、Framer Motion。

## Global Constraints

- 正式页面遵循 `frontend/docs/design-spec.md`：零圆角、零阴影、1px 边界、数值 mono + tabular-nums、明暗双主题、终端控件尺寸阶梯。
- 外壳尺寸只从 `frontend/components/terminal/terminal-constants.ts` 读取；动效令牌变更须同步 `frontend/app/globals.css` 与 `frontend/lib/motion/tokens.ts`。
- 登录工作流以外的页面不得改业务数据语义、权限、API 或交互流程；任何动画不得遮挡数据、延迟关键操作或隐藏重要内容。
- 复用 `frontend/components/motion/*`；尊重 reduced-motion、reduced-transparency、触摸设备和既有性能约束。
- dashboard-v2 是 `frontend/docs/design-spec.md` 登记的刻意例外。不得把它作为 V3 页面重写；如需触及，必须先回到用户确认的设计范围。
- 前端验证顺序：`pnpm lint` → `pnpm build` → `pnpm test`；相关 Playwright 与无障碍/动效测试按影响面运行。

---

## 文件结构与交付边界

### 本计划覆盖的首轮文件

- `frontend/components/terminal/terminal-shell.tsx`：外壳组合、移动导航抽屉、页面过渡挂载。
- `frontend/components/terminal/terminal-rail.tsx`、`terminal-subnav.tsx`、`terminal-header.tsx`、`terminal-inspector.tsx`、`terminal-footer.tsx`：六区外壳视觉与状态细节。
- `frontend/components/terminal/terminal-constants.ts`、`frontend/components/terminal/use-terminal-layout.ts`：尺寸单源与布局状态，不新增散落魔法尺寸。
- `frontend/components/ui/button.tsx`、`input.tsx`、`tabs.tsx`、`card.tsx`、`table.tsx` 及其同目录既有测试：高频共享控件。
- `frontend/components/terminal/term-controls.tsx` 及 `term-controls.test.tsx`：终端工具行共享原语。
- `frontend/components/motion/PageTransition.tsx`、`NormalPageTransition.tsx`、`MotionFade.tsx`、`MotionStagger.tsx` 及现有对应测试：只在发现影响目标交互的可验证缺口时调整。
- `frontend/tests/design/` 与 `frontend/tests/a11y/`：共享布局、主题、减少动态偏好回归。
- `frontend/tests/dashboard/operations-mobile-blf614.spec.ts`、`frontend/tests/dashboard/reports-mobile-blf616.spec.ts` 和相关页面测试：代表性页面回归。
- `frontend/app/dashboard/operations/daily-analysis/` 与 `frontend/app/dashboard/reports/order-info/`：代表页面按阶段实际影响的组件和样式文件；实现开始前用 CodeGraph 查找入口及调用关系，并将精确文件清单补到对应阶段计划/任务记录。

### 后续模块扩展边界

首轮计划交付外壳、共享组件和两种代表页面模式。扩展到其他 operations / reports / advertising / finance / CRM / system 模块时，每次按导航域和复用影响面建立独立、可回归的阶段计划；在动该批 UI 前先列出实际路由、源文件、现有测试与设计例外，再执行相同检查流程。该机制用于控制全站改造范围，不授权改动 dashboard-v2 例外或业务/API。

---

## Task 1: 建立 Terminal 外壳回归基线

**Files:**
- Modify: `frontend/components/terminal/terminal-rail.test.tsx`
- Modify: `frontend/components/terminal/terminal-subnav.test.tsx`
- Modify: `frontend/components/terminal/terminal-header.test.tsx`
- Modify: `frontend/components/terminal/terminal-inspector.test.tsx`
- Modify: `frontend/components/terminal/terminal-footer.test.tsx`
- Modify: `frontend/components/terminal/use-terminal-layout.test.ts`

**Interfaces:**
- Consumes: 现有外壳组件 props、`TERMINAL_*` 尺寸常量和 `useTerminalLayout` 状态接口。
- Produces: 可锁定 rail/subnav/header/inspector/footer 的角色、可访问名称、展开/折叠状态与常量尺寸的回归断言；不改生产接口。

- [x] **Step 1: 读取现有外壳测试和源文件，记录当前真实交互**

运行：`cd frontend && pnpm vitest run components/terminal/terminal-rail.test.tsx components/terminal/terminal-subnav.test.tsx components/terminal/terminal-header.test.tsx components/terminal/terminal-inspector.test.tsx components/terminal/terminal-footer.test.tsx components/terminal/use-terminal-layout.test.ts`

结果：原有外壳测试通过；后新增 Header 高度/控制状态和 Footer 高度/可访问名测试，具体运行结果见 Step 3。

- [x] **Step 2: 为当前可见交互补充基线断言**

为每个目标组件只补缺失断言：主题/导航按钮有可访问名称；折叠按钮的 `aria-expanded` 与状态同步；当前导航项有当前状态语义；布局 hook 的 toggle 能往返切换；rail/subnav/header/inspector/footer 的尺寸引用 `terminal-constants.ts` 中对应常量，不在测试里硬编码另一个尺寸数值。

- [x] **Step 3: 运行目标测试确认基线通过**

运行：`cd frontend && pnpm vitest run components/terminal/terminal-rail.test.tsx components/terminal/terminal-subnav.test.tsx components/terminal/terminal-header.test.tsx components/terminal/terminal-inspector.test.tsx components/terminal/terminal-footer.test.tsx components/terminal/use-terminal-layout.test.ts`

结果：6 个外壳测试文件、57 tests 全通过；Header 新增尺寸与 `aria-pressed` 状态契约、Footer 新增尺寸与状态区域名称契约。另在 Rail/Footer 图标笔画 1.75 契约新增后，Rail/Header/Footer 目标组 3 个测试文件、44 tests 通过。

- [x] **Step 4: 提交测试基线**

```bash
git add frontend/components/terminal/terminal-rail.test.tsx frontend/components/terminal/terminal-subnav.test.tsx frontend/components/terminal/terminal-header.test.tsx frontend/components/terminal/terminal-inspector.test.tsx frontend/components/terminal/terminal-footer.test.tsx frontend/components/terminal/use-terminal-layout.test.ts
git commit -m "test(终端外壳): 补齐交互回归基线"
```

## Task 2: 打磨外壳对齐、密度与可访问状态

> 首轮实际修正已完成：Footer `<footer>` 增加 `role="status" aria-label="全局状态栏"`；Rail/Footer 的 Lucide 图标显式使用规范 `strokeWidth={1.75}`。Header 尺寸和两个侧栏切换状态现由 Task 1 的契约测试覆盖，不需额外改生产接口。

**Files:**
- Modify: `frontend/components/terminal/terminal-constants.ts`
- Modify: `frontend/components/terminal/terminal-rail.tsx`
- Modify: `frontend/components/terminal/terminal-subnav.tsx`
- Modify: `frontend/components/terminal/terminal-header.tsx`
- Modify: `frontend/components/terminal/terminal-inspector.tsx`
- Modify: `frontend/components/terminal/terminal-footer.tsx`
- Modify: `frontend/components/terminal/terminal-shell.tsx`
- Modify: Task 1 中受影响的外壳测试

**Interfaces:**
- Consumes: Task 1 外壳行为基线；V3 字号、图标、高度阶梯及外壳尺寸常量。
- Produces: 外壳结构与交互保持原有 props/路由行为；所有布局尺寸通过既有常量或规范阶梯表达。

- [ ] **Step 1: 根据现有测试新增一个可复现的外壳回归断言**

针对审计确认的第一处具体偏差，先新增单一失败测试：检查不同外壳区域的顶部分割线/控制高度对齐，或测试超窄视口中控件无重叠。选择的断言必须指向真实 DOM 与常量，不允许使用脆弱的整页快照。

- [ ] **Step 2: 运行该测试确认失败**

运行：`cd frontend && pnpm vitest run components/terminal/terminal-shell.test.tsx`

预期：FAIL，失败信息对应已确认的外壳偏差。若 Task 2 的新增断言属于既有单组件测试，则将命令改为该真实测试路径并同步更新此计划。

- [ ] **Step 3: 最小修复偏差**

在 `terminal-constants.ts` 中只在存在缺失的共享尺寸概念时新增常量；组件通过引用该常量统一尺寸。清理与设计规范冲突的圆角、阴影、档外字号/图标尺寸；所有新颜色使用现有 term token。保留桌面 Inspector/导航开关、移动 Sheet、主题切换、键盘快捷键与 URL 路由行为。

- [ ] **Step 4: 验证外壳单测与视觉契约测试**

运行：`cd frontend && pnpm vitest run components/terminal`

预期：PASS；对修改过的 DOM 保持现有 aria/test id 契约，不通过放宽断言掩盖布局问题。

- [ ] **Step 5: 提交外壳调整**

```bash
git add frontend/components/terminal
git commit -m "fix(终端外壳): 收口布局与交互细节"
```

## Task 3: 校准外壳过渡和移动端导航体验

**Files:**
- Modify: `frontend/components/terminal/terminal-shell.tsx`
- Modify: `frontend/components/terminal/terminal-subnav.tsx`
- Modify: `frontend/components/terminal/terminal-inspector.tsx`
- Create: `frontend/components/terminal/terminal-shell.test.tsx`
- Modify: `frontend/tests/a11y/reduced-motion.spec.ts`
- Modify: `frontend/tests/a11y/reduced-transparency.spec.ts`

**Interfaces:**
- Consumes: Task 2 的外壳尺寸/布局基线及现有 motion primitives。
- Produces: 保持 `TerminalShell({ children })` 公共接口；开合与路由状态按当前 motion 系统过渡，减少动态偏好下直接退化为无过渡状态。

- [ ] **Step 1: 写移动端抽屉与面板开合的行为测试**

断言移动端导航由可见按钮打开、选择导航后关闭；桌面子导航/Inspector 的控制状态与可访问属性同步。对 reduced-motion 环境，断言内容仍立即可见且没有必需动画才能完成的交互。

- [ ] **Step 2: 运行新增测试确认缺口**

运行：`cd frontend && pnpm vitest run components/terminal/terminal-shell.test.tsx && pnpm test:ui -- tests/a11y/reduced-motion.spec.ts tests/a11y/reduced-transparency.spec.ts`

预期：新增 shell 单测在需要修复的行为上失败；Playwright 无障碍用例保持既有环境配置，不把浏览器 spec 交给 Vitest。

- [ ] **Step 3: 用现有原语实现有层次的开合反馈**

复用已有 Transition/Radix 动效；将动画限制在 transform/opacity 等合适属性；不新增常驻动画、全局 pointermove 监听或不必要的 token。reduced-motion 时保证面板即刻到达目标状态。

- [ ] **Step 4: 验证单测与浏览器无障碍用例**

运行：`cd frontend && pnpm vitest run components/terminal && pnpm test:ui -- tests/a11y/reduced-motion.spec.ts tests/a11y/reduced-transparency.spec.ts`

预期：两类测试均 PASS。若浏览器测试需本地登录或服务，按 `frontend/tests/setup/global-setup.ts` 的既定 fixture 配置执行并记录环境前置条件。

- [ ] **Step 5: 提交外壳动效调整**

```bash
git add frontend/components/terminal frontend/tests/a11y/reduced-motion.spec.ts frontend/tests/a11y/reduced-transparency.spec.ts
git commit -m "feat(终端外壳): 强化可访问的面板过渡"
```

## Task 4: 共享交互组件状态基线与缺口盘点

> **设计边界：** `frontend/components/ui/tabs.tsx` 的 default variant 与 AI Chat V2 是登记的独立设计表面，保留既有圆角/渐变/投影。此任务只审查 `variant="term"` 与控件交互/可访问状态，不把 V3 Terminal 规范套用至该例外；`table.tsx` 中按规范用于 1px 表格分隔线的 inset shadow 也保留。

**Files:**
- Read/Modify: `frontend/components/ui/button.test.tsx`
- Read/Modify: `frontend/components/ui/input.test.tsx`
- Read/Modify: `frontend/components/ui/tabs.test.tsx`
- Read/Modify: `frontend/components/ui/table.test.tsx`
- Read/Modify: `frontend/components/terminal/term-controls.test.tsx`
- Read: `frontend/docs/design-spec.md`
- Read: `frontend/docs/table-spec.md`
- Create: `docs/superpowers/plans/2026-09-23-frontend-terminal-polish/2026-09-23-frontend-terminal-polish-component-inventory.md`

**Interfaces:**
- Consumes: Task 2/3 建立的 shell 外观、现有 UI 组件 API 与 V3 规范。
- Produces: 组件缺口清单，逐项列出组件、实际偏差、调用面、测试和是否纳入后续修正；不变更生产 API。

- [ ] **Step 1: 运行已有共享组件测试作为现状基线**

运行：`cd frontend && pnpm vitest run components/ui/button.test.tsx components/ui/input.test.tsx components/ui/tabs.test.tsx components/ui/table.test.tsx components/terminal/term-controls.test.tsx`

预期：PASS。若测试文件不存在，用 `codegraph files --path frontend/components/ui` 确认真实文件名，并在 inventory 记录实际路径。

- [ ] **Step 2: 检查暗/亮主题和交互状态的契约**

仅对目标组件检查默认、hover、focus-visible、active、disabled、loading 及适用的错误状态。核对 term variant、按钮/输入高度、键盘导航、Radix 状态；仅记录可复现或由规范明确禁止的偏差。

- [ ] **Step 3: 写入组件盘点清单**

为每个偏差填写源文件、现有调用方类别、复现步骤、相关测试及风险；按“使用面 × 用户任务重要性”排序。将未发现偏差的组件标为本轮无需改动，不为制造工作而改变 API。

- [ ] **Step 4: 检查文档和盘点完整性**

运行：`rg -n "TODO|TBD|待定|占位" docs/superpowers/plans/2026-09-23-frontend-terminal-polish/2026-09-23-frontend-terminal-polish-component-inventory.md`

预期：无未解决占位；文件中每条偏差都带有可运行的验证命令。

- [ ] **Step 5: 提交组件盘点**

```bash
git add docs/superpowers/plans/2026-09-23-frontend-terminal-polish/2026-09-23-frontend-terminal-polish-component-inventory.md
git commit -m "docs(前端组件): 盘点终端交互状态缺口"
```

## Task 5: 修正共享控件的已确认缺口

**Files:**
- Modify: `frontend/components/ui/button.tsx` 与对应测试（只在 inventory 指认时）
- Modify: `frontend/components/ui/input.tsx` 与对应测试（只在 inventory 指认时）
- Modify: `frontend/components/ui/tabs.tsx` 与对应测试（只在 inventory 指认时）
- Modify: `frontend/components/ui/table.tsx` 与对应测试（只在 inventory 指认时）
- Modify: `frontend/components/terminal/term-controls.tsx` 与对应测试（只在 inventory 指认时）
- Modify: `frontend/app/globals.css` 与 `frontend/lib/motion/tokens.ts`（仅当确需同步修改动效 token）

**Interfaces:**
- Consumes: Task 4 inventory 中经设计规范验证的具体缺口。
- Produces: 公共 API 保持向后兼容的组件状态修复；若确需 API 改变，先由代码检索找到并迁移全部调用方，且在计划记录中给出精确签名。

- [ ] **Step 1: 按缺口逐一写失败测试**

选择 inventory 第一项，在对应测试中写一个用户可观察行为断言，如 keyboard focus、disabled 不触发回调、term 尺寸/语义色/状态可访问；一项缺口对应一条有价值断言。

- [ ] **Step 2: 运行单个测试确认失败**

运行：`cd frontend && pnpm vitest run <由组件盘点清单指定的测试文件> -t "新增的行为契约描述"`

预期：FAIL，原因与缺口一致。执行前把 inventory 中的确切测试文件路径和该测试的 `it()` 标题原样代入命令并留在任务记录中。

- [ ] **Step 3: 修复实现且不改变业务语义**

仅在对应共享组件修复；颜色来自 `--term-*` / Tailwind term；圆角为 `rounded-none`，无阴影；高度和字体使用规范阶梯。动效 token 仅在现有值无法表达目标交互时才调整，并同步 CSS 与 JS。

- [ ] **Step 4: 运行变更组件和调用方测试**

运行：`cd frontend && pnpm vitest run components/ui/button.test.tsx components/ui/input.test.tsx components/ui/tabs.test.tsx components/ui/table.test.tsx components/terminal/term-controls.test.tsx`

预期：PASS，且无共享组件契约回归。inventory 另列出的页面/调用方测试在各自页面任务中运行；每完成一个独立组件/缺口，重复步骤 1–4 后再进入下一项。

- [ ] **Step 5: 提交一个组件边界内的变更**

```bash
git add frontend/components/ui frontend/components/terminal/term-controls.tsx frontend/components/terminal/term-controls.test.tsx frontend/app/globals.css frontend/lib/motion/tokens.ts
git commit -m "fix(共享组件): 修正已验证的终端状态"
```

实际暂存范围仅包含本次确有修改的文件。

## Task 6: 打磨运营分析代表页面

> 结果：daily-analysis 汇总/明细表切换到实体 term 背景/状态色；`MetricSwitcherCard` 指标选择和图表形态控制统一 Terminal 令牌、尺寸与键盘焦点。页面目标 Vitest 4 files / 22 tests、移动筛选/桌面/dark/reduced-motion Playwright 7/7、lint 0 errors（27 warnings）、独立重跑 build 通过、Impeccable detector `[]`。详细范围和命令见 `2026-09-23-frontend-terminal-polish-component-inventory.md`。

**Files:**
- Read/Modify: `frontend/app/dashboard/operations/daily-analysis/` 实际路由入口与直接呈现组件
- Read/Modify: `frontend/components/terminal/daily-analysis-table.tsx`（仅当调用图确认其为目标页共享实现）
- Read/Modify: `frontend/components/terminal/header-filter-suite.tsx`（仅当目标缺口属于全局筛选带）
- Modify: `frontend/tests/dashboard/mobile-filter-strip-pilot.spec.ts`
- Modify: 该页面已存在的 Vitest 测试

**Interfaces:**
- Consumes: Tasks 2–5 的 shell/控件状态基线；既有全局筛选 URL/state contract。
- Produces: daily-analysis 页面外观与交互回归，不改筛选字段、URL 参数语义、API 查询或权限。

- [x] **Step 1: 定位页面组件与调用面**

运行：`codegraph status .`、`codegraph files --path frontend/app/dashboard/operations`、`codegraph files --path frontend/components/terminal`；对页面入口符号执行 `codegraph query <真实符号> --kind component` 和 `codegraph callers <真实符号>`，再读取命中的源文件及 `operations-mobile-blf614.spec.ts`。

结果：`page.tsx` → 默认导出 daily-analysis 页面组件；确认 Header filter slot、MetricSwitcherCard、DataTableCard、Table 与移动 MobileFilterStrip 调用面。CodeGraph 确认 `DailyAnalysisTable` 仅被 dashboard-v2 主页引用，按例外未触及。页面浏览器基线与调用面记于 inventory。

- [x] **Step 2: 新增页面层失败回归断言**

结果：新增 `mobile-filter-strip-pilot.spec.ts` 桌面契约，检查 daily-analysis 汇总/明细表面使用实体 term token、sticky 色、不透明日期格与非重色斑马行；新增 `metric-switcher-card.test.tsx` 活跃/非活跃指标、图表形态交互、ARIА 状态和 V3 focus/尺寸断言。筛选 fixture 与 URL 语义保持原样。

- [x] **Step 3: 运行页面用例确认缺陷可复现**

运行：`cd frontend && pnpm test:ui -- tests/dashboard/operations-mobile-blf614.spec.ts`

结果：页面表格新断言先因 `bg-[hsl(var(--surface-panel))]/94...` 失败；MetricSwitcherCard 新断言先因 h-7 圆角选择器、active `bg-primary` 失败。目标测试确认偏差来源，随后修复。

- [x] **Step 4: 只改目标页或共享源头实现**

结果：daily-analysis 两类表格使用 `bg-term-panel / bg-term-raised / bg-term-hover`；`MetricSwitcherCard` active surface/indicator、focus ring 与 chart-kind group 切换统一 term token 和控件阶梯。没有改变筛选、URL、查询、Excel 导出或 dashboard-v2。

- [x] **Step 5: 验证桌面/移动、主题与 reduced-motion**

运行：`cd frontend && pnpm test:ui -- tests/dashboard/operations-mobile-blf614.spec.ts && pnpm vitest run app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts`

结果：`mobile-filter-strip-pilot.spec.ts` mobile project **7/7 passed**（含筛选折叠/展开/URL、桌面 1440、light/dark 实体表面、reduced-motion 下图表控件可用）；页面 Vitest 4 files / 22 tests passed。`pnpm lint` 0 errors、27 warnings；`pnpm build` 通过；Impeccable detector `[]`。light/dark 1440 截图已复核，文件路径记于 inventory。

- [ ] **Step 6: 提交页面批次**

```bash
git add frontend/app/dashboard/operations frontend/components/terminal/daily-analysis-table.tsx frontend/components/terminal/header-filter-suite.tsx frontend/tests/dashboard/operations-mobile-blf614.spec.ts
git commit -m "fix(运营分析): 打磨终端数据工作区"
```

结果：已完成；实际暂存范围仅含本批 6 个源代码、测试和计划记录文件。

## Task 7: 打磨报表代表页面并验证共享模式

> 结果：order-info 的 numeric 表头/单元格采用显式 `tabular-nums`；移动筛选将短选择器置于两列区、关键词搜索和清空筛选置于全宽区，按 393px 截图复核。BLF-616 订单 fixture 覆盖折叠交互、light/dark 实体 sticky 背景、表内横滑与页面无溢出。订单 mobile 1/1、关联 Vitest 4 files / 28 tests、lint 0 errors（27 warnings）、独立 build 通过、detector `[]`。BLF-616 中另外 5 个其它报表/计算页旧选择器失败情况见 component inventory。

**Files:**
- Read/Modify: `frontend/app/dashboard/reports/order-info/` 实际路由入口和直接呈现组件
- Read/Modify: `frontend/components/terminal/term-table.tsx`（CodeGraph 确认 order-info 页面使用；numeric 样式影响 20 个调用方，需验证 representative consumers）
- Read: `frontend/components/terminal/daily-analysis-table.test.tsx`（当前仓库存在的共用数据表测试）
- Modify: `frontend/tests/dashboard/reports-mobile-blf616.spec.ts`
- Modify: 该页面现存的 Vitest 测试

**Interfaces:**
- Consumes: Task 6 验证过的筛选带、数据表、加载/错误反馈模式；报表原有数据和导出行为。
- Produces: order-info 报表响应式/主题/状态回归；既有查询、排序、导出、列含义不变。

- [x] **Step 1: 用 CodeGraph 定位 order-info 页面和共享依赖**

运行：`codegraph files --path frontend/app/dashboard/reports`；按其入口真实 component 符号运行 `codegraph query <真实符号> --kind component` 和 `codegraph callers <真实符号>`；读取 `reports-mobile-blf616.spec.ts`、页面组件、`frontend/docs/table-spec.md`。

结果：`OrderInfoPage` → `OrderInfoPageInner` 使用 shared `TermTable / TermTHead / TermHead / TermCell`；页面里程碑测试为 `page.test.tsx` 与 `reports-mobile-blf616.spec.ts`。CodeGraph 显示 TermTable 共有 20 个调用方，代表测试取订单、ad-data、exchange-rate、daily-analysis 4 suite。sticky、数字和 mobile 约束依据 `frontend/docs/table-spec.md`。

- [x] **Step 2: 写一条针对目标偏差的失败测试**

结果：新增 `page.test.tsx` numeric table contract（header 与数量/金额 cell 均右对齐、tabular nums）；更新 `reports-mobile-blf616.spec.ts` 订单 case 以先展开 BLF-940 filter strip，再断言页面 3 个 filter 与两列表格筛选布局、12+ 列表格内部横滑/light-dark sticky 背景。fixture 与业务 data rows 保持原状。

- [x] **Step 3: 运行 Playwright 用例确认失败**

运行：`cd frontend && pnpm test:ui -- tests/dashboard/reports-mobile-blf616.spec.ts`

结果：新增 numeric header 断言在 `TermHead numeric` 首次失败，准确指向缺失 `tabular-nums`；数量 cell 追加断言再确认 `TermCell numeric` 同样缺样式。BLF-616 旧订单断言曾因未打开折叠筛选条而失败，修正交互步骤后订单用例通过。

- [x] **Step 4: 修复目标页面或共享 term-table 层**

结果：`TermHead numeric` 与 `TermCell numeric` 统一添加 `text-right tabular-nums`；订单页数量/金额单元格显式标注数值 tabular 样式。sticky `TermHead` 使用 `bg-term-raised` 不透明底色并按既有 1px 边界显示；列含义、排序、导出与业务语义不变。

- [x] **Step 5: 运行页面与共享组件测试**

运行：`cd frontend && pnpm test:ui -- tests/dashboard/reports-mobile-blf616.spec.ts && pnpm vitest run app/dashboard/reports/order-info/page.test.tsx components/terminal/daily-analysis-table.test.tsx`

结果：订单 mobile Playwright **1/1 passed**（light/dark reload，实体 sticky background，filter strip 和表内横滑）；目标及 3 个代表共享 consumer 的 Vitest **4 files / 28 passed**；`pnpm lint` 0 errors / 27 warnings；`pnpm build` 通过；Impeccable detector `[]`。整份 BLF-616 其它 5 个页面的 e2e selector/route 假设漂移见 inventory，不归入订单用例结果。

- [ ] **Step 6: 提交报表页面批次**

```bash
git add frontend/app/dashboard/reports/order-info frontend/components/terminal/term-table.tsx frontend/tests/dashboard/reports-mobile-blf616.spec.ts
git commit -m "fix(报表): 打磨终端订单信息页"
```

结果：已完成，实际提交文件见提交 `fix(报表): 打磨终端订单信息页`。

## Task 8: 全局验证、视觉复核与模块扩展路线图

> 结果：inventory 与模块 roadmap 已完成；订单筛选手机端调整为短控件双列与关键词全宽。相关订单 Playwright、28 项目标 Vitest、lint 与独立 build 通过；全量 Vitest 未回传最终摘要、BLF-616 非订单页有 5 项 selector 漂移、2 个 auth-dependent a11y spec 为 skipped，均如实保留为未全绿项。

**Files:**
- Read: `frontend/docs/design-spec.md`
- Read: `frontend/docs/motion-system.md`
- Read: `frontend/docs/perf-budget.md`
- Modify: `frontend/tests/dashboard/reports-mobile-blf616.spec.ts`（BLF-940 后移动订单控件分组 + header 横向 scroller 正确排除）
- Modify: `docs/superpowers/plans/2026-09-23-frontend-terminal-polish/2026-09-23-frontend-terminal-polish-component-inventory.md`
- Create: `docs/superpowers/plans/2026-09-23-frontend-terminal-polish/2026-09-23-frontend-terminal-polish-module-roadmap.md`

**Interfaces:**
- Consumes: Tasks 1–7 的可运行测试和两类代表页面实现。
- Produces: 首轮完成证据与按模块推进的可追踪路标；没有完成的模块明确保留为后续独立范围，不宣称全站已打磨完成。

- [ ] **Step 1: 跑项目规定的完整前端顺序**

运行：`cd frontend && pnpm lint && pnpm build && pnpm test`

结果：`pnpm lint` 0 errors / 27 warnings；`pnpm build` 单独运行通过（含 OpenAPI type check）；全量 `pnpm test -- --pool=threads --maxWorkers=4 --reporter=dot` 已启动后台 runner，当前仍未回传最终摘要，所以此 Step 保持未完成。

- [ ] **Step 2: 跑本轮相关浏览器测试**

运行：`cd frontend && pnpm test:ui -- tests/dashboard/operations-mobile-blf614.spec.ts tests/dashboard/reports-mobile-blf616.spec.ts tests/a11y/reduced-motion.spec.ts tests/a11y/reduced-transparency.spec.ts`

结果：已分别运行目标 suites；`operations-mobile-blf614.spec.ts --project=mobile` 为 2 passed / 3 失败（portfolio-overview 旧 Select 假设），`mobile-filter-strip-pilot.spec.ts --project=mobile` 7/7 passed，BLF-616 order-info mobile 单用例 1/1 通过而非订单另 5 项 selector 漂移，reduced-motion/transparency 的 auth-dependent 测试 skipped。此合并浏览器 Step 保持未完成，后续待修复旧用例并具备认证 fixture 后重跑。

- [x] **Step 3: 做一次桌面/移动批量截图检查并集中修复**

结果：按 1440px/393px、light/dark 对外壳、daily-analysis、order-info 做一次合并截图 pass；修复了 daily-analysis term 表面、订单 Numeric 列，并将移动订单筛选改成短控件双列 + 全宽搜索。截图仅存在于临时目录并已目视复核、不保留仓库附件；移动横溢测试排除了 Header 自有 overflow-x-auto scroller。

- [x] **Step 4: 建立模块扩展路线图**

结果：创建 `2026-09-23-frontend-terminal-polish-module-roadmap.md`，路由对照 `SIDEBAR_TOP_GROUPS` 和实际 page.tsx；列出 operations、reports、advertising、finance、CRM、system 的批次路由/现有主要移动 e2e、排序理由，并记录 dashboard-v2、AI Chat、恒暗 display 例外与 BLF-616 drift。

- [x] **Step 5: 更新首轮状态并写扩展计划**

结果：inventory 与 roadmap 已记录真实完成项、全量 Vitest 未回传、5 个 BLF-616 失效选择器与 2 个 reduced-motion/transparency skip。运行占位词扫描时唯一命中是父 plan 本身用于指导该扫描的命令说明；component inventory 与 module roadmap 本身未发现未处理占位。

- [x] **Step 6: 提交验证和路线图**

```bash
git add docs/superpowers/plans/2026-09-23-frontend-terminal-polish
git commit -m "docs(前端): 记录终端打磨验证与模块路线"
```

结果：Task 8 文档与订单移动筛选修正一并纳入本轮末尾提交 `docs(前端): 记录终端打磨验证与模块路线`。

---

## Definition of Done

- 外壳与首批共享组件按 V3 Terminal 规范回归，桌面和移动导航/布局交互可用。
- daily-analysis 与 order-info 两个代表页面通过相关目标单元、浏览器与主题检查；order-info、daily-analysis reduced-motion 目标操作已在浏览器用例覆盖。
- lint 0 errors、production build 通过；全量 Vitest runner 尚未返回汇总，reports BLF-616 仍有 5 项旧路由/selector 失败，2 个 auth-dependent a11y specs 在此无认证 fixture 环境下 skipped；这些均不标记为全绿。
- 一轮集中视觉检查及必要的一轮修正复核完成：Shell 与两个代表页面已按 1440/390、light/dark 批量目视复核；截图为临时检查材料，不纳入版本库。
- inventory 和 roadmap 明确记录首轮覆盖及后续模块边界；不把未处理页面宣称为已完成，也不重做 dashboard-v2 刻意例外。
