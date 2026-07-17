'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
} from '@/components/ui/data-card'

// ============================================================
// Table 设计统一 · 预设层 (Design-system presets)
// 仅在现有 Table 原语之上做"加法"，不改动 table.tsx 本体，
// 因此现有的 1000+ 处用法不受影响。
// 密度/状态色均用 `!` 重要前缀覆写原语默认值（与 data-card 的 DENSE_* 一致）。
// ============================================================

export type TableDensity = 'compact' | 'cozy'

/** 表头单元格密度（覆写 TableHead 默认 h-11/px-4） */
export const densityHead: Record<TableDensity, string> = {
  compact: '!h-9 !px-3 !text-[0.66rem] !tracking-[0.14em]',
  cozy: '!h-11 !px-4 !text-[0.6875rem]',
}

/** 数据单元格密度（覆写 TableCell 默认 p-4） */
export const densityCell: Record<TableDensity, string> = {
  compact: '!px-3 !py-2 !text-[13px]',
  cozy: '!px-4 !py-3 !text-sm',
}

/** 数字列统一右对齐 + 等宽数字（财务/指标场景） */
export const numericCell = 'text-right tabular-nums font-medium'

/**
 * 数字列表头：表头默认带 `text-left`（无 !），此处用 `!text-right` 显式覆写，
 * 避免依赖 Tailwind 源码顺序（text-right 恰在 text-left 之后才生效的巧合）。
 */
export const numericHead = '!text-right tabular-nums font-medium'

// ── 状态色系统（映射到 globals.css 的 --data-* token，自动适配 dark） ──
export type TableStatus = 'success' | 'warning' | 'negative' | 'neutral' | 'info'

export const statusPillClass: Record<TableStatus, string> = {
  success:
    'bg-[hsl(var(--data-positive)/0.12)] text-[hsl(var(--data-positive))] ring-1 ring-inset ring-[hsl(var(--data-positive)/0.28)]',
  warning:
    'bg-[hsl(var(--data-warning)/0.14)] text-[hsl(var(--data-warning))] ring-1 ring-inset ring-[hsl(var(--data-warning)/0.32)]',
  negative:
    'bg-[hsl(var(--data-negative)/0.12)] text-[hsl(var(--data-negative))] ring-1 ring-inset ring-[hsl(var(--data-negative)/0.26)]',
  neutral:
    'bg-[hsl(var(--data-neutral)/0.12)] text-[hsl(var(--data-neutral))] ring-1 ring-inset ring-[hsl(var(--data-neutral)/0.26)]',
  info: 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] ring-1 ring-inset ring-[hsl(var(--primary)/0.26)]',
}

export const statusDotClass: Record<TableStatus, string> = {
  success: 'bg-[hsl(var(--data-positive))]',
  warning: 'bg-[hsl(var(--data-warning))]',
  negative: 'bg-[hsl(var(--data-negative))]',
  neutral: 'bg-[hsl(var(--data-neutral))]',
  info: 'bg-[hsl(var(--primary))]',
}

export function StatusPill({
  status,
  label,
  dot = true,
  className,
}: {
  status: TableStatus
  label: string
  dot?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold',
        statusPillClass[status],
        className
      )}
    >
      {dot && (
        <span className={cn('h-1.5 w-1.5 rounded-full', statusDotClass[status])} />
      )}
      {label}
    </span>
  )
}

// ── 统一外壳：标题条 + 工具栏槽 + 滚动体 + 底栏(分页)槽 ──
// 任何业务表都套这层，chrome 即一致。
export interface DataTableFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string
  description?: string
  /** 标题条右侧操作区（按钮 / tabs） */
  action?: React.ReactNode
  /** 表头下方工具条（筛选 / 视图列 / 搜索） */
  toolbar?: React.ReactNode
  /** 底部栏（分页 / 已选计数） */
  footer?: React.ReactNode
  /** 滚动体最大高度；设了才允许纵向滚动 + sticky 表头 */
  maxHeight?: number | string
  /** 工具栏与标题条合并（无独立标题时常用） */
  flush?: boolean
}

export function DataTableFrame({
  title,
  description,
  action,
  toolbar,
  footer,
  maxHeight,
  flush,
  className,
  children,
  ...props
}: DataTableFrameProps) {
  const hasHeader = title || description || action
  return (
    <DataTableCard className={className} {...props}>
      {hasHeader && (
        <DataTableCardHeader title={title} description={description} action={action} />
      )}
      {toolbar && (
        <div
          className={cn(
            'dashboard-toolbar border-x-0',
            flush || hasHeader ? 'border-t-0' : '',
            'border-b border-border/70'
          )}
        >
          {toolbar}
        </div>
      )}
      <DataTableCardBody>
        <div
          className={cn('w-full', maxHeight ? 'overflow-y-auto' : '', 'overflow-x-auto')}
          style={maxHeight ? { maxHeight } : undefined}
        >
          {children}
        </div>
      </DataTableCardBody>
      {footer && (
        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3 md:px-6">
          {footer}
        </div>
      )}
    </DataTableCard>
  )
}
