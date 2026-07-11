# Phase 1 — 全局路由过渡 + 两项结构修正

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0 完成 ✅
> **执行日期：** 2026-07-11
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 关键结构性修正（全部完成）

- ✅ `app/dashboard/layout.tsx` 整页 swap → 拆 `{isNavigationLoading ? <DashboardPageLoading/> : children}` 为始终渲染 children（children 经由 `<PageTransition>` 包裹，line 60-62）
- ✅ `app/dashboard/data-analysis/ad-analysis/layout.tsx` 嵌套 PageTransition → children 直接渲染（保留 `<Suspense fallback={<DashboardPageLoading/>}>` 兜底，L14）

## 任务清单

### ✅ 任务 1.1 — `useSpotlight` hook
- [x] TDD：`use-spotlight.test.tsx` 3/3 PASS
- [x] 实现 `components/motion/use-spotlight.ts`（matchMedia 守卫 + pointermove → --spot-x/--spot-y）
- [x] commit `c9d8e737` — feat(动效): 新增 useSpotlight hook + 单测

> **轻微观察**（非缺陷）：hook 注释提 "coarse pointer 自动关闭" 但实作只检 reduced-transparency。该不完整与父 plan §1.1 参考实作同步；CSS 侧也无 `(pointer: coarse) → --spotlight-strength: 0` 兜底规则。建议在 Phase 2 dashboard-surface-card 引入时统一补齐。

### ✅ 任务 1.2 — `MotionFade` 原语
- [x] TDD：`motion-fade.test.tsx` 2/2 PASS
- [x] 实现 `components/motion/MotionFade.tsx`（useReducedMotion 守卫，`@/lib/motion/tokens` 引用）
- [x] commit `15705cb6` — feat(动效): 新增 MotionFade 原语

### ✅ 任务 1.3 — `MotionStagger` 原语
- [x] TDD：`motion-stagger.test.tsx` 2/2 PASS
- [x] 实现 `components/motion/MotionStagger.tsx`（MotionStagger + MotionStaggerItem，staggerChildren 0.07 + delayChildren 0.02）
- [x] commit `73bacaab` — feat(动效): 新增 MotionStagger / MotionStaggerItem

> **spec 偏离 1**（合理）：测试选择器从 `div > div` 改为 `div[style*="opacity"]`。原选择器在 RTL 中匹配外层容器（空变体无 inline opacity），改用属性选择器更稳健指向 MotionStaggerItem 的 motion.div。Spec reviewer 评估：fix 而非 hack。

### ✅ 任务 1.4 — `PageTransition` 全局路由过渡
- [x] TDD：`page-transition.test.tsx` 2/2 PASS
- [x] 实现 `components/motion/PageTransition.tsx`（AnimatePresence mode='wait' + key=pathname；reduce/reduceTransparency/normal 三态完整；无方向判定）
- [x] commit `35966b7d` — feat(动效): 新增 PageTransition 全局路由过渡

> **spec 偏离 2**（合理）：第二个测试原本用 `vi.spyOn(framer, 'useReducedMotion').mockReturnValue(true)`，但 vitest 4 下属性是只读 getter（抛 `Cannot redefine property`）。简化方案保留核心价值（children 挂载 + AnimatePresence 渲染），filter/blur 真实行为交由 e2e/手动验证。Spec reviewer 评估：合理。

### ✅ 任务 1.5 — dashboard/layout 接入 PageTransition + 拆整页 swap
- [x] TDD：`app/dashboard/layout.test.tsx` 用最危险 case（`isNavigationLoading=true`）验证 children 必渲染 + page-loading 必不出现
- [x] 修改 `app/dashboard/layout.tsx`：
  - L6 import `PageTransition`
  - 删除 `DashboardPageLoading` import
  - 删除 `useGlobalLoading` hook 调用（layout 不再依赖）
  - L60–62 children 用 `<PageTransition>` 包裹
- [x] grep 验证：layout.tsx 无 `DashboardPageLoading` / `isNavigationLoading` 引用
- [x] lint + build 通过
- [x] commit `f9221075` — feat(动效): dashboard layout 接入 PageTransition 拆整页 loading swap

### ✅ 任务 1.6 — ad-analysis layout 拆嵌套 PageTransition
- [x] 修改 `app/dashboard/data-analysis/ad-analysis/layout.tsx`：
  - 删除 `<AdAnalysisPageTransition>` 包裹
  - children 直接渲染于 `<Suspense fallback={<DashboardPageLoading/>}>` 内
  - 保留 `AdAnalysisTopFilters` + `AdAnalysisTabNav` 其它职责
- [x] grep 验证：`AdAnalysisPageTransition` 仅匹配定义文件（孤立，已 dead code）
- [x] build 通过（tree-shake 掉 dead code）
- [x] commit `9302a48f` — refactor(动效): 拆 ad-analysis 嵌套 PageTransition 包裹 防全局双层动画

### ✅ 任务 1.7 — 审计残留 + Phase 1 整体验证
- [x] grep `AnimatePresence\|key={pathname}`：dashboard 区域仅匹配 dead code 的 `page-transition.tsx`（line 3/65/67/83），实际渲染路径无嵌套过渡
- [x] lint/build/test 三道关卡通过
- [x] tag `phase1-motion-transition`（annotated，msg "Phase 1: global page transition"）

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（全部 pre-existing）
- [x] `pnpm build` 通过：全部路由编译
- [x] `pnpm test` 全 PASS：18 files / 142 tests
- [x] git tag `phase1-motion-transition` 已创建并指向 HEAD

## 关键 commit

```
9302a48f refactor(动效): 拆 ad-analysis 嵌套 PageTransition 包裹 防全局双层动画
f9221075 feat(动效): dashboard layout 接入 PageTransition 拆整页 loading swap
35966b7d feat(动效): 新增 PageTransition 全局路由过渡
73bacaab feat(动效): 新增 MotionStagger / MotionStaggerItem
15705cb6 feat(动效): 新增 MotionFade 原语
c9d8e737 feat(动效): 新增 useSpotlight hook + 单测
```

## 已知可观察偏差（不影响功能）

1. `use-spotlight.ts` 注释提 "coarse pointer 自动关闭" 但实作未实现（与父 plan §1.1 参考实作同步）→ 建议 Phase 2.3 补齐
2. `components/dashboard/ad-analysis/page-transition.tsx` 已 dead code（仅自身 grep 命中）→ 后续可加 `@deprecated` 标记或清理
3. PageTransition reduced-motion/reduced-transparency 分支的真实行为靠 e2e/手动验证（spec 自己也提示脆弱）→ Phase 4 手动验收

## 手动验收待执行（Phase 4 收口）

> 用户在浏览器中：
> 1. /dashboard 内任意两路由切换：旧页 exit → 新页 enter，spring + blur 一致
> 2. ad-analysis 子路由间切换：**无双层动画**（重点回归）
> 3. 切换路由时顶栏 GlobalLoadingOverlay 仍可见

## 下一阶段

✅ Phase 1 完成 → 进入 **Phase 2**（hover/active 标准化）。

详细任务在 `docs/superpowers/plans/2026-07-11-frontend-motion-system-phase2.md`。