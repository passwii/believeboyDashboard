import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownUp, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useCrmTable } from './use-crm-table'
import { CrmSearchInput } from './crm-search-input'
import type { CrmColumnDef, CrmTableProps, FilterCondition } from './types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyTableState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { TermEnumPill, TERM_SELECT_NATIVE } from '@/components/crm/term-shared'
import { cn } from '@/lib/utils'

/**
 * P5-4: 从 table.filters 反推 select 当前应显示的 value。
 * 仅匹配 op=eq 的单字段条件；'and' / 'or' 复合条件视为无单字段快捷筛选。
 * 未匹配时返回 '' （= 「全部」占位）。
 */
function _filterSelectValue(
  filters: FilterCondition[],
  field: string
): string {
  const cond = filters.find((c) => 'field' in c && c.field === field && c.op === 'eq')
  if (!cond || !('value' in cond)) return ''
  return String((cond as { field: string; op: 'eq'; value: unknown }).value)
}

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
        // BLF-837：列定义带 tone 时走终端单色 pill；否则回退旧彩色胶囊（弹窗等非终端场景）
        if (entry.tone) {
          return (
            <TermEnumPill tone={entry.tone} title={entry.label}>
              {entry.label}
            </TermEnumPill>
          )
        }
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

function PageJump({ totalPages, onJump }: { totalPages: number; onJump: (p: number) => void }) {
  const [val, setVal] = useState('')
  const commit = () => {
    const n = Number.parseInt(val, 10)
    if (Number.isFinite(n) && n >= 1 && n <= totalPages) onJump(n)
    setVal('')
  }
  return (
    <span className="ml-1 flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={totalPages}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        aria-label="跳转到页码"
        className="h-9 w-14 rounded-none border border-term-border bg-term-bg px-1 font-mono text-sm tabular-nums text-term-text focus:border-term-border-strong focus:outline-none"
        placeholder="页码"
      />
      <Button variant="outline" size="sm" onClick={commit} disabled={!val} className="rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text">
        跳
      </Button>
    </span>
  )
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
  filterFields = [],
  searchable = false,
  searchPlaceholder,
}: CrmTableProps<T>) {
  const table = useCrmTable<T>({
    queryKey,
    fetchPage,
    defaultPageSize,
  })

  // 表头快捷筛选：选中项转 FilterCondition 写入 hook 的 filters（URL 状态）；
  // hook 的 runFetch 会自动把 filters 注入 fetchPage 重新拉数。
  const handleFilterChange = (field: string, value: string) => {
    const rest = table.filters.filter((f) => !('field' in f) || f.field !== field)
    const next: FilterCondition[] = value ? [...rest, { field, op: 'eq', value }] : rest
    // P5-12: 原子 URL 写（filters + page=1 合并到一次 router.replace）
    table.setFiltersAndPage(next, 1)
  }

  // 筛选变更后重置到第 1 页。用序列化内容比较（非引用）——table.filters 是
  // useMemo(parseFilters)，任何 URL 变更（翻页/排序）都返回新数组引用，引用比较
  // 会让翻页/排序误触发重置（点下一页被弹回第 1 页）；比较 JSON 内容则只在筛选
  // 真正变化时重置。单独用 effect 而非连发 setFilters+setPage，避免闭包快照互相覆盖。
  const filtersKey = JSON.stringify(table.filters)
  const prevFiltersKeyRef = useRef(filtersKey)
  useEffect(() => {
    if (prevFiltersKeyRef.current !== filtersKey && table.page > 1) {
      table.setPage(1)
    }
    prevFiltersKeyRef.current = filtersKey
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 精确依赖 filtersKey/page/setPage
  }, [filtersKey, table.page, table.setPage])

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
        className="space-y-2 rounded-none"
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
      <ErrorState title="加载失败" message={table.error.message} onRetry={() => void table.refresh()} />
    )
  }

  const totalPages = Math.max(1, Math.ceil(table.total / table.pageSize))

  return (
    <div className="flex h-full flex-col">
      {(searchable || filterFields.length > 0) && (
        // 移动规则 2/8：手机 2 列网格内联标签；桌面 md+ 恢复横向 flex 排列（终端控件规格）
        <div className="mb-1.5 grid grid-cols-2 items-end gap-2 md:flex md:flex-wrap md:items-center md:gap-1.5">
          {searchable && (
            <div className="col-span-2 md:col-span-1">
              <CrmSearchInput
                value={table.keyword}
                onChange={table.setKeyword}
                placeholder={searchPlaceholder}
              />
            </div>
          )}
          {filterFields.map((f) => (
            <label
              key={f.key}
              className="flex flex-col gap-1 text-xs md:flex-row md:items-center md:gap-1.5"
            >
              <span className="font-mono uppercase tracking-wider text-term-muted">{f.label}</span>
              <select
                aria-label={f.label}
                className={TERM_SELECT_NATIVE}
                value={_filterSelectValue(table.filters, f.field ?? f.key)}
                onChange={(e) => handleFilterChange(f.field ?? f.key, e.target.value)}
              >
                <option value="">全部</option>
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {/* BLF-837：表格容器零圆角 + term 边界；行高密度由单元格覆盖类控制 */}
      <div className="min-h-0 flex-1 overflow-auto border border-term-border">
        <Table className="border-collapse font-mono text-xs tabular-nums [&_td]:h-9 [&_td]:border-term-border [&_td]:px-2 [&_td]:py-0 [&_td]:text-xs [&_td]:text-term-text [&_th]:h-9 [&_th]:rounded-none [&_th]:border-b [&_th]:border-term-border [&_th]:border-r-0 [&_th]:bg-term-raised [&_th]:px-2 [&_th]:py-0 [&_th]:font-mono [&_th]:text-xs [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-term-muted [&_tr:hover]:bg-term-hover [&_tr]:border-b-0 data-[state=selected]:bg-term-raised">
          <TableHeader className={STICKY_TOP_ROW}>
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
                  className={col.headerClassName}                  data-sort={
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
                      className="inline-flex items-center text-left font-mono uppercase tracking-wider hover:text-term-text"
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
              <EmptyTableState colSpan={columns.length + (selectable ? 1 : 0)} message={emptyText} />
            ) : (
              (table.data ?? []).map((row) => {
                const id = String(row[rowKey])
                const isSelected = selectedIds.includes(id)
                return (
                  <TableRow
                    key={id}
                    data-state={isSelected ? 'selected' : undefined}
                    className={cn(onRowClick && 'cursor-pointer')}                    onClick={(e) => {
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

      {table.total > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 font-mono text-xs text-term-muted">
          <div className="flex items-center gap-3">
            <span className="tabular-nums">共 {table.total} 条</span>
            <label className="flex items-center gap-1">
              每页
              <select
                aria-label="每页条数"
                value={table.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
                className={TERM_SELECT_NATIVE}
              >
                {[20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-1">
            {/* 移动规则 5：分页按钮触摸目标 ≥44px */}
            <Button variant="outline" size="sm" className="max-md:min-h-[44px] max-md:min-w-[44px] rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text" disabled={table.page <= 1} onClick={() => table.setPage(1)} aria-label="首页">
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="max-md:min-h-[44px] max-md:min-w-[44px] rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text" disabled={table.page <= 1} onClick={() => table.setPage(table.page - 1)} aria-label="上一页">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-1 tabular-nums">
              第 {table.page} / {totalPages} 页
            </span>
            <Button variant="outline" size="sm" className="max-md:min-h-[44px] max-md:min-w-[44px] rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text" disabled={table.page >= totalPages} onClick={() => table.setPage(table.page + 1)} aria-label="下一页">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="max-md:min-h-[44px] max-md:min-w-[44px] rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:text-term-text" disabled={table.page >= totalPages} onClick={() => table.setPage(totalPages)} aria-label="末页">
              <ChevronsRight className="h-4 w-4" />
            </Button>
            {totalPages > 1 && <PageJump totalPages={totalPages} onJump={table.setPage} />}
          </div>
        </div>
      )}
    </div>
  )
}
