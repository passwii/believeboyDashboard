# 设计文档：前端动效设计系统（Apple 级交互质感）

- 关联 issue：无（工程性改造，全局前端）
- 状态：设计稿 v1（待用户审查）
- 范围：本次仅产出设计文档，**不写实现代码**；确认后由 writing-plans 拆实现计划
- 日期：2026-07-11

## 1. 目标与非目标

**目标**

- 在现有前端（Next.js 16 App Router + Tailwind v3 + shadcn/ui + framer-motion 12）之上，**正式建立一套统一的动效设计系统**，并系统性铺开到全局，达到 **Apple 级交互质感**（精密、有重量感、物理可信）。
- 覆盖用户点名的三类反馈：**Sidebar hover、页面切换、各类显示反馈**，并形成可复用、可审查、可维护的规范。
- 复用并提升项目已有的雏形（CSS 动效 token、两层 sidebar 的 spring 过渡、ad-analysis 的页面切换先例、Raycast 风玻璃暗色），而非从零重写。

**非目标（YAGNI，本期不做）**

- 引入新动画库（GSAP 仅作备用，本期不扩展；不引入 Lottie / Three.js 等）。
- 改动业务逻辑、数据层、路由结构；动效是**叠加层**。
- 重做视觉设计语言（配色、字体、布局网格）——本期只动"运动与反馈"，不动静态视觉。
- 把现有 513 处散落 hover/transition 用法全量改写——本期只 retrofit 高频表面，其余存量保留。
- 移动端手势动效（swipe 等）专项——本期仅保证移动端不退化、尊重 reduced-motion。

## 2. 已确认的关键决策

来自对话中用户拍板：

| # | 问题 | 决策 |
|---|------|------|
| Q1 | 改造范围/打法 | **A 先立动效设计系统，再全面铺开**（统一规范 + 可复用原语，一次到位） |
| Q2 | 动效强度/风格 | **升级为 Apple 级质感**：spring 物理、玻璃/聚光、加权按下；不拘泥现有 B2B 朴素风 |
| Q3 | 页面切换形态 | **C 混合**：容器 `scale 0.985→1 + opacity 0→1 + blur(8px→0)`（spring）+ 内部内容 60–80ms stagger 错落落位 |
| Q4 | 实现路线 | **路线 1「Token + Primitive + 全局 Wrapper」集中式动效系统**（见 §3） |

## 3. 架构与文件地图

集中式系统：动效 token 在 CSS 与 JS 两侧同源定义；抽一组可复用 framer-motion 原语；在 `app/dashboard/layout.tsx` 放一个全局 `PageTransition`；hover/active 用一套规范 utility 标准化到关键表面。

```
frontend/
├─ app/globals.css                 # 扩 token + 新增规范 utility（.u-interactive / .u-press / .u-focus / .u-spotlight）
├─ lib/motion/
│  ├─ tokens.ts                    # JS 侧共享常量（时长 / ease / spring），与 CSS token 同源
│  └─ variants.ts                  # framer-motion variants：pageTransition(C) / fadeUp / staggerContainer / staggerItem
├─ components/motion/
│  ├─ PageTransition.tsx           # 全局路由过渡（泛化自 ad-analysis/page-transition.tsx）
│  ├─ MotionFade.tsx               # 通用淡入（可选封装）
│  └─ MotionStagger.tsx            # 容器 + 子项，内容错落进场
├─ app/dashboard/layout.tsx        # 用 <PageTransition> 包裹 children（全局生效）
├─ components/ui/button.tsx         # shadcn Button：接入 press/hover 规范
├─ components/dashboard/sidebar-*   # 侧栏 hover/active 指示、spotlight
├─ app/(各页面壳)                   # 高频卡片/面板接入 .dashboard-surface spotlight + stagger 内容
└─ components/dashboard/ad-analysis/page-transition.tsx  # 泛化回收，避免重复过渡
```

不动 Tailwind v3 / shadcn / framer-motion 现有依赖版本；`ad-analysis/page-transition.tsx` 泛化进 `components/motion/PageTransition.tsx` 后，原文件调用点改为使用全局 wrapper（或保留为同名薄封装，避免双包过渡）。

