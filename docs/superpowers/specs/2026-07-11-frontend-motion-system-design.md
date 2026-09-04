# 设计文档：前端动效设计系统（Apple 级交互质感）

- 关联 issue：无（工程性改造，全局前端）
- 状态：设计稿 v2（已按审查打磨；待用户终审）
- 范围：本次仅产出设计文档，**不写实现代码**；确认后由 writing-plans 拆实现计划
- 日期：2026-07-11（v2）

## 1. 目标与非目标

**目标**

- 在现有前端（Next.js 16 App Router + Tailwind v3 + shadcn/ui + framer-motion 12）之上，**正式建立一套统一的动效设计系统**，并系统性铺开到全局，达到 **Apple 级交互质感**（精密、有重量感、物理可信）。
- 覆盖用户点名的三类反馈：**Sidebar hover、页面切换、各类显示反馈**，并形成可复用、可审查、可维护的规范。
- 复用并提升项目已有的雏形（CSS 动效 token、两层 sidebar 的 spring 过渡、ad-analysis 的页面切换先例、Raycast 风玻璃暗色、GlobalLoadingOverlay 顶栏进度），而非从零重写。

**非目标（YAGNI，本期不做）**

- 引入新动画库（GSAP 仅作备用，本期不扩展；不引入 Lottie / Three.js 等）。
- 改动业务逻辑、数据层、路由结构；动效是**叠加层**。
- 重做视觉设计语言（配色、字体、布局网格）——本期只动"运动与反馈"，不动静态视觉。
- 把现有散落 hover/transition 用法全量改写——本期只 retrofit 高频表面，并把存量 utility 路由到新 token。
- 移动端手势动效（swipe 等）专项——本期仅保证移动端不退化、尊重 reduced-motion / reduced-transparency。

## 2. 已确认的关键决策

来自对话中用户拍板：

| # | 问题 | 决策 |
|---|------|------|
| Q1 | 改造范围/打法 | **A 先立动效设计系统，再全面铺开**（统一规范 + 可复用原语，一次到位） |
| Q2 | 动效强度/风格 | **升级为 Apple 级质感**：spring 物理、玻璃/聚光、加权按下；不拘泥现有 B2B 朴素风 |
| Q3 | 页面切换形态 | **C 混合**：容器 `scale 0.985→1 + opacity 0→1 + blur(8px→0)`（spring）+ 内部内容 60–80ms stagger 错落落位 |
| Q4 | 实现路线 | **路线 1「Token + Primitive + 全局 Wrapper」集中式动效系统**（见 §3） |

## 3. 架构与文件地图

集中式系统：动效 token 在 CSS 与 JS 两侧同源定义；抽一组可复用 framer-motion 原语；在 `app/dashboard/layout.tsx` 放一个全局 `PageTransition`（只覆盖 `/dashboard/*`，登录页 `/login` 与公开页 `/p/*` 不受影响）；hover/active 用一套规范 utility 标准化到关键表面。

```
frontend/
├─ app/globals.css                 # 扩 token + 新增规范 utility（.u-interactive / .u-press / .u-focus / .u-spotlight / .u-stagger-item）
├─ lib/motion/
│  ├─ tokens.ts                    # JS 侧共享常量（时长 / ease / spring），与 CSS token 同源
│  └─ variants.ts                  # framer-motion variants：pageTransitionContainer(C, spring) / fadeUp / staggerContainer / staggerItem
├─ components/motion/
│  ├─ PageTransition.tsx           # 全局路由过渡（key={pathname}，AnimatePresence mode="wait"）
│  ├─ MotionFade.tsx               # 通用淡入封装
│  ├─ MotionStagger.tsx            # 容器 + 子项（内容错落进场；opt-in）
│  └─ useSpotlight.ts              # 轻量 spotlight hook（pointermove → CSS 变量）
├─ app/dashboard/layout.tsx        # ① 包 <PageTransition> 包裹 children；② 拆除 isNavigationLoading 整页 swap（见 §5、§9）
└─ 改造点：
   ├─ components/ui/button.tsx        # 接入 .u-press / .u-focus / .u-interactive（拓宽 transition）
   ├─ components/dashboard/sidebar-*  # active 指示 spring、spotlight、hover 规范
   ├─ app/dashboard/data-analysis/ad-analysis/layout.tsx  # 拆除 <AdAnalysisPageTransition> 包裹（见 §9 防双包）
   └─ components/dashboard/dashboard-surface-card.tsx   # 新增：可选 spotlight 包装（不全局挂，避免 92 处 pointermove）
```

