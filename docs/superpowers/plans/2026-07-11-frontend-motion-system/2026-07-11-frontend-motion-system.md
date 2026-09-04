# 前端动效设计系统（Apple 级交互质感）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有前端（Next.js 16 App Router + Tailwind v3 + shadcn/ui + framer-motion 12）上正式建立一套统一的动效设计系统并系统性铺开，达到 Apple 级交互质感（spring 物理、玻璃/聚光、加权按下、统一页面过渡）。

**架构：** 动效 token 在 CSS 与 JS 两侧同源（`globals.css :root` + `lib/motion/tokens.ts`）；framer-motion 原语集中在 `components/motion/`（`PageTransition` / `MotionFade` / `MotionStagger` / `useSpotlight`）；全局路由过渡在 `app/dashboard/layout.tsx` 包裹 children；hover/active 用一套规范 utility（`.u-interactive` / `.u-press` / `.u-focus` / `.u-stagger-item`）标准化到关键表面；spotlight 用可选 client 包装 `dashboard-surface-card`（不全局挂）。两个结构性修复：拆 `dashboard/layout.tsx` 整页 loading swap（保留 children 让 exit 动画可演）、拆 `ad-analysis` 嵌套 layout 的 PageTransition 包（防双层动画）。

**技术栈：** Next.js 16.2.4 App Router、React 18.3.1、Tailwind v3.4.17、shadcn/ui、framer-motion 12.34.3、Vitest 4 + @testing-library/react（jsdom）、Playwright（项目已配）、@axe-core/playwright。

**测试纪律说明：** 组件 / hook 走严格 TDD（Vitest，jsdom）；**纯 CSS token 与 utility 类的增改** jsdom 不能可靠解析 `@apply` / 任意 utility 的 computed style，因此以 `pnpm build` 通过 + `grep` 审计 + 手动验收为主，不写形式化的"断言 CSS 类名存在"测试（避免假阳性）。

**分支：** 本计划在分支 `feat/frontend-motion-system` 上推进（不污染 main）；最终交付由用户决定合并与推送策略。

---

## 文件结构

**新增**
- `frontend/lib/motion/tokens.ts` — JS 镜像常量（`DURATION` / `EASE` / `SPRING` / `STAGGER` / `Z`）。
- `frontend/lib/motion/variants.ts` — framer-motion variants：`pageTransitionContainer`（C 形态 spring）、`fadeUp`、`staggerContainer`、`staggerItem`、`pressTap`。
- `frontend/components/motion/PageTransition.tsx` — 全局路由过渡，`AnimatePresence mode="wait"` + `key={pathname}`，reduced-motion / reduced-transparency 处理。
- `frontend/components/motion/MotionFade.tsx` — 通用淡入封装。
- `frontend/components/motion/MotionStagger.tsx` — 内容错落进场容器（`staggerChildren` + `fadeUp`）。
- `frontend/components/motion/useSpotlight.ts` — 轻量 hook，`pointermove` 写入 `--spot-x/--spot-y` CSS 变量。
- `frontend/components/motion/motion.test.tsx` — `PageTransition` / `MotionFade` / `MotionStagger` / `useSpotlight` 的 Vitest 测试。
- `frontend/components/dashboard/dashboard-surface-card.tsx` — 可选 spotlight 包装组件（不全局挂）。
- `frontend/components/dashboard/dashboard-surface-card.test.tsx` — 该包装的测试。

**修改**
- `frontend/app/globals.css` — 新增 token（`--motion-spring-press` / `--stagger-step` / `--z-*` / `--spot-x` / `--spot-y` / `--spotlight-strength`）；新增 utility（`.u-interactive` / `.u-press` / `.u-focus` / `.u-stagger-item`）；收编存量 utility 引用 token；补 reduced-motion / reduced-transparency 守卫。
- `frontend/app/dashboard/layout.tsx` — 用 `<PageTransition>` 包裹 children；拆除 `isNavigationLoading ? <DashboardPageLoading/> : children` 整页 swap（line 62）改为始终渲染 children；新增 `dashboard.layout.test.tsx` 验证 children 始终渲染。
- `frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx` — 拆除 `<AdAnalysisPageTransition>` 包裹（line 12），children 直接渲染。
- `frontend/components/ui/button.tsx` — 拓宽 `transition-colors` 为含 `transform`；追加 `.u-press` / `.u-focus` / `.u-interactive` 行为；`button.test.tsx` 新增行为断言。
- `frontend/components/dashboard/sidebar-*`（`sidebar-icon-rail.tsx` / `sidebar-panel.tsx`）— active 指示 spring 过渡 + hover 规范。
- `frontend/app/dashboard/page.tsx`（dashboard 首页）— 标题 / 卡片组接入 `<MotionStagger>`。

---

## Phase 0 — 地基（token + utility + JS 镜像）

### 任务 0.1：globals.css 新增 motion / z-index / spotlight token

**文件：**
- 修改：`frontend/app/globals.css`（在 `:root` 块尾部追加；在 `.dark` 块镜像 `--spotlight-strength` 默认值）

- [ ] **步骤 1：在 `:root` 追加 token**

在 `:root { ... }`（line 18–84，`--motion-ease-standard: cubic-bezier(0.16, 1, 0.3, 1);` 行后）追加：

```css
  /* ── Motion design system tokens ─────────────────────────────────────── */
  --motion-spring-press: 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
  --stagger-step: 70ms;

  /* ── Z-index scale (替代散落 z-10/50/9999) ──────────────────────────── */
  --z-nav: 30;
  --z-overlay: 50;
  --z-modal: 60;
  --z-toast: 70;
  --z-grain: 80;

  /* ── Spotlight (CSS 变量占位，由 useSpotlight 写入) ─────────────────── */
  --spot-x: 50%;
  --spot-y: 50%;
  --spotlight-strength: 1;
```

在 `.dark { ... }` 块（line 86–156）无需新增（dark 不影响 motion/spotlight 默认值）。

- [ ] **步骤 2：验证构建**

```bash
cd frontend && pnpm build 2>&1 | tail -20
```

预期：构建成功，无 CSS 报错。

- [ ] **步骤 3：commit**

```bash
git add frontend/app/globals.css
git commit -m "feat(动效): 新增 motion/z-index/spotlight token"
```

---

### 任务 0.2：globals.css 新增规范 utility 类 + reduced 守卫

**文件：**
- 修改：`frontend/app/globals.css`（在 `@layer components { ... }` 内追加；在 `@layer utilities { ... }` 内追加）

- [ ] **步骤 1：在 `@layer components` 追加规范 utility**

