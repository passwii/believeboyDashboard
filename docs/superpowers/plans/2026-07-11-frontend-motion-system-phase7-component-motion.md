# Phase 7 — 通用组件动效统一

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-6 完成 + tag `phase6-promotion`
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ⏳ pending（开工前）

## 背景与动机

Phase 2-6 主要覆盖：
- Button / Sidebar / 4 个 UI 组件（dropdown-menu/tabs/combobox/calendar）
- DashboardSurfaceCard + KPI 试点
- 路由切换 + 内容 stagger

**未覆盖的通用动效**：
1. **Radix 派生组件**（Popover / Dialog / Sheet / Tooltip）的 spring 过渡尚未统一到 token
2. **表单元素**（Toggle / Checkbox / Radio / Switch）的状态切换微动效缺失
3. **Skeleton/Loading** 的入场过渡（list-item / table-row）
4. **ai-chat 自定义动效**（`bb-anim-scale-in` / `bb-arcs-entrance`）未接入 motion token

Phase 7 收口通用组件动效，让"全站动效一致"从设计原则变成代码事实。

## 前置状态

- `frontend/components/ui/` 已知有：`popover.tsx` / `dialog.tsx` / `sheet.tsx`（可能） / `tooltip.tsx` / `dropdown-menu.tsx`（已动）/ `toggle.tsx` / `checkbox.tsx` / `radio-group.tsx` / `switch.tsx` / `form.tsx` / `input.tsx` 等
- 已就位 token：`DURATION` / `EASE` / `SPRING` / `STAGGER`（`lib/motion/tokens.ts`）
- 已就位 utility：`.ui-floating-motion` / `.ui-overlay-motion`（globals.css 中已有 Radix 默认过渡）
- ai-chat 自定义动效：见 `frontend/components/chat/constants/animation-styles.ts`

## 任务清单

### ⏳ 任务 7.1 — Radix 派生组件 spring 过渡统一

**文件**：
- 修改：`frontend/components/ui/popover.tsx`
- 修改：`frontend/components/ui/dialog.tsx`
- 修改：`frontend/components/ui/sheet.tsx`（如果存在）
- 修改：`frontend/components/ui/tooltip.tsx`

**实现要点**：
- 这些 Radix 组件可能用 framer-motion 或 CSS 过渡
- 若用 framer-motion：把硬编码 `duration: 0.2/0.3` 与 `ease: [...]` 替换为 `DURATION.*` + `EASE.*`
- 若用 CSS（`.ui-floating-motion` / `.ui-overlay-motion`）：确认引用 token，**不**改 cubic-bezier（已是 `--motion-spring-press` 一致）
- 关键原则：**不要**重复加 spring 过渡（已有 `.ui-floating-motion` 的组件不应再叠加）
- build + test 验证

**commit**：`refactor(动效): Radix popover/dialog/sheet/tooltip spring 过渡统一 token`

---

### ⏳ 任务 7.2 — 表单元素微动效（Toggle / Checkbox / Radio / Switch）

**文件**：
- 修改：`frontend/components/ui/toggle.tsx`
- 修改：`frontend/components/ui/checkbox.tsx`
- 修改：`frontend/components/ui/radio-group.tsx`
- 修改：`frontend/components/ui/switch.tsx`

**实现要点**：
- Toggle / Switch：滑动块的 spring 过渡（用 framer-motion layout 或 spring key）
- Checkbox / Radio：状态切换的勾画动画（用 framer-motion 或 SVG path animation）
- 检查现有实现：
  - 已有 `@radix-ui/react-switch` 等 Radix 组件 → 可能已有内置过渡，确认引用 token
  - 已有 CVA variants → 给 active / checked 状态加 `data-[state=checked]:` 样式
- 不破坏可访问性（focus-visible ring 保留）
- build + test 验证

**commit**：`feat(动效): 表单元素 Toggle/Checkbox/Radio/Switch 微动效统一`

---

