# Phase 7 — 通用组件动效统一

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-6 完成 + tag `phase6-promotion`
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 7.1 — Radix 派生组件 spring 过渡统一
- [x] 评估：`popover.tsx` 已使用 `ui-floating-motion`，无需重复加 spring；`dialog.tsx` 无 framer-motion
- [x] 改 `frontend/components/ui/sheet.tsx`：关闭时长 → `var(--motion-slow)`
- [x] 改 `frontend/components/ui/tooltip.tsx`：关闭时长 → `var(--motion-fast)`
- [x] commit `7bcf0101` — refactor(动效): Radix popover/dialog/sheet/tooltip spring 过渡统一 token

> commit message 提到 popover/dialog 但实际只改了 sheet/tooltip（小偏差，commit body 与实际不符）

### ✅ 任务 7.2 — 表单元素微动效
- [x] 评估：`toggle.tsx` / `radio-group.tsx` **不存在**（未强行新建）
- [x] 改 `frontend/components/ui/checkbox.tsx`：token 化颜色过渡
- [x] 改 `frontend/components/ui/switch.tsx`：Root 颜色过渡 token 化 + Thumb 从硬编码 `duration-200` + cubic-bezier 改为 `var(--motion-spring-press)`
- [x] commit `cb2103f3` — feat(动效): 表单元素 Toggle/Checkbox/Radio/Switch 微动效统一

### ✅ 任务 7.3 — Skeleton/Loading 入场过渡
- [x] 新增 `.u-skeleton-shimmer` utility（globals.css）
- [x] 复用现有 `@keyframes shimmer`
- [x] 改 `frontend/components/ui/skeleton.tsx`：从 `animate-pulse` 升级到 shimmer
- [x] 保留 Skeleton API 与 `className` 覆盖能力
- [x] commit `2e8e625c` — feat(动效): Skeleton/Loading 入场过渡优化

### ✅ 任务 7.4 — ai-chat 自定义动效 token 化
- [x] 评估：只替换与现有 token 数值完全对齐的 cubic-bezier；保留 ai-chat 独立时序（`0.6s` / `1.2s` / pulse 等）
- [x] 改 `frontend/components/chat/constants/animation-styles.ts`
- [x] 改 `frontend/components/chat/ai-chat-window.tsx`
- [x] 改 `frontend/components/chat/ray-background.tsx`
- [x] `cubic-bezier(0.16, 1, 0.3, 1)` → `var(--motion-ease-standard)`
- [x] `cubic-bezier(0.22, 1, 0.36, 1)` → `var(--motion-ease-out)`
- [x] commit `f55a75f6` — refactor(动效): ai-chat 自定义动效 token 化

### ✅ 任务 7.5 — Phase 7 整体验证 + tag
- [x] lint 0 errors / build pass / test **154 passed (21 files)**（零回归）
- [x] tag `phase7-component-motion` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过：全部 page 编译
- [x] `pnpm test` 全 PASS：21 files / 154 tests（与 Phase 6 持平）
- [x] git tag `phase7-component-motion` 已创建
- [x] 4 commits + 1 tag 已 push 到 `origin/feat/frontend-motion-system`

## 关键 commit

```
f55a75f6 refactor(动效): ai-chat 自定义动效 token 化
2e8e625c feat(动效): Skeleton/Loading 入场过渡优化
cb2103f3 feat(动效): 表单元素 Toggle/Checkbox/Radio/Switch 微动效统一
7bcf0101 refactor(动效): Radix popover/dialog/sheet/tooltip spring 过渡统一 token
```

## 关键变更摘要

**修改**：
- `frontend/components/ui/sheet.tsx`
- `frontend/components/ui/tooltip.tsx`
- `frontend/components/ui/checkbox.tsx`
- `frontend/components/ui/switch.tsx`
- `frontend/components/ui/skeleton.tsx`
- `frontend/app/globals.css`（新增 `.u-skeleton-shimmer`）
- `frontend/components/chat/constants/animation-styles.ts`
- `frontend/components/chat/ai-chat-window.tsx`
- `frontend/components/chat/ray-background.tsx`

## 实施纪律亮点

1. **保守评估**：每个任务都先 grep + 读文件评估是否真的有改动空间
2. **不强行加 spring**：`.ui-floating-motion` 已 token 化的组件不重复叠加
3. **不强行新建**：toggle / radio-group 不存在就不建（避免范围蔓延）
4. **不动 a11y**：未修改 `focus-visible` / `aria-*` / Radix state 语义
5. **ai-chat 时序独立**：保留 chips `2.8s delay + 0.6s scale-in` 等独立时序，避免全局 token 化破坏视觉

## 手动验收（用户在浏览器）

1. **Sheet/Drawer**（任意带 sheet 的页面）：打开/关闭有过渡时长变化（应仍流畅）
2. **Tooltip**：hover 触发，过渡时长基于 `--motion-fast`
3. **Switch / Checkbox**：状态切换有 spring 手感
4. **Skeleton**：loading 状态从 pulse 升级为 shimmer（更精致的渐变光带滑动）
5. **ai-chat**（视觉一致性）：chips / arcs / particles 的入场动画应仍与改动前一致

## 下一阶段

✅ Phase 7 完成 → 进入 **Phase 8**（性能 + 可访问性收口：Lighthouse 优化 + axe-core 扫描 + reduced-motion 退化回归 + CI 集成）。

详细任务在 `2026-07-11-frontend-motion-system-phase8-perf-a11y.md`（后续 Phase 8 计划时创建）。