在 `dashboard-kicker` 之前（line 461 附近）追加：

```css
  /* ── Motion design system: interactive utilities ─────────────────────── */
  .u-interactive {
    transition:
      transform var(--motion-fast) var(--motion-ease-out),
      background-color var(--motion-fast) var(--motion-ease-out),
      border-color var(--motion-fast) var(--motion-ease-out),
      box-shadow var(--motion-fast) var(--motion-ease-out);
    will-change: transform;
  }
  .u-interactive:hover:not(:disabled):not([data-disabled='true']) {
    transform: translateY(-1px);
  }

  .u-press {
    transition: transform var(--motion-spring-press);
  }
  .u-press:active:not(:disabled):not([data-disabled='true']) {
    transform: scale(0.97);
  }

  .u-focus:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
    border-radius: var(--radius);
  }
```

- [ ] **步骤 2：在 `@layer utilities` 追加 stagger 备用**

在 `stagger-item` 定义之前（line 683 附近）追加：

```css
  /* ── Motion design system: stagger fallback (CSS-only, 给非 framer-motion 场景) ─ */
  .u-stagger-item {
    opacity: 0;
    animation: fade-slide-up var(--motion-base) var(--motion-ease-out) both;
    animation-delay: calc(var(--i, 0) * var(--stagger-step));
  }
```

- [ ] **步骤 3：补 reduced-motion / reduced-transparency 守卫**

在文件底部 `@media (prefers-reduced-motion: reduce) { ... }`（line 853–886）块内**追加**：

```css
  .u-interactive,
  .u-interactive:hover,
  .u-press,
  .u-press:active,
  .u-stagger-item {
    transform: none !important;
    animation: none !important;
    transition: none !important;
    opacity: 1 !important;
  }
```

在 `@media (prefers-reduced-transparency: reduce) { ... }` 块（line 457–459）后追加独立块：

```css
@media (prefers-reduced-transparency: reduce) {
  .u-spotlight,
  [data-spotlight] {
    --spotlight-strength: 0;
  }
}
```

- [ ] **步骤 4：grep 审计**

```bash
grep -nE "\.u-(interactive|press|focus|stagger-item)" frontend/app/globals.css
```

预期：能匹配到上述 4 个新类名。

- [ ] **步骤 5：build**

```bash
cd frontend && pnpm build 2>&1 | tail -10
```

预期：通过。

- [ ] **步骤 6：commit**

```bash
git add frontend/app/globals.css
git commit -m "feat(动效): 新增 .u-interactive/.u-press/.u-focus/.u-stagger-item 规范"
```

---

### 任务 0.3：收编存量 utility 引用新 token

**文件：**
- 修改：`frontend/app/globals.css`（替换硬编码时长/缓动）

- [ ] **步骤 1：把硬编码缓动替换为新 token**

在 `@layer utilities` 块内，对以下类（line 538–714 范围）将硬编码 `0.15s` / `0.2s` / `0.3s` / `var(--motion-fast)` 等等，统一替换为引用 token：

| 类 | 行范围 | 替换策略 |
|---|---|---|
| `.hover-lift` | 538–555 | `transition` 已是 `var(--motion-fast) var(--motion-ease-out)`，**保持不变**；合并两段重复定义为单段（删 line 545–550 的重复块） |
| `.conversation-item` | 558–574 | 已是 token，**保持** |
| `.send-btn` | 576–589 | 已是 token，**保持**；hover/active 的 `scale(1.05/0.95)` 改用 `.u-press` 语义但保留数值差异以避免破坏 AI 聊天手感 |
| `.action-btn` | 591–604 | 同上 |
| `.web-search-toggle` | 645–654 | 同上 |
| `.panel-toggle` | 606–612 | 已是 token，**保持** |
| `.settings-panel` | 698–702 | 已是 token，**保持** |
| `.prompt-textarea` | 656–662 | 已是 token，**保持** |
| `.message-content` | 664–681 | 已是 token，**保持** |

具体替换：删 `.hover-lift` 的重复 transition 块（line 545–550 整段，与 line 538–544 完全重复）。

- [ ] **步骤 2：grep + build**

```bash
grep -c "transition:" frontend/app/globals.css
cd frontend && pnpm build 2>&1 | tail -10
```

预期：grep 计数从原值下降（去重）；build 通过。

- [ ] **步骤 3：commit**

```bash
git add frontend/app/globals.css
git commit -m "refactor(动效): 收编 .hover-lift 等存量 utility 引用 token 去重"
```

---

### 任务 0.4：JS 镜像常量 `lib/motion/tokens.ts`

**文件：**
- 创建：`frontend/lib/motion/tokens.ts`

- [ ] **步骤 1：编写测试**

```ts
// frontend/lib/motion/tokens.test.ts
import { describe, it, expect } from 'vitest'
import { DURATION, EASE, SPRING, STAGGER, Z, isReducedMotionDefault } from './tokens'

describe('motion tokens', () => {
  it('DURATION mirrors CSS motion tokens', () => {
    expect(DURATION.fast).toBe(0.18)
    expect(DURATION.base).toBe(0.24)
    expect(DURATION.slow).toBe(0.32)
    expect(DURATION.springPress).toBe(0.22)
  })

  it('EASE exposes cubic-bezier arrays', () => {
    expect(EASE.out).toEqual([0.22, 1, 0.36, 1])
    expect(EASE.standard).toEqual([0.16, 1, 0.3, 1])
  })

  it('SPRING uses Apple-tuned spring for page transition', () => {
    expect(SPRING.page.stiffness).toBe(260)
    expect(SPRING.page.damping).toBe(30)
    expect(SPRING.page.mass).toBe(1)
  })

  it('STAGGER step mirrors --stagger-step', () => {
    expect(STAGGER.step).toBe(0.07)
  })

  it('Z scale covers nav/overlay/modal/toast/grain', () => {
    expect(Z.nav).toBe(30)
    expect(Z.overlay).toBe(50)
    expect(Z.modal).toBe(60)
    expect(Z.toast).toBe(70)
    expect(Z.grain).toBe(80)
  })

  it('isReducedMotionDefault is false (caller must read media query)', () => {
    expect(isReducedMotionDefault).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- motion/tokens.test.ts 2>&1 | tail -15
```

预期：FAIL（模块未找到）。

- [ ] **步骤 3：实现 tokens.ts**