## 4. 动效 Token（CSS + JS 同源）

**复用现有**（已存在于 `globals.css` `:root`）：

- `--motion-fast: 180ms`、`--motion-base: 240ms`、`--motion-slow: 320ms`
- `--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1)`（≈ easeOutExpo，Apple 味）
- `--motion-ease-standard: cubic-bezier(0.16, 1, 0.3, 1)`

**本期新增**：

- `--motion-spring-press: 220ms cubic-bezier(0.34, 1.56, 0.64, 1)`（带轻微回弹的按下/弹出）
- `--stagger-step: 70ms`（内容错落步长，可在 §2 决策基础上微调）
- `--z-nav / --z-overlay / --z-modal / --z-toast / --z-grain` 统一层级标尺（替代散落的 z 值）
- `--spot-x: 50%`、`--spot-y: 50%`（spotlight 光标坐标占位，由 `useSpotlight` 写入）
- `--spotlight-strength`（聚光强度，减透明时归零）

`lib/motion/tokens.ts` 镜像上述数值为 JS 常量（`DURATION`、`EASE`、`SPRING`），供 framer-motion 的 `transition` 使用，保证"设计语言一处定义、两处生效"。

## 5. 全局页面切换（C 形态）

**机制**

- `components/motion/PageTransition.tsx`：客户端组件，内部 `AnimatePresence mode="wait"` + `key={usePathname()}`，**包裹于 `app/dashboard/layout.tsx` 的 `{children}`**。
- 置于 layout（跨路由不卸载）是 exit 动画生效的前提；`mode="wait"` 保证"旧页退场 → 新页进场"串行，避免叠影。
- 内部内容用 `MotionStagger` 做错落进场（见 §7）。

**容器 variants（C 形态）**

```
initial : { opacity: 0, scale: 0.985, filter: 'blur(8px)', y: 6 }
animate : { opacity: 1, scale: 1,      filter: 'blur(0px)', y: 0 }
exit    : { opacity: 0, scale: 0.99,  filter: 'blur(4px)', y: -4 }
transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] }   // 或 spring { type:'spring', stiffness:260, damping:30 }
```

**无障碍 / 性能**

- `prefers-reduced-motion: reduce` → 退化为 `{ opacity: 1 }` / `duration: 0`，无位移无模糊。
- `prefers-reduced-transparency: reduce` → 禁用 `filter: blur`，仅保留 opacity/位移或纯瞬时。
- `blur` 半径压到 8px + `will-change: transform, opacity, filter`；大页面退场时不长时间持有模糊层。
- 检查 `ad-analysis` 嵌套 layout 不双包 `PageTransition`（先泛化回收原实现）。

## 6. hover / active 规范（Apple 级）

新增规范 utility 类（**增量，不破坏现有 513 处 hover 用法**），先 retrofit 高频表面（按钮 / 卡片 / 侧栏 / 导航 active）：

- **`.u-interactive`**（通用交互基底）：`transition: transform/background/border-color/box-shadow var(--motion-fast) var(--motion-ease-out)`；hover 时底色/边框微提亮 + `translateY(-1px)` + 阴影上浮。
- **`.u-press`**（加权按下）：`:active { transform: scale(0.97) }`，过渡用 `--motion-spring-press`，模拟物理按下回弹。
- **`.u-focus`**（键盘焦点环）：`outline: 2px solid hsl(var(--ring))`、`outline-offset: 2px`，满足 WCAG 可见焦点要求（可访问性硬指标）。
- **`.u-spotlight`**（聚光边，高级触感）：卡片/侧栏项 hover 时，跟随光标的径向高光边。由轻量 `useSpotlight` hook（pointermove 写 `--spot-x/--spot-y`）驱动 `radial-gradient` 描边 + 边框微亮 + 1px 上浮。减透明时退化为静态顶部高光。

**Sidebar 专项**

- active 指示用 spring 宽度/透明度过渡（替代生硬高亮）。
- 一级 icon rail 与 hover 展开 panel：保留现有 spring 过渡（`cubic-bezier(0.22,1.18,0.36,1)`），提亮 hover 底色位移。
- 当前路由命中分组的高亮与 hover/pin 状态机（`use-sidebar-panel.ts`）保持不变，仅叠加动效规范。

