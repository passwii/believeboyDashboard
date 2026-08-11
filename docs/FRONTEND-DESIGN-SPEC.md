# 前端设计规范（FRONTEND-DESIGN-SPEC）

> **适用版本：** v1.2（BLF-497 定稿 v1.0，2026-08-07；BLF-503 增补 §8 页面模式，2026-08-08；BLF-573 增补 §9 暗黑模式层次规范，2026-08-10）
> **适用对象：** 在 `frontend/` 下新增 / 修改 UI 的工程师
> **定位：** 全站前端设计的**总纲与对照基准**。所有页面打磨子 issue（BLF-498 ~ 501）以本文档为验收对照。
> **原则：** 文档与实际代码一致（每个条目都指向真实代码位置）；可执行、不空谈。

---

## 0. 文档地图（Master Index）

本文档是**唯一入口**，细分规范按主题拆在子文档，正文只保留"规则 + 指向"：

| 主题 | 文档 | 状态 |
|---|---|---|
| **本总纲**（设计语言 / 暗黑 / 组件 / 排版 / 移动 / 清单 / 层次规范） | `docs/FRONTEND-DESIGN-SPEC.md`（本文件） | 权威 |
| 暗黑层次设计决策记录（Raycast 精髓提炼 / 采纳与不采纳） | `docs/dark-mode-depth-design-decisions.md` | 权威（BLF-573 定稿） |
| 表格唯一配方（密度 / 对齐 / sticky / 空态） | `frontend/docs/table-spec.md` | 权威（BLF-496 定稿） |
| 图表与图例统一（ChartContainer / 豁免表） | `docs/chart-unification-spec.md` | 权威（BLF-495 定稿） |
| 硬编码色例外清单 + Token 红线 | `frontend/docs/design-spec.md` | 权威（§2 登记例外，本节 §2.2 转引） |
| 移动端适配规则（10 条 + 排列总则） | `MOBILE_ADAPTATION_RULES.md` | 权威 |
| 动效体系（时长 / 缓动 / stagger） | `frontend/docs/motion-system.md` | 权威 |

> 修改某块规则时，改对应子文档即可；本文档只做入口与红线汇总，避免多源不一致。

---

## 1. 设计语言总纲

### 1.1 一句话定义

**Raycast 式玻璃质感暗黑 + `dashboard-surface` 表面体系**。参照物：Dashboard 主页（v2，`frontend/app/dashboard/page.tsx`）与表格展示页（`frontend/app/dashboard/table-showcase/page.tsx`）。新页面/新组件应"读起来像同一种材料"。

### 1.2 表面 token 分层（Surface 阶梯）

定义于 `frontend/app/globals.css`：

- **Light**（`:root`，globals.css:53-61）：`--surface-base`(210 28% 97%) → `subtle` → `panel` → `overlay` → `strong` → `soft` → `low` → `high` → `outline`。
- **Dark**（`.dark`，globals.css:158-166）：画布 L9% → 导航壳 L12% → 内容窗 L15% → 卡片 L19% → 浮层 L22~23% → 高亮 L26% 的明度阶梯，hue≈225 保留冷调呼应品牌蓝。

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
| `.dashboard-surface` | globals.css:450-483 | **默认卡片**：rounded-lg + border + `--shadow-soft`；dark 下叠加"玻璃边"（顶部 1px 内高光 + 全周长内描边，BLF-573 起为 `--shadow-level-2`）+ 左上品牌光晕 `::after`。**全站卡片首选**（92+ 处共用）。 |
| `.dashboard-panel` | globals.css:485-493 | 次级面板（`--surface-soft` 底 + p-3/4），用于内嵌区块 |
| `.dashboard-subtle-panel` | globals.css:495-497 | 最轻量面板（`--surface-subtle` 底） |
| `.dashboard-glass` | globals.css:499-510 | 真玻璃（backdrop-blur 14~18px），仅用于**必须**玻璃质感的元素（浮层 / 导航浮窗） |
| `.dashboard-toolbar` | globals.css:586-594 | 工具栏容器（overlay 底 + 玻璃边） |
| `.dashboard-full-width` | globals.css:437-448 | 突破 max-width 限制（全宽表格区） |

> ⚠️ `.dashboard-surface` **故意不加 backdrop-filter**（globals.css:462-475 记录了历史决策：高 DPI 屏 blur 会糊掉 1px 边框与小字号）。需要玻璃质感时显式用 `.dashboard-glass`，不要给 surface 类补 blur。

