# 前端设计规范（FRONTEND-DESIGN-SPEC）

> **适用版本：** v1.0（BLF-497 定稿，2026-08-07）
> **适用对象：** 在 `frontend/` 下新增 / 修改 UI 的工程师
> **定位：** 全站前端设计的**总纲与对照基准**。所有页面打磨子 issue（BLF-498 ~ 501）以本文档为验收对照。
> **原则：** 文档与实际代码一致（每个条目都指向真实代码位置）；可执行、不空谈。

---

## 0. 文档地图（Master Index）

本文档是**唯一入口**，细分规范按主题拆在子文档，正文只保留"规则 + 指向"：

| 主题 | 文档 | 状态 |
|---|---|---|
| **本总纲**（设计语言 / 暗黑 / 组件 / 排版 / 移动 / 清单） | `docs/FRONTEND-DESIGN-SPEC.md`（本文件） | 权威 |
| 表格唯一配方（密度 / 对齐 / sticky / 空态） | `frontend/docs/table-spec.md` | 权威（BLF-496 定稿） |
| 图表与图例统一（ChartContainer / 豁免表） | `docs/chart-unification-spec.md` | 权威（BLF-495 定稿） |
| 硬编码色例外清单 + Token 红线 | `frontend/docs/design-spec.md` | 权威（§2 登记例外，本节 §2.2 转引） |
| 移动端适配规则（9 条） | `MOBILE_ADAPTATION_RULES.md` | 权威 |
| 动效体系（时长 / 缓动 / stagger） | `frontend/docs/motion-system.md` | 权威 |

> 修改某块规则时，改对应子文档即可；本文档只做入口与红线汇总，避免多源不一致。

---

## 1. 设计语言总纲

### 1.1 一句话定义

**Raycast 式玻璃质感暗黑 + `dashboard-surface` 表面体系**。参照物：Dashboard 主页（v2，`frontend/app/dashboard/page.tsx`）与表格展示页（`frontend/app/dashboard/table-showcase/page.tsx`）。新页面/新组件应"读起来像同一种材料"。

### 1.2 表面 token 分层（Surface 阶梯）

定义于 `frontend/app/globals.css`：

- **Light**（`:root`，globals.css:53-61）：`--surface-base`(210 28% 97%) → `subtle` → `panel` → `overlay` → `strong` → `soft` → `low` → `high` → `outline`。
- **Dark**（`.dark`，globals.css:144-152）：画布 L9% → 导航壳 L12% → 内容窗 L15% → 卡片 L19% → 浮层 L22~23% → 高亮 L26% 的明度阶梯，hue≈225 保留冷调呼应品牌蓝。

| token | 语义 | 典型用途 |
|---|---|---|
| `--surface-base` | 页面画布 | body / 最底层背景（与 `--background` 同值，可互换） |
| `--surface-subtle` | 微差底色 | 表头、chip、分隔区 |
| `--surface-panel` | 标准面板 | 卡片主体（dark 下与 `--card` 同值） |
| `--surface-overlay` | 浮起面板 | 弹窗 / 下拉 / 玻璃层 |
| `--surface-strong` / `--surface-high` | 高亮 / 强调 | hover 态、选中态 |
| `--surface-soft` / `--surface-low` | 柔和底 | 次级面板、内嵌块 |
| `--surface-outline` | 描边 | 分割线 |

**用法**：一律写 `bg-[hsl(var(--surface-*))]`；**不要**直接写 `bg-card` 之外的裸色值（见 §2 红线）。

### 1.3 表面构件类（globals.css @layer components）

