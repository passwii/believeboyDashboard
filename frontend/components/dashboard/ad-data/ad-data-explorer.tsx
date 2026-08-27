'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  Download,
  Search,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { TermPanel } from '@/components/terminal/term-panel'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  fetchAdRawCached,
  fetchAdUploadFilesCached,
} from '@/lib/ad-client-cache'
import {
  AD_DATA_REPORT_TYPES,
  aggregateAdDataRows,
  buildAdDataCsv,
  formatAdDataValue,
  getAdDataReportType,
  getAggregateColumns,
  isNumericFormat,
  type AdDataColumn,
  type AdDataReportType,
} from '@/lib/ad-data'

type RawRow = Record<string, unknown> & {
  id?: number
  raw_row?: Record<string, unknown>
}

type UploadFileItem = {
  report_type: string
  ingestion_status: string
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500]

/** 数值列（int/money/percent/ratio）→ 等宽右对齐 */
const isNumericCol = (col: AdDataColumn) =>
  col.format === 'int' || col.format === 'money' || col.format === 'percent' || col.format === 'ratio'

export function AdDataExplorer() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()

  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''

  const [availableTypes, setAvailableTypes] = useState<string[]>([])
  const [availableLoading, setAvailableLoading] = useState(false)
  const [selectedReportType, setSelectedReportType] = useState<string>('')

  const [rows, setRows] = useState<RawRow[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [mode, setMode] = useState<'raw' | 'aggregate'>('raw')

  const config: AdDataReportType | undefined = selectedReportType
    ? getAdDataReportType(selectedReportType)
    : undefined

  const isAggregate = mode === 'aggregate'

  // 每个分组合并了多少份明细（用于"合并份数"列；与 lib 内部 composite key 一致）
  const groupCounts = useMemo(() => {
    const map = new Map<string, number>()
    if (!config) return map
    for (const r of rows) {
      const gk = config.groupBy.map((k) => String(r[k] ?? '')).join(' ')
      map.set(gk, (map.get(gk) ?? 0) + 1)
    }
    return map
  }, [rows, config])

  const baseRows: RawRow[] = useMemo(() => {
    if (!config || !isAggregate) return rows
    const agg = aggregateAdDataRows(rows, config)
    return agg.map((r) => {
      const gk = config.groupBy.map((k) => String(r[k] ?? '')).join(' ')
      return { ...r, __agg_count: groupCounts.get(gk) ?? 0 }
    })
  }, [rows, config, isAggregate, groupCounts])

  const displayColumns: AdDataColumn[] = useMemo(
    () =>
      isAggregate && config
        ? [{ key: '__agg_count', label: '合并份数', format: 'int' }, ...getAggregateColumns(config)]
        : (config?.columns ?? []),
    [isAggregate, config]
  )

  // ---- 拉取"有哪些报表类型有成功入库的数据"（BEL-421：2min 客户端缓存）----
  useEffect(() => {
    if (!projectId) return
    // 缓存键按用户域隔离，等 session 就绪再取数，避免 unknown 域双请求
    if (status === 'loading') return
    let active = true
    setAvailableLoading(true)
    fetchAdUploadFilesCached<UploadFileItem[]>(projectId, country, session)
      .then((items) => {
        if (!active) return
        const types = Array.from(
          new Set(
            items.filter((it) => it.ingestion_status === 'success').map((it) => it.report_type)
          )
        )
        setAvailableTypes(types)
        // 默认选中第一个有数据的类型（若当前未选或所选无数据）
        setSelectedReportType((prev) => {
          if (prev && types.includes(prev)) return prev
          return types[0] || ''
        })
      })
      .catch(() => {
        if (!active) return
        setAvailableTypes([])
      })
      .finally(() => {
        if (active) setAvailableLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, country, session, status])

  // ---- 拉取选中类型的原始行（BEL-421：2min 客户端缓存，切回已看过的类型 0 请求）----
  useEffect(() => {
    if (!projectId || !selectedReportType || !config) return
    if (status === 'loading') return
    let active = true
    setLoading(true)
    setError(null)
    const query = new URLSearchParams({
      period: 'custom',
      country,
      limit: '10000',
      start_date: dateFrom || '2000-01-01',
      end_date: dateTo || '2100-12-31',
    })
    fetchAdRawCached<{ data: RawRow[]; summary?: { total_rows?: number } }>(
      projectId,
      config.endpoint,
      query,
      session
    )
      .then((payload) => {
        if (!active) return
        setRows(payload.data ?? [])
        setTotalRows(payload.summary?.total_rows ?? payload.data?.length ?? 0)
        setPage(1)
      })
      .catch((fetchError) => {
        if (!active) return
        setError(fetchError instanceof Error ? fetchError.message : '数据加载失败')
        setRows([])
        setTotalRows(0)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, country, dateFrom, dateTo, selectedReportType, config, session, status])

  // ---- 搜索 + 排序 ----
  const filtered = useMemo(() => {
    if (!displayColumns.length) return []
    if (!search.trim()) return baseRows
    const q = search.trim().toLowerCase()
    return baseRows.filter((row) =>
      displayColumns.some((col) =>
        formatAdDataValue(row[col.key], col.format).toLowerCase().includes(q)
      )
    )
  }, [baseRows, search, displayColumns])

  const sorted = useMemo(() => {
    if (!displayColumns.length || !sort) return filtered
    const col = displayColumns.find((c) => c.key === sort.key)
    if (!col) return filtered
    const numeric = isNumericFormat(col.format)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (numeric) return (Number(av) - Number(bv)) * dir
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir
    })
  }, [filtered, sort, displayColumns])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * pageSize
  const pageRows = sorted.slice(pageStart, pageStart + pageSize)

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      return { key, dir: 'asc' }
    })
  }

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleExport = () => {
    if (!config || sorted.length === 0) return
    const csv = buildAdDataCsv(sorted, displayColumns)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ad-data-${selectedReportType}-${dateFrom || 'all'}-${dateTo || 'all'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!projectId) return <EmptyState rowHeight="lg" message="请先在上方选择项目。" />
  if (availableLoading && availableTypes.length === 0)
    return <EmptyState rowHeight="lg" message="正在加载已上传的广告报表..." />

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* 控制条：报表类型选择 + 搜索 + 视图切换 + 导出（终端工具栏规格） */}
      <div className="flex flex-col gap-3 border border-term-border bg-term-panel p-2 lg:flex-row lg:items-end lg:justify-between">
        {/* BLF-611：手机端字段全宽单列（sm 起 2 列），lg+ 恢复横向 + 固定宽，桌面零回归 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center lg:gap-3">
          <div className="space-y-1.5">
            <div className="font-mono text-xs uppercase tracking-wider text-term-muted">
              报表类型
            </div>
            <Select
              value={selectedReportType}
              onValueChange={(value) => setSelectedReportType(value)}
            >
              <SelectTrigger className="h-8 w-full border-term-border bg-term-bg text-sm shadow-none lg:w-[15rem]">
                <SelectValue placeholder="选择报表类型" />
              </SelectTrigger>
              <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                {AD_DATA_REPORT_TYPES.map((item) => {
                  const hasData = availableTypes.includes(item.reportType)
                  return (
                    <SelectItem
                      key={item.reportType}
                      value={item.reportType}
                      disabled={!hasData}
                      className="rounded-none text-sm focus:bg-term-hover focus:text-term-text"
                    >
                      <span className="flex items-center gap-2">
                        {hasData ? (
                          <Check className="h-3.5 w-3.5 text-term-pos" strokeWidth={1.75} />
                        ) : (
                          <span className="h-3.5 w-3.5" />
                        )}
                        {item.label}
                        {!hasData ? (
                          <span className="text-xs text-term-faint">（暂无数据）</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="font-mono text-xs uppercase tracking-wider text-term-muted">
              搜索
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-term-faint" strokeWidth={1.75} />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                placeholder="按任意列内容过滤..."
                className="h-8 w-full rounded-none border-term-border bg-term-bg pl-8 text-sm shadow-none focus-visible:ring-0 lg:w-[16rem]"
              />
            </div>
          </div>
        </div>

        {/* BLF-611：手机端视图切换与导出同行各占一半；lg 用 lg:contents 拆回行内联排，桌面零回归 */}
        <div className="flex items-end gap-2 lg:contents">
          <div className="flex-1 space-y-1.5 lg:flex-none">
            <div className="font-mono text-xs uppercase tracking-wider text-term-muted">
              视图
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant={mode === 'raw' ? 'default' : 'outline'}
                size="sm"
                className={cn(
                  'h-8 flex-1 rounded-none border-term-border px-2 text-xs shadow-none lg:flex-none',
                  mode !== 'raw' && 'bg-transparent text-term-muted hover:bg-term-hover hover:text-term-text'
                )}
                onClick={() => {
                  setMode('raw')
                  setPage(1)
                }}
              >
                原始明细
              </Button>
              <Button
                variant={mode === 'aggregate' ? 'default' : 'outline'}
                size="sm"
                className={cn(
                  'h-8 flex-1 rounded-none border-term-border px-2 text-xs shadow-none lg:flex-none',
                  mode !== 'aggregate' && 'bg-transparent text-term-muted hover:bg-term-hover hover:text-term-text'
                )}
                onClick={() => {
                  setMode('aggregate')
                  setPage(1)
                }}
              >
                聚合
              </Button>
            </div>
          </div>

          <Button
            variant="outline"
            className="h-8 flex-1 gap-1.5 rounded-none border-term-border bg-transparent px-2 text-xs text-term-muted shadow-none hover:bg-term-hover hover:text-term-text lg:flex-none"
            onClick={handleExport}
            disabled={!config || sorted.length === 0}
          >
            <Download className="h-[18px] w-[18px]" strokeWidth={1.75} />
            导出 CSV
          </Button>
        </div>
      </div>

      {/* 状态 / 错误 / 空态（term 色系） */}
      {error ? (
        <div
          role="alert"
          className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          ERR · {error}
        </div>
      ) : null}
      {loading ? (
        <div className="space-y-px border border-term-border bg-term-panel p-px">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-none" />
          ))}
        </div>
      ) : !config || rows.length === 0 ? (
        <EmptyState
          rowHeight="lg"
          message={
            selectedReportType && !availableTypes.includes(selectedReportType)
              ? '该报表类型在当前项目/国家下暂无成功入库的数据。'
              : '当前筛选条件下没有广告原始数据。'
          }
        />
      ) : (
        <>
          {/* 概览统计：mono 行内元信息（替代 Badge 胶囊） */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-term-muted">
            <span>报表：{config.label}</span>
            {isAggregate ? (
              <span>
                聚合后 {baseRows.length.toLocaleString()} 行（合并自{' '}
                {rows.length.toLocaleString()} 份明细）
              </span>
            ) : (
              <span>服务端总行数：{totalRows.toLocaleString()}</span>
            )}
            <span className="text-term-text">
              第 {pageStart + 1}-{Math.min(pageStart + pageSize, sorted.length)} / 共{' '}
              {sorted.length.toLocaleString()} 行
            </span>
            {!isAggregate && totalRows > sorted.length ? (
              <span className="text-term-warn">
                仅显示前 {sorted.length.toLocaleString()} 行（已达拉取上限）
              </span>
            ) : null}
          </div>

          {/* 表格：TermPanel + TermTable，表头 sticky，滚动收口在面板内 */}
          <TermPanel bodyClassName="min-h-0 overflow-hidden">
            <div className="max-h-[calc(100vh-360px)] min-h-[240px] overflow-auto term-scroll">
              <TermTable className="min-w-full">
                <TermTHead>
                  <TermRow className="hover:bg-transparent">
                    {!isAggregate ? (
                      <TermHead className="w-10" title="" />
                    ) : null}
                    {displayColumns.map((col) => (
                      <TermHead
                        key={col.key}
                        numeric={isNumericCol(col)}
                        onClick={() => toggleSort(col.key)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sort?.key === col.key ? (
                            sort.dir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" strokeWidth={1.75} />
                            ) : (
                              <ArrowDown className="h-3 w-3" strokeWidth={1.75} />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" strokeWidth={1.75} />
                          )}
                        </span>
                      </TermHead>
                    ))}
                  </TermRow>
                </TermTHead>
                <TermBody>
                  {pageRows.map((row, idx) => {
                    const rowId = typeof row.id === 'number' ? row.id : pageStart + idx
                    if (isAggregate) {
                      return (
                        <TermRow key={rowId}>
                          {displayColumns.map((col) => (
                            <TermCell key={col.key} numeric={isNumericCol(col)}>
                              {formatAdDataValue(row[col.key], col.format)}
                            </TermCell>
                          ))}
                        </TermRow>
                      )
                    }
                    const isOpen = expanded.has(rowId)
                    return (
                      <FragmentRow
                        key={rowId}
                        row={row}
                        rowId={rowId}
                        columns={displayColumns}
                        isOpen={isOpen}
                        onToggle={() => toggleExpand(rowId)}
                      />
                    )
                  })}
                </TermBody>
              </TermTable>
            </div>
          </TermPanel>

          {/* 分页：终端工具条规格 */}
          <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs tabular-nums text-term-muted">
            <div className="flex items-center gap-2">
              <span>每页</span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value))
                  setPage(1)
                }}
              >
                <SelectTrigger className="h-8 w-[5rem] rounded-none border-term-border bg-term-panel text-xs shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem
                      key={size}
                      value={String(size)}
                      className="rounded-none text-sm focus:bg-term-hover focus:text-term-text"
                    >
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>行</span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="h-7 rounded-none border-term-border bg-transparent px-2 text-xs text-term-muted shadow-none hover:bg-term-hover hover:text-term-text"
              >
                上一页
              </Button>
              <span className="text-term-text">
                第 {safePage} / {totalPages} 页
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="h-7 rounded-none border-term-border bg-transparent px-2 text-xs text-term-muted shadow-none hover:bg-term-hover hover:text-term-text"
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FragmentRow({
  row,
  rowId,
  columns,
  isOpen,
  onToggle,
}: {
  row: RawRow
  rowId: number
  columns: AdDataColumn[]
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <>
      <TermRow highlight={isOpen}>
        <TermCell className="w-10 px-1">
          <button
            type="button"
            aria-label="展开原始数据"
            onClick={onToggle}
            className="flex h-6 w-6 items-center justify-center text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
          >
            <ChevronRight
              className={cn('h-[18px] w-[18px] transition-transform', isOpen && 'rotate-90')}
              strokeWidth={1.75}
            />
          </button>
        </TermCell>
        {columns.map((col) => (
          <TermCell key={col.key} numeric={isNumericCol(col)}>
            {formatAdDataValue(row[col.key], col.format)}
          </TermCell>
        ))}
      </TermRow>
      {isOpen ? (
        <TermRow highlight className="hover:bg-term-raised">
          <TermCell />
          <TermCell colSpan={columns.length}>
            <p className="mb-1 font-mono text-xs uppercase tracking-wider text-term-faint">
              原始上传数据（raw_row，未做解析的中文列）
            </p>
            <pre className="max-h-72 overflow-auto term-scroll border border-term-border bg-term-bg p-2 font-mono text-xs leading-5 text-term-text">
              {JSON.stringify(row.raw_row ?? {}, null, 2)}
            </pre>
          </TermCell>
        </TermRow>
      ) : null}
    </>
  )
}