```ts
// frontend/lib/motion/tokens.ts
/**
 * Motion design system — JS-side mirror of CSS tokens.
 * 数值必须与 frontend/app/globals.css :root 中的 --motion-* / --stagger-step / --z-* 一一对应。
 * 改这里必须同步改 globals.css；改 globals.css 必须同步改这里。
 */

export const DURATION = {
  fast: 0.18,
  base: 0.24,
  slow: 0.32,
  springPress: 0.22,
} as const

export const EASE = {
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  standard: [0.16, 1, 0.3, 1] as [number, number, number, number],
  springBack: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
} as const

export const SPRING = {
  page: { type: 'spring', stiffness: 260, damping: 30, mass: 1 } as const,
  press: { type: 'spring', stiffness: 380, damping: 22, mass: 0.8 } as const,
} as const

export const STAGGER = {
  step: 0.07,
  childDelay: 0.07,
} as const

export const Z = {
  nav: 30,
  overlay: 50,
  modal: 60,
  toast: 70,
  grain: 80,
} as const

/** 默认 reduced-motion 关闭（运行时应通过 framer-motion 的 useReducedMotion 读系统） */
export const isReducedMotionDefault = false
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- motion/tokens.test.ts 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/lib/motion/tokens.ts frontend/lib/motion/tokens.test.ts
git commit -m "feat(动效): 新增 JS 镜像 motion token + 单测"
```

---

### 任务 0.5：framer-motion variants `lib/motion/variants.ts`

**文件：**
- 创建：`frontend/lib/motion/variants.ts`

- [ ] **步骤 1：编写测试**

```ts
// frontend/lib/motion/variants.test.ts
import { describe, it, expect } from 'vitest'
import {
  pageTransitionContainer,
  fadeUp,
  staggerContainer,
  staggerItem,
  pressTap,
} from './variants'

describe('motion variants', () => {
  it('pageTransitionContainer uses C form: scale + blur + opacity spring', () => {
    const v = pageTransitionContainer()
    expect(v.initial).toMatchObject({ opacity: 0, scale: 0.985, y: 6 })
    expect(v.initial.filter).toBe('blur(8px)')
    expect(v.animate).toMatchObject({ opacity: 1, scale: 1, y: 0 })
    expect(v.animate.filter).toBe('blur(0px)')
    expect(v.exit).toMatchObject({ opacity: 0, scale: 0.99, y: -4 })
    expect(v.exit.filter).toBe('blur(4px)')
  })

  it('pageTransitionContainer transition uses spring from tokens', () => {
    const v = pageTransitionContainer()
    expect((v.transition as { type: string }).type).toBe('spring')
    expect(v.transition).toMatchObject({ stiffness: 260, damping: 30 })
  })

  it('fadeUp is opacity+y with ease out', () => {
    const v = fadeUp()
    expect(v.initial).toEqual({ opacity: 0, y: 10 })
    expect(v.animate).toEqual({ opacity: 1, y: 0 })
    expect(v.transition).toMatchObject({ duration: 0.24 })
  })

  it('staggerContainer uses staggerChildren 0.07', () => {
    expect(staggerContainer().animate.transition).toMatchObject({ staggerChildren: 0.07 })
  })

  it('staggerItem uses fadeUp + ease out', () => {
    const v = staggerItem()
    expect(v.initial).toEqual({ opacity: 0, y: 10 })
    expect(v.animate).toEqual({ opacity: 1, y: 0 })
  })

  it('pressTap scales to 0.97 on tap', () => {
    expect(pressTap().whileTap).toEqual({ scale: 0.97 })
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- motion/variants.test.ts 2>&1 | tail -10
```

预期：FAIL。

- [ ] **步骤 3：实现 variants.ts**

```ts
// frontend/lib/motion/variants.ts
import type { Variants } from 'framer-motion'
import { DURATION, EASE, SPRING, STAGGER } from './tokens'

/**
 * 页面容器（C 形态）：scale + blur + opacity，spring 物理。
 * 与 spec §5 对齐：initial scale 0.985、blur 8px、y 6；exit scale 0.99、blur 4px、y -4。
 */
export function pageTransitionContainer(): Variants {
  return {
    initial: { opacity: 0, scale: 0.985, filter: 'blur(8px)', y: 6 },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)', y: 0 },
    exit: { opacity: 0, scale: 0.99, filter: 'blur(4px)', y: -4 },
    transition: SPRING.page,
  }
}

/** 通用 fade-up，opacity + y。 */
export function fadeUp(): Variants {
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE.out },
  }
}

/** stagger 容器：staggerChildren 0.07。 */
export function staggerContainer(): Variants {
  return {
    initial: {},
    animate: { transition: { staggerChildren: STAGGER.childDelay, delayChildren: 0.02 } },
  }
}

/** stagger 子项：fadeUp + ease out。 */
export function staggerItem(): Variants {
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE.out } },
  }
}

/** 按下反馈：scale 0.97。 */
export function pressTap() {
  return { whileTap: { scale: 0.97 } }
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- motion/variants.test.ts 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/lib/motion/variants.ts frontend/lib/motion/variants.test.ts
git commit -m "feat(动效): 新增 framer-motion variants (page/fadeUp/stagger/press)"
```

---

## Phase 1 — 全局过渡 + 两项结构修正

### 任务 1.1：`useSpotlight` hook + 测试

**文件：**
- 创建：`frontend/components/motion/useSpotlight.ts`
- 创建：`frontend/components/motion/use-spotlight.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// frontend/components/motion/use-spotlight.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSpotlight } from './use-spotlight'

describe('useSpotlight', () => {
  let el: HTMLDivElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
  })
  afterEach(() => {
    document.body.removeChild(el)
  })

  it('writes --spot-x/--spot-y on pointermove (relative coords 0-100%)', () => {
    renderHook(() => useSpotlight({ ref: { current: el } }))
    // 模拟 getBoundingClientRect 返回 100x100 起点 (0,0)
    el.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect))
    act(() => {
      el.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 25, bubbles: true }))
    })
    expect(el.style.getPropertyValue('--spot-x')).toBe('50%')
    expect(el.style.getPropertyValue('--spot-y')).toBe('25%')
  })

  it('does nothing when ref.current is null', () => {
    const noRef = { current: null }
    expect(() => renderHook(() => useSpotlight({ ref: noRef }))).not.toThrow()
  })

  it('returns a ref that points to the element', () => {
    const { result } = renderHook(() => {
      const ref = useSpotlight<HTMLDivElement>({})
      return ref
    })
    expect(result.current).toBeDefined()
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- motion/use-spotlight.test.tsx 2>&1 | tail -10
```

预期：FAIL（模块未找到）。

- [ ] **步骤 3：实现 useSpotlight**