| 类 | 位置 | 用途 |
|---|---|---|
| `.dashboard-surface` | globals.css:405-441 | **默认卡片**：rounded-lg + border + `--shadow-soft`；dark 下叠加"玻璃边"（顶部 1px 内高光 + 全周长内描边）+ 左上品牌光晕 `::after`。**全站卡片首选**（92+ 处共用）。 |
| `.dashboard-panel` | globals.css:443-454 | 次级面板（`--surface-soft` 底 + p-3/4），用于内嵌区块 |
| `.dashboard-subtle-panel` | globals.css:456-458 | 最轻量面板（`--surface-subtle` 底） |
| `.dashboard-glass` | globals.css:460-474 | 真玻璃（backdrop-blur 14~18px），仅用于**必须**玻璃质感的元素（浮层 / 导航浮窗） |
| `.dashboard-toolbar` | globals.css:540-552 | 工具栏容器（overlay 底 + 玻璃边） |
| `.dashboard-full-width` | globals.css:392-403 | 突破 max-width 限制（全宽表格区） |

> ⚠️ `.dashboard-surface` **故意不加 backdrop-filter**（globals.css:420-433 记录了历史决策：高 DPI 屏 blur 会糊掉 1px 边框与小字号）。需要玻璃质感时显式用 `.dashboard-glass`，不要给 surface 类补 blur。

### 1.4 色彩系统

- **语义色**：`--primary`（品牌蓝 214 89% 43% / dark 222 100% 68%）、`--success`/`--warning`/`--destructive`、`--muted-foreground`（次级文字）、`--data-positive/--data-warning/--data-negative/--data-neutral`（状态数据色，见 §3.2）。
- **图表色**：`--chart-1..7`（light: globals.css:38-44；dark: 125-131），见 §3.4 与 `docs/chart-unification-spec.md`。
- **描边**：`--stroke-soft` / `--stroke-strong`（图表 grid/线）。
- 所有色值都是 HSL 分量，必须经 `hsl(var(--...))` 取用，保证 dark 自动切换。

### 1.5 圆角 / 阴影 / 动效

- **圆角阶梯**：`--radius-xs(0.375rem) / sm(0.5rem) / md(0.625rem) / lg(0.75rem) / xl(1rem)`，`--radius` = lg（globals.css:70-75）。卡片用 lg，内嵌小块用 md/sm。
- **阴影**：`--shadow-soft`（默认卡片）/ `--shadow-raised`（hover 浮起）/ `--shadow-overlay`（浮层）（globals.css:76-78, 162-164）。用 `hover-lift` 类切换 soft→raised。
- **动效 token**：`--motion-fast(180ms) / base(240ms) / slow(320ms)`、缓动 `--motion-ease-out / standard`、`--stagger-step(70ms)`（globals.css:79-83）。**JS 侧必须同步** `frontend/lib/motion/tokens.ts`（`DURATION/EASE/SPRING/STAGGER`），改 CSS 必须同步 JS，反之亦然——`tokens.test.ts` 有数值断言锁契约。
- **交互工具类**：`u-interactive`（hover 上浮 1px）、`u-press`（按压 0.97）、`u-focus`（focus ring）、`animate-enter`（入场）、`animate-float`（浮动）、`stagger-item` / `u-stagger-item`（错落入场，见 globals.css:777-792）。

### 1.6 字体与排版

- **正文字体** `--font-sans`、**标题字体** `--font-display`（globals.css:204-210：h1~h4 用 display + `letter-spacing: -0.035em`）。
- **大数字**：`.dashboard-display`（clamp 2.15~2.75rem，globals.css:510-516）。
- **Eyebrow 小标**：`.dashboard-kicker`（`text-[0.68rem] uppercase tracking-[0.22em] text-muted-foreground`，globals.css:506-508）；pill 变体见 site-navigation（§4.1）。
- **根字号响应式**：17px（>1440px）→ 16px（1440 以下）→ 15px（1180 以下 / iPad）→ 16px（768 以下）→ 15px（480 以下），globals.css:216-253。**不要用固定 px 字号做页面级标题缩放**，字号全部 rem。

---

## 2. 暗黑模式规范

### 2.1 双主题机制

- 由 `next-themes` 提供：`frontend/components/theme-provider.tsx` + `theme-toggle.tsx`（顶部切换）。
- **每个颜色都必须在 light / dark 两套下可读**：写法是「token 自动适配」（推荐）或「浅色 + `dark:` 变体」。
- 页面**禁止**强制改主题（`document.documentElement.classList.add('dark')`），仅 §2.3 例外清单中的刻意页面允许。

