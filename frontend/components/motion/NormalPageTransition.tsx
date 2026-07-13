'use client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useEffect, useState } from 'react'
import { SPRING, DURATION, EASE } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
  pathname: string
}

/**
 * 普通 dashboard 路由的过渡 wrapper。
 * - wrapper: h-full w-full（普通页面有自然流内容，h-full 可解析）
 * - motion.div: will-change-transform h-full w-full
 * - reduced-motion / reduced-transparency 全量退化
 */
export function NormalPageTransition({ children, className, pathname }: Props) {
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

  // blur 与 spring 解耦：transform/opacity 走 GPU spring（永不掉帧），
  // filter(blur) 走短 tween —— 即便页面很重（数据加载/Suspense），
  // 主线程被占满时也只丢「模糊」细节、不会丢整体位移动效，避免「加载/卡顿时 motion 没了」。
  const transition = reduce
    ? { duration: 0 }
    : {
        ...SPRING.page,
        filter: { duration: DURATION.base, ease: EASE.out },
      }

  return (
    <div className={className ?? 'h-full w-full'}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={pathname}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          className="will-change-[transform,opacity,filter] h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