### 1.4 色彩系统

- **语义色**：`--primary`（品牌蓝 214 89% 43% / dark 222 100% 68%）、`--success`/`--warning`/`--destructive`、`--muted-foreground`（次级文字）、`--data-positive/--data-warning/--data-negative/--data-neutral`（状态数据色，见 §3.2）。
- **图表色**：`--chart-1..7`（light: globals.css:38-44；dark: 139-145），见 §3.4 与 `docs/chart-unification-spec.md`。
- **描边**：`--stroke-soft` / `--stroke-strong`（图表 grid/线）。
- 所有色值都是 HSL 分量，必须经 `hsl(var(--...))` 取用，保证 dark 自动切换。

### 1.5 圆角 / 阴影 / 动效

- **圆角阶梯**：`--radius-xs(0.375rem) / sm(0.5rem) / md(0.625rem) / lg(0.75rem) / xl(1rem)`，`--radius` = lg（globals.css:70-75）。卡片用 lg，内嵌小块用 md/sm。
- **阴影**：兼容别名 `--shadow-soft`（默认卡片）/ `--shadow-raised`（hover 浮起）/ `--shadow-overlay`（浮层）（globals.css:76-78, 176-178）。**Raycast 成对阴影（BLF-573）**：`--shadow-level-1..5`（外阴影 + inset 配对，globals.css:80-92, 180-209），层次规范见 §9；dark 下 `.dashboard-surface` / `.dashboard-panel` / `.dashboard-toolbar` 消费 `--shadow-level-2`，`.dashboard-glass` 消费 `--shadow-level-5`。用 `hover-lift` 类切换 soft→raised。
- **动效 token**：`--motion-fast(180ms) / base(240ms) / slow(320ms)`、缓动 `--motion-ease-out / standard`、`--stagger-step(70ms)`（globals.css:93-97）。**JS 侧必须同步** `frontend/lib/motion/tokens.ts`（`DURATION/EASE/SPRING/STAGGER`），改 CSS 必须同步 JS，反之亦然——`tokens.test.ts` 有数值断言锁契约。
- **交互工具类**：`u-interactive`（hover 上浮 1px）、`u-press`（按压 0.97）、`u-focus`（focus ring）、`u-focus-glow`（聚焦蓝辉光，BLF-573）、`animate-enter`（入场）、`animate-float`（浮动）、`stagger-item` / `u-stagger-item`（错落入场，见 globals.css:820-837）。

### 1.6 字体与排版

- **正文字体** `--font-sans`、**标题字体** `--font-display`（globals.css:249-256：h1~h4 用 display + `letter-spacing: -0.035em`）。
- **大数字**：`.dashboard-display`（clamp 2.15~2.75rem，globals.css:556-562）。
- **Eyebrow 小标**：`.dashboard-kicker`（`text-[0.68rem] uppercase tracking-[0.22em] text-muted-foreground`，globals.css:552-554）；pill 变体见 site-navigation（§4.1）。
- **根字号响应式**：17px（>1440px）→ 16px（1440 以下）→ 15px（1180 以下 / iPad）→ 16px（768 以下）→ 15px（480 以下），globals.css:225-298。**不要用固定 px 字号做页面级标题缩放**，字号全部 rem。

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
| 移动端 | 容器自带 `overflow-x-auto` 横向滚动降级；关键列可加 `STICKY_LEFT_*` | globals.css:603-616 |

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

标准结构 = **eyebrow（可选）+ 标题 + 描述 + 操作区**，**已收口为 `PageHeader` 原语**（`components/ui/page-header.tsx`，规则见 §8.1），两种形态：

1. **Eyebrow pill 形态**（`PageHeader` 的 `eyebrow` prop，参考 `app/dashboard/operations/site-navigation/page.tsx:138`）：
   ```tsx
   <PageHeader eyebrow={<><Store className="h-3.5 w-3.5" /> 运营导航 · 站点导航</>} description="..." actions={...} />
   ```
2. **Kicker 小标形态**（`PageHeader` 的 `kicker` prop + `title`，`dashboard-kicker` 类，参考 `app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx` 的 `DataTableCardHeader` 内用法）：
   ```tsx
   <PageHeader kicker="操作台账" title="库存明细表" description="..." />
   ```

