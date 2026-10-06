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
 * 普通 dashboard 路由的过渡 wrapper。
 * - wrapper: h-full w-full（普通页面有自然流内容，h-full 可解析）
 * - motion.div: h-full w-full，极致轻量（opacity + 极短 translateY）
 * - reduced-motion 全量退化（不再用 blur，无 reduced-transparency 分支）
 */
export function NormalPageTransition({ children, className, pathname }: Props) {
  const reduce = useReducedMotion()

  const initial = reduce ? { opacity: 1 } : { opacity: 0, y: 8 }
  const animate = reduce ? { opacity: 1 } : { opacity: 1, y: 0 }
  const exit = reduce ? { opacity: 1 } : { opacity: 0, y: -6 }

  // 极致轻量：只动 opacity + 极短 translateY（都是合成器属性，零逐帧重绘），
  // 用 0.24s ease-out 短 tween 代替 spring —— 整页合成层存在时间缩短约 3 倍，
  // GPU 显存占用与合成次数大幅下降；不再用 scale（避免大层重栅格）。
  const transition = reduce ? { duration: 0 } : { duration: DURATION.base, ease: EASE.out }

  return (
    <div className={className ?? 'h-full w-full'}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={pathname}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          data-testid="page-transition-motion"
          className="h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
