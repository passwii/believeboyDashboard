'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, Clock4, FileDown, Loader2, PackageSearch } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DataCard, DataCardHeader, DataCardContent, DataTableCard, DataTableCardHeader, DataTableCardBody, DataTableCardStatBar, DENSE_CELL, DENSE_HEAD } from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { formatLocalTimestampForFilename } from '@/lib/utils'

type ExcelCell = import('exceljs').Cell

function applyBorder(cell: ExcelCell, color = 'FFE2E8F0') {
  cell.border = {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  }
}

function applyHeaderBorder(cell: ExcelCell) {
  applyBorder(cell, 'FFCBD5E1')
}

const API_BASE = '/api/backend/api/v1'

type ProjectOption = {
  id: number
  name: string
}

type InventorySummary = {
  sku_count: number
  out_of_stock_count: number
  aging_sku_count: number
  over_aged_sku_count: number
  total_available_qty: number
  total_age_0_90_qty: number
  total_age_91_180_qty: number
  total_age_181_270_qty: number
  total_age_271_365_qty: number
  total_age_365_plus_qty: number
  action_type_count: number
}

type InventoryItem = {
  project_id: number
  project_name: string
  country: string
  sku: string
  asin: string | null
  available_qty: number
  age_0_90_qty: number
  age_91_180_qty: number
  age_181_270_qty: number
  age_271_365_qty: number
  age_365_plus_qty: number
  recommended_action: string | null
  recommended_action_label: string
  stock_status: string
  aging_status: string
}

type InventoryResponse = {
  project_id: number
  project_name: string
  country: string
  snapshot_at: string | null
  summary: InventorySummary
  action_options: string[]
  items: InventoryItem[]
}

