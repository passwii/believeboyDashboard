'use client'
import { type HTMLAttributes, type ReactNode, useRef } from 'react'
import { useSpotlight } from '@/components/motion/use-spotlight'
import { cn } from '@/lib/utils'

type Props = {
  children: ReactNode
  className?: string
  /** 是否启用 spotlight（pointermove 写入 CSS 变量）；默认 true */
  spotlight?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>

/**
 * 可选 spotlight 包装：把 `.dashboard-surface` 卡片转为 client 组件，
 * 启用时通过 useSpotlight 把光标坐标写入 --spot-x/--spot-y。
 *
 * 关键约束：
 * - 不全局替换 `.dashboard-surface`（现有 92 处用法，挂 pointermove 会爆性能）。
 * - 仅在真正需要 hover 聚光感的卡片（KPI / 数据卡片）显式改用此包装。
 * - 减透明 / 粗指针下 useSpotlight 不挂监听，CSS 通过 --spotlight-strength 关闭视觉。
 */
export function DashboardSurfaceCard({
  children,
  className,
  spotlight = true,
  ...rest
}: Props) {
  // 本地持有 ref，避免 useSpotlight 内部 useRef<T | null> 与 <div ref> 的类型不兼容
  const ref = useRef<HTMLDivElement>(null)
  useSpotlight<HTMLDivElement>({ enabled: spotlight, ref })

  return (
    <div
      ref={ref}
      data-spotlight={spotlight ? '' : undefined}
      className={cn(
        'dashboard-surface u-interactive',
        // spotlight 视觉：径向高光边；减透明时通过 globals.css 降级为 0
        spotlight &&
          'before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:opacity-[calc(var(--spotlight-strength)*0.85)] before:bg-[radial-gradient(220px_circle_at_var(--spot-x)_var(--spot-y),hsl(var(--primary)/0.18),transparent_60%)] before:transition-opacity before:duration-300',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