### 2.2 Token 使用红线（禁则）

以 `frontend/docs/design-spec.md` §2 为准，核心四条：

1. **业务页面禁止裸用浅色硬编码**（无 `dark:` 变体时）：`bg-white` / `bg-slate-100` / `bg-gray-50` / `text-gray-700` / `border-slate-*` 等。统一改 `bg-[hsl(var(--surface-*))]` / `text-muted-foreground` 等 token。
2. **表格粘性表头**：单元格背景必须用**不透明** token（`bg-[hsl(var(--surface-subtle))]`），否则滚动时暗黑模式出现浅色带（实现见 `frontend/components/ui/table.tsx` 的 `STICKY_*` 常量，禁止手写 sticky 类）。
3. **状态色**：用 `StatusPill`（`components/ui/table-presets.tsx`，映射 `--data-*`）或 `Badge` 内置 variant（`success/warning/info/destructive/outline`，自带 dark 变体），禁止手写 `bg-slate-100 text-slate-800` 之类。
4. **改 token 双侧同步**：`globals.css` ↔ `lib/motion/tokens.ts`（§1.5）。

**自查基线**（BLF-494 后现状，供回归）：

```bash
# 业务页残留浅色硬编码（以下应为 0 或仅剩登记例外）
grep -rn "bg-white\b\|bg-slate-100\|bg-gray-50\|text-gray-700" frontend/app --include="*.tsx"
```

> 2026-08-07 核查：`app/` 下残留 `bg-white` 均已带 `dark:` 变体（login / full-screen-signup / commission-rules-card / operator-management）或属于登记例外（page-render 白底渲染），见 §2.3。

### 2.3 例外清单（登记制）

**凡"刻意不走 token"的位置必须登记在 `frontend/docs/design-spec.md` §1，禁止悄悄新增例外。** 当前已登记 3 类：

| 例外 | 范围 | 原因 |
|---|---|---|
| **AI Chat 玻璃岛** | `frontend/components/chat/*`（ai-chat-window / conversation-sidebar / model-selector / token-footer 等） | 刻意设计的恒暗玻璃岛：独立于全站双主题，页面级临时强制 dark（`app/dashboard/ai/chat/page.tsx`），离开还原，不污染他页 |
| **文档渲染白底** | `app/dashboard/tools/page-render/page-render-client.tsx`、`app/p/[id]/page-renderer.tsx` | 渲染的是用户上传的独立 HTML（`srcDoc` + sandbox），白底是"纸张画布"，跟随主题会失真；Markdown 分支已走 token + `dark:prose-invert` |
| **数字大屏** | `app/dashboard/system/digital-display/page.tsx` | mount 时强制 dark + 全屏，恒为暗色展示页；卡片已从自制配方迁移到标准 surface token（BLF-494） |

> 新增例外的流程：先在设计评审确认"刻意为之"，再写入 `design-spec.md` §1 并在本表同步一行。

---

## 3. 组件规范

### 3.1 卡片

- **统一用 `dashboard-surface` 或 surface token**：普通卡片 `<div className="dashboard-surface ...">`；业务统计卡用 `components/ui/stat-card.tsx` 的 `StatCard`（内置 `hover-lift` + `animate-enter` + 四色 icon 变体）；Dashboard 主页用 `components/dashboard-v2/v2-card.tsx` 的 `V2Card`（**蓝色单色独立体系**，见 §6.2，仅主页使用）。
- **圆角**：卡片 `rounded-lg`（`--radius-lg`）或按场景取 `--radius-*` 阶梯；**禁止**随手 `rounded-3xl`。
- **阴影**：默认 `--shadow-soft`，hover 用 `hover-lift` → `--shadow-raised`；浮层用 `--shadow-overlay`。禁止手写 `shadow-[0_16px_30px_-24px_...]` 这类自制配方。
- **禁止**：在业务页"自制卡片配方"（裸 div + 硬编码底色/阴影绕过 surface token）。

### 3.2 表格

