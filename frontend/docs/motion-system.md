# Motion System Guide

> **适用版本：** v1（Phase 0-10 完成）
> **适用对象：** 在 `frontend/` 下新增 / 修改动效相关的工程师
> **目标：** 让任何工程师在 5 分钟内能决定"用哪个组件 + 用哪个 token"

---

## 1. 概览

本项目动效系统分三层，**自下而上依赖**：

```
┌─────────────────────────────────────────────────────────────┐
│ Composition 层：业务页面组合（dashboard row、profile 等）     │
└─────────────────────────────────────────────────────────────┘
            ↑                    ↑                  ↑
┌─────────────────────────────────────────────────────────────┐
│ Primitive 层：components/motion/*                           │
│ - PageTransition / Normal / FullBleed                       │
│ - MotionFade / MotionStagger / MotionStaggerItem            │
│ - DashboardSurfaceCard（组合 dashboard-surface + spotlight） │
│ - useSpotlight hook                                         │
└─────────────────────────────────────────────────────────────┘
            ↑                    ↑                  ↑
┌─────────────────────────────────────────────────────────────┐
│ Token 层：单一真相源（双侧镜像）                             │
│ - CSS：frontend/app/globals.css :root                        │
│ - JS：  frontend/lib/motion/tokens.ts                        │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**

1. **改 token 必双侧同步**：改 `globals.css` 必须同步改 `tokens.ts`，反之亦然（详见 §2.3）
2. **优先用 Primitive 而非直接用 framer-motion**：业务方只用组合原语，不直接写 `motion.div`
3. **无障碍是默认行为**：reduced-motion / reduced-transparency 不需要单独写，已封装在 Primitive 内

---

## 2. Token 系统

### 2.1 CSS 侧（`frontend/app/globals.css :root`）

| Token | 值 | 用途 |
|-------|----|----|
| `--motion-fast` | `180ms` | hover / focus 等微状态切换（感知阈值上限 ≈ 200ms） |
| `--motion-base` | `240ms` | 通用过渡时长（淡入、面板） |
| `--motion-slow` | `320ms` | 大块内容过渡 |
| `--motion-spring-press` | `220ms cubic-bezier(0.34, 1.56, 0.64, 1)` | 加权按下回弹（`u-press` 用） |
| `--motion-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | ≈ easeOutExpo，惯性减弱 |
| `--motion-ease-standard` | `cubic-bezier(0.16, 1, 0.3, 1)` | 标准缓动 |
| `--stagger-step` | `70ms` | 内容错落步长 |
| `--spot-x / --spot-y` | `50%`（默认） | spotlight 光标坐标（由 `useSpotlight` 写入） |
| `--spotlight-strength` | `1`（默认） | spotlight 强度（reduce-transparency 时为 0） |

### 2.2 JS 侧（`frontend/lib/motion/tokens.ts`）

| JS 常量 | 值 | 对应 CSS | 备注 |
|---------|----|----------|------|
| `DURATION.fast` | `0.18` | `--motion-fast` (180ms) | 单位：秒（framer-motion） |
| `DURATION.base` | `0.24` | `--motion-base` (240ms) | |
| `DURATION.slow` | `0.32` | `--motion-slow` (320ms) | |
| `DURATION.springPress` | `0.22` | `--motion-spring-press` (220ms cubic-bezier...) | |
| `EASE.out` | `[0.22, 1, 0.36, 1]` | `--motion-ease-out` | |
| `EASE.standard` | `[0.16, 1, 0.3, 1]` | `--motion-ease-standard` | |
| `SPRING.page` | `{ stiffness: 260, damping: 30, mass: 1 }` | （无对应 CSS） | 仅 JS 使用，路由过渡 |
| `STAGGER.step` | `0.07` | `--stagger-step` (70ms) | |
| `STAGGER.childDelay` | `0.07` | （同 STAGGER.step） | staggerChildren 用，与 step 同值 |
| `isReducedMotionDefault` | `false` | （运行时 media query） | 常量仅占位，调用方读 `useReducedMotion()` |

