import * as React from 'react'
import { Database, FileQuestion, PackageOpen } from 'lucide-react'

import { cn } from '@/lib/utils'

interface EmptyStateBaseProps {
  message?: string
  icon?: 'database' | 'file' | 'package'
  customIcon?: React.ReactNode
  className?: string
}

interface EmptyStateTableProps extends EmptyStateBaseProps {
  colSpan: number
  rowHeight?: never
  chartHeight?: never
}

interface EmptyStateChartProps extends EmptyStateBaseProps {
  chartHeight?: string
  colSpan?: never
  rowHeight?: never
}

interface EmptyStateGeneralProps extends EmptyStateBaseProps {
  rowHeight?: 'sm' | 'md' | 'lg' | string
  colSpan?: never
  chartHeight?: never
}

type EmptyStateProps = EmptyStateTableProps | EmptyStateChartProps | EmptyStateGeneralProps

const icons = {
  database: Database,
  file: FileQuestion,
  package: PackageOpen,
}

const rowHeightClasses = {
  sm: 'h-16',
  md: 'h-24',
  lg: 'h-32',
}

export function EmptyState({
  message = '暂无数据',
  icon = 'database',
  customIcon,
  className,
  colSpan,
  chartHeight,
  rowHeight,
}: EmptyStateProps) {
  const IconComponent = icons[icon]

  const content = (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        colSpan ? 'py-8' : 'py-6',
        className
      )}
    >
      {customIcon ?? (
        <IconComponent className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.5} />
      )}
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )

  if (colSpan !== undefined) {
    const heightClass =
      rowHeight && rowHeight in rowHeightClasses
        ? rowHeightClasses[rowHeight as keyof typeof rowHeightClasses]
        : 'h-24'

    return (
      <tr>
        <td colSpan={colSpan} className={cn('text-center text-muted-foreground', heightClass)}>
          {content}
        </td>
      </tr>
    )
  }

  if (chartHeight) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/10 text-sm text-muted-foreground',
          chartHeight
        )}
      >
        {message}
      </div>
    )
  }

  const heightClass =
    rowHeight && rowHeight in rowHeightClasses
      ? rowHeightClasses[rowHeight as keyof typeof rowHeightClasses]
      : 'h-24'

  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-border/60 bg-muted/20',
        heightClass,
        className
      )}
    >
      {content}
    </div>
  )
}

export function EmptyTableState({
  colSpan,
  message = '暂无数据',
  className,
}: {
  colSpan: number
  message?: string
  className?: string
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn('h-24 text-center text-muted-foreground', className)}>
        {message}
      </td>
    </tr>
  )
}

export function EmptyChartState({
  message = '暂无数据',
  height = 'h-[280px]',
  className,
}: {
  message?: string
  height?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/10 text-sm text-muted-foreground',
        height,
        className
      )}
    >
      {message}
    </div>
  )
}

export { EmptyState as default }
