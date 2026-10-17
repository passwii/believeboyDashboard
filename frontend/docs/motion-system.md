# Motion System Guide

> **适用版本：** 当前 frontend 动效实现（2026-10 更新）
> **适用对象：** 在 `frontend/` 下新增 / 修改动效相关的工程师
> **目标：** 说明当前可用的路由动效与 CSS 动效工具类

---

## 1. 概览

本项目动效系统分三层，**自下而上依赖**：

```
┌─────────────────────────────────────────────────────────────┐
│ Composition 层：业务页面组合（dashboard row、profile 等）     │
└─────────────────────────────────────────────────────────────┘
            ↑                    ↑                  ↑
┌─────────────────────────────────────────────────────────────┐
│ 可复用层                                                   │
│ - PageTransition / Normal / FullBleed（路由切换）            │
│ - CSS：animate-fade-slide-up / u-stagger-item               │
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
2. **页面内容优先使用 CSS 动效工具类**：元素淡入用 `animate-fade-slide-up`，列表错落用 `u-stagger-item`；不要导入已移除的 MotionFade / MotionStagger 包装组件
3. **无障碍退化由全局 CSS 保证**：reduced-motion 时以上 CSS 动效会立即显示；自定义 framer-motion 动效必须自行处理 `useReducedMotion()`

---

## 2. Token 系统

> **2026-10-16（v2 全量替换）**：旧自研 `--motion-fast / base / slow / spring-press / ease-out / ease-standard / --stagger-step`
> 已整体替换为 [transitions.dev](https://transitions.dev) 的 token 尺度（全量 `_root.css` 已导入 `globals.css :root`）。
> 选档看 **usage**（这段动效在做什么），不看数值就近——例：modal 关闭用 `quick`(150ms)，即使旧实现写的是 300ms。
> 迁移映射与决策见 [`docs/superpowers/plans/2026-10-16-transitions-dev-motion-migration/`](../../docs/superpowers/plans/2026-10-16-transitions-dev-motion-migration/2026-10-16-transitions-dev-motion-migration.md)。

### 2.1 CSS 侧（`frontend/app/globals.css :root`）

**时长（7 档）**

| Token | 值 | 用途 |
|-------|----|----|
| `--duration-stagger` | `40ms` | 逐项 stagger 偏移 |
| `--duration-micro` | `80ms` | tooltip / path delay、shake 分段 |
| `--duration-quick` | `150ms` | modal / dropdown 关闭、text swap、tooltip 出现、**hover / focus 微状态** |
| `--duration-fast` | `250ms` | icon swap、dropdown / modal 打开、tabs sliding、page slide、按压回弹 |
| `--duration-medium` | `350ms` | panel 关闭、toast 关闭 |
| `--duration-slow` | `400ms` | panel 打开、skeleton 内容揭示、输入清空、**内容淡入** |
| `--duration-very-slow` | `500ms` | 强调时刻：badge 出现、文本揭示、success check |

**缓动（6 档）**

| Token | 值 | 用途 |
|-------|----|----|
| `--ease-smooth-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 项目主曲线：modal / dropdown / panel 开合、page slide、resize |
| `--ease-in-out` | `ease-in-out` | icon swap、text swap、text reveal、skeleton reveal |
| `--ease-out` | `ease-out` | tooltip 开 / 关 |
| `--ease-linear` | `linear` | shimmer、skeleton pulse、spinner、加载条 |
| `--ease-bounce` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | badge 弹出、按压回弹 |
| `--ease-bounce-strong` | `cubic-bezier(0.34, 3.85, 0.64, 1)` | 弹性 hover 收回 |

**几何（距离 / 缩放 / 模糊）**

| Token | 值 |
|-------|----|
| `--distance-micro / small / base / medium / large` | `4 / 6 / 8 / 12 / 30px` |
| `--scale-large / medium / small / tiny` | `0.96 / 0.97 / 0.98 / 0.99` |
| `--blur-small / medium / large` | `2 / 3 / 8px` |

