'use client'

import * as React from 'react'

import { Delta, DeltaIcon, DeltaValue } from '@/components/ui/delta'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import type { ChartCardDelta, ChartCardProps } from './chart-card'

/**
 * TermChartCard — 首页图表卡的 terminal 壳（BLF-978 Stage 2）。
 *
 * 与 `ChartCard`（surface 面板风）同构：图标徽章 + 标题 + Delta + 描述 +
 * 操作区 + 页脚 + 加载骨架 + 空态占位。区别仅在视觉语言——
 * TermChartCard 走 TermPanel 同构壳（直角 + 1px term 边界 + 零阴影），
 * 40px 标题条（对齐 TermPanel 规范 §1；BLF-887 高度上档）。
 *
 * 仅首页 v2-* 图用本组件替换 ChartCard；其他页面（reports / display 等）
 * 继续用 ChartCard（后续迁移另开 issue）。
 */
export type { ChartCardDelta, ChartCardProps }

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
}: ChartCardProps) {
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
          {icon != null && (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-none bg-transparent text-term-accent [&_svg]:size-4">
              {icon}
            </span>
          )}
          <h3 className="truncate text-sm font-semibold uppercase tracking-wider text-term-muted">
            {title}
          </h3>
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
          <div className={cn(heightClass, 'flex w-full items-center justify-center text-sm text-term-faint')}>
            <span>{emptyText}</span>
          </div>
        ) : (
          children
        )}
      </div>

      {footer != null && (
        <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-term-border/60 px-3 py-2">
          {footer}
        </footer>
      )}
    </section>
  )
}
