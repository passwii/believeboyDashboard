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
 * 普通 dashboard 路由的过渡 wrapper。
 * - wrapper: h-full w-full（普通页面有自然流内容，h-full 可解析）
 * - motion.div: h-full w-full，纯 GPU 合成（transform + opacity）
 * - reduced-motion 全量退化（不再用 blur，无 reduced-transparency 分支）
 */
export function NormalPageTransition({ children, className, pathname }: Props) {
  const reduce = useReducedMotion()

  const initial = reduce ? { opacity: 1 } : { opacity: 0, scale: 0.985, y: 6 }

  const animate = reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }
  const exit = reduce ? { opacity: 1 } : { opacity: 0, scale: 0.99, y: -4 }

  // 纯 GPU 合成：只动 transform(scale/translateY) + opacity，零逐帧重绘。
  // 早期版本用 animated filter:blur 全页重绘 + will-change:filter 巨层，是掉帧元凶，已移除；
  // 优雅的「落位感」完全由 scale+opacity 的 spring 提供，任何页面/Retina 上锁定 60fps。
  const transition = reduce ? { duration: 0 } : SPRING.page

  return (
    <div className={className ?? 'h-full w-full'}>
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
