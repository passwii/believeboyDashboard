'use client'
import { usePathname } from 'next/navigation'
import { type ReactNode } from 'react'
import { isFullBleedDashboardRoute } from '@/lib/motion/routes'
import { FullBleedPageTransition } from './FullBleedPageTransition'
import { NormalPageTransition } from './NormalPageTransition'

type Props = {
  children: ReactNode
  className?: string
}

/**
 * 全局路由过渡 dispatcher：根据 pathname 自动选 Normal 或 FullBleed 变体。
 * - 普通 dashboard 路由：NormalPageTransition（h-full w-full wrapper + motion.div）
 * - full-bleed 路由（如 /dashboard/ai/chat）：FullBleedPageTransition（!absolute inset-0 wrapper）
 *
 * 路由清单维护在 frontend/lib/motion/routes.ts 的 FULL_BLEED_DASHBOARD_ROUTES。
 * 新增 full-bleed 页面只需在数组追加，不需改本组件。
 */
export function PageTransition({ children, className }: Props) {
  const pathname = usePathname()
  const Component = isFullBleedDashboardRoute(pathname)
    ? FullBleedPageTransition
    : NormalPageTransition
  // pathname 传给变体：motion.div 用 key={pathname} 触发 AnimatePresence exit/enter
  return (
    <Component className={className} pathname={pathname}>
      {children}
    </Component>
  )
}