**页面级头部布局**：`flex flex-wrap items-start justify-between gap-5`（标题/描述在左，操作/统计在右，由 `PageHeader` 内置，参考 site-navigation:138-166）。区块标题用 `flex items-end justify-between`（`h2 text-lg font-semibold tracking-tight md:text-xl` + `text-xs text-muted-foreground` 描述，site-navigation:162-165）。

### 4.2 页面壳

- 页面根容器：`dashboard-page-shell`（`space-y-8`，dark 下顶部品牌光晕，globals.css:564-583）或直接 `space-y-6 md:space-y-7`（site-navigation）。
- 全宽场景：`.dashboard-full-width`（globals.css:437-448）。
- 表格卡：`DataTableCard` / `DataTableFrame`（自带标题条 + toolbar 槽 + footer 槽）。

### 4.3 排版红线

- 标题走 `--font-display`（h1~h4 自动应用，globals.css:249-256）；大数字用 `.dashboard-display`；不要用固定 px 字号。
- Eyebrow 统一用 `dashboard-kicker` 或 §4.1 pill 配方，**禁止**每页自造一套小标样式。
- 数字优先 `tabular-nums`（表格列、金额、统计卡）。

---

## 5. 移动端适配

**规则全集见 `MOBILE_ADAPTATION_RULES.md`（10 条规则 + 组件排列总则，BLF-610 升级）**，此处列摘要与代码落点：

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
| 10 | 表格横滑保持列宽不折行（BLF-610，多列表格默认方案） | globals.css `<768px` `min-width: max-content` 兜底 + 页面级 `max-w/min-w/whitespace-nowrap` 调优 |

**组件排列总则**（BLF-610）：卡片/KPI 默认 `grid-cols-2` 一行两个、随断点递增；宽组件（表格/图表/趋势图）独占一行；表单一列起步 `md:grid-cols-2`；标题行手机 `flex-col` 堆叠、按钮 `w-full sm:w-auto`。

**框架级兜底**（globals.css `@media (max-width: 768px)`，BLF-610 升级）：`dashboard-surface / dashboard-panel / overflow-auto / overflow-x-auto` 内的 table 强制 `min-width: max-content`（保持与桌面端相同的列宽需求，取代旧 `min-width: 600px` 固定下限——它仍会压缩宽表导致折行）+ 容器 `overflow-x-auto` 横向滚动承接。
**触控滚动条**（globals.css:300-318）：`pointer: coarse` 下细滚动条 6px；`prefers-reduced-motion` / `prefers-reduced-transparency` 均有全局降级（globals.css:347-361, 619-624）。

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
| `stat-card.tsx` | `StatCard` 统计卡 + `StatCardRow` 指标卡行 | emerald/rose/sky/amber 四色 + trend（涨跌走 Delta） |
| `delta.tsx` | `Delta` / `DeltaIcon` / `DeltaValue` 涨跌原语 | 正值 emerald / 负值 rose，主页 v2-delta 为其 re-export |
| `page-header.tsx` | `PageHeader` 页面头部 | §4.1/§8.1：eyebrow pill + kicker 两种形态 + 操作区 |
| `filter-toolbar.tsx` | `FilterToolbar` 筛选工具栏 | §8.2：桌面横向 / 手机 2 列网格 |
| `error-state.tsx` | `ErrorState` 错误态 | §8.4 三态之错误：可带重试、表格内 colSpan |
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
7. **移动端**：对照 `MOBILE_ADAPTATION_RULES.md` 10 条规则 + 组件排列总则逐项过。
8. **组件**：新能力优先复用 §6 清单中的组件；确需新增先与设计规范对齐。
9. **动效**：时长/缓动取 `--motion-*` 或 `lib/motion/tokens.ts`，不另起节奏；新交互满足 `prefers-reduced-motion` 降级。

---

## 8. 页面模式（Page Patterns）

> BLF-503 定稿（2026-08-08）。本节把**高频页面组合**收口为可复用原语 + 规则，是 Stage 4 后续"高频页精修 / 长尾页扫尾"（BLF-504+）的统一模板。每个模式 = 规则 + 组件引用 + 真实页面示例；**新页面优先按本节组合，不再逐页手写**。

### 8.1 PageHeader 页面头部

**规则**：页面级头部 = eyebrow（可选）+ 标题（可选）+ 描述 + 操作区，布局 `flex flex-wrap items-start justify-between gap-5`（标题/描述在左，操作/统计在右）。