**单位转换**：JS 用**秒**（framer-motion API），CSS 用**毫秒**（CSS animation）。ms ÷ 1000 = s。

### 2.3 修改纪律

⚠️ **改一处必须同步另一处**

> **Phase 10 v2 清理**：已删除 `Z.*`（5 档 z-index 标尺）/ `EASE.springBack` / `SPRING.press` — Phase 9 调研确认 0 引用。详见 `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`。

```bash
# 改 CSS（globals.css :root）→ 同步改 JS（tokens.ts），反之亦然
# 改前：grep 现有用法
cd frontend
grep -rn "DURATION\.\|EASE\.\|SPRING\.\|STAGGER\." --include="*.ts" --include="*.tsx" | grep -v test

# 改后：跑测试 + 构建
pnpm test && pnpm build
```

具体步骤：
1. 先在两处都先改值（不留中间状态）
2. 跑 `pnpm test`（`tokens.test.ts` 有数值断言）
3. 跑 `pnpm build`（检查 TS 类型）
4. 如改动了 `DURATION` / `EASE` 等关键曲线，建议跑 `pnpm test:e2e` 做 Playwright 视觉回归（若 CI 中已配置）

---

## 3. 何时用什么组件（决策树）

### 3.1 路由切换

```tsx
// app/layout.tsx（已就位，无需修改）
<PageTransition>{children}</PageTransition>
```

- ✅ **普通 dashboard 路由**：`<PageTransition>` 自动选 `<NormalPageTransition>`
- ✅ **full-bleed absolute 路由**（如 `/dashboard/ai-chat`）：同上，自动选 `<FullBleedPageTransition>`
- ❌ **不推荐**：手动导入 `<NormalPageTransition>` / `<FullBleedPageTransition>`（除非 dispatcher 决策不适合；当前没有此场景）

### 3.2 元素淡入

```tsx
import { MotionFade } from '@/components/motion/MotionFade'

<MotionFade>
  <Card />
</MotionFade>
```

**适用**：单个元素的入场、加载完成后显示。会自动尊重 `prefers-reduced-motion`（reduced 时跳过 fade，瞬时显示）。

### 3.3 列表错落进场

```tsx
import { MotionStagger, MotionStaggerItem } from '@/components/motion/MotionStagger'

<MotionStagger className="contents">  {/* 注意：contents 不破坏 grid */}
  <MotionStaggerItem><Card /></MotionStaggerItem>
  <MotionStaggerItem><Card /></MotionStaggerItem>
  <MotionStaggerItem><Card /></MotionStaggerItem>
</MotionStagger>
```

**适用**：dashboard row / 卡片网格 / 列表入场。

**注意**：
- 容器使用 `className="contents"` 避免破坏 grid / flex 布局（如果外层是 grid）
- 当前仅 `MotionStaggerItem` 暴露为 named export；不要自己写 `motion.div variants={...}`
- reduced-motion 时直接返回 children（无 stagger）

### 3.4 数据卡聚光（hover spotlight）

```tsx
import { DashboardSurfaceCard } from '@/components/dashboard/dashboard-surface-card'

<DashboardSurfaceCard spotlight>  {/* spotlight 默认 true */}
  <CardContent />
</DashboardSurfaceCard>
```

**适用**：KPI 卡 / 数据卡 / 需要 hover 聚光感的高频表面。

**关键约束**：
- ⚠️ **不要全局替换**：现有 92 处 `.dashboard-surface` 不动，全局挂 pointermove 会爆性能
- 仅在新组件或试点处使用此 wrapper
- spotlight 视觉由 CSS 径向渐变 + `before:` pseudo 实现，无需 JS 介入渲染
- reduced-transparency / coarse pointer 下 useSpotlight 不挂监听，CSS 通过 `--spotlight-strength: 0` 关闭视觉

