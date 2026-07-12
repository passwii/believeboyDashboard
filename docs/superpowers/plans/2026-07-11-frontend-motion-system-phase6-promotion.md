# Phase 6 — Phase 2/3 推广（spotlight + stagger + u-* 扩散到全站高频表面）

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-5 完成（含 hotfix 1-4）+ tag `phase5-page-transition-refactor`
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 背景与动机

Phase 2/3 试点只覆盖 row 1 + Button + Sidebar + 一张 KPI 卡 + row 1 stagger。Phase 6 把试点扩散到 row 2/3 + ad-analysis 入口页 + 4 个高频 UI 组件。

## 任务清单

### ✅ 任务 6.1 — row 2 数据卡 MotionStagger
- [x] `frontend/app/dashboard/page.tsx` line 506-549：`MotionStagger className="contents"` 包裹 3 个子组件（DashboardAlertWidget / DashboardHealthKpis / DashboardTopProjects）
- [x] 每个子组件用 `<MotionStaggerItem>` 包裹
- [x] **不嵌套 dashboard-surface**：3 个子组件根已通过 DataCard/DataTableCard 自带 dashboard-surface，**未**包 `<DashboardSurfaceCard>`，只加 stagger（plan 标题"spotlight + stagger"与约束"已带 dashboard-surface → 只加 stagger"协调后按约束执行）
- [x] commit `79c6ce6d` — feat(动效): dashboard row 2 数据卡 spotlight + MotionStagger

### ✅ 任务 6.2 — row 3 数据卡 MotionStagger
- [x] `frontend/app/dashboard/page.tsx` line 551-595：同上模式包裹 DashboardTopCountries + LazyDashboardAdSpendChart
- [x] commit `fa181978` — feat(动效): dashboard row 3 数据卡 spotlight + MotionStagger

### ✅ 任务 6.3 — ad-analysis 入口页 MotionStagger
- [x] **改 layout 而非 page.tsx**（更合理）：10 个 page.tsx 都是 `<AdAnalysisXxxClient />` 单行 wrapper，包 MotionStagger 包围单 child 无 stagger 效果；改 `frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx` 包裹 TopFilters + TabNav + children 三个有意义 stagger 节点
- [x] commit `a209c948` — feat(动效): ad-analysis 入口页接入 MotionStagger

### ✅ 任务 6.4 — u-interactive 推广到高频 UI 组件
- [x] `dropdown-menu.tsx`：DropdownMenuItem / DropdownMenuCheckboxItem / DropdownMenuRadioItem 加 `u-interactive`（3 处）
- [x] `tabs.tsx`：TabsTrigger 加 `u-interactive`（1 处）
- [x] `combobox.tsx`：trigger Button 加 `u-interactive`（1 处）
- [x] `calendar.tsx`：button_previous / button_next / day_button 加 `u-interactive`（3 处）
- [x] commit `283fa872` — refactor(动效): u-interactive 推广到 dropdown-menu/tabs/combobox/calendar

### ✅ 任务 6.5 — Phase 6 整体验证 + tag
- [x] lint 0 errors / build pass / test **154 passed (21 files)**（零回归）
- [x] tag `phase6-promotion` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过：全部 page 编译
- [x] `pnpm test` 全 PASS：21 files / 154 tests（与 Phase 5 持平，无退化）
- [x] git tag `phase6-promotion` 已创建并指向 HEAD
- [x] 4 commits + 1 tag 已 push 到 `origin/feat/frontend-motion-system`

## 关键 commit

```
283fa872 refactor(动效): u-interactive 推广到 dropdown-menu/tabs/combobox/calendar
a209c948 feat(动效): ad-analysis 入口页接入 MotionStagger
fa181978 feat(动效): dashboard row 3 数据卡 spotlight + MotionStagger
79c6ce6d feat(动效): dashboard row 2 数据卡 spotlight + MotionStagger
```

## 关键变更摘要

**修改**：
- `frontend/app/dashboard/page.tsx`（row 2 + row 3）
- `frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx`
- `frontend/components/ui/dropdown-menu.tsx`
- `frontend/components/ui/tabs.tsx`
- `frontend/components/ui/combobox.tsx`
- `frontend/components/ui/calendar.tsx`

## 实施过程亮点

1. **Plan 与约束的协调**：plan 6.1/6.2 标题写"spotlight + stagger"，但约束明确说"已带 dashboard-surface → 只加 stagger"。Row 2/3 子组件根（DataCard/DataTableCard）已自带 dashboard-surface，所以只加 stagger，**未包 `<DashboardSurfaceCard>` 避免嵌套**。
2. **6.3 改 layout 而非 page.tsx**：10 个 ad-analysis page.tsx 是单行 wrapper，无可 stagger 的多子节点结构；改 layout 包裹 3 个有意义节点更合理。
3. **实施过程恢复**：tabs.tsx 因 className 单行超长（>2000 字符），第一次 Edit 误截断 → `git checkout` 还原 → 用更小唯一锚点重试成功。构建瞬态失败（stale worker）→ kill + rm -rf .next 恢复，与代码改动无关。

## 手动验收（用户在浏览器）

1. `/dashboard`：进入时 row 1/2/3 全部错落进场（70ms 间隔）
2. `/dashboard/data-analysis/ad-analysis/overview`：TopFilters + TabNav + 内容区错落进场
3. 任意 dropdown-menu：菜单项 hover 微提亮
4. tabs：trigger hover 微提亮 + active 状态有 spring 过渡
5. combobox：trigger hover 微提亮
6. calendar：日期 cell hover 微提亮

## 下一阶段

✅ Phase 6 完成 → 进入 **Phase 7**（通用组件动效统一：Popover/Dialog/Drawer/Sheet spring + 表单元素微动效 + Skeleton 入场）。

详细任务在 `2026-07-11-frontend-motion-system-phase7-component-motion.md`（后续 Phase 7 计划时创建）。