'use client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode } from 'react'
import { DURATION, EASE } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
  pathname: string
}

/**
 * Full-bleed absolute 路由的过渡 wrapper（当前覆盖 /dashboard/ai/chat）。
 * - wrapper: !absolute inset-0 直接填充 .dashboard-page-shell 的 containing block，
 *   绕开 h-full 百分比链路在只有 min-height 父级下解析为 0 的问题
 * - motion.div: h-full w-full，极致轻量（opacity + 极短 translateY）
 *   外层 wrapper 已是 !absolute inset-0 有确定高度，此处 h-full 可正确解析。
 *   h-full 同时保证 framer-motion transform 时 motion.div 不成为 0 高度 containing block。
 * - reduced-motion 全量退化（不再用 blur，无 reduced-transparency 分支）
 *
 * 选择依据：frontend/lib/motion/routes.ts 的 FULL_BLEED_DASHBOARD_ROUTES
 */
export function FullBleedPageTransition({ children, className, pathname }: Props) {
  const reduce = useReducedMotion()

  const initial = reduce ? { opacity: 1 } : { opacity: 0, y: 8 }
  const animate = reduce ? { opacity: 1 } : { opacity: 1, y: 0 }
  const exit = reduce ? { opacity: 1 } : { opacity: 0, y: -6 }

  // 极致轻量：只动 opacity + 极短 translateY（都是合成器属性，零逐帧重绘），
  // 用 0.24s ease-out 短 tween 代替 spring —— 整页合成层存在时间缩短约 3 倍，
  // GPU 显存占用与合成次数大幅下降；不再用 scale（避免大层重栅格）。
  const transition = reduce ? { duration: 0 } : { duration: DURATION.base, ease: EASE.out }

  return (
    <div className={className ?? '!absolute inset-0'}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={pathname}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          className="h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
