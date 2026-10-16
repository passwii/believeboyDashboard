# 设计规范（Design Spec）

> **适用版本：** v3（三阶段归拢版，2026-08-29）
> **适用对象：** 在 `frontend/` 下新增 / 修改 UI 的工程师
> **目标：** 归拢设计语言三个阶段（V1 / V2 / V3）的完整沿革，明确**现行权威 = V3 Terminal**；登记"刻意为之"的例外，避免后来者误判为 bug、误改、或写出跨时代混搭。

---

## 0. 版本时间线与阶段沿革

### 0.0 一张表看懂

| 阶段 | 时间窗 | 设计语言 | 令牌体系 | 分水岭 | 状态 |
|---|---|---|---|---|---|
| **V1** 早期默认 | 2026-02 ~ 2026-07 中 | shadcn 开箱样式 + 各页自配色 | 无统一令牌（`hsl(var(--background))` 系默认 + 局部硬编码） | `a16ce290` Geist 计划立项（2026-07-16） | 存档，无在线独占资产 |
| **V2** Geist Surface | 2026-07-16 ~ 2026-08-22 | 玻璃拟态：surface 阶梯 + 圆角 + 阴影 + 微交互 | `--surface-*` + `dashboard-surface` 构件类 | `9e47d99a` 终端外壳合入（2026-08-23，BLF-809） | 存量维护（约 32 文件 `dashboard-surface` / 68 文件 `--surface-*`） |
| **V3** Terminal 终端化 | 2026-08-23 起 | 高密度交易终端：零圆角 / 零阴影 / 1px 边界 / mono 数值 | `--term-*` 明暗双套 + Tailwind `term` 色组 | 进行中（最新 BLF-887，`1d9f461d`，2026-08-29） | **现行权威** |

**新人一句话**：新页面 / 新组件一律按 §0.3 V3 写；看到旧页面的圆角 / 阴影 / `surface` 类不是 bug，是 V2 存量（迁移口径见 §0.3.6）。

### 0.1 V1 —— 早期默认时代（存档）

- 2026-02 首批页面起（销售日报 `56b52a65`、项目 / 系统管理 `106304c2`），直接使用 shadcn/ui 开箱令牌（`--background / --primary / --muted` 系）+ 各页面局部硬编码配色。
- 2026-03 起 `dashboard-surface` 构件类在仪表盘 / 广告分析出现雏形（`cb360f6e` / `2cf5b715`），但未令牌化、未成文。
- 该阶段**无设计规范文档、无红线**，样式决策分散在各 page.tsx；已全部被 V2 / V3 重构覆盖，无需遵循。

### 0.2 V2 —— Geist Surface 玻璃时代（存量维护）

- 2026-07-16 Geist 阶段 A（设计令牌层）立项（`docs/superpowers/plans/2026-07-16-geist-phase-a-design-tokens/`），2026-08 上旬集中定稿：
  - **令牌**：`--surface-high / soft / subtle / low / outline / overlay` 表面阶梯 + `--shadow-soft / raised / overlay` + `--radius-*` 阶梯；
  - **构件**：`globals.css` `.dashboard-surface`（玻璃面板）+ `hover-lift` / `animate-enter` 微交互；
  - **规范**：BLF-494（暗黑硬编码清理）、BLF-496（`table-spec.md` v1）、BLF-497（`docs/FRONTEND-DESIGN-SPEC.md` 总纲）、BLF-501（页面收口）、BLF-503（PageHeader / FilterToolbar 模式库）。
- **仍在线的 V2 资产**（不是 bug；例外登记见 §1.5，迁移口径见 §0.3.6）：
  - 主页 `app/dashboard/page.tsx` + `components/dashboard-v2/`（V2Card 蓝色单色独立体系）；
  - 未迁完的存量页面（约 32 文件仍用 `dashboard-surface`）；
  - **微交互基建跨版本共用**：`u-btn / u-press / u-focus / u-interactive / u-focus-glow` 工具类与 `--motion-*` 令牌（见 `motion-system.md`）——V3 组件同样引用，只替换视觉表面层。

### 0.3 V3 —— Terminal 终端化（现行权威）★

