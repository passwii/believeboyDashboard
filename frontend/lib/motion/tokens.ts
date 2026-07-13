/**
 * Motion design system — JS-side mirror of CSS tokens.
 * 数值必须与 frontend/app/globals.css :root 中的 --motion-* / --stagger-step 一一对应。
 * 改这里必须同步改 globals.css；改 globals.css 必须同步改这里。
 *
 * ## CSS / JS 对照表
 *
 * | JS 常量 | JS 值 | CSS token | CSS 值 |
 * |---------|-------|-----------|--------|
 * | DURATION.fast | 0.18 | --motion-fast | 180ms |
 * | DURATION.base | 0.24 | --motion-base | 240ms |
 * | DURATION.slow | 0.32 | --motion-slow | 320ms |
 * | DURATION.springPress | 0.22 | --motion-spring-press | 220ms cubic-bezier(0.34, 1.56, 0.64, 1) |
 * | EASE.out | [0.22, 1, 0.36, 1] | --motion-ease-out | cubic-bezier(0.22, 1, 0.36, 1) |
 * | EASE.standard | [0.16, 1, 0.3, 1] | --motion-ease-standard | cubic-bezier(0.16, 1, 0.3, 1) |
 * | SPRING.page | { stiffness: 260, damping: 30, mass: 1 } | (无对应 CSS，仅 JS 使用) | framer-motion spring 物理 |
 * | STAGGER.step | 0.07 | --stagger-step | 70ms |
 * | STAGGER.childDelay | 0.07 | (无对应 CSS，仅 JS 使用) | 与 step 同值，建议合并（v2 调研） |
 *
 * **单位转换**：JS 用秒（framer-motion），CSS 用毫秒（CSS animation）。ms ÷ 1000 = s。
 *
 * **修改纪律**：改这里必须同步改 globals.css，改 globals.css 必须同步改这里。
 * 改前：`cd frontend && grep -rn "DURATION\.\|EASE\.\|SPRING\.\|STAGGER\." --include="*.ts" --include="*.tsx" | grep -v test`
 * 改后：`pnpm test`（tokens.test.ts 有数值断言）+ `pnpm build`（检查 TS 类型）
 */

/** hover / focus 等微状态切换的上限（感知阈值 ≈ 200ms）；springPress 用 spring 物理覆盖 */
export const DURATION = {
  fast: 0.18,
  base: 0.24,
  slow: 0.32,
  springPress: 0.22,
} as const

/** cubic-bezier 数组（framer-motion ease 字段）。
 * out ≈ easeOutExpo（惯性减弱）→ 进场 / 退出；
 * standard → hover / 微状态。 */
export const EASE = {
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  standard: [0.16, 1, 0.3, 1] as [number, number, number, number],
} as const

/** framer-motion spring 物理参数（无对应 CSS token；CSS cubic-bezier 不能表达 spring）。
 * page → 路由过渡（近临界阻尼，~0.5-0.8s 收敛，几乎无 overshoot）。 */
export const SPRING = {
  page: { type: 'spring', stiffness: 260, damping: 30, mass: 1 } as const,
} as const

/** stagger 错落节奏。
 * step 对应 --stagger-step（70ms），childDelay 与 step 同值（staggerChildren 用），v2 调研建议合并。 */
export const STAGGER = {
  step: 0.07,
  childDelay: 0.07,
} as const

/** 默认 reduced-motion 关闭（运行时应通过 framer-motion 的 useReducedMotion 读系统） */
export const isReducedMotionDefault = false
