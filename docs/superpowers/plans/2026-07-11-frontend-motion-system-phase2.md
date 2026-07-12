# Phase 2 — hover / active 标准化

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0 + Phase 1 完成 ✅
> **执行日期：** 2026-07-11
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 2.1 — Button 接入 u-press/u-focus/u-interactive + 测试
- [x] TDD：`button.test.tsx` 2/2 PASS
- [x] `button.tsx` line 8 base className 追加 `u-press u-focus u-interactive`
- [x] commit `c1cabcdd` — feat(动效): Button 接入 u-press/u-focus/u-interactive

> **spec 偏离**（合理）：测试 regex 从 `/transition/` 升级为 `\bu-(press|focus|interactive)\b` 三个独立 toMatch。升级版更精准（不依赖 Tailwind `transition` 类，精确锁定本次新增的三个 token）。Spec reviewer 评估：升级合理。

### ✅ 任务 2.2 — Sidebar active 指示 spring + hover 规范
- [x] `sidebar-icon-rail.tsx:76` (RailChip) + `:132` (UserChip)：spring transition 仅在 `isActive` 分支追加（不污染全局）
- [x] `sidebar-panel.tsx:120` RouteLoadingLink：nav item 追加 `u-interactive transition-colors`
- [x] commit `de98d17e` — feat(动效): Sidebar active 指示 spring + nav item hover 规范

### ✅ 任务 2.3 — DashboardSurfaceCard spotlight 包装 + 测试
- [x] TDD：`dashboard-surface-card.test.tsx` 2/2 PASS
- [x] 实现 `dashboard-surface-card.tsx`：'use client' + useSpotlight + cn() + 径向高光 before: 装饰
- [x] commit `068af806` — feat(动效): 新增 DashboardSurfaceCard spotlight 包装

> **类型兼容性绕路**（合理）：useSpotlight 内部 `RefObject<E | null>` 在 React 18 下与 `<div ref>` 类型不兼容。组件用本地 `useRef<HTMLDivElement>(null)` + 注入 ref 选项。功能等价（useEffect 用 ref.current 挂 pointermove listener，组件 ref 同时绑到 div）。Spec reviewer 评估：绕路有效，避免改 Phase 0 已合并的 hook。

### ✅ 任务 2.4 — dashboard 首页 KPI 卡试点 spotlight
- [x] `page.tsx:508-510`：`<DashboardSurfaceCard className="p-5">` 包裹 `<DashboardMetricTiles>`
- [x] **不嵌套**：`DashboardMetricTiles` 组件本身不带 `dashboard-surface`（用 `TileCard`），试点不形成 `dashboard-surface > dashboard-surface` 双层
- [x] 不全量替换其它 91 处 `.dashboard-surface` 用法
- [x] commit `112ce34a` — feat(动效): dashboard 首页 KPI 卡片试点 spotlight 包装

### ✅ 任务 2.5 — Phase 2 整体验证 + tag
- [x] lint 0 errors / build pass / test 146 passed (20 files)
- [x] tag `phase2-hover-active` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（全部 pre-existing react-hooks/exhaustive-deps）
- [x] `pnpm build` 通过：全部路由编译
- [x] `pnpm test` 全 PASS：20 files / 146 tests
- [x] git tag `phase2-hover-active` 已创建并指向 HEAD

## 关键 commit

```
112ce34a feat(动效): dashboard 首页 KPI 卡片试点 spotlight 包装
068af806 feat(动效): 新增 DashboardSurfaceCard spotlight 包装
de98d17e feat(动效): Sidebar active 指示 spring + nav item hover 规范
c1cabcdd feat(动效): Button 接入 u-press/u-focus/u-interactive
```

## 手动验收待执行（Phase 4 收口）

> 用户在浏览器中：
> 1. 按钮 hover 上浮、active scale(0.97) 回弹、Tab 焦点环可见
> 2. Sidebar active 项指示 spring 过渡、hover 展开 panel
> 3. 试点 KPI 卡 hover 看到聚光边跟随指针；其余卡片无 pointermove 监听

## 下一阶段

✅ Phase 2 完成 → 进入 **Phase 3**（高级触感 + 内容 stagger 推广）。

详细任务在 `docs/superpowers/plans/2026-07-11-frontend-motion-system-phase3.md`。