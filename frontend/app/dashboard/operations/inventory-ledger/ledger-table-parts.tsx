/**
 * Shared table chrome for the inventory-ledger tabs: client-side pagination
 * bar + CSV export button (BLF-428 前端重构).
 */

import { ChevronLeft, ChevronRight, FileDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { buildCsv, downloadCsv } from './ledger-derive'

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

export function ExportCsvButton({
  filename,
  headers,
  rows,
}: {
  filename: string
  headers: string[]
  rows: unknown[][]
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => downloadCsv(filename, buildCsv(headers, rows))}
    >
      <FileDown className="h-3.5 w-3.5" />
      导出 CSV
    </Button>
  )
}
