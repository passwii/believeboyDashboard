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
} as const;

export const EASE = {
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  standard: [0.16, 1, 0.3, 1] as [number, number, number, number],
  springBack: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
} as const;

export const SPRING = {
  page: { type: "spring", stiffness: 260, damping: 30, mass: 1 } as const,
  press: { type: "spring", stiffness: 380, damping: 22, mass: 0.8 } as const,
} as const;

export const STAGGER = {
  step: 0.07,
  childDelay: 0.07,
} as const;

export const Z = {
  nav: 30,
  overlay: 50,
  modal: 60,
  toast: 70,
  grain: 80,
} as const;

/** 默认 reduced-motion 关闭（运行时应通过 framer-motion 的 useReducedMotion 读系统） */
export const isReducedMotionDefault = false;