**唯一配方（详见 `frontend/docs/table-spec.md`）**：`DataTableCard` / `DataTableFrame`（外壳）+ `components/ui/table.tsx` 原语 + `components/ui/table-presets.tsx` 预设。

| 维度 | 规则 | 佐证 |
|---|---|---|
| 密度 | `compact` 为**全站默认**（表头 `densityHead.compact` h-9/0.66rem，数据格 `densityCell.compact` 13px）；展示型列表用 `cozy` | `table-presets.tsx` |
| 数字列 | 表头 `numericHead` + 数据格 `numericCell`（`!text-right tabular-nums font-medium`） | `table-presets.tsx` |
| 状态 | `StatusPill`（`success/warning/negative/neutral/info` → `--data-*`）或 `Badge` variant | `table-presets.tsx` / `ui/badge.tsx` |
| 表头 | 原语自带 uppercase + `tracking-[0.16em]` + surface-subtle 底，**不要手写背景** | `ui/table.tsx` |
| Sticky | 用 `STICKY_TOP_ROW` / `STICKY_LEFT_HEAD_CELL` / `STICKY_LEFT_CELL` / `STICKY_LEFT_CELL_HOVER` 常量，**禁止手写** `sticky left-0 z-30 bg-slate-100` | `ui/table.tsx` |
| 空态 | `EmptyTableState`（`colSpan` + `message`）；图表空态 `EmptyChartState`；loading 不算空态 | `ui/empty-state.tsx` |
| 移动端 | 容器自带 `overflow-x-auto` 横向滚动降级；关键列可加 `STICKY_LEFT_*` | globals.css:558-571 |

**已退役**：旧版 `components/dashboard/data-table.tsx`（@tanstack 自研封装）已删除（BLF-496）；需要排序/分页/多选时用 `@tanstack/react-table` 直接组合 `Table` 原语 + 预设（参考 `app/dashboard/table-showcase/page.tsx` 基线），**不要恢复旧封装**。

### 3.3 弹窗 / 下拉 / 通知

**统一走 `components/ui/` 既有组件，禁止页面内自造**：

| 场景 | 组件 | 文件 |
|---|---|---|
| 弹窗 | `Dialog` / `AlertDialog`（动效 `ui-overlay-motion`） | `ui/dialog.tsx` / `ui/alert-dialog.tsx` |
| 侧滑 | `Sheet` | `ui/sheet.tsx` |
| 下拉菜单 | `DropdownMenu` | `ui/dropdown-menu.tsx` |
| 浮层选择 | `Popover` / `Select` / `Command` / `Combobox` / `MultiSelect`（动效 `ui-floating-motion`） | `ui/popover.tsx` 等 |
| 日期 / 时间 | `DatePicker` / `TimePicker` / `CalendarWithPresets` / `DropdownRangeDatePicker` | `ui/date-picker.tsx` 等 |
| 提示浮层 | `Tooltip` / `HoverCard` | `ui/tooltip.tsx` / `ui/hover-card.tsx` |
| 表单 | `Form`(react-hook-form+zod) / `Input` / `Select` / `Switch` / `Tabs` / `Label` / `Textarea` | `ui/form.tsx` 等 |
| 图片预览 | `ImagePreviewDialog` | `ui/image-preview-dialog.tsx` |
| 上传 | `UploadZone` | `ui/upload-zone.tsx` |
| **通知** | **`components/notifications/` 的 `useNotifications().notify()`（全局 Provider，`NotificationBell` + toast）** | `components/notifications/*` |
| 面包屑 | `Breadcrumb` | `ui/breadcrumb.tsx` |

> **禁止引入新的通知库**（如 sonner）：通知统一走 `useNotifications()`（`frontend/components/notifications/notifications-context.tsx`）。

### 3.4 图表

**唯一体系（详见 `docs/chart-unification-spec.md`）**——所有 recharts 图表一律用 `components/ui/chart.tsx`：

