/**
 * Motion design system — JS-side mirror of the CSS tokens.
 * 数值必须与 frontend/app/globals.css :root 中的 transitions.dev token 尺度一一对应。
 * 改这里必须同步改 globals.css；改 globals.css 必须同步改这里。
 *
 * **来源**：https://transitions.dev 的 `_root.css`（全量 token 块已导入 globals.css :root）。
 * 命名空间 `--duration-* / --ease-* / --distance-* / --scale-* / --blur-*` 属 transitions.dev，
 * 与项目自有的 `--shadow-* / --surface-* / --term-*` 设计 token 不混用。
 *
 * ## CSS / JS 对照表
 *
 * | JS 常量 | JS 值 | CSS token | CSS 值 |
 * |---------|-------|-----------|--------|
 * | DURATION.stagger | 0.04 | --duration-stagger | 40ms |
 * | DURATION.micro | 0.08 | --duration-micro | 80ms |
 * | DURATION.quick | 0.15 | --duration-quick | 150ms |
 * | DURATION.fast | 0.25 | --duration-fast | 250ms |
 * | DURATION.medium | 0.35 | --duration-medium | 350ms |
 * | DURATION.slow | 0.4 | --duration-slow | 400ms |
 * | DURATION.verySlow | 0.5 | --duration-very-slow | 500ms |
 * | EASE.smoothOut | [0.22, 1, 0.36, 1] | --ease-smooth-out | cubic-bezier(0.22, 1, 0.36, 1) |
 * | EASE.inOut | 'ease-in-out' | --ease-in-out | ease-in-out |
 * | EASE.out | 'ease-out' | --ease-out | ease-out |
 * | EASE.linear | 'linear' | --ease-linear | linear |
 * | EASE.bounce | [0.34, 1.36, 0.64, 1] | --ease-bounce | cubic-bezier(0.34, 1.36, 0.64, 1) |
 * | EASE.bounceStrong | [0.34, 3.85, 0.64, 1] | --ease-bounce-strong | cubic-bezier(0.34, 3.85, 0.64, 1) |
 * | DISTANCE.* | 4 / 6 / 8 / 12 / 30 | --distance-* | 4px / 6px / 8px / 12px / 30px |
 * | SCALE.* | 0.96 / 0.97 / 0.98 / 0.99 | --scale-* | 0.96 / 0.97 / 0.98 / 0.99 |
 * | BLUR.* | 2 / 3 / 8 | --blur-* | 2px / 3px / 8px |
 * | SPRING.page | { stiffness: 260, damping: 30, mass: 1 } | (无对应 CSS，仅 JS 使用) | framer-motion spring 物理 |
 * | STAGGER.step | 0.04 | --duration-stagger | 40ms |
 *
 * **单位转换**：JS 用秒（framer-motion），CSS 用毫秒（CSS animation）。ms ÷ 1000 = s。
 *
 * **修改纪律**：改这里必须同步改 globals.css，改 globals.css 必须同步改这里。
 * 改前：`cd frontend && grep -rn "DURATION\.\|EASE\.\|SPRING\.\|STAGGER\." --include="*.ts" --include="*.tsx" | grep -v test`
 * 改后：`pnpm test`（tokens.test.ts 有数值断言）+ `pnpm build`（检查 TS 类型）
 */

/** 时长（7 档，transitions.dev 的 usage 语义）。
 * 选档看「这段动效在做什么」，不看数值就近——
 * 例：modal 关闭用 quick(0.15)，即使旧实现写的是 0.3。 */
export const DURATION = {
  /** 逐项 stagger 偏移 */
  stagger: 0.04,
  /** tooltip / path delay、shake 分段 */
  micro: 0.08,
  /** modal/dropdown 关闭、text swap、tooltip 出现、hover 微状态 */
  quick: 0.15,
  /** icon swap、dropdown/modal 打开、tabs sliding、page slide、按压回弹 */
  fast: 0.25,
  /** panel 关闭、toast 关闭 */
  medium: 0.35,
  /** panel 打开、skeleton 内容揭示、输入清空 */
  slow: 0.4,
  /** 强调时刻：badge 出现、文本揭示、success check */
  verySlow: 0.5,
} as const

/** 缓动（6 档）。smoothOut 是项目主曲线（modal/dropdown/panel 开合、page slide、resize）。 */
export const EASE = {
  smoothOut: [0.22, 1, 0.36, 1] as [number, number, number, number],
  inOut: 'ease-in-out' as const,
  out: 'ease-out' as const,
  linear: 'linear' as const,
  bounce: [0.34, 1.36, 0.64, 1] as [number, number, number, number],
  bounceStrong: [0.34, 3.85, 0.64, 1] as [number, number, number, number],
} as const

/** 位移距离（px）。text swap / shake / badge / 文本揭示 / check badge 各一档。 */
export const DISTANCE = {
  micro: 4,
  small: 6,
  base: 8,
  medium: 12,
  large: 30,
} as const

/** 缩放档位：modal / dropdown / tooltip / dropdown 关闭。 */
export const SCALE = {
  large: 0.96,
  medium: 0.97,
  small: 0.98,
  tiny: 0.99,
} as const

/** 模糊档位（px）：panel/icon/text swap/skeleton、page slide/text reveal、success check。 */
export const BLUR = {
  small: 2,
  medium: 3,
  large: 8,
} as const

/** framer-motion spring 物理参数（无对应 CSS token；CSS cubic-bezier 不能表达 spring）。
 * page → 路由过渡（近临界阻尼，~0.5-0.8s 收敛，几乎无 overshoot）。 */
export const SPRING = {
  page: { type: 'spring', stiffness: 260, damping: 30, mass: 1 } as const,
} as const

/** stagger 错落节奏。单档 step，对应 --duration-stagger（40ms）。
 * v2 调研建议 3 已采纳：原 step / childDelay 同值，合并为一档。 */
export const STAGGER = {
  step: 0.04,
} as const

/** 默认 reduced-motion 关闭（运行时应通过 framer-motion 的 useReducedMotion 读系统） */
export const isReducedMotionDefault = false