### ⏳ 任务 7.3 — Skeleton/Loading 入场过渡

**文件**：
- 修改：`frontend/components/ui/skeleton.tsx`（如果存在）
- 可能：dashboard 各页面的 dynamic loading skeleton（如 `dashboard-sales-chart.tsx`、`dashboard-ad-spend-chart.tsx` 中的 loading 态）

**实现要点**：
- 检查 `skeleton.tsx` 现状（可能已有 `animate-pulse`）
- 优化：shimmer 效果（gradient slide）替代简单 pulse
- 性能：`will-change` + 减少 layout thrash
- 入场过渡：list-item / table-row 用 `<MotionFade>` + `<MotionStagger>` 进场（如果还没用）
- build + test 验证

**commit**：`feat(动效): Skeleton/Loading 入场过渡优化`

---

### ⏳ 任务 7.4 — ai-chat 自定义动效 token 化

**文件**：
- 修改：`frontend/components/chat/constants/animation-styles.ts`
- 可能：`frontend/components/chat/` 下的 .css / .tsx 散落的 keyframes

**实现要点**：
- grep 现有 ai-chat 自定义 keyframes：`bb-anim-scale-in` / `bb-arcs-entrance` 等
- 检查硬编码 `0.6s` / `0.4s` / `cubic-bezier(...)` 等数值
- 替换为 `var(--motion-base)` / `var(--motion-ease-out)` 等 token 引用（如果已在 globals.css 中有同类动画）
- 不破坏 ai-chat 现有视觉行为
- build + test 验证

**commit**：`refactor(动效): ai-chat 自定义动效 token 化`

---

### ⏳ 任务 7.5 — Phase 7 整体验证 + tag

**验证清单**：
- `pnpm lint && pnpm build && pnpm test` 全过
- 测试数 ≥ 154（不应退化）
- git tag `phase7-component-motion`

**commit / tag**：
- 不新增 commit
- `git tag -a "phase7-component-motion" -m "Phase 7: component motion unification"`

---

## 关键文件变更摘要

**修改**（可能）：
- `frontend/components/ui/popover.tsx`
- `frontend/components/ui/dialog.tsx`
- `frontend/components/ui/sheet.tsx`
- `frontend/components/ui/tooltip.tsx`
- `frontend/components/ui/toggle.tsx`
- `frontend/components/ui/checkbox.tsx`
- `frontend/components/ui/radio-group.tsx`
- `frontend/components/ui/switch.tsx`
- `frontend/components/ui/skeleton.tsx`
- `frontend/components/chat/constants/animation-styles.ts`

## 验证清单（最终）

- [ ] `pnpm lint` 通过：0 errors
- [ ] `pnpm build` 通过
- [ ] `pnpm test` 全 PASS（≥154）
- [ ] 手动验证：Popover/Dialog/Sheet 弹入弹出 spring 手感
- [ ] 手动验证：Toggle/Switch 滑动块 spring 过渡
- [ ] 手动验证：Checkbox/Radio 状态切换动画
- [ ] 手动验证：Skeleton 入场过渡平滑
- [ ] git tag `phase7-component-motion` 已创建

## 关键约束

- **不破坏现有视觉行为**：仅 token 化 + 微弱动效补充，不颠覆现有交互
- **不重复加 spring**：已有 `.ui-floating-motion` / `.ui-overlay-motion` 的组件不应再叠加
- **可访问性优先**：focus-visible ring + aria-* 不被动画覆盖
- **每个推广单元独立 commit**：便于审查 + 回滚
- **不动业务逻辑**：动效是叠加层

## 下一阶段

✅ Phase 7 完成 → 进入 **Phase 8**（性能 + 可访问性收口：Lighthouse 优化 + axe-core 扫描 + reduced-motion 退化回归 + CI 集成）。

详细任务在 `2026-07-11-frontend-motion-system-phase8-perf-a11y.md`（后续 Phase 8 计划时创建）。