> 同一 `:root` 块内还全量导入了 35 个 transition 的语义变量（`--badge-*` / `--modal-*` / `--tt-*` / `--tabs-*` …，共 239 个），
> 供 Phase B 逐个接入 transition snippet 时消费；当前尚无消费点。
> License：免费商用、可复制修改进产品；禁止重新打包为竞品动画库（见 `~/.agents/skills/transitions-dev/LICENSE.txt`）。

### 2.2 JS 侧（`frontend/lib/motion/tokens.ts`）

| JS 常量 | 值 | 对应 CSS | 备注 |
|---------|----|----------|------|
| `DURATION.stagger / micro / quick / fast / medium / slow / verySlow` | `0.04 / 0.08 / 0.15 / 0.25 / 0.35 / 0.4 / 0.5` | `--duration-*` | 单位：秒（framer-motion） |
| `EASE.smoothOut` | `[0.22, 1, 0.36, 1]` | `--ease-smooth-out` | 主曲线 |
| `EASE.inOut / out / linear` | `'ease-in-out' / 'ease-out' / 'linear'` | `--ease-in-out / out / linear` | 字符串关键字，framer 直接接受 |
| `EASE.bounce` | `[0.34, 1.36, 0.64, 1]` | `--ease-bounce` | 按压回弹 |
| `EASE.bounceStrong` | `[0.34, 3.85, 0.64, 1]` | `--ease-bounce-strong` | |
| `DISTANCE.*` | `4 / 6 / 8 / 12 / 30` | `--distance-*` | 单位：px |
| `SCALE.*` | `0.96 / 0.97 / 0.98 / 0.99` | `--scale-*` | |
| `BLUR.*` | `2 / 3 / 8` | `--blur-*` | 单位：px |
| `SPRING.page` | `{ stiffness: 260, damping: 30, mass: 1 }` | （无对应 CSS） | 仅 JS 使用，路由过渡 |
| `STAGGER.step` | `0.04` | `--duration-stagger` | 单档（v2 已合并旧 childDelay） |
| `isReducedMotionDefault` | `false` | （运行时 media query） | 常量仅占位，调用方读 `useReducedMotion()` |

**单位转换**：JS 用**秒**（framer-motion API），CSS 用**毫秒**（CSS animation）。ms ÷ 1000 = s。

### 2.3 修改纪律

⚠️ **改一处必须同步另一处**

> > **Phase 10 v2 清理**：已删除 `Z.*`（5 档 z-index 标尺）/ `EASE.springBack` / `SPRING.press` — Phase 9 调研确认 0 引用。详见 `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`。
>
> **2026-10-16 v2 全量替换**：token 尺度改为 transitions.dev 的 7 档 duration + 6 档 easing + distance/scale/blur；
> `STAGGER.step` / `childDelay` 合并为单档。旧 `--motion-*` 名字已全部删除，不留别名（避免双真相源）。

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
- ✅ **full-bleed absolute 路由**（如 `/dashboard/ai/chat`）：同上，自动选 `<FullBleedPageTransition>`
- ❌ **不推荐**：手动导入 `<NormalPageTransition>` / `<FullBleedPageTransition>`（除非 dispatcher 决策不适合；当前没有此场景）

### 3.2 元素淡入

```tsx
<div className="animate-fade-slide-up">
  <Card />
</div>
```

**适用**：单个元素的入场、加载完成后显示。工具类使用全局 `--duration-slow` / `--ease-smooth-out`；`prefers-reduced-motion: reduce` 时全局 CSS 会取消动画并显示内容。

### 3.3 列表错落进场

```tsx
<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
  {items.map((item, index) => (
    <Card
      key={item.id}
      className="u-stagger-item"
      style={{ '--i': index } as React.CSSProperties}
    />
  ))}
</div>
```

**适用**：dashboard row / 卡片网格 / 列表入场。

**注意**：
- 直接在列表项上使用 `u-stagger-item`，不要额外包一层 `display: contents` 容器
- `--i` 是从 0 开始的序号，用于按 `--duration-stagger`（40ms）计算延迟
- reduced-motion 时全局 CSS 清除动画、延迟和透明度，内容保持可见