**关键约束（实现必须处理）**

- `app/dashboard/layout.tsx:62` 当前 `{isNavigationLoading ? <DashboardPageLoading/> : children}` 是**整页 swap**，会直接卸载旧页，**PageTransition 的 exit 动画无法播放**。Phase 1 必须改成 `{children}`（始终渲染，让 PageTransition 演 exit），loading 指示交由**已存在的** `GlobalLoadingOverlay`（顶栏进度条）+ 各路由 `loading.tsx`（Next.js Suspense）兜底。
- `app/dashboard/data-analysis/ad-analysis/layout.tsx:12` 已用 `<AdAnalysisPageTransition>` 包裹 children 并 key 在 pathname。Phase 1 必须**拆除该 wrap**（保留/迁移该组件能力进全局 `PageTransition`，但 layout 不再包），否则全局 + 嵌套两层动画重叠。

不动 Tailwind v3 / shadcn / framer-motion 现有依赖版本。

## 4. 动效 Token（CSS + JS 同源）

**复用现有**（已存在于 `globals.css :root`）：

- `--motion-fast: 180ms`、`--motion-base: 240ms`、`--motion-slow: 320ms`
- `--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1)`（≈ easeOutExpo，Apple 味）
- `--motion-ease-standard: cubic-bezier(0.16, 1, 0.3, 1)`

**本期新增**：

- `--motion-spring-press: 220ms cubic-bezier(0.34, 1.56, 0.64, 1)`（带轻微回弹的按下/弹出，与现有 `.ui-floating-motion` 节奏对齐）
- `--stagger-step: 70ms`（内容错落步长）
- `--z-nav / --z-overlay / --z-modal / --z-toast / --z-grain` 统一层级标尺（替代散落 `z-10/50`；Phase 0 做轻量审计）
- `--spot-x: 50%`、`--spot-y: 50%`、`--spotlight-strength`（spotlight 光标坐标与强度；`prefers-reduced-transparency` 下 `--spotlight-strength` 归零）

`lib/motion/tokens.ts` 镜像上述数值为 JS 常量（`DURATION`、`EASE`、`SPRING`），供 framer-motion `transition` 使用，保证"设计语言一处定义、两处生效"。

**存量 utility 收编**（Phase 0 一并做，避免两套节奏）：将现有 `.hover-lift` / `.animate-fade-slide-up` / `.stagger-item` / `.send-btn` / `.action-btn` / `.web-search-toggle` / `.panel-toggle` / `.conversation-item` 等散落 utility 的硬编码时长/缓动**改为引用新 token**（类名保留，行为不破坏）。

## 5. 全局页面切换（C 形态）

**机制**

- `components/motion/PageTransition.tsx`：客户端组件，内部 `AnimatePresence mode="wait"` + `key={usePathname()}`，包裹于 `app/dashboard/layout.tsx` 的 `{children}`。
- 置于 dashboard layout（跨子路由不卸载）是 exit 动画生效的前提；`mode="wait"` 保证"旧页退场 → 新页进场"串行，避免叠影。
- **作用域**：只覆盖 `/dashboard/*` 路由树；登录页、公开页、`/p/*` 不走此 wrapper，无额外开销。
- **query string 行为**：`usePathname()` 不含 query，同 pathname 仅 query 变化**不重触发**过渡（避免筛选条件切换时页面抖一下，可接受）。

**容器 variants（C 形态，spring）**

