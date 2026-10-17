'use client'

import { type ReactNode } from 'react'

import { SkeletonReveal } from '@/components/ui/skeleton-reveal'
import { useInViewOnce } from '@/lib/hooks/use-in-view-once'
import { cn } from '@/lib/utils'

export interface DeferredSectionProps {
  children: ReactNode
  /** 进入视口前渲染的占位，默认与容器等高的脉冲块 */
  fallback?: ReactNode
  /** IntersectionObserver rootMargin 提前量，默认 '320px' */
  rootMargin?: string
  /** 占位骨架高度类名，仅默认 fallback 生效，默认 'h-40' */
  fallbackHeight?: string
  className?: string
  'data-testid'?: string
}

/**
 * BEL-419 数据懒加载基座：视口懒挂载容器。
 *
 * 包裹"mount 即拉数"的自取数组件（如 DashboardAlertWidget），容器进入视口
 * （含 rootMargin 提前量）前只渲染骨架、不挂载子组件 —— 子组件的 useEffect
 * fetch 因此被推迟，削减首屏并发请求数。
 *
 * 注意：仅对"子组件自取数"有效；数据由父级取好再以 props 下发的组件请用
 * useInViewOnce 在父级延迟取数（见 app/dashboard/page.tsx Row 3 国家分布示例）。
 *
 * 动效（transitions.dev 14-skeleton-reveal）：进入视口后子组件挂载、骨架层转为已揭示态
 * （交叉淡入 + 去模糊），骨架层**不卸载**——否则没有可交叉淡出的对象。运动规格读
 * `--pulse-*` / `--reveal-*`，见 `components/ui/skeleton-reveal.tsx`。
 */
export function DeferredSection({
  children,
  fallback,
  rootMargin = '320px',
  fallbackHeight = 'h-40',
  className,
  'data-testid': testId,
}: DeferredSectionProps) {
  const { ref, inView } = useInViewOnce<HTMLDivElement>({ rootMargin })

  return (
    <div ref={ref} className={cn(className)} data-testid={testId}>
      <SkeletonReveal
        loading={!inView}
        skeleton={
          fallback ?? <div className={cn('w-full rounded-xl bg-term-raised', fallbackHeight)} />
        }
      >
        {/* 未进视口时刻意不渲染子组件，保留惰挂载（延迟子组件的 mount-fetch）语义 */}
        {inView ? children : null}
      </SkeletonReveal>
    </div>
  )
}