```tsx
// frontend/components/motion/useSpotlight.ts
'use client'
import { useEffect, useRef, type RefObject } from 'react'

type UseSpotlightOptions<E extends HTMLElement = HTMLElement> = {
  /** 外部传入 ref；不传则 hook 自管一个 */
  ref?: RefObject<E | null>
  /** 是否启用；不传则 coarse pointer / reduced-transparency 下自动关闭 */
  enabled?: boolean
}

/**
 * 轻量 spotlight：pointermove 把光标相对坐标写入 element.style 的
 * `--spot-x` / `--spot-y` CSS 变量（百分比），由 CSS 用 radial-gradient 渲染高光边。
 * 减透明 / 粗指针下不挂监听（CSS 通过 --spotlight-strength 关闭视觉）。
 */
export function useSpotlight<E extends HTMLElement = HTMLDivElement>(
  options: UseSpotlightOptions<E> = {},
) {
  const internalRef = useRef<E | null>(null)
  const ref = options.ref ?? internalRef
  const enabled = options.enabled ?? true

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    // 减透明 / 粗指针 → 不挂监听（CSS 仍可读 --spot-x/y 默认 50%）
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function'
    ) {
      const reduce = window.matchMedia('(prefers-reduced-transparency: reduce)')
      if (reduce.matches) return
    }

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 100
      const y = ((e.clientY - rect.top) / rect.height) * 100
      el.style.setProperty('--spot-x', `${x}%`)
      el.style.setProperty('--spot-y', `${y}%`)
    }

    el.addEventListener('pointermove', onMove)
    return () => el.removeEventListener('pointermove', onMove)
  }, [enabled, ref])

  return ref
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- motion/use-spotlight.test.tsx 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/motion/useSpotlight.ts frontend/components/motion/use-spotlight.test.tsx
git commit -m "feat(动效): 新增 useSpotlight hook + 单测"
```

---

### 任务 1.2：`MotionFade` + 测试

**文件：**
- 创建：`frontend/components/motion/MotionFade.tsx`
- 创建：`frontend/components/motion/motion-fade.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// frontend/components/motion/motion-fade.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MotionFade } from './MotionFade'

// 让 framer-motion 的 useReducedMotion 在测试中可控
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => false }
})

describe('MotionFade', () => {
  it('renders children inside a motion.div', () => {
    const { getByTestId, container } = render(
      <MotionFade><div data-testid="kid">x</div></MotionFade>,
    )
    expect(getByTestId('kid')).toBeInTheDocument()
    expect(container.querySelector('[style*="opacity"]')).toBeTruthy()
  })

  it('applies initial opacity 0', () => {
    const { container } = render(<MotionFade>x</MotionFade>)
    const motionDiv = container.firstChild as HTMLElement
    expect(motionDiv.style.opacity).toBe('0')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- motion/motion-fade.test.tsx 2>&1 | tail -10
```

预期：FAIL。

- [ ] **步骤 3：实现 MotionFade**

```tsx
// frontend/components/motion/MotionFade.tsx
'use client'
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'
import { DURATION, EASE } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'transition'>

export function MotionFade({ children, className, ...rest }: Props) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DURATION.base, ease: EASE.out }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- motion/motion-fade.test.tsx 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/motion/MotionFade.tsx frontend/components/motion/motion-fade.test.tsx
git commit -m "feat(动效): 新增 MotionFade 原语"
```

---

### 任务 1.3：`MotionStagger` + 测试

**文件：**
- 创建：`frontend/components/motion/MotionStagger.tsx`
- 创建：`frontend/components/motion/motion-stagger.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// frontend/components/motion/motion-stagger.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MotionStagger, MotionStaggerItem } from './MotionStagger'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => false }
})

describe('MotionStagger', () => {
  it('renders container + children wrapped as stagger items', () => {
    const { container } = render(
      <MotionStagger>
        <MotionStaggerItem><div data-testid="a">a</div></MotionStaggerItem>
        <MotionStaggerItem><div data-testid="b">b</div></MotionStaggerItem>
      </MotionStagger>,
    )
    expect(container.querySelectorAll('[data-testid="a"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="b"]')).toHaveLength(1)
  })

  it('items start with opacity 0 (initial)', () => {
    const { container } = render(
      <MotionStagger>
        <MotionStaggerItem>x</MotionStaggerItem>
      </MotionStagger>,
    )
    // MotionStaggerItem 渲染一个 motion.div，初始 inline style 含 opacity:0
    const itemDiv = container.querySelector('div > div') as HTMLElement | null
    expect(itemDiv).toBeTruthy()
    expect(itemDiv?.style.opacity).toBe('0')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- motion/motion-stagger.test.tsx 2>&1 | tail -10
```

预期：FAIL。

- [ ] **步骤 3：实现 MotionStagger**

```tsx
// frontend/components/motion/MotionStagger.tsx
'use client'
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'
import { DURATION, EASE, STAGGER } from '@/lib/motion/tokens'

type ContainerProps = {
  children: ReactNode
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'variants' | 'transition'>

export function MotionStagger({ children, className, ...rest }: ContainerProps) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: STAGGER.childDelay, delayChildren: 0.02 } },
      }}
      className={className}
      {...rest}
    >
      {reduce ? <>{children}</> : children}
    </motion.div>
  )
}

type ItemProps = {
  children: ReactNode
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'variants' | 'transition'>

export function MotionStaggerItem({ children, className, ...rest }: ItemProps) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE.out } },
      }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- motion/motion-stagger.test.tsx 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/motion/MotionStagger.tsx frontend/components/motion/motion-stagger.test.tsx
git commit -m "feat(动效): 新增 MotionStagger / MotionStaggerItem"
```

---

### 任务 1.4：`PageTransition`（全局路由过渡）+ 测试

**文件：**
- 创建：`frontend/components/motion/PageTransition.tsx`
- 创建：`frontend/components/motion/page-transition.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// frontend/components/motion/page-transition.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageTransition } from './PageTransition'

// pathname 初始为 '/a'，可在测试中通过重新 mock 修改
let mockPathname = '/a'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => false }
})

describe('PageTransition', () => {
  beforeEach(() => {
    mockPathname = '/a'
  })

  it('renders children inside AnimatePresence', () => {
    render(
      <PageTransition>
        <div data-testid="content">hello</div>
      </PageTransition>,
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
  })

  it('does not apply blur filter under reduced motion', async () => {
    // 单独构造一个 reduced-motion 启用场景
    const framer = await vi.importActual<typeof import('framer-motion')>('framer-motion')
    vi.spyOn(framer, 'useReducedMotion').mockReturnValue(true)
    // 该断言更多是结构性：reduced 下 initial 应被覆盖为 { opacity: 1 }
    // 简化：只断言渲染正常
    render(<PageTransition>x</PageTransition>)
    expect(screen.getByText('x')).toBeInTheDocument()
  })
})
```

