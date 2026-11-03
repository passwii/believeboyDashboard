/**
 * Shared table chrome for the inventory-ledger tabs: client-side pagination
 * bar + CSV export button + 列头（中文 label + 英文列名 tooltip, BLF-431）.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { WarmIconButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { DENSE_HEAD } from '@/components/ui/data-card'
import { TableHead } from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import styles from './inventory-ledger-warm.module.css'

/**
 * 列头单元格（BLF-431）：显示中文 label，hover 时以 tooltip 显示英文列名
 * （spec 表头 "Amazon 英文列名"，如 Starting Warehouse Balance）。
 *
 * 需要外层包一个 <TooltipProvider>（见表组件用法）。
 */
export function ColumnHeader({
  label,
  tooltip,
  className,
}: {
  label: string
  /** 英文列名；缺省则无 tooltip */
  tooltip?: string
  className?: string
}) {
  if (!tooltip) {
    return (
      <TableHead className={cn(DENSE_HEAD, styles.tableColumnHeader, className)}>
        {label}
      </TableHead>
    )
  }
  return (
    <TableHead className={cn(DENSE_HEAD, styles.tableColumnHeader, className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={styles.tableColumnLabel}
            tabIndex={0}
            aria-label={`${label}，Amazon 英文列名：${tooltip}`}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    </TableHead>
  )
}

export function PaginationBar({
  page,
  pageCount,
  total,
  onPageChange,
}: {
  page: number
  pageCount: number
  total: number
  onPageChange: (next: number) => void
}) {
  if (total === 0) return null
  return (
    <div className={styles.pagination}>
      <span>
        共 {total} 条 · 第 {page + 1} / {Math.max(pageCount, 1)} 页
      </span>
      <div className="flex items-center gap-1">
        <WarmIconButton
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
          aria-label="上一页"
        >
          <ChevronLeft className="h-4 w-4" />
        </WarmIconButton>
        <WarmIconButton
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
          aria-label="下一页"
        >
          <ChevronRight className="h-4 w-4" />
        </WarmIconButton>
      </div>
    </div>
  )
}