## 7. 高级触感（Apple 级点睛）

- **内容 stagger 进场**：`MotionStagger` 容器 `staggerChildren: 0.07`，子项 `fadeUp`（`opacity 0→1` + `y 10→0` + spring），用于页面标题/卡片依次落位（即 C 形态的内容层）。
- **加权按下反馈**：按钮、图标按钮、toggle 统一 `scale(0.97)` 回弹（§6 `.u-press`）。
- **玻璃/聚光 hover**：卡片 `.dashboard-surface` 接 `.u-spotlight`；浮层继续用现有 `.dashboard-glass`（Raycast 风）。
- **spring 物理**：开关、抽屉、Popover 用 spring/回弹缓动（现有 `.ui-floating-motion` 已是 `cubic-bezier(0.34,1.56,0.64,1)`，统一命名对接）。
- toast / dialog 已有 framer-motion / CSS 动画，保留并统一缓动到 token，避免多套节奏。

## 8. 铺开阶段（保证可审查、不破坏功能）

- **Phase 0 — 地基**：扩 `globals.css` token + 新增 §6 utility 类；新建 `lib/motion/tokens.ts`、`variants.ts`。
- **Phase 1 — 全局切换**：实现 `components/motion/PageTransition.tsx` + `MotionFade`/`MotionStagger`；在 `app/dashboard/layout.tsx` 包裹；回收 `ad-analysis/page-transition.tsx` 重复实现。
- **Phase 2 — hover/active 标准化**：`components/ui/button.tsx`、`.dashboard-surface`、sidebar-*、导航 active 指示接入规范。
- **Phase 3 — 高级触感**：spotlight hover（`useSpotlight`）、spring press、内容 stagger 落位。
- **Phase 4 — 验证**：见 §10。

## 9. 风险与护栏

- **不碰业务逻辑**：动效是叠加层，存量 hover/transition 不强制改，仅 retrofit 高频表面。
- **blur 性能**：小半径(8px) + `will-change` + 减透明时禁用；大列表/表格行不挂 blur 动画。
- **AnimatePresence 生效条件**：必须置于不卸载的 layout，children 以 pathname 为 key；核对 ad-analysis 嵌套 layout 不双包。
- **Tailwind v3 写法**：改 `tailwind.config.ts` / `globals.css` 走 v3 语法（非 v4），不升级框架。
- **Next 16 / React 18 兼容**：framer-motion 12 已验证可用；`AnimatePresence` 标准用法。
- **全程尊重 `prefers-reduced-motion` / `prefers-reduced-transparency`**：所有动效在减动/减透明下退化。

## 10. 测试与验证

- **静态/构建**：`cd frontend && pnpm lint && pnpm build && pnpm test`（Vitest 单元/组件断言）。
- **不破坏现有 Playwright 用例**：`pnpm test:ui` 现有端到端用例需仍通过（页面切换改为动画不影响 DOM 结构与可访问性角色）。
- **手动验收清单**（亮色 + 暗色各一遍）：
  1. Sidebar：rail hover 展开 panel 的 spring 手感；active 项指示过渡；spotlight hover。
  2. 页面切换：进入/离开任意 dashboard 路由，容器缩放淡入 + 内容 stagger；后退/前进一致。
  3. 按钮：hover 提亮上浮；`:active` 加权按下回弹；键盘 Tab 焦点环可见。
  4. 卡片：hover 聚光边 + 微浮；不影响表格 1px 边框可读性（暗色高 DPI 屏）。
  5. `prefers-reduced-motion` 开启：所有动画退化为瞬时、无位移无模糊。
  6. 性能：切换页面无卡顿、无长时模糊层残留（DevTools Performance / Lighthouse 抽查）。

## 11. 依赖与兼容性

- 框架：Next.js 16.2.4（App Router）、React 18.3.1。
- 样式：Tailwind v3.4.17、shadcn/ui（Radix + CVA）、`components.json`。
- 动画：framer-motion 12.34.3（主）、gsap 3.15.0（备用，本期不扩展）。
- 主题：next-themes（暗色已为 Raycast 风玻璃质感）。
- 无需新增 npm 依赖。