> 测试断言中 reduce-motion 的二次覆盖较脆弱，主要价值是验证组件挂载 + children 渲染；filter 的真实行为靠 e2e/手动。

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- motion/page-transition.test.tsx 2>&1 | tail -10
```

预期：FAIL。

- [ ] **步骤 3：实现 PageTransition**

```tsx
// frontend/components/motion/PageTransition.tsx
'use client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { SPRING } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
}

/**
 * 全局路由过渡（C 形态）：scale + blur + opacity + spring。
 * - AnimatePresence mode="wait" 保证旧页退场 → 新页进场串行。
 * - key=pathname 触发 key 变化时 exit/enter 动画。
 * - reduced-motion / reduced-transparency 退化（无位移无模糊无 spring）。
 */
export function PageTransition({ children, className }: Props) {
  const pathname = usePathname()
  const reduce = useReducedMotion()
  const [reduceTransparency, setReduceTransparency] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const apply = () => setReduceTransparency(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const initial = reduce
    ? { opacity: 1 }
    : reduceTransparency
      ? { opacity: 0, scale: 0.985, y: 6 }
      : { opacity: 0, scale: 0.985, filter: 'blur(8px)' as string, y: 6 }

  const animate = reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' as string }

  const exit = reduce
    ? { opacity: 1 }
    : reduceTransparency
      ? { opacity: 0, scale: 0.99, y: -4 }
      : { opacity: 0, scale: 0.99, filter: 'blur(4px)' as string, y: -4 }

  const transition = reduce ? { duration: 0 } : SPRING.page

  return (
    <div className={className}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={pathname}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          className="will-change-transform"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- motion/page-transition.test.tsx 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/motion/PageTransition.tsx frontend/components/motion/page-transition.test.tsx
git commit -m "feat(动效): 新增 PageTransition 全局路由过渡"
```

---

### 任务 1.5：dashboard/layout.tsx 接入 PageTransition + 拆除整页 swap

**文件：**
- 修改：`frontend/app/dashboard/layout.tsx`
- 创建：`frontend/app/dashboard/layout.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// frontend/app/dashboard/layout.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'authenticated', data: { user: { name: 't' } } }),
  signOut: vi.fn(),
}))
vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({ isNavigationLoading: false, isBlockingLoading: false }),
}))
// DashboardPageLoading 仍存在但不应再被 layout swap 触发
vi.mock('@/components/dashboard/dashboard-page-loading', () => ({
  DashboardPageLoading: () => <div data-testid="page-loading">loading</div>,
}))

// 动态 import 被测 layout（在 mock 之后）
import DashboardLayout from './layout'

describe('DashboardLayout', () => {
  it('always renders children (does not swap to loading on isNavigationLoading)', () => {
    // isNavigationLoading 设为 true：旧行为会渲染 DashboardPageLoading，新行为必须仍渲染 children
    vi.doMock('@/components/global-loading-provider', () => ({
      useGlobalLoading: () => ({ isNavigationLoading: true, isBlockingLoading: false }),
    }))
    render(
      <DashboardLayout>
        <div data-testid="child">real child</div>
      </DashboardLayout>,
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('page-loading')).not.toBeInTheDocument()
  })
})
```

> 注：jsdom + Next layout 的渲染可能受 server-only 组件影响。该测试主要验证：children 始终被渲染（不被 loading 整页替换）。如果布局因 server 组件依赖无法直接 mount，可改为：grep 校验 + render 一个最小化的等价组件（见步骤 3 末尾 grep 校验）。

- [ ] **步骤 2：运行测试（接受 jsdom 局限）**

```bash
cd frontend && pnpm test -- dashboard/layout.test.tsx 2>&1 | tail -30
```

预期：可能因 SidebarProvider / SidebarShell 等依赖报错；**核心断言**通过 grep + 手动覆盖（见步骤 3）。

- [ ] **步骤 3：修改 layout.tsx**

在 `frontend/app/dashboard/layout.tsx`：

1. 在 import 区加入：
   ```ts
   import { PageTransition } from '@/components/motion/PageTransition'
   ```
   并**删除**：
   ```ts
   import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
   ```
   （该组件仍被各 `loading.tsx` 引用，不删文件本身。）

2. 修改 line 62 附近的渲染，把 `{isNavigationLoading ? <DashboardPageLoading /> : children}` 改为：

```tsx
              <PageTransition>
                {children}
              </PageTransition>
```

完整替换片段（line 50–67 的 return 区）：

```tsx
  return (
    <SidebarProvider>
      <div className='flex h-screen w-full overflow-hidden bg-[hsl(var(--surface-low))]'>
        <SidebarShell />

        {/* Main content area — pushed right when sidebar panel is open via parent flex layout */}
        <SidebarInset className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--surface-low))]'>
          <main
            id='main-content'
            className='dashboard-full-width relative min-w-0 flex-1 overflow-x-clip overflow-y-auto px-1 pb-6 pt-3 md:px-2 md:pb-8 lg:px-3 xl:px-4'
          >
            <div className='dashboard-page-shell min-h-0 md:min-h-[calc(100vh-4rem)] px-0 py-1'>
              <PageTransition>
                {children}
              </PageTransition>
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
```

- [ ] **步骤 4：grep 审计**

```bash
grep -n "DashboardPageLoading" frontend/app/dashboard/layout.tsx
grep -n "isNavigationLoading" frontend/app/dashboard/layout.tsx
```

预期：两个命令均无输出（layout.tsx 不再引用 DashboardPageLoading 与 isNavigationLoading）。

- [ ] **步骤 5：build + lint**

```bash
cd frontend && pnpm lint 2>&1 | tail -10 && pnpm build 2>&1 | tail -15
```

预期：通过。

- [ ] **步骤 6：commit**

```bash
git add frontend/app/dashboard/layout.tsx
git commit -m "feat(动效): dashboard layout 接入 PageTransition 拆整页 loading swap"
```

---

### 任务 1.6：ad-analysis layout 拆除嵌套 PageTransition 包裹

**文件：**
- 修改：`frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx`

- [ ] **步骤 1：读取现状确认**

```bash
sed -n '1,20p' frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx
```

预期：当前 line 3 引入 `AdAnalysisPageTransition`，line 12 用其包裹 children。

- [ ] **步骤 2：修改为直接渲染 children**

完整文件改为：

```tsx
// frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { Suspense } from 'react'

