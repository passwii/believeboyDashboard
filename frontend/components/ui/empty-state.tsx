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
      {customIcon ?? <IconComponent className="h-8 w-8 text-term-faint" strokeWidth={1.5} />}
      <p className="font-mono text-xs text-term-muted">{message}</p>
    </div>
  )

  if (colSpan !== undefined) {
    const heightClass =
      rowHeight && rowHeight in rowHeightClasses
        ? rowHeightClasses[rowHeight as keyof typeof rowHeightClasses]
        : 'h-24'

    return (
      <tr>
        <td colSpan={colSpan} className={cn('text-center text-term-muted', heightClass)}>
          {content}
        </td>
      </tr>
    )
  }

  if (chartHeight) {
    return (
      <div
        className={cn(
          // Terminal 收口（BLF-872）：零圆角 + term 虚线边框/底色
          'flex items-center justify-center rounded-none border border-dashed border-term-border bg-term-raised font-mono text-xs text-term-muted',
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
        'rounded-none border border-dashed border-term-border bg-term-raised',
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
      <td colSpan={colSpan} className={cn('h-24 text-center text-term-muted', className)}>
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
        'flex items-center justify-center rounded-none border border-dashed border-term-border bg-term-raised font-mono text-xs text-term-muted',
        height,
        className
      )}
    >
      {message}
    </div>
  )
}

export { EmptyState as default }
