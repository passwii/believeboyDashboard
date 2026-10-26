/**
 * Shared table chrome for the inventory-ledger tabs: client-side pagination
 * bar + CSV export button + 列头（中文 label + 英文列名 tooltip, BLF-431）.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { DENSE_HEAD } from '@/components/ui/data-card'
import { Button } from '@/components/ui/button'
import { TableHead } from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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
      <TableHead className={cn(DENSE_HEAD, className)}>
        {label}
      </TableHead>
    )
  }
  return (
    <TableHead className={cn(DENSE_HEAD, className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help border-b border-dashed border-border/60">{label}</span>
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
    <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
      <span>
        共 {total} 条 · 第 {page + 1} / {Math.max(pageCount, 1)} 页
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 max-md:min-h-[44px] max-md:min-w-[44px]"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
          aria-label="上一页"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 max-md:min-h-[44px] max-md:min-w-[44px]"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
          aria-label="下一页"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
