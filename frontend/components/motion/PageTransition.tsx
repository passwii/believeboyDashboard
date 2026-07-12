'use client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { SPRING } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
}

/**
 * 全局路由过渡（C 形态）：scale + blur + opacity + spring。
 * - AnimatePresence mode="wait" 保证旧页退场 → 新页进场串行。
 * - key=pathname 触发 key 变化时 exit/enter 动画。
 * - reduced-motion / reduced-transparency 退化（无位移无模糊无 spring）。
 */
export function PageTransition({ children, className }: Props) {
  const pathname = usePathname()
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

  // full-bleed absolute 页面（如 /dashboard/ai-chat）根节点用 !absolute inset-0 撑满父级，
  // 不参与正常流高度 — 此时 h-full 百分比链路在只有 min-height 的 .dashboard-page-shell 下解析为 0。
  // 改用 !absolute inset-0 让 wrapper 直接填充 .dashboard-page-shell 的 containing block，
  // 恢复 main 分支的视觉行为，同时保留其它普通页面的 normal-flow transition。
  const isFullBleed = pathname === '/dashboard/ai-chat'
  const wrapperClass = className ?? (isFullBleed ? '!absolute inset-0' : 'h-full w-full')

  return (
    <div className={wrapperClass}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={pathname}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          // full-bleed 页面根节点用 !absolute inset-0 撑满父级（见上）。内层 motion.div
          // 必须给 h-full w-full：它处于 normal flow，唯一子节点是绝对定位（脱离文档流），
          // 若不显式给高/宽，motion.div 会塌缩为 0 高；而 framer-motion 的 transform
          // 又让它成为绝对子节点的 containing block，最终整页撑不满 → 塌缩不可见。
          // 外层 wrapper 已是 !absolute inset-0（有确定高度），此处 h-full 可正确解析。
          className="will-change-transform h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}