import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowDownUp, ArrowUp, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useCrmTable } from './use-crm-table'
import type { CrmColumnDef, CrmTableProps } from './types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

function formatCell<T>(value: unknown, row: T, column: CrmColumnDef<T>): React.ReactNode {
  if (column.render) {
    return column.render(value as T[keyof T], row)
  }
  if (value === null || value === undefined || value === '') return '-'
  switch (column.format) {
    case 'date': {
      const d = new Date(String(value))
      return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('zh-CN')
    }
    case 'datetime': {
      const d = new Date(String(value))
      return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN')
    }
    case 'currency':
      return typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value)
    case 'number':
      return typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value)
    case 'tag':
      return String(value)
    case 'enum': {
      const map = column.enumMap ?? {}
      const entry = map[String(value)]
      if (entry) {
        return (
          <span
            className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', entry.color)}
          >
            {entry.label}
          </span>
        )
      }
      return String(value)
    }
    default:
      return String(value)
  }
}

function SortIcon({ active, order }: { active: boolean; order?: 'asc' | 'desc' }) {
  if (!active) {
    return <ArrowDownUp className="ml-1 inline h-3 w-3 opacity-40" aria-hidden="true" />
  }
  if (order === 'desc') {
    return <ArrowDown className="ml-1 inline h-3 w-3" aria-hidden="true" data-testid="sort-desc" />
  }
  return <ArrowUp className="ml-1 inline h-3 w-3" aria-hidden="true" data-testid="sort-asc" />
}

export function CrmTable<T extends { id?: string | number }>({
  queryKey,
  fetchPage,
  columns,
  onRowClick,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectionChange,
  emptyText = '暂无数据',
  defaultPageSize,
  rowKey,
  refreshKey,
}: CrmTableProps<T>) {
  const table = useCrmTable<T>({
    queryKey,
    fetchPage,
    defaultPageSize,
  })

  // 外部批量操作（如移入公海）后主动刷新
  useEffect(() => {
    if (refreshKey && refreshKey > 0) {
      void table.refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const [internalSelected, setInternalSelected] = useState<string[]>([])
  const isControlled = controlledSelectedIds !== undefined
  const selectedIds = isControlled ? controlledSelectedIds : internalSelected

  const setSelectedIds = (next: string[]) => {
    if (!isControlled) setInternalSelected(next)
    onSelectionChange?.(next)
  }

  const rowIds = useMemo(
    () => (table.data ?? []).map((row) => String(row[rowKey])),
    [table.data, rowKey]
  )
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selectedIds.includes(id))
  const someSelected = rowIds.some((id) => selectedIds.includes(id))

  const toggleRow = (id: string) => {
    setSelectedIds(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
    )
  }
  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : rowIds)
  }

  // loading skeleton
  if (table.loading && (!table.data || table.data.length === 0)) {
    return (
      <div
        className="space-y-2"
        role="status"
        aria-busy="true"
        aria-label="表格加载中"
        data-testid="crm-table-skeleton"
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  // error
  if (table.error) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-6 text-center dark:border-rose-900/40 dark:bg-rose-950/30">
        <p className="text-sm text-rose-700 dark:text-rose-300">加载失败：{table.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void table.refresh()}>
          <RefreshCw className="mr-1 h-3 w-3" /> 重试
        </Button>
      </div>
    )
  }

  const totalPages = Math.max(1, Math.ceil(table.total / table.pageSize))
  const showPagination = table.total > table.pageSize

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60">
        <Table>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="全选当前页"
                    data-state={
                      allSelected ? 'checked' : someSelected ? 'indeterminate' : 'unchecked'
                    }
                  />
                </TableHead>
              )}
              {columns.map((col) => (
                <TableHead
                  key={String(col.key)}
                  style={col.width ? { width: col.width } : undefined}
                  className={col.headerClassName}
                  data-sort={
                    col.sortable
                      ? table.sortBy === col.key
                        ? (table.sortOrder ?? 'none')
                        : 'none'
                      : undefined
                  }
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center text-left text-sm font-medium hover:text-primary"
                      onClick={() => table.toggleSort(String(col.key))}
                    >
                      {col.title}
                      <SortIcon active={table.sortBy === col.key} order={table.sortOrder} />
                    </button>
                  ) : (
                    col.title
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(table.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="h-32 text-center"
                >
                  <EmptyState message={emptyText} rowHeight="lg" />
                </TableCell>
              </TableRow>
            ) : (
              (table.data ?? []).map((row) => {
                const id = String(row[rowKey])
                const isSelected = selectedIds.includes(id)
                return (
                  <TableRow
                    key={id}
                    data-state={isSelected ? 'selected' : undefined}
                    className={cn(onRowClick && 'cursor-pointer')}
                    onClick={(e) => {
                      // 避免 checkbox 点击冒泡触发 onRowClick
                      const target = e.target as HTMLElement
                      if (target.closest('[data-no-row-click]')) return
                      onRowClick?.(row)
                    }}
                  >
                    {selectable && (
                      <TableCell className="w-10" data-no-row-click>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(id)}
                          aria-label={`选择 ${id}`}
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell key={String(col.key)} className={col.className}>
                        {formatCell(row[col.key], row, col)}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {showPagination && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            共 {table.total} 条 · 第 {table.page} / {totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={table.page <= 1}
              onClick={() => table.setPage(table.page - 1)}
              aria-label="上一页"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={table.page >= totalPages}
              onClick={() => table.setPage(table.page + 1)}
              aria-label="下一页"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