| 项 | 规则 | 实现 |
|---|---|---|
| 组件 | `PageHeader`（`components/ui/page-header.tsx:31`），不包卡片外壳，页面按需包 `dashboard-surface` | — |
| 形态 1（主） | `kicker`：`dashboard-kicker` 小标 + `title`（h1，`--font-display` 自动）+ `description` | `ui/page-header.tsx` |
| 形态 2（变体） | `eyebrow`：§4.1 pill 胶囊小标（可带 icon），`title` 可省略（如 site-navigation 只有 pill+描述） | `ui/page-header.tsx` |
| 操作区 | `actions` 放右侧（按钮 / 轻量统计 chips），自动 flex-wrap；轻量统计用 chips 网格（`grid grid-cols-3 gap-2.5 max-w-sm`）而非 StatCard | — |

**示例**：`app/dashboard/operations/site-navigation/page.tsx:138`（pill 形态 + 右侧 3 个统计 chips）。存量 kicker 形态参照 `app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx`（`dashboard-kicker` + DataTableCardHeader 内用法）。

### 8.2 FilterToolbar 筛选工具栏

**规则**：筛选区统一 = 项目下拉 + 国家站点 + 日期范围 + SKU/其他 + 刷新按钮，间距 `gap-3`、容器 `dashboard-toolbar`、`px-4 py-4 lg:px-6 lg:py-5`。

| 项 | 规则 | 实现 |
|---|---|---|
| 组件 | `FilterToolbar`（`components/ui/filter-toolbar.tsx:37`），children = 字段，`actions` = 右侧操作（刷新等） | — |
| 桌面 | `md:flex md:flex-wrap md:items-center md:gap-3`，字段横向排列自动换行，actions `md:ml-auto` 靠右 | `ui/filter-toolbar.tsx` |
| 手机 | 自动折叠 `grid grid-cols-2 gap-2`（移动规则 2），actions `col-span-2` 占一行 | `ui/filter-toolbar.tsx` |
| 字段宽度 | 桌面固定宽（项目 140px / 国家 160px / 日期 220px），手机交给网格撑满：写 `w-full md:w-[140px]` 这类响应式宽度 | — |
| 手机专属操作 | 只在手机出现的按钮（如"近7天"）加 `md:hidden`，放 actions 内 | — |

**示例**：`app/dashboard/operations/daily-analysis/daily-analysis-client.tsx:1572`（项目 + 国家 + SKU + 日期 + 刷新，手机端 2 列网格 + 近7天）。
**备注**：`components/dashboard/console/filter-toolbar.tsx`（carded 形态：Card 包头 + 筛选）为存量变体，供 portfolio-overview 使用；新页面优先用本节的 strip 形态。

### 8.3 指标卡行（label-value-delta）

**规则**：统计卡统一 `StatCard`（label 大写小标 + 大数字 + 涨跌），涨跌统一走 `Delta` 原语；整行用 `StatCardRow` 栅格。

| 项 | 规则 | 实现 |
|---|---|---|
| 单卡 | `StatCard`（`components/ui/stat-card.tsx:48`）：四色 icon 变体 + `dashboard-surface` + hover-lift；trend 渲染走 `Delta` | `ui/stat-card.tsx` |
| 涨跌 | `Delta` / `DeltaIcon` / `DeltaValue`（`components/ui/delta.tsx`，BLF-503 从 v2-delta 上移全站通用）：正值 emerald / 负值 rose / 0 中性；`DeltaValue` 默认绝对值+% | `ui/delta.tsx` |
| 整行 | `StatCardRow`（`components/ui/stat-card.tsx:104`）：`grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5`，gap 3→4 | — |
| 边界 | >6 卡用水平滑动（移动规则 7）；Dashboard 主页仍用 v2 系列（§6.2，主页外禁止 import） | — |

**示例**：`app/dashboard/operations/project-goals/page.tsx`（StatCard 年度目标卡）；存量手写 delta（`v2-stats` 以外）迁移时改用 `Delta` 组合。

### 8.4 三态统一（loading / empty / error）

**规则**：每个数据区块必须覆盖三态；加载不算空态，错误不等于空态。

