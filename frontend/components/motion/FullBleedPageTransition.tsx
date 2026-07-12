'use client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useEffect, useState } from 'react'
import { SPRING } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
}

/**
 * Full-bleed absolute 路由的过渡 wrapper（当前覆盖 /dashboard/ai-chat）。
 * - wrapper: !absolute inset-0 直接填充 .dashboard-page-shell 的 containing block，
 *   绕开 h-full 百分比链路在只有 min-height 父级下解析为 0 的问题
 * - motion.div: will-change-transform h-full w-full
 *   外层 wrapper 已是 !absolute inset-0 有确定高度，此处 h-full 可正确解析。
 *   h-full 同时保证 framer-motion transform 时 motion.div 不成为 0 高度 containing block。
 * - reduced-motion / reduced-transparency 全量退化
 *
 * 选择依据：frontend/lib/motion/routes.ts 的 FULL_BLEED_DASHBOARD_ROUTES
 */
export function FullBleedPageTransition({ children, className }: Props) {
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
    <div className={className ?? '!absolute inset-0'}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key="full-bleed"
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          className="will-change-transform h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