> 规格细则：`docs/terminal-design/master-prompt.md`（总纲 / 打磨 SOP / 批次进度）；表格细则：`frontend/docs/table-spec.md` v2（BLF-872，已 term 化）。

#### 0.3.1 视觉纪律五条（不可违反）

1. **零圆角**：一律 `rounded-none`；
2. **零阴影**：禁 Box-Shadow；面板分割一律 `border border-term-border`（1px solid）；
3. **数值 mono**：金额 / 订单号 / 时间戳 `font-mono` + `tabular-nums`，语义着色 `text-term-pos / neg / warn`；
4. **明暗双套**：新增颜色必须同时补 light / dark 两套 `--term-*`；
5. **同排同档**：同一水平带上并排的可点击控件必须同高度档（档位表见 0.3.3）。

#### 0.3.2 令牌体系

`globals.css` `--term-*` 明暗两套（13 色 × 2 主题：bg / panel / raised / hover / border / border-strong / text / muted / faint / pos / warn / neg / accent），经 `tailwind.config.ts` `term` 色组消费（`bg-term-panel` 等）。浅色基调 `#f5f5f7` 系、深色基调 `#0c0c0e` 系，自动随主题翻转，无需 `dark:` 前缀。

#### 0.3.3 控件高度阶梯（BLF-887 终态，2026-08-29）

| 档位 | 用途 |
|---|---|
| `h-4`（16px） | 徽标本体、状态点 |
| `h-8`（32px） | 紧凑档：Tab 钮、MultiSelect 内嵌搜索、Button sm/xs、Input sm |
| `h-9`（36px） | 标准工具行：`TERM_BUTTON / TERM_INPUT / TERM_TRIGGER / TERM_SELECT_NATIVE`、Button default、Input default、Select / Combobox / Command 触发器、Pagination、TableHead、图标按钮（Header / Inspector / SubNav 折叠钮）、SubNav 列表项 |
| `h-10`（40px） | 页头级：`TERM_HEADER_TRIGGER`、term Tabs 栏、TermTabBar、TermPanel 标题条、TermTable 表头与行、Button / Input lg、工作区导出 / 查询钮 |
| `h-11`+ | 保留给 default Tabs（非 term）等旧基线，term 体系不取 |

规则：Header 插槽内控件统一 `h-10`；触控命中区最小 24px 不因档位放宽。完整沿革与对照见 `master-prompt.md` §1b-3（BLF-887 上档表）。

#### 0.3.4 外壳尺寸常量（BLF-887 终态）

单源 `components/terminal/terminal-constants.ts`：Rail **64px**（L1 图标 24px，常量 `TERMINAL_RAIL_ICON_SIZE`，改尺寸只动此处）/ SubNav **224px**（折叠 0，动效收缩）/ Header **56px** / Footer **36px** / Inspector **360px** / 顶部基准带 = Header 高度（表达式联动）。**禁止页面内手写像素值**，一律引用常量。

#### 0.3.5 原子组件收口清单（BLF-867 ~ 887，2026-08-27 ~ 08-29）