### 3.5 自定义 pointermove 高光

```tsx
import { useSpotlight } from '@/components/motion/use-spotlight'

const ref = useSpotlight<HTMLDivElement>({ enabled: true })
return <div ref={ref} className="...">...</div>
```

**适用**：需要更精细控制的 spotlight 场景（不通过 `<DashboardSurfaceCard>`，例如需要不同形状或不同色彩）。

**要点**：
- hook 写入 element.style 的 `--spot-x` / `--spot-y`（百分比），CSS 用 `radial-gradient(...)` 渲染
- 减透明 / 粗指针下 hook 不挂监听，CSS 仍可读 `--spot-x/y` 默认 `50%`

---

## 4. Full-bleed 路由处理

### 4.1 当前覆盖

`/dashboard/ai-chat` 是 full-bleed absolute 路由（页面用 `!absolute inset-0` 撑满父级）。

### 4.2 如何新增

只需在 `frontend/lib/motion/routes.ts` 的 `FULL_BLEED_DASHBOARD_ROUTES` 数组追加字符串：

```ts
const FULL_BLEED_DASHBOARD_ROUTES = [
  '/dashboard/ai-chat',
  '/dashboard/new-full-bleed-page',  // 新增
] as const
```

不需改任何组件代码。

### 4.3 行为差异

| 维度 | `<NormalPageTransition>` | `<FullBleedPageTransition>` |
|------|--------------------------|------------------------------|
| wrapper className | `h-full w-full` | `!absolute inset-0` |
| motion.div | `will-change-transform h-full w-full` | 同 |
| 触发条件 | pathname 不在 FULL_BLEED_DASHBOARD_ROUTES | pathname 严格匹配 |
| 典型场景 | `/dashboard/profile`、`/dashboard/system-management/...` | `/dashboard/ai-chat` |

### 4.4 为什么需要 full-bleed 变体

`.dashboard-page-shell` 是 `min-h-*` 父级而非确定高度，普通路由用 `h-full` 可正确解析。full-bleed 页面根 div 用 `!absolute inset-0`，PageTransition wrapper 不能再用 `h-full`（百分比链路在只有 min-height 父级下解析为 0），必须用 `!absolute inset-0` 直接填充 containing block。

---

## 5. 无障碍 / 退化

| 场景 | 退化策略 | 实现位置 |
|------|---------|---------|
| `prefers-reduced-motion: reduce` | 全量退化为瞬时（`duration: 0`、不 stagger、不 spring） | Primitive 内部读 `useReducedMotion()` |
| `prefers-reduced-motion: reduce`（CSS 侧） | `animation-duration: 0.01ms !important` | `globals.css` `@media` 块 |
| `prefers-reduced-transparency: reduce` | blur 关闭、spotlight 退化为静态高光（`--spotlight-strength: 0`） | Primitive 读 `matchMedia`；CSS `@media` |
| `(pointer: coarse)` | spotlight 不挂 pointermove 监听；CSS 静态高光保留 | `useSpotlight` 检查 `matchMedia`（注：当前实现检查 reduced-transparency，coarse 由 CSS 退化） |
| Keyboard Tab focus | `outline: 2px solid hsl(var(--ring))` 通过 `.u-focus` 强制可见 | `globals.css` `.u-focus` |
| 老年 / 前庭功能障碍 | `--motion-fast` 仍保持感知舒适阈值；不引入位移过大的动效 | （设计纪律，非代码约束） |

**写新组件时**：

- 如果直接用 framer-motion，必须自己读 `useReducedMotion()` 并提供退化分支
- 如果用 Primitive，已自带退化
- 永远不要用 `backdrop-filter` 在 `.dashboard-surface` 上（详见 `globals.css` 注释，原因：92 处共用 + Retina 糊掉细节）

---

## 6. 调试 checklist

