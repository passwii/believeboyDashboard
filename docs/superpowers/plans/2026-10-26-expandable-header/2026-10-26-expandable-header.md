# 可展开二层页面头部 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在终端头部加入可复用的第二层筛选区，并将每日分析页的站点与 SKU 筛选放入其中。

**Architecture:** 保留当前页面操作插槽，给页面次级筛选增加独立 portal anchor 和活动状态。`TerminalHeader` 将固定 56px 首层与按需显示的第二层分开布局；试点页的项目/日期在首层、站点在第二层，每日分析再把 SKU 注册到次级插槽。移动端继续使用现有正文筛选条。

**Tech Stack:** Next.js App Router、React、TypeScript、Tailwind CSS、Radix/shadcn primitives、Vitest、Testing Library。

## Global Constraints

- 桌面端默认在头部首层保留项目和日期筛选。
- 次级筛选默认收起，右侧按钮使用 `aria-expanded` 和明确的展开/收起可访问名称。
- 展开后头部在首层下方增加一行，正文自然下移，不覆盖内容。
- 全局站点筛选与显式注册的页面次级筛选共同放在第二层。
- 页面切换后第二层恢复收起；没有次级筛选时不显示按钮或空行。
- 保留现有通用 `HeaderSlotMount` 和其中的页面操作，不改变筛选状态、URL、缓存及数据请求语义。
- `md` 以下保持当前移动端筛选条与控件顺序。
- 本变更影响共享头部；按仓库 T3 规则跑前端全量测试和 `pnpm lint`。

---

### Task 1: 增加独立的次级头部插槽

**Files:**
- Modify: `frontend/components/terminal/terminal-header-slot.tsx`
- Test: `frontend/components/terminal/terminal-header-slot.test.tsx`

**Interfaces:**
- `TerminalHeaderSlotContextValue` 增加 `secondaryAnchor: HTMLElement | null` 与 `secondarySlotActive: boolean`。
- 新增 `SecondaryHeaderSlotMount` 作为 `TerminalHeader` 第二行的 DOM anchor。
- 新增 `useSecondaryHeaderSlot(node: React.ReactNode): React.ReactPortal | null`，把页面次级筛选 portal 到该 anchor；非空内容注册活动状态，页面卸载时注销。
- 原 `HeaderSlotMount`、`useHeaderSlot` 与移动端筛选 API 保持原签名和语义。

- [ ] **Step 1: 先写次级插槽失败测试**

在 `terminal-header-slot.test.tsx` 的测试外壳中挂载 `SecondaryHeaderSlotMount`，添加页面 harness 使用 `useSecondaryHeaderSlot(<span>SKU 筛选</span>)`。断言 portal 内容出现在 `data-testid="terminal-secondary-header-slot"` 内、`secondarySlotActive` 为 `true`；卸载页面后内容清除且状态回到 `false`。再断言空内容不激活插槽。

- [ ] **Step 2: 运行目标测试确认失败**

Run: `cd frontend && pnpm exec vitest run components/terminal/terminal-header-slot.test.tsx`
Expected: 新增用例因次级挂载组件、hook 与 context 状态不存在而失败；原有插槽与刷新用例保持通过。

- [ ] **Step 3: 实现次级 anchor 与注册生命周期**

在 Provider 增加次级 anchor setter 与带 token 的注册/注销回调，避免旧页面 cleanup 清除更新后的注册状态。`SecondaryHeaderSlotMount` 复用现有 binding context。`useSecondaryHeaderSlot` 仅在 `node != null` 时注册，并在 anchor 就绪后通过 `createPortal` 渲染。

- [ ] **Step 4: 重跑插槽测试**

Run: `cd frontend && pnpm exec vitest run components/terminal/terminal-header-slot.test.tsx`
Expected: 所有插槽和刷新测试通过；页面卸载后 portal 内容与活动状态都清除。

---

### Task 2: 将终端头部改为可展开双层布局

**Files:**
- Modify: `frontend/components/terminal/terminal-header.tsx`
- Test: `frontend/components/terminal/terminal-header.test.tsx`

**Interfaces:**
- 首层保留 56px 高度；外层 header 按内容自然增高。
- 第二行由 `SecondaryHeaderSlotMount` 承载全局站点选择器与页面次级 portal。
- `xl` 及以上试点路由的全局站点选择器在第二行；`md` 至 `xl` 的页面降级站点筛选由页面次级 portal 提供。
- 展开按钮仅在存在可见的全局次级筛选或页面次级 slot 时出现。

- [ ] **Step 1: 写头部层级与展开行为测试**

在 `terminal-header.test.tsx` 增加用例：每日分析路由默认首层显示项目和日期，站点与次级 SKU 不显示；按钮 `aria-expanded="false"`；点击后 `aria-expanded="true"`，站点与 SKU 显示在第二行；再次点击后收起。另测非试点且没有次级注册的页面不显示按钮，切换 pathname 会收起第二层。原有页面插槽控件仍在首层。

- [ ] **Step 2: 运行头部测试确认新断言失败**

Run: `cd frontend && pnpm exec vitest run components/terminal/terminal-header.test.tsx`
Expected: 新层级、按钮与收起状态断言失败；现有刷新、通知、用户菜单用例通过。

- [ ] **Step 3: 实现双层头部与全局筛选分组**

将当前固定高度 `<header>` 改为纵向容器；首层内部行继续使用 `TERMINAL_HEADER_HEIGHT`。把 `HeaderCountrySelect` 从项目/站点/日期组移到第二行的 `xl` 断点分支，在右侧全局图标组增加带 `aria-expanded` 的 Chevron 按钮。第二行关闭时不挂载筛选内容；打开时显示全局站点控件和次级 anchor。按钮只在 `xl` 试点路由有全局次级筛选，或页面注册 `secondarySlotActive` 时显示。监听 `pathname` 变化并收起。保留普通页面插槽原位置。