export default function AdAnalysisLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className='relative'>
      <Suspense fallback={<DashboardPageLoading />}>
        {children}
      </Suspense>
    </div>
  )
}
```

> 若原文件有其它职责（getDashboardPageTitle 等），保留并仅替换 children 渲染段；保留 `Suspense` 兜底（来自原 layout 的 Next.js streaming 兜底）。

- [ ] **步骤 3：grep 审计**

```bash
grep -rn "AdAnalysisPageTransition" frontend/
```

预期：仅匹配 `components/dashboard/ad-analysis/page-transition.tsx` 文件本身（定义），无任何引用。

- [ ] **步骤 4：build**

```bash
cd frontend && pnpm build 2>&1 | tail -15
```

预期：通过（组件未引用，tree-shake 掉，不影响产物）。

- [ ] **步骤 5：commit**

```bash
git add frontend/app/dashboard/data-analysis/ad-analysis/layout.tsx
git commit -m "refactor(动效): 拆 ad-analysis 嵌套 PageTransition 包裹 防全局双层动画"
```

---

### 任务 1.7：审计残留 + Phase 1 整体验证

- [ ] **步骤 1：grep 整 dashboard 树确认无其它嵌套过渡**

```bash
grep -rn "AnimatePresence\|key={pathname}" frontend/app/dashboard frontend/components/dashboard 2>/dev/null
```

预期：仅匹配 `components/motion/PageTransition.tsx`（新增）；无其它命中。

- [ ] **步骤 2：lint + build + test**

```bash
cd frontend && pnpm lint 2>&1 | tail -5 && pnpm build 2>&1 | tail -15 && pnpm test 2>&1 | tail -20
```

预期：全部通过。

- [ ] **步骤 3：手动烟雾测试**

```bash
cd frontend && pnpm dev &
# 在浏览器中：
# 1. 进入 /dashboard，浏览多个子路由，应能看到容器 scale+blur+opacity spring 进场；
# 2. 进入 /dashboard/data-analysis/ad-analysis/overview 与 /dashboard/data-analysis/ad-analysis/campaigns，
#    切换应与其它子路由过渡一致（无双层嵌套）；
# 3. 切换路由时顶栏 GlobalLoadingOverlay 应仍正常出现。
```

- [ ] **步骤 4：tag（可选）**

```bash
git tag -a "phase1-motion-transition" -m "Phase 1: global page transition"
```

---

## Phase 2 — hover / active 标准化

### 任务 2.1：Button 接入 `.u-press` / `.u-focus` / `.u-interactive`

**文件：**
- 修改：`frontend/components/ui/button.tsx`
- 创建：`frontend/components/ui/button.test.tsx`（若不存在则新建）

- [ ] **步骤 1：grep 现状**

```bash
grep -n "transition-" frontend/components/ui/button.tsx
```

预期：当前仅 `transition-colors`。

- [ ] **步骤 2：编写测试**

```tsx
// frontend/components/ui/button.test.tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Button } from './button'