| 组件域 | 收口内容 | 出处 |
|---|---|---|
| Button | 基座零圆角 + term 令牌；新增显式 `term` variant（高密度工具行）；档位 h-8 / 9 / 10 | #455（BLF-868） |
| 表单输入 | Input / Textarea / Switch：零圆角 + term 令牌 + `u-focus-glow` 焦点 | #456（BLF-869） |
| 选择类 | Select / Combobox / Command / Popover / DatePicker | #457（BLF-870） |
| 浮层类 | Sheet / Dialog / Tooltip | #458（BLF-871） |
| 数据展示 | Card / DataCard / StatCard / Table / Badge / Empty / Skeleton / Pagination 统一外壳 `TERM_PANEL_SURFACE`（`card.tsx` 导出：零圆角 / 零阴影 / 零渐变） | #464（BLF-872） |
| 导航布局 | FilterToolbar / ScrollArea / Separator；面包屑与页面标题由 `TerminalHeader` 承载（原 `Breadcrumb` / `PageHeader` 原语已下线）；**删除** `ui/sidebar.tsx`（731 行）+ `sidebar-mobile-sheet` + `sidebar-constants`（被 `terminal-shell` 六区外壳取代） | #465（BLF-873） |
| Tabs | `variant="term"`：term 基座 + 激活态 accent 发光指示条 + 前置 icon + h-10 | #451 / #461 / #466（BLF-867 / 883）+ BLF-887 |
| FieldLabel | **组件下线**，统一终端样式 | #450（BLF-876） |
| 操作区 / Header | 4 档固定宽度原子控件；Head 三区骨架与常量抽取（BLF-877）；刷新按钮全页面常驻（BLF-881） | #449 / #454 / #460 |
| 共享原语 | `components/terminal/term-controls.tsx`（`TERM_TRIGGER / INPUT / BUTTON / SELECT_NATIVE` + `TermPill / TermTabBar / TermToolRow`，约 30 处引用）——后续新页面一律从这里取控件基类 | #423（BLF-838） |
| Header 范式 | `header-filter-suite.tsx`（全局筛选四件套，h-10）+ `header-filter-controls.tsx`（BLF-826 范式收口；Operations 11 页上移 Top Header 插槽） | #467 |

#### 0.3.6 V2 存量迁移口径

1. **新页面 / 新组件一律 V3**：按 `master-prompt.md` §任务 2 SOP + `term-controls` 原语写；**不要**再加页面级标题胶囊 / 筛选条（改接 `header-filter-suite` 组件族）；
2. **存量 V2 页面**按批次迁（master-prompt 批次表 A–F 已收官，全站 52 模块终端化完成；后续增量以 issue 驱动），迁完删除旧类；
3. **motion 基建不动**：`u-*` 工具类、`--motion-*` 令牌跨版本共用，只换视觉表面层；
4. `variant="term"` / `TERM_PANEL_SURFACE` / `term-controls` 是唯一入口，**不要**再新造各域 term-shared 副本（`order-info` / `scheduled-reports` 存有历史本地副本，仅存量维护，勿模仿）。

---

## 1. 刻意例外清单（Deliberate Exceptions）

以下区域**刻意**使用硬编码色值 / 非标准 token，**不是 bug**。修改前请先阅读对应条目；若需要改动视觉，请先与本条目对齐或更新本文件。

### 1.1 AI Chat 双主题独立设计区（`components/chat/*`）

- **范围**：`components/chat/ai-chat-window.tsx`、`conversation-sidebar.tsx`、`model-selector.tsx`、`token-footer.tsx` 等；`app/dashboard/ai/page.tsx`（聊天入口）与 `app/dashboard/ai/chat/*` 一并归入本例外。
- **现状（BLF-859 起，2026-08-27）**：已移除 mount 时强制注入 `dark`，**跟随系统主题** light / dark 自动切换；内部仍用 `bg-white/[0.06]`、`border-white/[0.08]`、`text-[#8a8a8f]` 等独立配色（浅色纸感 / 深色玻璃，Raycast 风语言），**不走 term 令牌**。
- **决策**：聊天区是**独立设计语言**，与全站 term 体系解耦，**不迁移**；若未来统一需先做整页级设计决策再收口色值。
- **沿革**：V2 时代（BLF-501）曾登记为"恒暗玻璃岛"；BLF-859 废除恒暗、保留独立配色，本条即改写后的现状。

### 1.2 文档渲染白底（`page-render` / `page-renderer`）

- **范围**：`app/dashboard/tools/page-render/page-render-client.tsx`（HTML 预览 iframe）、`app/p/[id]/page-renderer.tsx`（公开页 HTML 渲染 iframe）。
- **现状**：HTML 预览 iframe 使用 `bg-white`；公开页 Markdown 分支使用 `bg-background` + `dark:prose-invert`。
- **决策依据**：
  - HTML 分支渲染的是**用户上传的独立 HTML 文档**（`srcDoc` + `sandbox`），文档自带背景；iframe 的 `bg-white` 只是"纸张画布"底色，跟随主题会让文档观感失真。
  - Markdown 分支走 token（`bg-background` + `dark:prose-invert`），已适配暗黑。