| 状态 | 配方 | 实现 |
|---|---|---|
| 加载 | 页面级骨架用 `page-skeletons.tsx`（`PageHeaderSkeleton` / `FilterBarSkeleton` / `KpiCardsSkeleton` / `DataTableSkeleton` / `ChartPanelSkeleton`，`components/dashboard/page-skeletons.tsx:23-205`）；表格行内骨架用 `table-skeleton.tsx` | — |
| 空态 | `EmptyState` / `EmptyTableState` / `EmptyChartState`（`components/ui/empty-state.tsx`）；表格内传 `colSpan` | — |
| 错误 | `ErrorState`（`components/ui/error-state.tsx:34`）：页面级默认带虚线边框 + 重试按钮；表格内传 `colSpan` 渲染错误行 | `ui/error-state.tsx` |

**示例**：loading 见 `app/dashboard/operations/` 各路由 `loading.tsx`（TablePageLoading/AnalyticsPageLoading）；空态见 daily-analysis 表格 `EmptyTableState colSpan`；错误态新代码统一 `ErrorState`（存量页面的手写错误块按本模式迁移）。

### 8.5 模式落地清单

| 模式 | 原语 | 试点页面（已落地） | 待铺开 |
|---|---|---|---|
| 页面头部 | `PageHeader` | site-navigation（pill 形态） | 其余业务页头部 |
| 筛选工具栏 | `FilterToolbar` | daily-analysis | inventory-analysis / inventory-ledger / weekly-product-analysis / portfolio-overview |
| 指标卡行 | `StatCardRow` + `Delta` | StatCard 已统一 Delta（project-goals 等存量卡自动生效） | 各页 KPI 行 |
| 三态 | `ErrorState` + 骨架 + 空态 | — | 存量手写错误块迁移 |

> **BLF-505 长尾扫尾（2026-08-10）落地记录**：
>
> - **PageHeader（pill 形态）已铺开**：platform-inspection、store-navigation、shipment-management、sku-info、weekly-product-analysis、portfolio-overview、alerts、agent-management、backup-management、changelog、vat-invoice、report-reconciliation、ai/ad-analysis、ai/believeboy-models、ai/digital-employees、reports/auto-upload、reports/product-analysis、profile。
> - **FilterToolbar 已铺开**：project-goals、return-analysis、inventory-replenishment、seasonal-replenishment、weekly-product-analysis。
> - **保留的存量变体**：① console 页头（`DataCardHeader`/`CardHeader` + `dashboard-kicker`，daily-analysis / exchange-rate / order-info / monthly-report / logs / account-management 等）为卡内 console 模式，允许并存；② `components/dashboard/console/filter-toolbar.tsx` carded 形态供 portfolio-overview；③ console-hero（icon tile + SnapshotSelector，inventory-replenishment / pricing-calculation）为跨页既定模式；④ 报表渲染页（ai/insights）与版本发布 hero（feature-updates）为刻意设计。
> - **暗黑硬编码**：清扫 project-goals「本月」高亮行 `bg-blue-50/50` → 补 `dark:bg-blue-950/30` + `dark:text-blue-400`；cyan 自制 eyebrow 徽章（project-info / data-management / profile / change-password）→ 标准 primary pill 配方。
> - **三态**：store-navigation 手写 spinner/错误块 → `CardListSkeleton` + `ErrorState`；weekly-product-analysis 手写错误块 → `ErrorState`。
> - 全部 6 域批次：`pnpm lint` 0 error；`pnpm build` 通过；vitest 749 全绿；tsc 51 个既有错误与 main 基线一致 0 新增。

> 后续页面打磨子 issue 以本节为验收模板：目标页面头部/筛选/指标卡/三态必须命中上表原语，否则视为未收口。

> **BLF-605（2026-08-10）落地记录：PILL 并入首卡（shipment-management）**：
>
> - 页面顶部独立 PageHeader 段移除，其 eyebrow pill（`<Ship /> 运营 · 货件管理`，§4.1 配方）**并入首个卡片头部**，替换原「控制台」标题；操作区（刷新/新建/模板/导入）保留在 PILL 右侧同行。
> - 适用场景：页面仅一个主卡片 + 该卡头部已有标题栏时，顶层 pill + 卡头标题语义重复 → 合并为卡内 pill 头，省一层页面纵向空间。
> - 实现：`app/dashboard/operations/shipment-management/page.tsx`（删除独立 `<section>` + `PageHeader`，卡头 `<h2>控制台</h2>` → 同配方 `<span>` pill）。
> - 跟进（2026-08-11）：pill 高度与右侧操作按钮对齐——`h-9`（同按钮行高）+ icon `h-4 w-4`（同按钮 icon），保留 `text-xs` 与 `tracking-[0.14em]` 配方文字样式；卡内 pill 场景以等高为佳。
---

