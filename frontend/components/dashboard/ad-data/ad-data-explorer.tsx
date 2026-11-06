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

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import {
  WarmButton,
  WarmSegmentedControl,
} from '@/components/dashboard-v2/warm-ledger/controls'
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
import styles from './ad-data-explorer.module.css'

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

const isDateCol = (col: AdDataColumn) => col.format === 'date'

const isCodeCol = (col: AdDataColumn) =>
  /(^|_)(id|asin|sku)(_|$)/i.test(col.key)

export function AdDataExplorer() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()

  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''

  const [availableTypes, setAvailableTypes] = useState<string[]>([])
  const [availableLoading, setAvailableLoading] = useState(false)
  const [availableError, setAvailableError] = useState<string | null>(null)
  const [availableRetryKey, setAvailableRetryKey] = useState(0)
  const [selectedReportType, setSelectedReportType] = useState<string>('')

  const [rowsResult, setRowsResult] = useState<{ signature: string; value: RawRow[] } | null>(null)
  const [totalRowsResult, setTotalRowsResult] = useState<{ signature: string; value: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(null)

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
  const refreshKey = useAdClientRefreshKey()
  const sessionUser = session?.user as
    | { id?: string | null; roleType?: string | null; name?: string | null }
    | undefined
  const querySignature = JSON.stringify([
    projectId,
    country,
    dateFrom,
    dateTo,
    selectedReportType,
    sessionUser?.id ?? null,
    sessionUser?.roleType ?? null,
    sessionUser?.name ?? null,
  ])
  // Refreshes keep the current signature; changing any query scope hides prior rows immediately.
  const rows = useMemo(
    () => rowsResult?.signature === querySignature ? rowsResult.value : [],
    [querySignature, rowsResult]
  )
  const totalRows = totalRowsResult?.signature === querySignature ? totalRowsResult.value : 0
  const error = errorResult?.signature === querySignature ? errorResult.message : null
  const isLoading = loading || (
    Boolean(projectId && selectedReportType && config) &&
    status !== 'loading' &&
    rowsResult?.signature !== querySignature &&
    !error
  )

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
    setAvailableError(null)
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
      .catch((lookupError) => {
        if (!active) return
        setAvailableTypes([])
        setAvailableError(
          lookupError instanceof Error && lookupError.message
            ? lookupError.message
            : '广告报表列表加载失败'
        )
      })
      .finally(() => {
        if (active) setAvailableLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, country, session, status, refreshKey, availableRetryKey])

  // ---- 拉取选中类型的原始行（BEL-421：2min 客户端缓存，切回已看过的类型 0 请求）----
  useEffect(() => {
    if (!projectId || !selectedReportType || !config) return
    if (status === 'loading') return
    let active = true
    setRowsResult((current) => current?.signature === querySignature ? current : null)
    setTotalRowsResult((current) => current?.signature === querySignature ? current : null)
    setErrorResult((current) => current?.signature === querySignature ? current : null)
    setLoading(true)
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
        setRowsResult({ signature: querySignature, value: payload.data ?? [] })
        setTotalRowsResult({
          signature: querySignature,
          value: payload.summary?.total_rows ?? payload.data?.length ?? 0,
        })
        setPage(1)
      })
      .catch((fetchError) => {
        if (!active) return
        setErrorResult({
          signature: querySignature,
          message: fetchError instanceof Error ? fetchError.message : '数据加载失败',
        })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, country, dateFrom, dateTo, selectedReportType, config, querySignature, session, status, refreshKey])

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

  if (!projectId) {
    return <AdDataEmptyState message="请先在上方选择项目。" />
  }
  if (availableLoading && availableTypes.length === 0) {
    return <AdDataEmptyState message="正在加载已上传的广告报表..." status />
  }
  if (availableError && availableTypes.length === 0) {
    return (
      <div className={cn(styles.errorBar, 'justify-between gap-3')} role="alert">
        <span>{availableError}</span>
        <WarmButton
          variant="secondary"
          onClick={() => setAvailableRetryKey((current) => current + 1)}
        >
          重试
        </WarmButton>
      </div>
    )
  }

  return (
    <div className={styles.page} data-warm-ad-data="true">
      <section
        className={styles.controls}
        data-warm-ad-data-controls="true"
        aria-label="广告数据控制"
      >
        <div className={styles.controlRow}>
          <div className={styles.field} data-testid="ad-data-report-type-control">
            <span className={styles.fieldLabel}>报表类型</span>
            <Select
              value={selectedReportType}
              onValueChange={(value) => setSelectedReportType(value)}
            >
              <SelectTrigger
                className={cn(styles.control, styles.reportSelect)}
                aria-label="报表类型"
              >
                <SelectValue placeholder="选择报表类型" />
              </SelectTrigger>
              <SelectContent className={cn('warm-ledger', styles.selectContent)}>
                {AD_DATA_REPORT_TYPES.map((item) => {
                  const hasData = availableTypes.includes(item.reportType)
                  return (
                    <SelectItem
                      key={item.reportType}
                      value={item.reportType}
                      disabled={!hasData}
                      className={styles.selectItem}
                    >
                      <span
                        className={
                          hasData ? styles.optionAvailable : styles.optionUnavailable
                        }
                      >
                        {hasData ? (
                          <Check aria-hidden />
                        ) : (
                          <span className={styles.optionPlaceholder} />
                        )}
                        <span>{item.label}</span>
                        {!hasData ? (
                          <span className={styles.optionUnavailableText}>
                            （暂无数据）
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>搜索</span>
            <div className={styles.searchWrap}>
              <Search className={styles.searchIcon} aria-hidden />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(1)
                }}
                placeholder="按任意列内容过滤..."
                aria-label="搜索广告数据"
                className={styles.searchInput}
              />
            </div>
          </div>
        </div>

        <div className={styles.viewRow}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>视图</span>
            <WarmSegmentedControl<'raw' | 'aggregate'>
              value={mode}
              options={[
                { value: 'raw', label: '原始明细' },
                { value: 'aggregate', label: '聚合' },
              ]}
              ariaLabel="数据视图"
              onChange={(value) => {
                setMode(value)
                setPage(1)
              }}
            />
          </div>
          <WarmButton
            variant="primary"
            onClick={handleExport}
            disabled={!config || sorted.length === 0}
            aria-label="导出 CSV"
          >
            <Download aria-hidden />
            导出 CSV
          </WarmButton>
        </div>
      </section>

      {error ? (
        <div className={styles.errorBar} role="alert">
          {error}
        </div>
      ) : null}
      {isLoading && rows.length > 0 ? (
        <div className={styles.refreshBar} role="status" aria-live="polite">
          正在刷新广告明细…
        </div>
      ) : null}
      {isLoading && rows.length === 0 ? (
        <div
          className={styles.skeletonStack}
          data-warm-ad-data-skeleton="true"
          aria-busy="true"
        >
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className={styles.skeletonRow} aria-hidden />
          ))}
        </div>
      ) : !config || rows.length === 0 ? (
        <AdDataEmptyState
          message={
            selectedReportType && !availableTypes.includes(selectedReportType)
              ? '该报表类型在当前项目/国家下暂无成功入库的数据。'
              : '当前筛选条件下没有广告原始数据。'
          }
        />
      ) : (
        <>
          <div className={styles.summaryBar}>
            <span className={styles.summaryText}>报表：{config.label}</span>
            {isAggregate ? (
              <span className={styles.summaryText}>
                聚合后 <span className={styles.summaryValue}>{baseRows.length.toLocaleString()}</span>{' '}
                行（合并自 <span className={styles.summaryValue}>{rows.length.toLocaleString()}</span>{' '}
                份明细）
              </span>
            ) : (
              <span className={styles.summaryText}>
                服务端总行数：
                <span className={styles.summaryValue}>{totalRows.toLocaleString()}</span>
              </span>
            )}
            <span className={styles.summaryText}>
              第{' '}
              <span className={styles.summaryValue}>
                {pageStart + 1}-{Math.min(pageStart + pageSize, sorted.length)}
              </span>{' '}
              / 共 <span className={styles.summaryValue}>{sorted.length.toLocaleString()}</span>{' '}
              行
            </span>
            {!isAggregate && totalRows > sorted.length ? (
              <span className={styles.summaryWarning}>
                仅显示前 <span className={styles.summaryValue}>{sorted.length.toLocaleString()}</span>{' '}
                行（已达拉取上限）
              </span>
            ) : null}
          </div>

          <section
            className={styles.tablePanel}
            aria-label={`${config.label}广告数据`}
          >
            <div
              className={styles.tableScroller}
              data-ad-data-table-scroll="true"
            >
              <table
                className={styles.table}
                aria-label={`${config.label}广告数据表`}
              >
                <thead>
                  <tr>
                    {!isAggregate ? (
                      <th scope="col" className={cn(styles.headCell, styles.expandCell)}>
                        <span className="sr-only">展开原始数据</span>
                      </th>
                    ) : null}
                    {displayColumns.map((col) => {
                      const activeSort = sort?.key === col.key
                      const ariaSort = activeSort
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      return (
                        <th
                          key={col.key}
                          scope="col"
                          className={styles.headCell}
                          data-numeric={isNumericCol(col) ? 'true' : undefined}
                          aria-sort={ariaSort}
                        >
                          <button
                            type="button"
                            className={styles.sortButton}
                            onClick={() => toggleSort(col.key)}
                          >
                            <span>{col.label}</span>
                            {activeSort ? (
                              sort.dir === 'asc' ? (
                                <ArrowUp className={styles.sortIcon} aria-hidden />
                              ) : (
                                <ArrowDown className={styles.sortIcon} aria-hidden />
                              )
                            ) : (
                              <ArrowUpDown className={styles.sortIcon} aria-hidden />
                            )}
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, index) => {
                    const rowId = typeof row.id === 'number' ? row.id : pageStart + index
                    if (isAggregate) {
                      return (
                        <tr key={rowId} className={styles.bodyRow}>
                          {displayColumns.map((col) => (
                            <AdDataCell key={col.key} column={col} value={row[col.key]} />
                          ))}
                        </tr>
                      )
                    }

                    return (
                      <FragmentRow
                        key={rowId}
                        row={row}
                        rowId={rowId}
                        columns={displayColumns}
                        isOpen={expanded.has(rowId)}
                        onToggle={() => toggleExpand(rowId)}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className={styles.pagination}>
            <div className={styles.pageSizeGroup}>
              <span>每页</span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value))
                  setPage(1)
                }}
              >
                <SelectTrigger
                  className={cn(styles.control, styles.pageSizeSelect)}
                  aria-label="每页行数"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={styles.selectContent}>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem
                      key={size}
                      value={String(size)}
                      className={styles.selectItem}
                    >
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>行</span>
            </div>

            <div className={styles.pagerGroup}>
              <WarmButton
                variant="secondary"
                disabled={safePage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </WarmButton>
              <span>
                第 <span className={styles.pageNumber}>{safePage}</span> /{' '}
                <span className={styles.pageNumber}>{totalPages}</span> 页
              </span>
              <WarmButton
                variant="secondary"
                disabled={safePage >= totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                下一页
              </WarmButton>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function AdDataEmptyState({
  message,
  status = false,
}: {
  message: string
  status?: boolean
}) {
  return (
    <div
      className={styles.emptyState}
      data-warm-ad-data-empty="true"
      role={status ? 'status' : undefined}
    >
      <p>{message}</p>
    </div>
  )
}

function AdDataCell({ column, value }: { column: AdDataColumn; value: unknown }) {
  return (
    <td
      className={cn(
        styles.dataCell,
        isNumericCol(column) && styles.numericCell,
        isDateCol(column) && styles.dateCell,
        isCodeCol(column) && styles.codeCell
      )}
      data-numeric={isNumericCol(column) ? 'true' : undefined}
      data-mono={isDateCol(column) || isCodeCol(column) ? 'true' : undefined}
    >
      {formatAdDataValue(value, column.format)}
    </td>
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
      <tr className={styles.bodyRow} data-expanded={isOpen ? 'true' : 'false'}>
        <td className={cn(styles.dataCell, styles.expandCell)}>
          <button
            type="button"
            aria-label="展开原始数据"
            aria-expanded={isOpen}
            onClick={onToggle}
            className={styles.expandButton}
          >
            <ChevronRight
              className={styles.expandIcon}
              data-expanded={isOpen ? 'true' : 'false'}
              aria-hidden
            />
          </button>
        </td>
        {columns.map((column) => (
          <AdDataCell key={column.key} column={column} value={row[column.key]} />
        ))}
      </tr>
      {isOpen ? (
        <tr className={styles.bodyRow} data-expanded="true">
          <td colSpan={columns.length + 1} className={styles.rawCell}>
            <span className={styles.rawLabel}>原始上传数据（raw_row，未做解析的中文列）</span>
            <pre className={styles.rawPre}>
              {JSON.stringify(row.raw_row ?? {}, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  )
}