- [ ] **Step 4: 重跑头部测试**

Run: `cd frontend && pnpm exec vitest run components/terminal/terminal-header.test.tsx`
Expected: 新增双层布局断言和原有头部行为用例通过；首层高度仍为 `TERMINAL_HEADER_HEIGHT`。

---

### Task 3: 将每日分析页筛选拆分到首层与第二层

**Files:**
- Modify: `frontend/components/dashboard/daily-analysis-header-filters.tsx`
- Test: `frontend/components/dashboard/daily-analysis-header-filters.test.tsx`
- Create: `frontend/components/dashboard/daily-analysis-header-slots.tsx`
- Test: `frontend/components/dashboard/daily-analysis-header-slots.test.tsx`
- Modify: `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`

**Interfaces:**
- 新增 `LegacyFallbackProjectDateFilters`：受控项目与日期筛选，接受当前 country 以选择日期时区。
- 新增 `LegacyFallbackCountryFilter`：受控站点选择。
- `LegacyFallbackFilters` 保留原接口和全量三件套输出，内部组合以上组件，避免其他调用行为变化。
- 新增 `DailyAnalysisHeaderSlots`，接收 `isMobile`、首层、次级和移动端筛选节点；桌面只 portal 首层/次级，移动端只 portal 现有移动筛选条。
- 每日分析页用 `DailyAnalysisHeaderSlots` 注册 `md` 至 `xl` 的首层项目/日期与次级站点/SKU；`xl` 以上首层/全局站点继续由 TerminalHeader 全局筛选渲染。

- [ ] **Step 1: 为拆分控件与 slot adapter 写失败测试**

在 `daily-analysis-header-filters.test.tsx` 验证项目/日期组件只渲染项目与日期并调用原回调；站点组件只渲染站点并调用 `onCountryChange`；原 `LegacyFallbackFilters` 仍包含全部三项。在 `daily-analysis-header-slots.test.tsx` 用真实 `TerminalHeaderSlotProvider`、两个 desktop mount 与 `MobileStripMount` 验证：桌面节点分别进入首层/次级 anchor，移动端节点只进入 mobile strip，desktop anchors 不残留内容。

- [ ] **Step 2: 运行目标测试确认新用例失败**

Run: `cd frontend && pnpm exec vitest run components/dashboard/daily-analysis-header-filters.test.tsx components/dashboard/daily-analysis-header-slots.test.tsx`
Expected: 新组件导出与 slot adapter 断言失败；原有 SKU 和降级筛选用例通过。

- [ ] **Step 3: 拆分降级筛选并实现 slot adapter**

从现有 `LegacyFallbackFilters` 抽出项目/日期与站点控件，保留各自 class、选项、日期时区及回调；再由旧组件组合两者，维持原调用契约。新增 `DailyAnalysisHeaderSlots` 调用 `useHeaderSlot`、`useSecondaryHeaderSlot`、`useMobileFilterStrip`，按 `isMobile` 参数只挂载当前断点的节点。

- [ ] **Step 4: 重跑拆分与 slot adapter 测试**

Run: `cd frontend && pnpm exec vitest run components/dashboard/daily-analysis-header-filters.test.tsx components/dashboard/daily-analysis-header-slots.test.tsx`
Expected: 新拆分和 slot adapter 测试及全部旧测试通过。

- [ ] **Step 5: 接入每日分析页的两个桌面插槽**

将现有 `headerFilterControls` 分成首层与次级内容：`md` 至 `xl` 首层传入 `LegacyFallbackProjectDateFilters`；第二层传入 `LegacyFallbackCountryFilter` 和 SKU。`xl` 及以上首层筛选继续由全局组件显示，页面次级节点只包含 SKU，站点由全局第二层显示。移动端 `MobileFilterStrip` 保持项目、站点、日期、SKU 全量四件套，并交给 `DailyAnalysisHeaderSlots`。

- [ ] **Step 6: 运行头部接线与数据绑定目标测试**

Run: `cd frontend && pnpm exec vitest run components/dashboard/daily-analysis-header-filters.test.tsx components/dashboard/daily-analysis-header-slots.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx`
Expected: 控件分组、portal 路由与现有头部到页面数据绑定契约测试全部通过。

---

### Task 4: 完成共享头部回归验证

**Files:**
- Verify: `frontend/components/terminal/terminal-header.test.tsx`
- Verify: `frontend/components/terminal/terminal-header-slot.test.tsx`
- Verify: `frontend/components/dashboard/daily-analysis-header-filters.test.tsx`
- Verify: `frontend/components/dashboard/daily-analysis-header-slots.test.tsx`
- Verify: `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx`

- [ ] **Step 1: 运行 mock 稳定性检查**

Run: `cd frontend && pnpm check:mocks`
Expected: 退出码 `0`，没有不稳定 mock 命中。

- [ ] **Step 2: 运行前端全量测试**

Run: `cd frontend && pnpm test`
Expected: 全量 Vitest 执行完成；记录所有失败文件，并按仓库失败集对账规则区分基线失败与本次回归。

- [ ] **Step 3: 运行前端 lint**

Run: `cd frontend && pnpm lint`
Expected: 退出码 `0`。

- [ ] **Step 4: 检查最终变更与工作区**

Run: `git diff --check` 和 `git status --short`
Expected: 无空白错误；仅有本次头部实现相关文件待提交。