## 9. 暗黑模式层次规范（Raycast Depth & Elevation）

> BLF-573 定稿（2026-08-10）+ BLF-574 落地（2026-08-10，Stage 7-2：公共组件层次铺开）。依据 Raycast 官方设计参考（`docs/dark-mode-depth-design-decisions.md` §1 提炼，源：Raycast DESIGN.md §6）——**阴影永远成对（外 + inset），层次感靠结构不靠颜色**。本节是权威规范，决策记录见 `docs/dark-mode-depth-design-decisions.md`，每个条目指向真实代码。

### 9.1 阴影层级（Level 0-5 成对阴影）

**token 定义**：`frontend/app/globals.css`——light `:root`（globals.css:80-107）+ dark `.dark`（globals.css:189-231）。

| Level | token | 用途 | 结构 |
|---|---|---|---|
| 0 Void | — | 页面画布（`--background`） | 无阴影 |
| 1 Subtle | `--shadow-level-1` | 内联微元素 / chip | 微小外下落 + 极淡内高光 |
| 2 Ring | `--shadow-level-2` | **标准卡片**（`.dashboard-surface` 等） | 顶内高光 + 全周长内描边 + soft 下落 = 双环围合 |
| 3 Button | `--shadow-level-3` | 按钮 / 按压态（macOS 原生按压） | 白顶内高光 + 白 1px 外环 + 深底内嵌 |
| 4 Key | `--shadow-level-4` | 键帽 / 命令面板条目 | 5 层阴影栈 + inset 按压 |
| 5 Floating | `--shadow-level-5` | 浮层 / 玻璃面板（`.dashboard-glass`） | 2px 深环 + 白辉光 + overlay 下落 + 玻璃边 |

**兼容别名**：`--shadow-soft / --shadow-raised / --shadow-overlay` 保留（soft≈L2 下落、raised≈L2 hover、overlay≈L5 下落），存量消费方不受影响（tailwind.config.ts:251-259 映射 + 27 处 tsx 引用零改动）。

**已落地消费**（dark 下）：`.dashboard-surface`（globals.css:470-479）、`.dashboard-panel`（:505-511）、`.dashboard-toolbar`（:634-640）→ `var(--shadow-level-2)`；`.dashboard-glass`（:519-528）→ `var(--shadow-level-5)`。Tailwind 侧 `shadow-level-1..5` 工具类可用（tailwind.config.ts:255-260）。

**BLF-574 落地（Stage 7-2）**：

| 消费点 | 类 / 规则 | 结构 | 位置 |
|---|---|---|---|
| 按钮按压 | `.dark .u-btn`（default/destructive/outline/secondary 变体挂 `u-btn`） | `--shadow-level-3`（白顶内高光 + 白 1px 外环 + 深底内嵌） | globals.css:573-582 + `components/ui/button.tsx:12-18` |
| 按钮按压态 | `.dark .u-btn:active` | `--shadow-level-3-active`（内嵌加深，u-press scale 保留） | globals.css:583-587 + token :99-102 / :229-232 |
| 卡片 hover | `.dark .hover-lift:hover` | `--shadow-level-2-hover`（raised 下落 + 更亮玻璃边/内描边） | globals.css:695-698 + token :93-97 / :221-225 |
| 浮层玻璃 | `.dark .u-floating-glass`（dialog/sheet/popover/select/dropdown/tooltip 浮层容器挂类） | 玻璃渐变 + `--shadow-level-5`（2px 深环 + 白辉光）+ blur 18px | globals.css:588-593；组件：dialog.tsx:41 / sheet.tsx:33 / popover.tsx:26 / select.tsx:75 / dropdown-menu.tsx:49,66 / tooltip.tsx:22 |
| 浮层字面量 | `dark:shadow-[0_24px_48px...]` 已删除 | → `--shadow-level-5`（token 引用） | dialog/popover/select |

### 9.2 边框高光（Glass Edge）