### 3.4 页面级 authoured 动效（登录页品牌面板，2026-09-30）

登录 `/login` 左栏「工作区地图」是两个纯 CSS 动效，**零 JS、零计时器**（`.login-*` 类定义在
`globals.css` 末尾、`@layer` 之外）：

| 动效 | 类 | 节奏 | 动的属性 |
|---|---|---|---|
| 8 个业务域行轮流点亮（tint + 1px accent 竖条 + icon 转 accent） | `.login-domain-row` | 每行 1s、一圈 8s（`animation-delay: calc(i * 1s)` 写在行内 `--login-domain-delay`） | `opacity` / `transform` / `color` |
| 1px accent 扫描线沿栅格自上而下巡场 | `.login-grid-scan-track` / `-line` | 一圈 9s | `transform` / `opacity` |

**为什么放 `@layer` 之外**：面板是 `min-h-dvh` 全高构图，需要按**视口高度**断点降档行高
（默认 `2.5rem`，≤760px 降 `2rem`），而 Tailwind 只有宽度断点；unlayered 规则才能覆盖
`h-*` 等 utilities。同类全高构图可沿用这个口径。

**退化**：两个动效都进 `prefers-reduced-motion: reduce` 闸门（`animation: none` + 覆盖层
`opacity: 0`），关闭后各行停在静息色，信息零丢失——不使用 framer-motion，
因为这里不需要 JS 参与，避免给登录路由加 hydration 成本。

**反向纪律（2026-09-30）**：`.u-interactive` 会在 hover 时 `translateY(-1px)`，**不要用在
输入框上**——书写面 hover 位移会干扰输入体验（登录表单已摘除，单测
`components/login/sign-in-card.test.tsx` 守住）。输入框只保留 focus 的 `border-color` /
`box-shadow` 过渡，无任何 hover 位移。

---

## 4. Full-bleed 路由处理

### 4.1 当前覆盖

`/dashboard/ai/chat` 是 full-bleed absolute 路由（页面用 `!absolute inset-0` 撑满父级）。

### 4.2 如何新增

只需在 `frontend/lib/motion/routes.ts` 的 `FULL_BLEED_DASHBOARD_ROUTES` 数组追加字符串：