| 场景 | 必须 | 禁止 |
|---|---|---|
| 容器 | `ChartContainer`（统一 tick/grid/dark 适配） | 裸 `ResponsiveContainer` |
| Tooltip | `ChartTooltip` + `ChartTooltipContent` | 裸 `<Tooltip contentStyle=...>`、自写 tooltip div |
| 图例 | `ChartLegend` + `ChartLegendContent` | 裸 `<Legend>`、`<Legend formatter=...>` |
| 系列色 | `hsl(var(--chart-1..7))` 或 ChartConfig `color` → `var(--color-<key>)` | 硬编码 hex（`#71717a`、`#3b82f6` 等） |
| 坐标轴文字 | 不写 fill（默认 `--muted-foreground`）或 `fill: 'hsl(var(--muted-foreground))'` | `tick={{ fill: '#...' }}` |

**豁免登记**（见 chart-unification-spec.md §3）：SVG data-URL 图表（`app/dashboard/ai/insights/page.tsx`，独立图片无法解析 CSS 变量）、dashboard-v2 六图（主页独立蓝色单色体系）、数字大屏（TV 场景）、`demo.tsx` / `metric-switcher-card.tsx`（line-charts-6 存量，逐步迁移）。**新代码禁止使用 `line-charts-6.tsx`**。

**验收命令**（BLF-495 基线）：`grep -rn "<Legend" frontend/components frontend/app --include="*.tsx" | grep -v ChartLegendContent` → 无输出；`grep -rn "tick={{" frontend/app --include="*.tsx" | grep "#[0-9a-fA-F]"` → 无输出。

---

## 4. 页面头部与排版

### 4.1 页面头部模式

标准结构 = **eyebrow（可选）+ 标题 + 描述 + 操作区**，两种形态：

1. **Eyebrow pill 形态**（参考 `app/dashboard/operations/site-navigation/page.tsx:137-140`）：
   ```tsx
   <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-primary/90">
     <Store className="h-3.5 w-3.5" /> 运营导航 · 站点导航
   </p>
   ```
2. **Kicker 小标形态**（`dashboard-kicker` 类，参考 `app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx` 的 `DataTableCardHeader` 内用法）：
   ```tsx
   <p className="dashboard-kicker">操作台账</p>
   <div className="text-base font-semibold text-foreground">库存明细表</div>
   ```

**页面级头部布局**：`flex flex-wrap items-start justify-between gap-5`（标题/描述在左，操作/统计在右，参考 site-navigation:134-135）。区块标题用 `flex items-end justify-between`（`h2 text-lg font-semibold tracking-tight md:text-xl` + `text-xs text-muted-foreground` 描述，site-navigation:162-165）。

### 4.2 页面壳

- 页面根容器：`dashboard-page-shell`（`space-y-8`，dark 下顶部品牌光晕，globals.css:518-537）或直接 `space-y-6 md:space-y-7`（site-navigation）。
- 全宽场景：`.dashboard-full-width`（globals.css:392-403）。
- 表格卡：`DataTableCard` / `DataTableFrame`（自带标题条 + toolbar 槽 + footer 槽）。

### 4.3 排版红线

- 标题走 `--font-display`（h1~h4 自动应用，globals.css:204-210）；大数字用 `.dashboard-display`；不要用固定 px 字号。
- Eyebrow 统一用 `dashboard-kicker` 或 §4.1 pill 配方，**禁止**每页自造一套小标样式。
- 数字优先 `tabular-nums`（表格列、金额、统计卡）。

---

## 5. 移动端适配

**规则全集见 `MOBILE_ADAPTATION_RULES.md`（9 条规则）**，此处列摘要与代码落点：