- **顶内高光**：`--glass-edge-highlight`（dark 0.08，globals.css:197）——卡片顶部 1px 白高光，模拟光源在上，被 `--shadow-level-2/5` 内部引用（`hsl(220 30% 100% / var(--glass-edge-highlight))`）。
- **全周长内描边**：1px `hsl(220 30% 100% / 0.04)`，含于 `--shadow-level-2`（globals.css:200-203）。
- **标准边框**：1px `hsl(var(--border) / 0.55)`（`.dark .dashboard-surface`，globals.css:477）。
- **hover 过渡**：Raycast 用 opacity 0.6；本项目走 `.u-interactive`（上浮 1px，globals.css:537-547）与 `.hover-lift`（translateY -2px；dark 下叠加 `--shadow-level-2-hover` 配对阴影，globals.css:688-698），不换色、不叠 blur。
- **其他高频件玻璃边**（BLF-574）：`badge.tsx` / `switch.tsx` 暗黑顶部内高光 `dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.08)]`；`table.tsx` 粘性表头 `STICKY_TOP_ROW` / `STICKY_TOP_GROUP_ROW` 暗黑叠加顶部内高光。

### 9.3 输入聚焦（Focus Glow）

- **token**：`--focus-glow`——light `hsla(214,89%,43%,0.12)` / dark `hsla(202,100%,67%,0.15)`（Raycast 蓝辉光原文，globals.css:87 / 198）。
- **工具类**：`.u-focus-glow`（globals.css:562-570）——**仅 `.dark` 生效**，focus-visible/focus 时 1px ring + 4px 蓝辉光，替代默认硬环 `ring-2`；light 走组件自带 `focus-visible:ring-2` 视觉零变化（`.dark .u-focus-glow` 0-3-0 特异性覆盖 ring 工具 0-2-0）。
- **现状（BLF-574 已迁移）**：`input.tsx` / `textarea.tsx` / `select.tsx` 触发器 / `combobox.tsx` 触发器均已挂 `u-focus-glow`（input.tsx:7 / textarea.tsx:7 / select.tsx:22 / combobox.tsx:105）；输入背景暗黑对齐 `dark:bg-[hsl(var(--surface-soft)/0.96)]`（近黑蓝调）。

### 9.4 毛玻璃使用边界（含高 DPI 约束）

- **禁则**：`.dashboard-surface` / `.dashboard-panel` 一律**不加** backdrop-filter（globals.css:481-494 历史决策：曾因高 DPI 下 14px blur 糊掉 1px 边框与 12px 表头、且 92 处共用影响面过大而移除）。
- **允许**：仅浮层 / 导航浮窗——`.dashboard-glass`（globals.css:519-528）与 `.u-floating-glass`（globals.css:588-593，dark 下 dialog/sheet/popover/select/dropdown/tooltip 浮层统一挂载，backdrop-blur 18px）；`prefers-reduced-transparency: reduce` 时 `.dark .sidebar-panel-shell` 与 `.dark .u-floating-glass` 关闭 blur（globals.css:532-534 / 594-597）。
- **高 DPI 自查**：新玻璃元素须确认 blur 半径 ≤ 20px，且元素内无 1px 边框 / `text-[11px]` 级关键内容；5K/4K/Retina 截图验收。

### 9.5 圆角映射（在既有 `--radius-*` 上对齐用途，不推翻）

| 用途 | Raycast | 本项目 token（globals.css:70-75） | 值 |
|---|---|---|---|
| 微元素 / code span | 2-3px | `--radius-xs` | 0.375rem (6px) |
| 按钮 / 徽章 | 6px | `--radius-md` | 0.625rem (10px) |
| 输入框 | 8px | `--radius-md` | 0.625rem (10px) |
| 标准卡 | 12px | `--radius-lg` | 0.75rem (12px) |
| 大卡 / 浮层 | 16-20px | `--radius-xl` | 1rem (16px) |
| pill | 86px+ | `rounded-full` | 9999px |

**现状**：按钮/输入框已用 `rounded-md`（button.tsx:8 / input.tsx:7），卡片 `rounded-lg`（dashboard-surface，globals.css:451），浮层 `rounded-lg~xl`——与上表对齐，无需改动；新组件按上表取用。

### 9.6 背景与材质

- dark 画布：`--background: 225 12% 9%`（globals.css:118）≈ Raycast `#07080a` 蓝调近黑，**禁止纯黑 `#000`**。
- 卡片材质：`--surface-panel: 225 12% 19%`（globals.css:160）≈ Raycast `#101111`；分层明度阶梯（画布 L9% → 导航 L12% → 内容窗 L15% → 卡片 L19% → 浮层 L22-23% → 高亮 L26%，globals.css:158-166）。