| 症状 | 可能原因 | 排查路径 |
|------|---------|---------|
| 路由切换看不到动效 | PageTransition 变体 key 不是 pathname | grep `key={pathname}` 在 `Normal/FullBleedPageTransition.tsx` |
| full-bleed 页面塌缩 | wrapper 不是 `!absolute inset-0` | 检查 `isFullBleedDashboardRoute` 路由判断 + 父级是否 min-h |
| 看不到 stagger | MotionStagger 容器没 `display: contents` | 检查 `className` 是否被覆盖 |
| Spotlight 不跟随 | reduced-transparency / coarse pointer 启用 | DevTools → Rendering 检查 media |
| Spotlight 闪屏 | `before:` pseudo 与 `transition-opacity` 没正确合并 | 检查 `dashboard-surface-card.tsx` 的 `before:` 链 |
| 路由切换慢 / 卡 | `will-change-transform` 未释放 | 检查 `AnimatePresence mode="wait"` 是否正确卸载旧 motion.div |
| 模糊糊掉 1px 边框 | Retina 屏 backdrop-filter 半径过大 | 永不主动加 backdrop-filter 到 `.dashboard-surface` |
| 数值不一致 | CSS 与 JS 两侧数值漂移 | `pnpm test`（`tokens.test.ts` 有数值断言） |

---

## 7. v2 Token 优化建议（参考）

完整调研报告见 [`docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`](../../docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md)。

**TL;DR（Phase 10 已实施清理，剩余项待后续决策）**：

1. `Z.*` / `EASE.springBack` / `SPRING.press` 已在 Phase 10 删除（Phase 9 调研确认 0 引用）
2. `STAGGER.childDelay` 与 `STAGGER.step` 值相同（都是 0.07）→ 合并为一个
3. 是否需要 `SPRING.modal` / `SPRING.toast` 场景化常量？当前 toast 用 `DURATION.springPress` + 字符串 ease
4. 是否需要 `EASE.springSoft`（更软）/ `springSnappy`（更脆）变体？

---

## 8. 设计稿同步

### 8.1 Token → 设计端映射

- **颜色 token**：已在 `globals.css` 的 `:root` 与 `.dark` 镜像（设计稿改色同步这两块）
- **时长 / 缓动 token**：应同步到 Figma Variables / Design Tokens（180ms / 240ms / 320ms / 220ms）
- **spring / stagger 参数**：应在 Figma Smart Animate 时复用相同曲线（260/30/1）

### 8.2 修改流程

| 发起方 | 动作 | 反向同步 |
|--------|------|---------|
| 设计师改 Figma token | 工程师同步改 `globals.css :root` + `lib/motion/tokens.ts` | PR review 校验双侧 |
| 工程师改 token | 通知设计师更新 Figma Variables | PR description 注明 |
| PR review | 检查 token 修改是否双侧同步 | 改单侧 = review 不通过 |

### 8.3 当前状态

- 项目目前 designer-side token 未建立（无 Figma 文件关联）
- 本节作为接口预留，Figma 文件建立后填充具体链接 + 命名约定
- 即便未建立，**所有 PR 改 token 仍必须双侧同步**（见 §2.3）

---

## 9. 延伸阅读

- 父 plan：`docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md`
- 阶段计划：
  - Phase 0：`...-phase0.md`（基础设施）
  - Phase 1：`...-phase1.md`（transition 基线）
  - Phase 2：`...-phase2.md`（hover / active）
  - Phase 3：`...-phase3.md`（premium stagger）
  - Phase 4：`...-phase4.md`（页面过渡）
  - Phase 5：`...-phase5-page-transition-refactor.md`（拆 Normal / FullBleed 变体）
  - Phase 6：`...-phase6-promotion.md`（u-interactive 推广）
  - Phase 7：`...-phase7-component-motion.md`（Primitive 提取）
  - Phase 8：`...-phase8-perf-a11y.md`（性能 + 无障碍）
- 性能预算：`frontend/docs/perf-budget.md`
- 基线测量：`frontend/docs/perf-baseline-2026-06.md`