```
initial : { opacity: 0, scale: 0.985, filter: 'blur(8px)', y: 6 }
animate : { opacity: 1, scale: 1,      filter: 'blur(0px)', y: 0 }
exit    : { opacity: 0, scale: 0.99,   filter: 'blur(4px)', y: -4 }
transition: { type: 'spring', stiffness: 260, damping: 30, mass: 1 }
                  // 近临界阻尼，~0.28s 收敛、几乎无 overshoot，仍有 spring 感；手感偏死可调 stiffness 240 / damping 26
```

**内容 stagger（opt-in）**

- PageTransition 提供**容器层**过渡，**对所有 /dashboard 子路由自动生效**。
- **内容层 stagger 是 opt-in**：各页面将标题/卡片组用 `<MotionStagger>` 包裹即获得 60–80ms 错落 `fadeUp`（`staggerChildren: 0.07`，子项 `opacity 0→1 + y 10→0 + spring`）。未包裹的页面只享受容器过渡，仍正确。

**无障碍 / 性能**

- `prefers-reduced-motion: reduce` → 退化为 `{ opacity: 1 }` / `duration: 0`，无位移无模糊无 spring。
- `prefers-reduced-transparency: reduce` → 禁用 `filter: blur`，仅保留 opacity/位移或纯瞬时。
- `blur` 半径 8px + `will-change: transform, opacity, filter`；退场动画结束即释放（`AnimatePresence` 完成即卸载旧 motion.div）。
- **不在表格行 / 长列表项上挂 blur 动画**（仅容器级一次性 0.28s，可控）。
- `filter: blur()` 是元素自身模糊（element filter），**非 `backdrop-filter`**——区别于现有 `.dashboard-glass` 的背景模糊，无高 DPI 糊字问题。

## 6. hover / active 规范（Apple 级）

新增规范 utility 类（**增量，不破坏现有用法**），先 retrofit 高频表面（按钮 / 卡片 / 侧栏 / 导航 active）：

- **`.u-interactive`**（交互基底）：`transition: transform/background-color/border-color/box-shadow var(--motion-fast) var(--motion-ease-out)`；hover 时底色/边框微提亮 + `translateY(-1px)` + 阴影上浮。`:disabled` 不触发。
- **`.u-press`**（加权按下）：`:active:not(:disabled) { transform: scale(0.97) }`，过渡用 `--motion-spring-press`，模拟物理按下回弹。
- **`.u-focus`**（键盘焦点环）：`outline: 2px solid hsl(var(--ring))`、`outline-offset: 2px`；与 spotlight / 边框互不覆盖（focus 优先级最高）。WCAG 可见焦点硬指标。
- **`.u-stagger-item`**（与 MotionStagger 配合的 CSS 备用方案，给非 framer-motion 的场景用）：`opacity:0; animation: fade-slide-up var(--motion-base) var(--motion-ease-out) both; animation-delay: calc(var(--i, 0) * var(--stagger-step));`，子项加 `style={{ ['--i' as any]: index }}`。

**Spotlight（聚光边）**

- **不全局挂在 `.dashboard-surface`**（现有 92 处用法，pointermove 全量监听会爆性能）。
- 改为**可选包装**：新增 `dashboard-surface-card.tsx`（轻量 client 组件），内部 `useSpotlight(ref)` 在 `pointermove` 时把光标坐标写入 `ref.current` 的 `--spot-x/--spot-y` CSS 变量，CSS 用 `radial-gradient(...at var(--spot-x) var(--spot-y)...)` 渲染高光边。
- **降级策略**：`prefers-reduced-transparency: reduce` 或 `(pointer: coarse)` 或视口 `< sm` → 用静态顶部 conic-gradient 高光，不挂监听。
- 在确实需要 spotlight 的高频卡片（如 KPI 卡片、数据卡片）显式改用此包装；信息展示型卡片维持现状。

**Sidebar 专项**

- active 指示用 spring 宽度/透明度过渡（替代生硬高亮）。
- 一级 icon rail 与 hover 展开 panel：保留现有 spring 过渡（`cubic-bezier(0.22,1.18,0.36,1)`），提亮 hover 底色位移。
- 当前路由命中分组的高亮与 hover/pin 状态机（`use-sidebar-panel.ts`）保持不变，仅叠加动效规范。

## 7. 高级触感（Apple 级点睛）