### 9.7 验收红线（BLF-575 全站层次验证定稿，2026-08-10）

> 本节是 Stage 7-3 对全站落地的硬性验收红线。**新页面 / 新组件合入前对照本节自查**，命中即打回。

**浮层红线（浮层字面量清零）**

1. 浮层（dialog / alert-dialog / sheet / popover / select / dropdown / tooltip / chart tooltip / 自定义 hover 浮层）容器必须挂 `u-floating-glass`（dark 下自动取 `--shadow-level-5` + blur 18px + 玻璃渐变）。
2. **禁写字面量阴影**：`dark:shadow-[0_24px_48px_...]`、`shadow-xl`（dark 侧）等一律不得出现在浮层上——BLF-574 已清零 dialog/popover/select，BLF-575 收口 chart.tsx:172 / line-charts-6.tsx:190 / metric-switcher-card.tsx:819 / alert-dialog.tsx:39 / report-status-card.tsx:140。
3. light 模式保留浮层原 `shadow-lg` / `bg-popover`（`u-floating-glass` 仅 `.dark` 生效，视觉零变化）。
4. 验证方法：Playwright 计算样式断言——dark 下浮层 `box-shadow` 含 `--shadow-level-5` 特征（2px 深环 + 白辉光）、`backdrop-filter: blur(18px)`（cascade 已实测 utilities 层不覆盖 `.dark .u-floating-glass`，0-2-0 特异性 + components 层声明均生效）。

**卡片红线（禁止毛玻璃上卡）**

5. `.dashboard-surface` / `.dashboard-panel` / `DataCard` / `StatCard` / V2Card **一律禁止 backdrop-filter**（高 DPI 糊边历史教训，globals.css:481-494）。
6. 验证方法：`getComputedStyle(card).backdropFilter === 'none'`。BLF-575 实测 7 个高频页 × light/dark 抽样卡片全部 none。

**高 DPI 红线（硬验收项，≥2x 必查）**

7. 新玻璃元素 blur 半径 ≤ 20px，且浮层内不得有 1px 边框 / `text-[11px]` 级关键内容。
8. 1px 边框在 DPR3 下过渡宽度应 ≈ 1 device px（crisp）；表头 `text-[11px]/[12px]` 必须可读。验收截图（DPR2 light/dark 七页 + DPR3 代表页）见 BLF-575 issue 评论附件。
9. 背景→卡片→浮层三档亮度必须可区分（dark 画布 L9% ≈ `rgb(20,22,26)` → 卡片 L19% → 浮层 L22-23%），禁止卡片与画布同色糊成一团。

**动效红线**

10. 新增动效不得绕过全局 `prefers-reduced-motion` 兜底（globals.css:1065 全局 `animation-duration/transition-duration: 0.01ms`）；浮层位移动画需在 `prefers-reduced-motion` 下 `transform: none`（globals.css:434）。验证：Playwright `reducedMotion: 'reduce'` 下页面 `transitionDuration > 0.02s` 的元素数 = 0。

**BLF-575 落地记录（2026-08-10）**

- 修复 5 处浮层字面量残留：`chart.tsx:172`（ChartTooltipContent）、`line-charts-6.tsx:190`（图表 tooltip）、`metric-switcher-card.tsx:819`（MetricSwitcherTooltip，daily-analysis 在用）、`alert-dialog.tsx:39`（AlertDialogContent，BLF-574 漏网）、`report-status-card.tsx:140`（hover 浮层）→ 全部 `u-floating-glass` + 去字面量。
- 新增 `alert-dialog.test.tsx`（u-floating-glass + 字面量禁则 + light 保留 shadow-lg，镜像 dialog.test.tsx）。
- 高频页验证（dashboard / daily-analysis / inventory-analysis / inventory-ledger / commission-management / platform-revenue / crm-dashboard）：全部复用 §1.3 / §6 公共件，页面层零新增阴影字面量（platform-revenue 彩色渐变 pill 的 `shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]` 为刻意双模强调样式，保留）。
- 高 DPI：DPR2/DPR3 截图 18 张留档；卡片 `backdrop-filter: none` 抽样全部通过；1px 边框 DPR3 过渡 1 device px；表头 11px 清晰。