| 规则 | 摘要 | 落点 |
|---|---|---|
| 1 | 表格 → 手机端卡片列表（≥5 列） | `hidden md:block` + `md:hidden space-y-3` |
| 2 | 工具栏筛选项折叠 2 列网格 | `grid grid-cols-2 md:flex`，按钮 `w-full md:w-auto` |
| 3 | Dialog 响应式宽度：`max-w-[calc(100%-2rem)] sm:max-w-[540px]` | 表单 `md:grid-cols-2` |
| 4 | KPI 紧凑网格：`grid-cols-2 sm:grid-cols-3 md:grid-cols-5` | 数字 `text-xl`，标签 `text-xs` |
| 5 | 触摸目标 ≥44×44px | `min-h-[44px] min-w-[44px]` |
| 6 | 空状态居中带图标 | `flex flex-col items-center justify-center py-12` |
| 7 | 指标卡 → 水平滑动（≥6 卡）：`overflow-x-auto snap-x snap-mandatory`，每屏 2 卡 | `w-[calc(50%-0.25rem)]` |
| 8 | 筛选项标签内联（手机端不用 `FilterField`） | `text-[0.65rem] gap-1.5` |
| 9 | 控制台筛选项去小标题标签 | — |

**框架级兜底**（globals.css:558-571）：`<768px` 时所有 `dashboard-surface / dashboard-panel / overflow-auto` 内的 table 强制 `min-width: 600px` + 容器 `overflow-x-auto`，保证表格不塌。
**触控滚动条**（globals.css:255-273）：`pointer: coarse` 下细滚动条 6px；`prefers-reduced-motion` / `prefers-reduced-transparency` 均有全局降级（globals.css:302-315, 574-579）。

---

## 6. 组件清单（Reusable Component Index）

### 6.1 `components/ui/*`（全站通用，shadcn + 业务原语）

| 组件 | 职责 | 说明 |
|---|---|---|
| `button.tsx` | 按钮（variant/size 齐全） | 全站唯一按钮入口 |
| `badge.tsx` | 徽章（含 success/warning/info/destructive/outline） | 状态短标签 |
| `card.tsx` | shadcn Card 基座 | 业务卡尽量用 `dashboard-surface` / DataCard 而非裸 Card |
| `data-card.tsx` | `DataCard` / `DataTableCard` / `DataTableCardHeader` / `DataTableCardBody` / `DataTableCardStatBar` | 表格卡外壳（+ 兼容别名 `DENSE_HEAD/DENSE_CELL`） |
| `table.tsx` | `Table` 原语 + `STICKY_*` 常量 + `ColGroup` | 不承载业务样式 |
| `table-presets.tsx` | `densityHead/densityCell/numericHead/numericCell/StatusPill` + `DataTableFrame` | 表格预设 |
| `table-skeleton.tsx` | 表格骨架屏 | loading 态 |
| `empty-state.tsx` | `EmptyState` / `EmptyTableState` / `EmptyChartState` | 空态（loading 不算） |
| `chart.tsx` | `ChartContainer` / `ChartTooltip` / `ChartTooltipContent` / `ChartLegend` / `ChartLegendContent` | **图表唯一体系** |
| `funnel-chart.tsx` | 漏斗图 | — |
| `stat-card.tsx` | `StatCard` 统计卡 | emerald/rose/sky/amber 四色 + trend |
| `dialog.tsx` / `alert-dialog.tsx` / `sheet.tsx` | 弹窗 / 确认框 / 侧滑 | 统一动效 |
| `dropdown-menu.tsx` / `popover.tsx` / `select.tsx` / `command.tsx` / `combobox.tsx` / `multi-select.tsx` | 各类选择器 | 页面内选择一律用这些 |
| `tabs.tsx` / `accordion.tsx` / `collapsible.tsx` / `breadcrumb.tsx` / `tooltip.tsx` / `hover-card.tsx` | 导航 / 收纳 / 提示 | — |
| `form.tsx` / `input.tsx` / `label.tsx` / `textarea.tsx` / `switch.tsx` / `checkbox.tsx` / `radio*` | 表单原语 | react-hook-form + zod |
| `calendar.tsx` / `date-picker.tsx` / `time-picker.tsx` / `calendar-with-presets.tsx` / `dropdown-range-date-picker.tsx` | 日期时间 | — |
| `pagination.tsx` | 分页 | — |
| `skeleton.tsx` / `scroll-area.tsx` / `separator.tsx` / `avatar.tsx` / `tooltip.tsx` | 基础件 | — |
| `image-preview-dialog.tsx` / `upload-zone.tsx` | 图片预览 / 上传 | — |
| `sidebar.tsx` + `sidebar-constants.ts` + `sidebar-mobile-sheet.tsx` | 侧边栏（双层 rail+panel） | 全站导航 |
| `refresh-progress-bar.tsx` | 刷新进度条 | — |
| `skip-link.tsx` | 无障碍跳转 | — |
| `tab-motion.tsx` | Tabs 动效 | — |
| `icons/` | 自定义图标（chatgpt-icon 等） | lucide-react 为主，缺失时放这里 |
| `line-charts-6.tsx` | **存量弃用**（新代码禁用） | 仅 demo.tsx / metric-switcher-card 在用 |
| `demo.tsx` | 组件展示样例 | — |
| `full-screen-signup.tsx` | 注册页 | — |

