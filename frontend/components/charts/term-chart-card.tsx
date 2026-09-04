'use client'

import * as React from 'react'

import { Delta, DeltaIcon, DeltaValue } from '@/components/ui/delta'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Term 图表卡壳（BLF-979 Stage 2）：与 TermPanel 同构的直角 1px term 语言壳，
 * 供首页 v2-* 图表卡换装，对齐订单流/明细表的 terminal 黑底风格。
 *
 * 视觉：`rounded-none border-term-border bg-term-panel shadow-none`，
 * 标题条 40px（`h-10`），`text-sm uppercase tracking-wider text-term-muted`。
 *
 * 与 `charts/chart-card.tsx` 的 ChartCard props 完全兼容，仅视觉令牌替换。
 * 旧 ChartCard 保留给 reports/display 等其他消费者（BLF-976 只动首页）。
 */
export interface TermChartCardDelta {
  value: number
  variant?: 'default' | 'badge'
}

export interface TermChartCardProps {
  /** 表头左侧图标（lucide 图标组件实例，size-4 由内部统一，无胶囊底） */
  icon?: React.ReactNode
  /** 卡片标题 */
  title: React.ReactNode
  /** 副标题描述 */
  description?: React.ReactNode
  /** 涨跌徽章（复用 ui/delta） */
  delta?: TermChartCardDelta
  /** 表头右侧操作区（如 TopProjects 排序 tab） */
  actions?: React.ReactNode
  /** 页脚（CardFooter 区） */
  footer?: React.ReactNode
  /** 透传容器 className（col-span 等布局类） */
  className?: string
  /** 数据加载中 → 图表区渲染骨架（高度同 heightClass） */
  loading?: boolean
  /** 数据为空 → 图表区渲染空态占位 */
  empty?: boolean
  /** 空态文案，默认「暂无数据」 */
  emptyText?: string
  /** 图表区高度类（加载骨架 / 空态占位共用），默认与 charts defaultChartContainerClass 一致 */
  heightClass?: string
  /** 图表本体（LineChartCard / BarChartCard / …） */
  children: React.ReactNode
}

export function TermChartCard({
  icon,
  title,
  description,
  delta,
  actions,
  footer,
  className,
  loading = false,
  empty = false,
  emptyText = '暂无数据',
  heightClass = 'aspect-auto h-52 w-full md:h-64',
  children,
}: TermChartCardProps) {
  // loading 优先：调用方传 loading={pageLoading && !hasData} + empty={!hasData}，
  // 两者可同时为真（"加载中且无数据"），此时应显示骨架而非空白或空态。
  const showSkeleton = loading
  const showEmpty = !loading && empty

  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-none border border-term-border bg-term-panel shadow-none',
        className
      )}
    >
      {(title != null || description != null || delta != null || actions != null) && (
        <header className="flex h-10 shrink-0 items-center gap-2 rounded-none border-b border-term-border bg-transparent pl-2 pr-1">
          {icon != null && <span className="shrink-0 text-term-accent [&_svg]:size-4">{icon}</span>}
          <h2 className="truncate text-sm font-semibold uppercase tracking-wider text-term-muted">
            {title}
          </h2>
          {delta != null && (
            <Delta value={delta.value} variant={delta.variant ?? 'badge'}>
              <DeltaIcon variant="trend" />
              <DeltaValue />
            </Delta>
          )}
          {actions != null && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}

      <div className="min-h-0 flex-1 p-2">
        {showSkeleton ? (
          <div className={cn(heightClass, 'w-full')} aria-busy="true" role="status">
            <Skeleton className="h-full w-full" />
          </div>
        ) : showEmpty ? (
          <div className={cn(heightClass, 'flex w-full items-center justify-center text-sm text-term-muted')}>
            <span>{emptyText}</span>
          </div>
        ) : (
          children
        )}
      </div>

      {footer != null && (
        <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-term-border px-2 py-2">
          {footer}
        </footer>
      )}
    </section>
  )
}