- **结论**：**保持现状**。全仓 grep `bg-white` 时此两处为白底渲染页例外。

### 1.3 数字大屏恒暗（`app/dashboard/system/digital-display/page.tsx`）

- **现状**：页面在 mount 时强制 `document.documentElement.classList.add('dark')` 并请求全屏，**恒为暗色展示页**（无 light 态）。
- **注意**：自 BLF-494 起，大屏卡片已迁移到标准 surface token；"恒暗"本身保留为刻意例外（展示类页面）。

### 1.4 数字员工办公室投屏模式（`app/dashboard/ai/digital-employees/office/page.tsx`）

- **范围**：`?mode=presentation` 分支（全屏投屏视图）。普通模式走 `dashboard-page-shell` + token，与全站一致。
- **现状**：投屏分支在 mount 时强制 `dark` 并请求全屏，**恒为暗色展示页**（无 light 态），与 §1.3 数字大屏并列。

### 1.5 主页 dashboard-v2 蓝色单色体系（V2 定稿产物）

- **范围**：`app/dashboard/page.tsx` + `components/dashboard-v2/`（`V2Card` 等）。
- **现状**：BLF-497 §6.2 定稿的**蓝色单色独立体系**，仅主页使用；V3 终端化覆盖了外壳 / 导航 / 表格，但主页卡片体系仍为 V2 形态。
- **结论**：属 V2 时代刻意保留的独立体系，**不是漏改**；重构前先读 BLF-497 的决策记录，不要顺手"term 化"。

---

## 2. Token 使用红线（V3 口径）

1. **业务页禁止裸用硬编码色**（`bg-white` / `bg-slate-100` / `bg-gray-50` / `text-gray-700` 等无 `dark:` 变体的浅色硬编码）：新代码一律 term 令牌（`bg-term-panel / text-term-muted` 等）；例外仅限 §1 登记。
2. **表格粘性表头**：单元格背景必须用**实体不透明 term 令牌**（推荐 `bg-term-raised`，首列数据格 `bg-term-panel`），否则滚动时暗黑模式会出现浅色带（细则见 `table-spec.md` §1.5）。
3. **状态色**：表格用 `StatusPill`（`table-presets.tsx`，映射 `--data-*` 自动适配 dark）或 `Badge` 内置 variant；终端工具行用 `term-controls.tsx` 的 `TermPill`（tone 语义色）；**禁止**业务页手写状态色类（如 `bg-slate-100 text-slate-800`）。
4. **新颜色双主题双写**：`--term-*` 必须 light / dark 两套同步新增，Tailwind `term` 色组同步 `tailwind.config.ts`；漏写暗色即在暗黑模式出浅色块。
5. **圆角 / 阴影零回归**：term 体系内禁新增 `rounded-*`（`rounded-none` 除外，`switch` 滑轨等物理隐喻除外）与任何 Box-Shadow；浮层与面板分割一律 `border-term-border`。
6. **动效令牌双侧同步**：修改 `--motion-*` 需同步 `lib/motion/tokens.ts`（见 `motion-system.md` §2.3）。

---

## 3. 文档地图

| 主题 | 文档 | 说明 |
|---|---|---|
| V3 终端化总纲 / SOP / 批次进度 | `docs/terminal-design/master-prompt.md` | V3 权威细则（BLF-887 已同步） |
| BLF-809 交付复盘 | `docs/terminal-design/design-review.md` | 历史决策与问题清单 |
| 表格唯一配方 | `frontend/docs/table-spec.md` | v2（BLF-872，已 term 化） |
| V2 总纲（存档） | `docs/FRONTEND-DESIGN-SPEC.md` | V2 定稿总纲；**与 V3 冲突处以本文档为准** |
| 动效体系 | `frontend/docs/motion-system.md` | 跨版本共用（`u-*` / `--motion-*`） |
| 暗黑层次决策 | `docs/dark-mode-depth-design-decisions.md` | V2 定稿（BLF-573） |
| 图表统一 / 移动端适配 | `docs/chart-unification-spec.md` / `MOBILE_ADAPTATION_RULES.md` | 主题性规范，沿 V2 定稿 |