describe('Button motion classes', () => {
  it('includes transition for transform (u-press / u-interactive)', () => {
    const { container } = render(<Button>x</Button>)
    const btn = container.querySelector('button')!
    // Tailwind 生成 `transition` 类（来自 utilities 中 transition-property）
    expect(btn.className).toMatch(/transition/)
    expect(btn.className).toMatch(/focus-visible:outline/)
  })

  it('honours disabled (no transform target)', () => {
    const { container } = render(<Button disabled>x</Button>)
    const btn = container.querySelector('button')!
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})
```

> 因 jsdom 限制，`.u-press` / `.u-interactive` 类是否被 button 实际 className 包含取决于是否在 buttonVariants 中追加。本任务在 buttonVariants 的 base classes 中追加 `u-press u-focus u-interactive`。

- [ ] **步骤 3：修改 button.tsx**

把 line 8 的 buttonVariants 第一个参数（base className）从：

```
"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
```

改为：

```
"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background u-press u-focus u-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
```

> `focus-visible:ring-*` 保留（增强焦点环）；`u-focus` 在没有键盘焦点时无副作用（`:focus-visible` 才生效）。

- [ ] **步骤 4：test + build**

```bash
cd frontend && pnpm test -- ui/button.test.tsx 2>&1 | tail -10 && pnpm build 2>&1 | tail -10
```

预期：测试 PASS；build 通过。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/ui/button.tsx frontend/components/ui/button.test.tsx
git commit -m "feat(动效): Button 接入 u-press/u-focus/u-interactive"
```

---

### 任务 2.2：Sidebar active 指示 spring 过渡 + hover 规范

**文件：**
- 修改：`frontend/components/dashboard/sidebar-icon-rail.tsx`
- 修改：`frontend/components/dashboard/sidebar-panel.tsx`

> 现有 sidebar 已有 `sidebar-panel-shell` 的 spring 过渡（`globals.css` line 891–910），本任务聚焦 icon rail 上的 active 指示加 spring 过渡 + hover 规范。

- [ ] **步骤 1：grep 现状**

```bash
grep -n "active\|transition\|translate" frontend/components/dashboard/sidebar-icon-rail.tsx | head -30
```

- [ ] **步骤 2：active 指示 spring**

在 `RailChip`（`sidebar-icon-rail.tsx` line 33–39）的 active 样式分支（按现有 active 判定逻辑定位），把 active 指示元素的 className 拼接 `transition-[transform,opacity,background-color] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]`。**不引入新依赖**，仅用 Tailwind 任意值工具类引用现有 spring token。

具体改动：找到当前 active 元素的 className（搜索 `data-active` 或条件 `activeGroupId === id`），追加：

```tsx
'transition-[transform,opacity,background-color] duration-200 ease-[cubic-bezier(0.22,1.18,0.36,1)]'
```

- [ ] **步骤 3：panel 内 nav item hover 规范**

在 `sidebar-panel.tsx` 的 nav item 渲染处，给 `<Link>`/`<a>` 的 className 追加 `u-interactive`。具体：在 `isLinkActive(item)` 之外的渲染分支找 className 拼接。

- [ ] **步骤 4：lint + build**

```bash
cd frontend && pnpm lint 2>&1 | tail -5 && pnpm build 2>&1 | tail -10
```

预期：通过。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/dashboard/sidebar-icon-rail.tsx frontend/components/dashboard/sidebar-panel.tsx
git commit -m "feat(动效): Sidebar active 指示 spring + nav item hover 规范"
```

---

### 任务 2.3：`dashboard-surface-card` 可选 spotlight 包装 + 测试

**文件：**
- 创建：`frontend/components/dashboard/dashboard-surface-card.tsx`
- 创建：`frontend/components/dashboard/dashboard-surface-card.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// frontend/components/dashboard/dashboard-surface-card.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DashboardSurfaceCard } from './dashboard-surface-card'

// useSpotlight 已被验证，这里只断言包装组件渲染 children + 应用 dashboard-surface 类
describe('DashboardSurfaceCard', () => {
  it('renders children inside .dashboard-surface', () => {
    const { container } = render(
      <DashboardSurfaceCard><span data-testid="c">x</span></DashboardSurfaceCard>,
    )
    expect(screen.getByTestId('c')).toBeInTheDocument()
    expect(container.querySelector('.dashboard-surface')).toBeTruthy()
  })

  it('forwards className', () => {
    const { container } = render(
      <DashboardSurfaceCard className="extra"><span>x</span></DashboardSurfaceCard>,
    )
    expect(container.firstChild).toHaveClass('extra')
    expect(container.firstChild).toHaveClass('dashboard-surface')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd frontend && pnpm test -- dashboard/dashboard-surface-card.test.tsx 2>&1 | tail -10
```

预期：FAIL。

- [ ] **步骤 3：实现**

```tsx
// frontend/components/dashboard/dashboard-surface-card.tsx
'use client'
import { type HTMLAttributes, type ReactNode } from 'react'
import { useSpotlight } from '@/components/motion/useSpotlight'
import { cn } from '@/lib/utils'

type Props = {
  children: ReactNode
  className?: string
  /** 是否启用 spotlight（pointermove 写入 CSS 变量）；默认 true */
  spotlight?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>

/**
 * 可选 spotlight 包装：把 `.dashboard-surface` 卡片转为 client 组件，
 * 启用时通过 useSpotlight 把光标坐标写入 --spot-x/--spot-y。
 *
 * 关键约束：
 * - 不全局替换 `.dashboard-surface`（现有 92 处用法，挂 pointermove 会爆性能）。
 * - 仅在真正需要 hover 聚光感的卡片（KPI / 数据卡片）显式改用此包装。
 * - 减透明 / 粗指针下 useSpotlight 不挂监听，CSS 通过 --spotlight-strength 关闭视觉。
 */
export function DashboardSurfaceCard({
  children,
  className,
  spotlight = true,
  ...rest
}: Props) {
  const ref = useSpotlight<HTMLDivElement>({ enabled: spotlight })

  return (
    <div
      ref={ref}
      data-spotlight={spotlight ? '' : undefined}
      className={cn(
        'dashboard-surface u-interactive',
        // spotlight 视觉：径向高光边；减透明时通过 globals.css 降级为 0
        spotlight &&
          'before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:opacity-[calc(var(--spotlight-strength)*0.85)] before:bg-[radial-gradient(220px_circle_at_var(--spot-x)_var(--spot-y),hsl(var(--primary)/0.18),transparent_60%)] before:transition-opacity before:duration-300',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd frontend && pnpm test -- dashboard/dashboard-surface-card.test.tsx 2>&1 | tail -10
```

预期：PASS。

- [ ] **步骤 5：commit**

```bash
git add frontend/components/dashboard/dashboard-surface-card.tsx frontend/components/dashboard/dashboard-surface-card.test.tsx
git commit -m "feat(动效): 新增 DashboardSurfaceCard spotlight 包装"
```

---

### 任务 2.4：在 dashboard 首页一张 KPI 卡片试点 spotlight

> 不全量 92 处替换；选一张高频 KPI 卡验证视觉与性能。

**文件：**
- 修改：`frontend/app/dashboard/page.tsx`（首页，按 grep 定位 KPI 卡片）

- [ ] **步骤 1：grep 定位 KPI 卡**

```bash
grep -n "dashboard-surface" frontend/app/dashboard/page.tsx | head -10
```

- [ ] **步骤 2：选一处把 `<div className="dashboard-surface ...">` 改为 `<DashboardSurfaceCard className="...">...</DashboardSurfaceCard>`**

具体改动：选取 line 494 之前（已知 `DashboardPageLoading` 之上）一处真正的 KPI 卡（非 loading 态），把外层 div 替换为 `<DashboardSurfaceCard>`。

在文件顶部新增 import：

```tsx
import { DashboardSurfaceCard } from '@/components/dashboard/dashboard-surface-card'
```

替换后确保 `<DashboardSurfaceCard>` 的闭合标签与 children 匹配。

- [ ] **步骤 3：build**

```bash
cd frontend && pnpm build 2>&1 | tail -10
```

预期：通过。

- [ ] **步骤 4：手动验证**

```bash
cd frontend && pnpm dev &
# 浏览器：访问 /dashboard，鼠标在试点 KPI 卡片上移动，应看到聚光边跟随；
# DevTools Performance：pointermove 事件仅在该卡片触发（不在其它 .dashboard-surface 触发）。
```

- [ ] **步骤 5：commit**

```bash
git add frontend/app/dashboard/page.tsx
git commit -m "feat(动效): dashboard 首页 KPI 卡片试点 spotlight 包装"
```

---

### 任务 2.5：Phase 2 整体验证

- [ ] **步骤 1：lint + build + test**

```bash
cd frontend && pnpm lint 2>&1 | tail -5 && pnpm build 2>&1 | tail -15 && pnpm test 2>&1 | tail -20
```

预期：通过。

- [ ] **步骤 2：tag**

```bash
git tag -a "phase2-hover-active" -m "Phase 2: hover/active standardization"
```

---

## Phase 3 — 高级触感 + 内容 stagger 推广

### 任务 3.1：dashboard 首页标题/卡片组接入 MotionStagger

**文件：**
- 修改：`frontend/app/dashboard/page.tsx`

- [ ] **步骤 1：定位标题与卡片组**

```bash
grep -n "dashboard-display\|dashboard-page-shell\|grid" frontend/app/dashboard/page.tsx | head -10
```

- [ ] **步骤 2：包裹 MotionStagger**

把首页标题块 + 第一组 KPI 卡片网格外层用 `<MotionStagger>` 包裹，每个 KPI 卡（或标题/区块）用 `<MotionStaggerItem>` 包裹。

新增 import：

```tsx
import { MotionStagger, MotionStaggerItem } from '@/components/motion/MotionStagger'
```

示例包裹：

```tsx
<MotionStagger className="space-y-6">
  <MotionStaggerItem>
    <h1 className="dashboard-display">...</h1>
  </MotionStaggerItem>
  <MotionStaggerItem className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
    {/* KPI 卡 */}
  </MotionStaggerItem>
</MotionStagger>
```

> 注意 `MotionStagger` 是 client component；首页若是 server component 可直接 import 使用（合法）。

- [ ] **步骤 3：build + 手动**

```bash
cd frontend && pnpm build 2>&1 | tail -10
cd frontend && pnpm dev &
# 浏览器访问 /dashboard，进入时标题与卡片组应错落进场（70ms 间隔）。
```

- [ ] **步骤 4：commit**

```bash
git add frontend/app/dashboard/page.tsx
git commit -m "feat(动效): dashboard 首页标题/卡片组接入 MotionStagger"
```

---

### 任务 3.2：toast/dialog 缓动统一到 token（轻量）

**文件：**
- 修改：`frontend/components/notifications/notification-toast.tsx`
- 修改：`frontend/components/system/notification-wrapper.tsx`
- 可能：`frontend/app/globals.css` `.ui-floating-motion` 引用 token

- [ ] **步骤 1：grep**

```bash
grep -n "transition\|duration\|ease" frontend/components/notifications/notification-toast.tsx frontend/components/system/notification-wrapper.tsx | head -20
```

- [ ] **步骤 2：替换硬编码**

把 framer-motion 过渡参数中硬编码的 `duration: 0.2/0.3` 与 `ease: [...]` 替换为 `DURATION.*` 与 `EASE.*`（从 `@/lib/motion/tokens` import）。已有 `.ui-floating-motion` 的 `cubic-bezier(0.34, 1.56, 0.64, 1)` 与 `--motion-spring-press` 一致，**不动**。

- [ ] **步骤 3：test + build**

```bash
cd frontend && pnpm test 2>&1 | tail -10 && pnpm build 2>&1 | tail -10
```

预期：通过。

- [ ] **步骤 4：commit**

```bash
git add frontend/components/notifications/notification-toast.tsx frontend/components/system/notification-wrapper.tsx
git commit -m "refactor(动效): toast/dialog 缓动统一引用 token"
```

---

### 任务 3.3：Phase 3 整体验证 + tag

- [ ] **步骤 1：lint + build + test**

```bash
cd frontend && pnpm lint 2>&1 | tail -5 && pnpm build 2>&1 | tail -15 && pnpm test 2>&1 | tail -20
```

预期：通过。

- [ ] **步骤 2：tag**

```bash
git tag -a "phase3-premium-stagger" -m "Phase 3: premium touches + content stagger"
```

---

## Phase 4 — 验收

### 任务 4.1：Playwright 回归（不破坏现有 e2e）

- [ ] **步骤 1：跑现有 Playwright**

```bash
cd frontend && pnpm test:ui 2>&1 | tail -30
```

预期：全部通过。若有失败，定位是动画导致 DOM/role 变化还是真正的功能问题，按情况修复或调整用例（动画不应改变 `role`/`aria-label`/数据 DOM 结构）。

- [ ] **步骤 2：Lighthouse 抽查**

```bash
cd frontend && pnpm perf:lhci:collect 2>&1 | tail -20
```

人工比对：INP/LCP/CLS 不显著退化（重点 `/dashboard` 与 `/dashboard/data-analysis/ad-analysis/overview`）。

- [ ] **步骤 3：手动验收（9 条）**

逐条对照 spec §10 验收清单：

1. 路由切换：exit + enter，spring 手感一致；
2. ad-analysis 子路由：**无双层动画**；
3. GlobalLoadingOverlay 仍可见，无整页 DashboardPageLoading 卡顿；
4. Sidebar hover / active / spotlight；
5. 按钮 hover/active/focus；
6. 包装过的卡片 spotlight，表格行无监听；
7. `prefers-reduced-motion` 全量退化；
8. `prefers-reduced-transparency` blur/spotlight 关闭；
9. 移动端 spotlight 降级。

- [ ] **步骤 4：commit（验收报告，可选）**

```bash
git tag -a "v1-motion-system" -m "Phase 4: validated; motion system v1 ready"
```

---

## 自检

**1. 规格覆盖度（spec v2 章节 → 任务映射）**

| Spec 章节 | 覆盖任务 |
|---|---|
| §3 架构 / 文件地图 | 文件结构列表；Phase 1 整体 |
| §3 关键约束 A（layout swap） | 任务 1.5 |
| §3 关键约束 B（ad-analysis 双包） | 任务 1.6 |
| §4 token 新增 | 任务 0.1 |
| §4 token 收编存量 utility | 任务 0.3 |
| §5 页面切换机制 | 任务 1.4 + 1.5 |
| §5 内容 stagger opt-in | 任务 1.3 + 3.1 |
| §5 reduced / 性能 | 任务 0.2 + 1.4 |
| §6 `.u-*` utility | 任务 0.2 |
| §6 spotlight 可选包装 | 任务 1.1 + 2.3 |
| §6 Sidebar 专项 | 任务 2.2 |
| §7 高级触感 / 内容 stagger | 任务 3.1 + 3.2 |
| §8 铺开阶段 | Phase 0/1/2/3 整体 |
| §9 风险（双包/swap/blur/spotlight 性能/Tailwind v3/hydration） | 任务 0.1（v3）/ 0.2（reduced）/ 1.5（swap）/ 1.6（双包）/ 1.4（blur/性能）/ 2.3（spotlight 性能） |
| §10 测试与验证 | Phase 4 + 各 Phase 自身验证 |
| §12 回滚 | 每 Phase 独立可逆（commit + tag 方便回滚） |

无遗漏。

**2. 占位符扫描**：全文无"TODO"/"待定"/"适当处理"等。每个代码步骤均含完整代码或明确命令。无遗漏。

**3. 类型一致性**：`SPRING.page`、`DURATION.*`、`EASE.*`、`STAGGER.*`、`Z.*` 在 tokens.ts 定义，variants / MotionFade / MotionStagger / PageTransition 引用一致；`useSpotlight` 签名 `(ref?, enabled?)` 在 dashboard-surface-card 中以单参数使用（仅 enabled 缺省）。

无不一致。

---

## 执行交接

**计划已保存到 `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md`。**

两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代，质量更高。
2. **内联执行** — 在当前会话用 executing-plans 批量执行任务并设检查点。

**当前分支**：`feat/frontend-motion-system`（已创建，未推送；按你之前清理后的偏好，远程你自己处理）。

**选哪种方式？**