type SnapshotOption = {
  snapshot_at: string
  is_current: boolean
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatSnapshot(value: string | null): string {
  if (!value) return '暂无快照'
  // snapshot_at is a naive datetime (no timezone) representing the business date.
  // Extract the date part directly to avoid any timezone conversion.
  const datePart = String(value).split('T')[0]
  if (!datePart) return '暂无快照'
  const [year, month, day] = datePart.split('-')
  if (!year || !month || !day) return '暂无快照'
  return `${year}年${month}月${day}日`
}

function stockMeta(status: string): { label: string; className: string } {
  if (status === 'out_of_stock') {
    return {
      label: '缺货',
      className: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
    }
  }
  return {
    label: '有货',
    className: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-300',
  }
}

function stockExcelFontColor(status: string): string {
  if (status === 'out_of_stock') return 'FFBE123C'
  return 'FF15803D'
}

function agingMeta(status: string): { label: string; className: string } {
  if (status === 'over_aged') {
    return {
      label: '超龄',
      className: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
    }
  }
  if (status === 'aging') {
    return {
      label: '偏高',
      className: 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300',
    }
  }
  return {
    label: '正常',
    className: 'border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/50 dark:text-sky-300',
  }
}

function agingExcelFontColor(status: string): string {
  if (status === 'over_aged') return 'FFBE123C'
  if (status === 'aging') return 'FFB45309'
  return 'FF0369A1'
}

export default function InventoryAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState<string>('')
  const [country, setCountry] = useState('US')

  const [snapshotAt, setSnapshotAt] = useState<string | null>(null)
  const [snapshotOptions, setSnapshotOptions] = useState<SnapshotOption[]>([])
  const [selectedSnapshotDate, setSelectedSnapshotDate] = useState<string>('current')
  const [summary, setSummary] = useState<InventorySummary>({
    sku_count: 0,
    out_of_stock_count: 0,
    aging_sku_count: 0,
    over_aged_sku_count: 0,
    total_available_qty: 0,
    total_age_0_90_qty: 0,
    total_age_91_180_qty: 0,
    total_age_181_270_qty: 0,
    total_age_271_365_qty: 0,
    total_age_365_plus_qty: 0,
    action_type_count: 0,
  })
  const [rows, setRows] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  const currentProjectId = useMemo(() => {
    const parsed = Number(projectId)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [projectId])

  const detailTotals = useMemo(
    () => ({
      available_qty: summary.total_available_qty,
      age_0_90_qty: summary.total_age_0_90_qty,
      age_91_180_qty: summary.total_age_91_180_qty,
      age_181_270_qty: summary.total_age_181_270_qty,
      age_271_365_qty: summary.total_age_271_365_qty,
      age_365_plus_qty: summary.total_age_365_plus_qty,
    }),
    [summary],
  )

  useEffect(() => {
    let active = true
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        if (!projectId && payload[0]?.id) {
          setProjectId(String(payload[0].id))
        }
      } catch (loadError) {
        if (!active) return
        notify({ type: 'error', title: '项目列表加载失败', message: loadError instanceof Error ? loadError.message : '项目列表加载失败' })
      } finally {
        if (active) setProjectsLoading(false)
      }
    }
    void loadProjects()
    return () => {
      active = false
    }
  }, [notify, projectId, session])

  useEffect(() => {
    if (!currentProjectId) return
    let active = true
    async function loadData() {
      setLoading(true)
      try {
        const query = new URLSearchParams({
          project_id: String(currentProjectId),
          country,
        })
        if (selectedSnapshotDate !== 'current') {
          query.set('snapshot_at', selectedSnapshotDate)
        }
        const response = await fetch(`${API_BASE}/inventory-analysis?${query.toString()}`, {
          headers: {},
          cache: 'no-store',
        })
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { detail?: string }
          throw new Error(payload.detail || `加载失败 (${response.status})`)
        }
        const payload = (await response.json()) as InventoryResponse
        if (!active) return
        setSnapshotAt(payload.snapshot_at)
        setSummary(payload.summary)
        setRows(payload.items)
      } catch (loadError) {
        if (!active) return
        notify({ type: 'error', title: '库存分析加载失败', message: loadError instanceof Error ? loadError.message : '库存分析加载失败' })
        setRows([])
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadData()
    return () => {
      active = false
    }
  }, [notify, country, currentProjectId, selectedSnapshotDate])

  useEffect(() => {
    if (!currentProjectId) return
    let active = true
    async function loadSnapshotOptions() {
      try {
        const query = new URLSearchParams({
          project_id: String(currentProjectId),
          country,
        })
        const response = await fetch(`${API_BASE}/inventory-snapshot-options?${query.toString()}`, {
          headers: {},
          cache: 'no-store',
        })
        if (!active) return
        if (response.ok) {
          const payload = (await response.json()) as SnapshotOption[]
          setSnapshotOptions(payload)
        }
      } catch {
        // ignore error
      }
    }
    void loadSnapshotOptions()
    return () => {
      active = false
    }
  }, [country, currentProjectId])

  const exportToExcel = async () => {
    if (rows.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的库存明细数据' })
      return
    }

    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('库存分析', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 2, showGridLines: false }],
      })

      const selectedProject = projects.find((project) => String(project.id) === projectId)
      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const columns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'ASIN', key: 'asin', width: 18 },
        { header: '库存', key: 'available_qty', width: 12 },
        { header: '0-90天', key: 'age_0_90_qty', width: 12 },
        { header: '91-180天', key: 'age_91_180_qty', width: 12 },
        { header: '181-270天', key: 'age_181_270_qty', width: 12 },
        { header: '271-365天', key: 'age_271_365_qty', width: 12 },
        { header: '超过365天', key: 'age_365_plus_qty', width: 14 },
        { header: '建议操作', key: 'recommended_action_label', width: 20 },
        { header: '库存状态', key: 'stock_status', width: 12 },
        { header: '库龄状态', key: 'aging_status', width: 12 },
      ] as const

      const lastColumn = columns.length
      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = '库存分析导出'
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：导出当前项目与国家站点下的库存分析明细`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
      worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

      worksheet.mergeCells(3, 1, 3, lastColumn)
      worksheet.getCell(3, 1).value = `项目：${selectedProject?.name || '--'}    国家站点：${COUNTRY_OPTIONS.find((option) => option.value === country)?.label || country}    快照时间：${formatSnapshot(snapshotAt)}`
      worksheet.getCell(3, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF64748B' } }
      worksheet.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }

      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))

      const headerRow = worksheet.getRow(4)
      headerRow.values = columns.map((column) => column.header)
      headerRow.height = 24
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        applyHeaderBorder(cell)
      })

      rows.forEach((row, index) => {
        const stock = stockMeta(row.stock_status)
        const aging = agingMeta(row.aging_status)
        const excelRow = worksheet.getRow(index + 5)
        excelRow.values = [
          row.sku,
          row.asin || '--',
          row.available_qty,
          row.age_0_90_qty,
          row.age_91_180_qty,
          row.age_181_270_qty,
          row.age_271_365_qty,
          row.age_365_plus_qty,
          row.recommended_action_label || '--',
          stock.label,
          aging.label,
        ]

        excelRow.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber >= 3 && colNumber <= 8 ? 'right' : 'left',
            wrapText: true,
          }
          if (colNumber >= 3 && colNumber <= 8) {
            cell.numFmt = '#,##0'
          }
          if (colNumber === 10) {
            cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: stockExcelFontColor(row.stock_status) } }
          }
          if (colNumber === 11) {
            cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: agingExcelFontColor(row.aging_status) } }
          }
          applyBorder(cell)
        })
      })

      const totalRow = worksheet.getRow(rows.length + 5)
      totalRow.values = [
        '合计',
        '--',
        detailTotals.available_qty,
        detailTotals.age_0_90_qty,
        detailTotals.age_91_180_qty,
        detailTotals.age_181_270_qty,
        detailTotals.age_271_365_qty,
        detailTotals.age_365_plus_qty,
        '--',
        '--',
        '--',
      ]
      totalRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        applyHeaderBorder(cell)
        cell.alignment = {
          vertical: 'middle',
          horizontal: colNumber >= 3 && colNumber <= 8 ? 'right' : 'left',
        }
        if (colNumber >= 3 && colNumber <= 8) {
          cell.numFmt = '#,##0'
        }
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `库存分析-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'inventory_analysis.export',
        targetType: 'inventory_analysis',
        targetId: currentProjectId,
        after: {
          project_id: currentProjectId,
          project_name: projects.find((project) => project.id === currentProjectId)?.name ?? null,
          country,
          row_count: rows.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      notify({ type: 'error', title: '导出 Excel 失败', message: exportError instanceof Error ? exportError.message : '导出 Excel 失败' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <DataCard>
        <DataCardHeader
          title="库存分析"
          titleClassName="text-2xl tracking-tight"
          badge={<p className="dashboard-kicker">Analysis Console</p>}
        />
        <DataCardContent className="grid gap-4 lg:grid-cols-2">
          <div className="dashboard-toolbar grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">项目</div>
              {projectsLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                    <SelectValue placeholder="请选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={String(project.id)}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">国家站点</div>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger className="border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="请选择国家站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">快照时间</div>
              <Select value={selectedSnapshotDate} onValueChange={setSelectedSnapshotDate}>
                <SelectTrigger className="border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="选择快照时间" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">最新快照</SelectItem>
                  {snapshotOptions.map((option) => (
                    <SelectItem key={option.snapshot_at} value={option.snapshot_at}>
                      {formatSnapshot(option.snapshot_at)}
                      {option.is_current ? ' (当前)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3 rounded-md border border-border/70 bg-[linear-gradient(135deg,hsl(var(--primary)/0.08),hsl(var(--surface-subtle))/0.96)] p-3 dark:border-border/85 dark:bg-[linear-gradient(135deg,hsl(var(--surface-overlay)),hsl(var(--surface-strong))]">
              <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
                <Clock4 className="h-4 w-4" />
                当前快照时间
              </div>
              <div className="text-lg font-bold text-blue-900 dark:text-blue-100">
                {formatSnapshot(snapshotAt)}
              </div>
            </div>
          </div>
          <DataTableCardStatBar
            items={[
              { label: 'SKU 总数', value: formatInt(summary.sku_count) },
              { label: '可售库存总量', value: formatInt(summary.total_available_qty) },
              { label: '缺货 SKU', value: formatInt(summary.out_of_stock_count), highlight: summary.out_of_stock_count > 0 },
              { label: '365+ 库龄库存', value: formatInt(summary.total_age_365_plus_qty), highlight: summary.total_age_365_plus_qty > 0 },
            ]}
          />
        </DataCardContent>
      </DataCard>

      <DataTableCard>
        <DataTableCardHeader className="flex min-w-0 flex-col gap-1 px-4 py-3 xl:flex-row xl:items-center xl:justify-between xl:gap-3">
          <div>
            <p className="dashboard-kicker">Operational Ledger</p>
            <div className="text-base font-semibold text-foreground">库存明细表</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={exportToExcel}
            disabled={exporting || loading || rows.length === 0}
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            {exporting ? '导出中...' : '导出 Excel'}
          </Button>
        </DataTableCardHeader>
        <DataTableCardBody className="overflow-auto" style={{ maxHeight: '600px' }}>
          <Table noWrapperRounded>
            <TableHeader>
              <TableRow>
                <TableHead className={DENSE_HEAD}>SKU</TableHead>
                <TableHead className={DENSE_HEAD}>ASIN</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>库存</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>0-90天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>91-180天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>181-270天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>271-365天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>超过365天</TableHead>
                <TableHead className={DENSE_HEAD}>建议操作</TableHead>
                <TableHead className={DENSE_HEAD}>库存状态</TableHead>
                <TableHead className={DENSE_HEAD}>库龄状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      正在加载库存数据...
                    </span>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <EmptyTableState colSpan={11} message="当前筛选下暂无库存快照数据" />
              ) : (
                <>
                  {rows.map((row) => {
                    const stock = stockMeta(row.stock_status)
                    const aging = agingMeta(row.aging_status)
                    return (
                      <TableRow key={`${row.sku}::${row.asin || 'na'}`}>
                        <TableCell className={`font-medium ${DENSE_CELL}`}>{row.sku}</TableCell>
                        <TableCell className={DENSE_CELL}>{row.asin || '--'}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(row.available_qty)}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(row.age_0_90_qty)}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(row.age_91_180_qty)}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(row.age_181_270_qty)}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(row.age_271_365_qty)}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(row.age_365_plus_qty)}</TableCell>
                        <TableCell className={DENSE_CELL}>
                          {row.recommended_action_label || '--'}
                        </TableCell>
                        <TableCell className={DENSE_CELL}>
                          <Badge variant="outline" className={stock.className}>
                            {stock.label}
                          </Badge>
                        </TableCell>
                        <TableCell className={DENSE_CELL}>
                          <Badge variant="outline" className={aging.className}>
                            {aging.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={2} className={DENSE_CELL}>合计</TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(detailTotals.available_qty)}</TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(detailTotals.age_0_90_qty)}</TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(detailTotals.age_91_180_qty)}</TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(detailTotals.age_181_270_qty)}</TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(detailTotals.age_271_365_qty)}</TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>{formatInt(detailTotals.age_365_plus_qty)}</TableCell>
                    <TableCell colSpan={3} className={DENSE_CELL} />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}
