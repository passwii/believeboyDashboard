'use client'

import * as React from 'react'

import { Delta, DeltaIcon, DeltaValue } from '@/components/ui/delta'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * 统一图表卡壳（BLF-911 收口）：图标徽章 + 标题 + Delta + 描述 + 操作区 +
 * 页脚 + 加载骨架 + 空态占位，全部收敛到一处，供全站图表卡复用。
 *
 * 与 `charts/cards.tsx` 的 `*ChartCard`（纯图表本体）区分：本组件是「卡 + 表头 + 状态」，
 * 图表本体仍由 LineChartCard / BarChartCard / … 负责，作为 children 传入。
 *
 * 视觉：surface 面板风（rounded-lg + border + bg-card + 成对阴影），
 * 非 terminal 黑底。不依赖 ui/card（其基座为 term 风），自主渲染。
 */
export interface ChartCardDelta {
  value: number
  variant?: 'default' | 'badge'
}

export interface ChartCardProps {
  /** 表头左侧图标徽章内容（lucide 图标组件实例，size-4 由内部统一） */
  icon?: React.ReactNode
  /** 卡片标题 */
  title: React.ReactNode
  /** 副标题描述 */
  description?: React.ReactNode
  /** 涨跌徽章（复用 ui/delta） */
  delta?: ChartCardDelta
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

export function ChartCard({
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
  const showSkeleton = loading && !empty
  const showEmpty = empty && !loading

  return (
    <div
      className={cn(
        'flex flex-col gap-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground',
        'shadow-soft dark:border-border/70 dark:shadow-level-2',
        className
      )}
    >
      {(title != null || description != null || delta != null || actions != null) && (
        <div className="flex flex-col gap-2 p-5 pb-2">
          <div className="flex flex-wrap items-center gap-2">
            {icon != null && (
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
                {icon}
              </span>
            )}
            <h3 className="text-base font-semibold leading-none tracking-tight text-foreground">
              {title}
            </h3>
            {delta != null && (
              <Delta value={delta.value} variant={delta.variant ?? 'badge'}>
                <DeltaIcon variant="trend" />
                <DeltaValue />
              </Delta>
            )}
            {actions != null && <div className="ml-auto flex items-center gap-2">{actions}</div>}
          </div>
          {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      )}

      <div className="p-5 pt-2">
        {showSkeleton ? (
          <div className={cn(heightClass, 'w-full')} aria-busy="true" role="status">
            <Skeleton className="h-full w-full" />
          </div>
        ) : showEmpty ? (
          <div className={cn(heightClass, 'flex w-full items-center justify-center text-sm text-muted-foreground')}>
            <span>{emptyText}</span>
          </div>
        ) : (
          children
        )}
      </div>

      {footer != null && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 px-5 py-3">
          {footer}
        </div>
      )}
    </div>
  )
}
