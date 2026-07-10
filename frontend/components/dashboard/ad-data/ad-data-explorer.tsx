'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronRight, Download, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  AD_DATA_REPORT_TYPES,
  buildAdDataCsv,
  formatAdDataValue,
  getAdDataReportType,
  isNumericFormat,
  type AdDataColumn,
} from '@/lib/ad-data'

const API_BASE = '/api/backend'

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

async function parseError(response: Response): Promise<string> {
  const raw = await response.text()
  try {
    const payload = JSON.parse(raw) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return raw || `请求失败 (${response.status})`
  }
}

export function AdDataExplorer() {
  const searchParams = useSearchParams()

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

  const config = selectedReportType ? getAdDataReportType(selectedReportType) : undefined

  // ---- 拉取"有哪些报表类型有成功入库的数据" ----
  useEffect(() => {
    if (!projectId) return
    let active = true
    setAvailableLoading(true)
    const query = new URLSearchParams({ country })
    fetch(`${API_BASE}/api/v1/external/projects/${projectId}/ad-upload-files?${query.toString()}`, {
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseError(res))
        return (await res.json()) as UploadFileItem[]
      })
      .then((items) => {
        if (!active) return
        const types = Array.from(
          new Set(items.filter((it) => it.ingestion_status === 'success').map((it) => it.report_type)),
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
    // session 仅用于鉴权透传，无需作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, country])

  // ---- 拉取选中类型的原始行 ----
  useEffect(() => {
    if (!projectId || !selectedReportType || !config) return
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
    fetch(
      `${API_BASE}/api/v1/external/projects/${projectId}/ad-${config.endpoint}-raw?${query.toString()}`,
      { cache: 'no-store' },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseError(res))
        const payload = (await res.json()) as { data: RawRow[]; summary?: { total_rows?: number } }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, country, dateFrom, dateTo, selectedReportType])

  // ---- 搜索 + 排序 ----
  const filtered = useMemo(() => {
    if (!config) return []
    if (!search.trim()) return rows
    const q = search.trim().toLowerCase()
    return rows.filter((row) =>
      config.columns.some((col) =>
        formatAdDataValue(row[col.key], col.format).toLowerCase().includes(q),
      ),
    )
  }, [rows, search, config])

  const sorted = useMemo(() => {
    if (!config || !sort) return filtered
    const col = config.columns.find((c) => c.key === sort.key)
    if (!col) return filtered
    const numeric = isNumericFormat(col.format)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (numeric) return (Number(av) - Number(bv)) * dir
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir
    })
  }, [filtered, sort, config])

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
    const csv = buildAdDataCsv(sorted, config.columns)
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
    <div className="space-y-4">
      {/* 控制条：报表类型选择 + 搜索 + 导出 */}
      <Card className="dashboard-surface">
        <CardContent className="flex flex-col gap-3 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="space-y-1.5">
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                报表类型
              </div>
              <Select value={selectedReportType} onValueChange={(value) => setSelectedReportType(value)}>
                <SelectTrigger className="h-10 w-[15rem] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="选择报表类型" />
                </SelectTrigger>
                <SelectContent>
                  {AD_DATA_REPORT_TYPES.map((item) => {
                    const hasData = availableTypes.includes(item.reportType)
                    return (
                      <SelectItem key={item.reportType} value={item.reportType} disabled={!hasData}>
                        <span className="flex items-center gap-2">
                          {hasData ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <span className="h-3.5 w-3.5" />
                          )}
                          {item.label}
                          {!hasData ? (
                            <span className="text-xs text-muted-foreground">（暂无数据）</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                搜索
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPage(1)
                  }}
                  placeholder="按任意列内容过滤..."
                  className="h-10 w-[16rem] pl-8"
                />
              </div>
            </div>
          </div>

          <Button variant="outline" onClick={handleExport} disabled={!config || sorted.length === 0}>
            <Download className="mr-1.5 h-4 w-4" />
            导出 CSV
          </Button>
        </CardContent>
      </Card>

      {/* 状态 / 错误 / 空态 */}
      {error ? (
        <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}
      {loading ? (
        <EmptyState rowHeight="lg" message="正在加载原始数据..." />
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
          {/* 概览统计 */}
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">报表：{config.label}</Badge>
            <Badge variant="outline">服务端总行数：{totalRows.toLocaleString()}</Badge>
            <Badge variant="outline">
              当前显示：第 {pageStart + 1}-{Math.min(pageStart + pageSize, sorted.length)} / 共{' '}
              {sorted.length.toLocaleString()} 行
            </Badge>
            {totalRows > sorted.length ? (
              <Badge variant="outline" className="text-amber-600">
                仅显示前 {sorted.length.toLocaleString()} 行（已达拉取上限）
              </Badge>
            ) : null}
          </div>

          {/* 表格 */}
          <Card className="dashboard-surface overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              <Table className="min-w-full">
                <TableHeader className="sticky top-0 z-10 bg-[hsl(var(--surface-overlay))]">
                  <TableRow>
                    <TableHead className="w-10" />
                    {config.columns.map((col) => (
                      <TableHead
                        key={col.key}
                        className="cursor-pointer select-none whitespace-nowrap hover:text-foreground"
                        onClick={() => toggleSort(col.key)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sort?.key === col.key ? (
                            sort.dir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" />
                          )}
                        </span>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row, idx) => {
                    const rowId = typeof row.id === 'number' ? row.id : pageStart + idx
                    const isOpen = expanded.has(rowId)
                    return (
                      <FragmentRow
                        key={rowId}
                        row={row}
                        rowId={rowId}
                        columns={config.columns}
                        isOpen={isOpen}
                        onToggle={() => toggleExpand(rowId)}
                      />
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* 分页 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>每页</span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value))
                  setPage(1)
                }}
              >
                <SelectTrigger className="h-8 w-[5rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={String(size)}>
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
              >
                上一页
              </Button>
              <span className="text-sm text-muted-foreground">
                第 {safePage} / {totalPages} 页
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
      <TableRow className={cn('hover:bg-[hsl(var(--surface-soft))]', isOpen && 'bg-[hsl(var(--surface-soft))]')}>
        <TableCell className="p-2">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle} aria-label="展开原始数据">
            <ChevronRight className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')} />
          </Button>
        </TableCell>
        {columns.map((col) => (
          <TableCell key={col.key} className="whitespace-nowrap text-sm">
            {formatAdDataValue(row[col.key], col.format)}
          </TableCell>
        ))}
      </TableRow>
      {isOpen ? (
        <TableRow className="bg-[hsl(var(--surface-soft))]">
          <TableCell />
          <TableCell colSpan={columns.length} className="py-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              原始上传数据（raw_row，未做解析的中文列）
            </p>
            <pre className="max-h-72 overflow-auto rounded-md border border-border/70 bg-[hsl(var(--surface-strong))] p-3 text-xs leading-5">
              {JSON.stringify(row.raw_row ?? {}, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