### 6.2 `components/dashboard-v2/*`（Dashboard 主页专用，独立蓝色单色体系）

| 组件 | 职责 |
|---|---|
| `v2-grid.tsx` | 主页响应式网格 |
| `v2-card.tsx` | 主页卡片（rounded-none + blue 渐变底） |
| `v2-stats.tsx` / `v2-delta.tsx` | 统计卡 / 涨跌 |
| `v2-revenue-chart.tsx` / `v2-channel-chart.tsx` / `v2-country-chart.tsx` / `v2-traffic-chart.tsx` / `v2-stock-chart.tsx` / `v2-project-chart.tsx` | 六张图表（蓝色系 `#2563eb` 等，刻意独立色板） |
| `v2-top-projects.tsx` | 项目排行 |
| `v2-format.ts` | 格式化工具 |

> **边界**：v2 组件只服务 Dashboard 主页（`app/dashboard/page.tsx`），其他页面**禁止** import v2 系列；图表组件应改用 `chart.tsx` 体系。

### 6.3 业务组件目录（按域）

| 目录 | 域 |
|---|---|
| `components/dashboard/*` | 旧主页组件（metrics / visitors / portfolio / ad-analysis / console / inventory-replenishment / ad-data 等） |
| `components/crm/*` | CRM（crm-table / crm-advance-filter / crm-detail-card 等） |
| `components/chat/*` | AI 聊天（暗色玻璃岛，§2.3 例外） |
| `components/notifications/*` | 通知（`useNotifications` 全局） |
| `components/digital-employee/*` | 数字员工（office-badge 等） |
| `components/system/*` | 系统管理 |
| `components/motion/*` | 动效组件（`lib/motion/` 的 React 封装） |
| `components/customer-service/*` / `components/report-upload/*` | 客服 / 报表上传 |

---

## 7. 验收红线（lint/build 之外）

每个"页面收口"子 issue（BLF-498 ~ 501）验收时对照本节：

1. **暗黑**：目标页面无裸 `bg-white/bg-slate-100/bg-gray-50/text-gray-700`（无 dark 变体且非 §2.3 例外）；表格粘性表头用不透明 token。
2. **卡片**：目标页面卡片为 `dashboard-surface` / `DataCard` / `StatCard` / `V2Card`（主页外不用 V2），无自制卡片配方。
3. **表格**：密度/数字列/状态徽章/sticky/空态符合 `frontend/docs/table-spec.md`（对照 `app/dashboard/table-showcase/page.tsx` 基线）。
4. **图表**：无裸 `<Legend`、无 tick hex、系列色走 `--chart-*`（对照 §3.4 验收命令）；不在主页外 import v2 组件。
5. **弹窗/通知**：使用 `components/ui/*` 与 `useNotifications()`，页面内零自造。
6. **排版**：eyebrow 用 `dashboard-kicker` 或 §4.1 pill；标题字号 rem、标题走 `--font-display`。
7. **移动端**：对照 `MOBILE_ADAPTATION_RULES.md` 9 条规则逐项过。
8. **组件**：新能力优先复用 §6 清单中的组件；确需新增先与设计规范对齐。
9. **动效**：时长/缓动取 `--motion-*` 或 `lib/motion/tokens.ts`，不另起节奏；新交互满足 `prefers-reduced-motion` 降级。
