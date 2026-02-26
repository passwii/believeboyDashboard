/**
 * Daily Report Page - Animation Variants
 * 销售日报页面的动画变体配置
 */

import type { Variants } from 'framer-motion'

/**
 * 获取容器变体
 */
export function getContainerVariants(shouldReduceMotion: boolean | null): Variants {
  return {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: shouldReduceMotion ? 0 : 0.08,
        delayChildren: shouldReduceMotion ? 0 : 0.05,
      },
    },
  }
}

/**
 * 获取项目变体
 */
export function getItemVariants(shouldReduceMotion: boolean | null): Variants {
  return {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        duration: shouldReduceMotion ? 0.1 : 0.3,
        ease: [0.22, 1, 0.36, 1],
      },
    },
  }
}

/**
 * 获取状态变体
 */
export function getStatusVariants(shouldReduceMotion: boolean | null): Variants {
  return {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : -8 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        duration: shouldReduceMotion ? 0.1 : 0.24,
        ease: [0.16, 1, 0.3, 1],
      },
    },
    exit: {
      opacity: 0,
      y: shouldReduceMotion ? 0 : -8,
      transition: { duration: shouldReduceMotion ? 0.08 : 0.2 },
    },
  }
}

/**
 * 获取日志项目变体
 */
export function getLogItemVariants(shouldReduceMotion: boolean | null): Variants {
  return {
    hidden: { opacity: 0, x: shouldReduceMotion ? 0 : -8 },
    show: {
      opacity: 1,
      x: 0,
      transition: {
        duration: shouldReduceMotion ? 0.1 : 0.22,
        ease: [0.16, 1, 0.3, 1],
      },
    },
    exit: { opacity: 0, x: shouldReduceMotion ? 0 : -8, transition: { duration: 0.15 } },
  }
}
