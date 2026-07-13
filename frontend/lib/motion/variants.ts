import type { Variants } from 'framer-motion'
import { DURATION, EASE, SPRING, STAGGER } from './tokens'

/**
 * 页面容器（C 形态）：scale + blur + opacity，spring 物理。
 * 与 spec §5 对齐：initial scale 0.985、blur 8px、y 6；exit scale 0.99、blur 4px、y -4。
 *
 * 注：framer-motion 12 的 Variants 类型只允许 [key: string]: Variant，
 * 但运行时支持顶层 transition（作为状态级 transition 的默认值）。
 * 这里用 as Variants 走类型逃生口（runtime 行为已验证）。
 */
export function pageTransitionContainer(): Variants {
  return {
    initial: { opacity: 0, scale: 0.985, filter: 'blur(8px)', y: 6 },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)', y: 0 },
    exit: { opacity: 0, scale: 0.99, filter: 'blur(4px)', y: -4 },
    transition: SPRING.page,
  } as Variants
}

/** 通用 fade-up，opacity + y。 */
export function fadeUp(): Variants {
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE.out },
  } as Variants
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
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE.out },
  } as Variants
}

/** 按下反馈：scale 0.97。 */
export function pressTap() {
  return { whileTap: { scale: 0.97 } }
}
