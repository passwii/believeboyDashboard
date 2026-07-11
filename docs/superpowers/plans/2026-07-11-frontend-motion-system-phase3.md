# Phase 3 — 高级触感 + 内容 stagger 推广

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0 + Phase 1 + Phase 2 完成 ✅
> **执行日期：** 2026-07-11
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 3.1 — dashboard 首页标题/卡片组接入 MotionStagger
- [x] `app/dashboard/page.tsx`：row 1（KPI + SalesChart）外层 `<section>` 用 `<MotionStagger className="contents">` 包裹，子节点用 `<MotionStaggerItem>` 包裹
- [x] `display: contents` 让 stagger 容器不渲染为 div，保留 `grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]` 布局
- [x] 仅 row 1（最小可行推广），row 2/3 保持不变
- [x] build 通过
- [x] commit `d6fcb8ba` — feat(动效): dashboard 首页标题/卡片组接入 MotionStagger

### ✅ 任务 3.2 — toast/dialog 缓动统一到 token
- [x] `components/notifications/notification-toast.tsx`：`duration: 0.22` → `DURATION.springPress`
- [x] 保守方案：ease 字符串 `easeOut` 保持原样（不替换为 `EASE.out` 数组，避免语义混淆）
- [x] `.ui-floating-motion` 的 `cubic-bezier(0.34, 1.56, 0.64, 1)` 未触碰（已是 `--motion-spring-press` 一致）
- [x] `notification-wrapper.tsx` 无 framer-motion transition 值（实际无文件改动）
- [x] commit `18a95d05` — refactor(动效): toast/dialog 缓动统一引用 token

### ✅ 任务 3.3 — Phase 3 整体验证
- [x] lint 0 errors / build 通过 / test 146 passed (20 files)
- [x] tag `phase3-premium-stagger` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过
- [x] `pnpm test` 全 PASS：20 files / 146 tests
- [x] git tag `phase3-premium-stagger` 已创建

## 关键 commit

```
18a95d05 refactor(动效): toast/dialog 缓动统一引用 token
d6fcb8ba feat(动效): dashboard 首页标题/卡片组接入 MotionStagger
```

## 已知可观察行为（不影响功能）

- `MotionStagger` reduced-motion 分支渲染 Fragment 时，子 `MotionStaggerItem` 失去 variants 上下文 → 依赖 framer-motion 默认行为（无 animate 指令时显示 natural state，无 opacity:0 问题）。属 framer-motion 行为契约依赖，非显式保障。

## 手动验收待执行（Phase 4 收口）

> 用户在浏览器中：
> 1. 浏览器访问 /dashboard，进入时 row 1（KPI + 销售图）应错落进场（70ms 间隔）
> 2. 网格布局未破坏：KPI 占左 2fr、销售图占右 3fr
> 3. 系统 `prefers-reduced-motion: reduce` 启用时，stagger 不应触发

## 下一阶段

✅ Phase 3 完成 → 进入 **Phase 4**（验收：Playwright 回归 + Lighthouse + 手动 9 条 + 最终 tag）。

详细任务在 `docs/superpowers/plans/2026-07-11-frontend-motion-system-phase4.md`。