- **内容 stagger 进场**（§5，opt-in）。
- **加权按下反馈**：按钮、图标按钮、toggle 统一 `scale(0.97)` 回弹（§6 `.u-press`）。
- **玻璃/聚光 hover**：卡片走 `dashboard-surface-card` 包装；浮层继续用现有 `.dashboard-glass`（Raycast 风）。
- **spring 物理**：开关、抽屉、Popover 用 spring/回弹缓动（现有 `.ui-floating-motion` 已是 `cubic-bezier(0.34,1.56,0.64,1)`，命名对齐 token）。
- toast / dialog 已有 framer-motion / CSS 动画，保留并统一缓动到 token，避免多套节奏。

## 8. 铺开阶段（保证可审查、不破坏功能）

- **Phase 0 — 地基**
  - 扩 `globals.css` token（§4 新增部分）+ 新增 §6 utility 类 + 收编存量 utility 引用 token。
  - 新增 `lib/motion/tokens.ts`、`variants.ts`（JS 与 CSS 同源）。
  - 轻量 z-index 标尺（新建 token + 审计 `tailwind.config.ts` 与少量高频 `z-*` 用法）。
- **Phase 1 — 全局切换与结构修正**（含 §3 两项关键约束处理）
  - 新增 `components/motion/PageTransition.tsx` + `MotionFade` + `MotionStagger` + `useSpotlight`。
  - **`app/dashboard/layout.tsx`**：① children 用 `<PageTransition>` 包裹；② 拆除 `isNavigationLoading ? <DashboardPageLoading/> : children` 整页 swap（line 62），改为始终渲染 children，loading 靠 `GlobalLoadingOverlay`（已存在）+ 路由 `loading.tsx` 兜底。
  - **`app/dashboard/data-analysis/ad-analysis/layout.tsx`**：拆除 `<AdAnalysisPageTransition>` 包裹（line 12），children 直接交给全局。
  - **审计**：grep `AnimatePresence` / `motion.*` / `key={pathname}` 确认 `dashboard/` 下无其他嵌套过渡残留。
- **Phase 2 — hover/active 标准化**
  - `components/ui/button.tsx`：当前仅 `transition-colors`，拓宽为含 `transform`，追加 `.u-press` / `.u-focus` / `.u-interactive`。
  - sidebar-*：active 指示 spring、hover 规范。
  - `.dashboard-surface` 高频卡片（KPI / 数据卡）接入 `dashboard-surface-card` spotlight 包装（不在 92 处全量挂）。
  - 导航 active 指示统一 spring 宽度/透明度。
- **Phase 3 — 高级触感与内容 stagger**
  - 各业务页面将标题/卡片组用 `<MotionStagger>` 包裹（先 dashboard 主页与高频入口页，后续推广）。
  - 加权按下、玻璃/聚光在 §7 全量落地。
- **Phase 4 — 验证**：见 §10。

## 9. 风险与护栏

- **不碰业务逻辑**：动效是叠加层，存量 hover/transition 不强制改，仅 retrofit 高频表面 + token 收编。
- **结构性冲突（Phase 1 解决）**：
  - 全局 PageTransition vs dashboard layout 整页 swap → 拆 swap，留 children。
  - 全局 PageTransition vs ad-analysis 嵌套过渡 → 拆 ad-analysis layout 的 wrap。
- **blur 性能**：8px 半径 + `will-change` + 减透明/减动时禁用；仅作用于 0.28s 的容器层；表格行/列表项不挂。
- **spotlight 性能**：不全局挂，仅可选包装 + 降级（粗指针 / 小屏 / 减透明 → 静态高光）。
- **AnimatePresence 生效条件**：置于不卸载的 dashboard layout；children 以 pathname 为 key；`mode="wait"` 串行；query 变化不重触发。
- **Tailwind v3 写法**：改 `tailwind.config.ts` / `globals.css` 走 v3 语法（非 v4），不升级框架。
- **Next 16 / React 18 / 客户端边界**：dashboard layout 已是 `'use client'`；PageTransition 也是 client；server page 渲染 client 组件合法，无 hydration mismatch（`usePathname` 仅在 client 使用）。
- **无障碍**：键盘焦点环不可被 spotlight/边框覆盖；`prefers-reduced-motion` / `prefers-reduced-transparency` 全量退化。

