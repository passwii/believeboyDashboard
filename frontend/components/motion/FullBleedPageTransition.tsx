'use client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode } from 'react'
import { SPRING } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
  pathname: string
}

/**
 * Full-bleed absolute 路由的过渡 wrapper（当前覆盖 /dashboard/ai-chat）。
 * - wrapper: !absolute inset-0 直接填充 .dashboard-page-shell 的 containing block，
 *   绕开 h-full 百分比链路在只有 min-height 父级下解析为 0 的问题
 * - motion.div: h-full w-full，纯 GPU 合成（transform + opacity）
 *   外层 wrapper 已是 !absolute inset-0 有确定高度，此处 h-full 可正确解析。
 *   h-full 同时保证 framer-motion transform 时 motion.div 不成为 0 高度 containing block。
 * - reduced-motion 全量退化（不再用 blur，无 reduced-transparency 分支）
 *
 * 选择依据：frontend/lib/motion/routes.ts 的 FULL_BLEED_DASHBOARD_ROUTES
 */
export function FullBleedPageTransition({ children, className, pathname }: Props) {
  const reduce = useReducedMotion()

  const initial = reduce ? { opacity: 1 } : { opacity: 0, scale: 0.985, y: 6 }

  const animate = reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }
  const exit = reduce ? { opacity: 1 } : { opacity: 0, scale: 0.99, y: -4 }

  // 纯 GPU 合成：只动 transform(scale/translateY) + opacity，零逐帧重绘。
  // 早期版本用 animated filter:blur 全页重绘 + will-change:filter 巨层，是掉帧元凶，已移除。
  const transition = reduce ? { duration: 0 } : SPRING.page

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