```ts
const FULL_BLEED_DASHBOARD_ROUTES = [
  '/dashboard/ai/chat',
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
| 典型场景 | `/dashboard/profile`、`/dashboard/system/...` | `/dashboard/ai/chat` |

### 4.4 为什么需要 full-bleed 变体

`.dashboard-page-shell` 是 `min-h-*` 父级而非确定高度，普通路由用 `h-full` 可正确解析。full-bleed 页面根 div 用 `!absolute inset-0`，PageTransition wrapper 不能再用 `h-full`（百分比链路在只有 min-height 父级下解析为 0），必须用 `!absolute inset-0` 直接填充 containing block。

---

## 5. 无障碍 / 退化

| 场景 | 退化策略 | 实现位置 |
|------|---------|---------|
| `prefers-reduced-motion: reduce` | 全量退化为瞬时（`duration: 0`、不 stagger、不 spring） | Primitive 内部读 `useReducedMotion()` |
| `prefers-reduced-motion: reduce`（CSS 侧） | `animation-duration: 0.01ms !important` | `globals.css` `@media` 块 |
| Keyboard Tab focus | `outline: 2px solid hsl(var(--ring))` 通过 `.u-focus` 强制可见 | `globals.css` `.u-focus` |
| 老年 / 前庭功能障碍 | `--duration-quick`（hover / focus 微状态）仍在 200ms 感知阈值内；不引入位移过大的动效 | （设计纪律，非代码约束） |

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
| 看不到 stagger | 列表项缺少 `u-stagger-item` 或 `--i` | 检查每个列表项是否设置工具类和从 0 开始的序号 |
| 路由切换慢 / 卡 | `will-change-transform` 未释放 | 检查 `AnimatePresence mode="wait"` 是否正确卸载旧 motion.div |
| 模糊糊掉 1px 边框 | Retina 屏 backdrop-filter 半径过大 | 永不主动加 backdrop-filter 到 `.dashboard-surface` |
| 数值不一致 | CSS 与 JS 两侧数值漂移 | `pnpm test`（`tokens.test.ts` 有数值断言） |

---

## 7. v2 全量替换（transitions.dev）— 已实施 2026-10-16

**主 plan**：[`docs/superpowers/plans/2026-10-16-transitions-dev-motion-migration/`](../../docs/superpowers/plans/2026-10-16-transitions-dev-motion-migration/2026-10-16-transitions-dev-motion-migration.md)

**已完成（Phase 0-3）**

1. `_root.css` 全量 `:root` 块导入 `globals.css`（239 个变量，含 35 个 transition 的语义变量）
2. 旧 7 个自研 token 全部删除；`globals.css` 28 处消费者 + 7 个组件按 usage 重映射
3. `lib/motion/tokens.ts` 重写为 7 档 `DURATION` + 6 档 `EASE` + `DISTANCE` / `SCALE` / `BLUR`；`STAGGER` 合并单档
4. `TERMINAL_SUBNAV_MOTION`（BLF-825/832 第二套 mini 体系）数值对齐新尺度

**已完成（Phase B，2026-10-16）— 8 个面接入 7 个**

| 面 | snippet | 落地 |
| --- | --- | --- |
| dialog + alert-dialog | 06-modal | `.ui-modal-motion` → `--modal-*` |
| select + popover + dropdown-menu | 05-menu-dropdown | `.ui-floating-motion` → `--dropdown-*` |
| tooltip | 17-tooltip | `.ui-tooltip-motion` → `--tt-*`（未接「整组气泡随指针平移」机制） |
| sheet | 07-panel-reveal | `.ui-panel-motion` → `--panel-*`，方向按 `data-side` |
| toast | 22-toast | `notification-toast.tsx` → 垂直上浮 + `--toast-*`（经 JS token 镜像） |
| skeleton | 14-skeleton-reveal | `.ui-skel*` + `SkeletonReveal` 两层交叉模糊揭示 → `--pulse-*` / `--reveal-*`；已接入 `DeferredSection`（13 个使用点） |
| tabs | 16-tabs-sliding | 滑块自定义 spring → `--tabs-dur` 250ms + `--tabs-ease`（不接 `--tabs-*` 浅色颜色 token） |
| accordion | 21-accordion | `accordion-down/up` → `--acc-expand` / `--acc-collapse` / `--acc-ease`；chevron → `--acc-chevron` |

**机制口径（Phase B 统一）**：snippet 原版是 vanilla DOM 的 `.is-open` / `.is-closing` 类切换；
Radix/React 是「open 即挂载 + `data-state`」→ **enter / exit 都走 keyframe**，但**所有时长 / 缓动 / 缩放 /
位移 / 模糊一律读 snippet 的语义变量**；snippet 之外的历史自定义（modal 的 `scale(1.012)` 过冲、
dropdown 的 `translate3d(±0.5rem)` 方向位移、sheet 的方向性过冲、toast 的横向滑入）不保留。
详见主 plan §11。

**仍未接入**：`_root.css` 里其余 27 个 transition（badge / success check / like button / tilt / morph /
thinking / reasoning / streaming / matrix 等）——当前无对应 UI 面；`--tabs-*` / `--shimmer-*` / `--tt-bg` /
`--like-color` / `--matrix-*` 等浅色主题**颜色** token 未接（与本仓库 term 令牌色彩体系冲突）。

**历史调研**：[`2026-07-11-frontend-motion-system-v2-token-recommendations.md`](../../docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md)（`Z.*` / `EASE.springBack` / `SPRING.press` 已在 Phase 10 删除）

---

## 8. 设计稿同步

### 8.1 Token → 设计端映射

- **颜色 token**：已在 `globals.css` 的 `:root` 与 `.dark` 镜像（设计稿改色同步这两块）
- **时长 / 缓动 token**：应同步到 Figma Variables / Design Tokens（40 / 80 / 150 / 250 / 350 / 400 / 500ms + 6 档 easing）
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