## 10. 测试与验证

- **静态/构建**：`cd frontend && pnpm lint && pnpm build && pnpm test`（Vitest 单元/组件断言）。
- **现有 Playwright 不破坏**：`pnpm test:ui`，页面切换改为动画不应影响 DOM 结构与可访问性角色（`role`/`aria` 不变）。
- **Lighthouse 抽查**：`pnpm perf:lhci`（项目已配 `.lighthouserc.json`），确认 LCP/INP/CLS 不退化（INP < 200ms、CLS < 0.1 目标）。
- **手动验收**（亮色 + 暗色各一遍）：
  1. `/dashboard/*` 内任意两路由切换：旧页 exit（scale+blur+opacity spring）→ 新页 enter（容器 + 内容 stagger）；后退/前进一致；query 切换不重触发。
  2. `/dashboard/data-analysis/ad-analysis/*` 子页间切换：**无双层动画**（重点回归），与其它子路由过渡一致。
  3. 全局 loading 仍可见：导航期间 `GlobalLoadingOverlay` 顶栏进度条正常显示，**不再出现整页 DashboardPageLoading 卡顿**。
  4. Sidebar：rail hover 展开 panel 的 spring 手感；active 项指示 spring 过渡；spotlight（仅包装卡片）。
  5. 按钮：hover 提亮上浮；`:active` 加权按下回弹；键盘 Tab 焦点环可见。
  6. 卡片（包装过 spotlight 的）：hover 聚光边 + 微浮；表格行/未包装卡片**无** spotlight 监听（DevTools 验证 pointermove 仅在包装卡片）。
  7. `prefers-reduced-motion: reduce` → 所有动画退化为瞬时、无位移无模糊无 spring。
  8. `prefers-reduced-transparency: reduce` → blur 关闭、spotlight 退化为静态高光。
  9. 移动端 / 粗指针：spotlight 降级为静态高光。

## 11. 依赖与兼容性

- 框架：Next.js 16.2.4（App Router）、React 18.3.1。
- 样式：Tailwind v3.4.17、shadcn/ui（Radix + CVA）、`components.json`。
- 动画：framer-motion 12.34.3（主）、gsap 3.15.0（备用，本期不扩展）。
- 主题：next-themes（暗色已为 Raycast 风玻璃质感）。
- loading：复用现有 `GlobalLoadingOverlay` + 各路由 `loading.tsx`（不引入新依赖）。
- **无需新增 npm 依赖**。

## 12. 回滚

- 每 Phase 独立可逆：移除对应组件引用 / 还原 layout 几行 / 还原 utility 即关闭对应能力，不影响其他 Phase。
- Phase 1 拆除的两处（layout swap 与 ad-analysis wrap）本身就是改动前的稳定状态，回滚恢复即可。

---

### v2 相对 v1 的关键打磨（审查补强）

1. 显式处理 **`dashboard/layout.tsx` 整页 swap vs exit 动画的结构性冲突**（Phase 1 必修，否则 exit 演不出来）。
2. 显式处理 **`ad-analysis` 嵌套 layout 的双层动画风险**（Phase 1 必修，否则动效嵌套错乱）。
3. 页面过渡统一为 **spring**（Q2 已定 spring 物理，移除 v1 的"duration 或 spring"二选一模糊），给出可调起点参数。
4. spotlight **不全局挂**，改为可选 client 包装 + 降级策略（v1 直接挂在 `.dashboard-surface` 在 92 处会爆）。
5. 存量 utility（`.hover-lift` 等）**收编到 token**，避免两套节奏（v1 提了但没列为 Phase 0 动作）。
6. content stagger **opt-in 模型**显式化（容器自动 / 内容 opt-in），v1 容易让人误以为全量默认生效。
7. 验收清单加入 Lighthouse、query 行为、ad-analysis 双层回归、global loading 兜底回归。
8. 新增回滚段（每 Phase 可逆），降低大改风险。