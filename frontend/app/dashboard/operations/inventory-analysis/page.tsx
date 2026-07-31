'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, Clock4, FileDown, Loader2, PackageSearch } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
  DENSE_CELL,
  DENSE_HEAD,
} from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { useNotifications } from '@/components/notifications'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'
import { applyBorder, applyHeaderBorder, applyRowBorder } from '@/lib/excel-styles'
import { getCountryLabel } from '@/lib/country'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { CountrySelect } from '@/components/dashboard/console'

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
  product_name: string | null
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
  shipment_quantities: Record<string, number>
}

type ShipmentColumn = {
  shipment_no: string
  label: string
  shipping_method: string | null
  forwarder_name: string | null
  etd_date: string | null
  eta_date: string | null
}

type InventoryResponse = {
  project_id: number
  project_name: string
  country: string
  report_date: string | null
  summary: InventorySummary
  action_options: string[]
  items: InventoryItem[]
  shipment_columns: ShipmentColumn[]
  shipment_column_totals: Record<string, number>
}

type SnapshotOption = {
  report_date: string
  is_current: boolean
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatBusinessDate(value: string | null): string {
  if (!value) return '暂无快照'
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
      className:
        'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
    }
  }
  return {
    label: '有货',
    className:
      'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-300',
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
      className:
        'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
    }
  }
  if (status === 'aging') {
    return {
      label: '偏高',
      className:
        'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300',
    }
  }
  return {
    label: '正常',
    className:
      'border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/50 dark:text-sky-300',
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
  // 项目 / 国家 / 报表快照日期 同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住选择。
  // reportDate 是后端响应里带回来的"数据是几号的"，属于衍生展示值，不放 URL。
  const [projectId, setProjectId] = useUrlParam<string>('project', '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useUrlParam('country', 'US', {
    allowed: ['US', 'DE', 'UK', 'ALL'],
  })
  const [reportDate, setReportDate] = useState<string | null>(null)
  const [snapshotOptions, setSnapshotOptions] = useState<SnapshotOption[]>([])
  const [selectedSnapshotDate, setSelectedSnapshotDate] = useUrlParam<string>('snapshot', 'current')
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
  const [shipmentColumns, setShipmentColumns] = useState<ShipmentColumn[]>([])
  const [shipmentColumnTotals, setShipmentColumnTotals] = useState<Record<string, number>>({})

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
    [summary]
  )

  useEffect(() => {
    let active = true
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        // 1. URL 没指定 projectId（空字符串）→ 选第一个
        // 2. URL 指定了具体项目但项目列表里找不到（用户失去权限、项目被删除）→ 回退到第一个
        // 用 payload（刚 fetch 到的），不用 projects（state 还是旧值）。
        if (payload.length > 0) {
          const existsInList = projectId && payload.some((p) => String(p.id) === projectId)
          if (!projectId || !existsInList) {
            const first = payload.find((p) => p.id !== null && p.id !== undefined)
            if (first?.id != null) setProjectId(String(first.id))
          }
        }
      } catch (loadError) {
        if (!active) return
        notify({
          type: 'error',
          title: '项目列表加载失败',
          message: loadError instanceof Error ? loadError.message : '项目列表加载失败',
        })
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
          query.set('report_date', selectedSnapshotDate)
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
        setReportDate(payload.report_date)
        setSummary(payload.summary)
        setRows(payload.items)
        setShipmentColumns(payload.shipment_columns || [])
        setShipmentColumnTotals(payload.shipment_column_totals || {})
      } catch (loadError) {
        if (!active) return
        notify({
          type: 'error',
          title: '库存分析加载失败',
          message: loadError instanceof Error ? loadError.message : '库存分析加载失败',
        })
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
        views: [{ state: 'frozen', ySplit: 4, xSplit: 3, showGridLines: false }],
      })

      const selectedProject = projects.find((project) => String(project.id) === projectId)
      const baseColumns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'ASIN', key: 'asin', width: 18 },
        { header: '品名', key: 'product_name', width: 24 },
        { header: '库存', key: 'available_qty', width: 12 },
        { header: '0-90天', key: 'age_0_90_qty', width: 12 },
        { header: '91-180天', key: 'age_91_180_qty', width: 12 },
        { header: '181-270天', key: 'age_181_270_qty', width: 12 },
        { header: '271-365天', key: 'age_271_365_qty', width: 12 },
        { header: '超过365天', key: 'age_365_plus_qty', width: 14 },
        { header: '建议操作', key: 'recommended_action_label', width: 20 },
        { header: '库存状态', key: 'stock_status', width: 12 },
        { header: '库龄状态', key: 'aging_status', width: 12 },
      ]
      const shipmentExportColumns = shipmentColumns.map((col) => ({
        header: col.label,
        key: `ship_${col.shipment_no}`,
        width: 14,
      }))
      const columns = [...baseColumns, ...shipmentExportColumns]

      const lastColumn = columns.length
      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))

      const headerRow = worksheet.getRow(1)
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
        const excelRow = worksheet.getRow(index + 2)
        excelRow.values = [
          row.sku,
          row.asin || '--',
          row.product_name || '--',
          row.available_qty,
          row.age_0_90_qty,
          row.age_91_180_qty,
          row.age_181_270_qty,
          row.age_271_365_qty,
          row.age_365_plus_qty,
          row.recommended_action_label || '--',
          stock.label,
          aging.label,
          ...shipmentColumns.map((col) => row.shipment_quantities?.[col.shipment_no] ?? ''),
        ]

        excelRow.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: (colNumber >= 4 && colNumber <= 9) || colNumber > 12 ? 'right' : 'left',
            wrapText: true,
          }
          if ((colNumber >= 4 && colNumber <= 9) || colNumber > 12) {
            cell.numFmt = '#,##0'
          }
          if (colNumber === 11) {
            cell.font = {
              name: 'Microsoft YaHei',
              bold: true,
              color: { argb: stockExcelFontColor(row.stock_status) },
            }
          }
          if (colNumber === 12) {
            cell.font = {
              name: 'Microsoft YaHei',
              bold: true,
              color: { argb: agingExcelFontColor(row.aging_status) },
            }
          }
          applyBorder(cell)
        })
      })

      const totalRow = worksheet.getRow(rows.length + 2)
      totalRow.values = [
        '合计',
        '--',
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
        ...shipmentColumns.map((col) => shipmentColumnTotals[col.shipment_no] ?? ''),
      ]
      applyRowBorder(totalRow, 1, columns.length)
      totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: (colNumber >= 4 && colNumber <= 9) || colNumber > 12 ? 'right' : 'left',
        }
        if ((colNumber >= 4 && colNumber <= 9) || colNumber > 12) {
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
      const safeProjectName = (selectedProject?.name || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      link.href = url
      link.download = `${safeProjectName}_${safeCountryLabel}-库存分析-${safeTimestamp}.xlsx`
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
      notify({
        type: 'error',
        title: '导出 Excel 失败',
        message: exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* 控制台：dashboard-surface 直接承载筛选项 + 业务日期 */}
      <div className="dashboard-surface px-4 py-4 lg:px-6 lg:py-5">
        {/* 筛选项：手机 2×2 网格无标签；桌面横向 */}
        <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-row lg:items-center lg:gap-3">
          {/* 项目 */}
          <div className="space-y-1.5 lg:space-y-1.5 lg:min-w-[140px] lg:flex-shrink-0">
            <div className="hidden lg:block text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              项目
            </div>
            {projectsLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-9 w-full border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
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
          {/* 国家站点 */}
          <div className="space-y-1.5 lg:space-y-1.5 lg:min-w-[120px] lg:flex-shrink-0">
            <div className="hidden lg:block text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              国家站点
            </div>
            <CountrySelect
              value={country}
              onChange={(value) => setCountry(value as 'US' | 'DE' | 'UK' | 'ALL')}
              triggerClassName="h-9 w-full border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]"
            />
          </div>
          {/* 业务日期 */}
          <div className="space-y-1.5 lg:space-y-1.5 lg:min-w-[140px] lg:flex-shrink-0">
            <div className="hidden lg:block text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              业务日期
            </div>
            <Select value={selectedSnapshotDate} onValueChange={setSelectedSnapshotDate}>
              <SelectTrigger className="h-9 w-full border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                <SelectValue placeholder="选择业务日期" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">最新业务日期</SelectItem>
                {snapshotOptions.map((option) => (
                  <SelectItem key={option.report_date} value={option.report_date}>
                    {formatBusinessDate(option.report_date)}
                    {option.is_current ? ' (当前)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* 当前业务日期 */}
          <div className="space-y-1.5 lg:space-y-1.5 lg:w-auto lg:min-w-[180px] lg:flex-shrink-0">
            <div className="hidden lg:block text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              当前业务日期
            </div>
            <div className="flex h-9 min-h-[44px] w-full items-center gap-2 rounded-lg border border-input bg-[linear-gradient(135deg,hsl(var(--primary)/0.08),hsl(var(--surface-subtle))/0.96)] px-3 dark:border-border/95 dark:bg-[linear-gradient(135deg,hsl(var(--surface-overlay)),hsl(var(--surface-strong))]">
              <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                <Clock4 className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">业务日期</span>
              </div>
              <div className="min-w-0 flex-1 truncate text-sm font-bold text-blue-900 dark:text-blue-100 sm:text-base">
                {formatBusinessDate(reportDate)}
              </div>
            </div>
          </div>
        </div>

        {/* 统计条：手机 2×2 网格（严格各占一行两个）；桌面横向 */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-5 sm:flex sm:flex-row sm:gap-0 lg:mt-5">
          <div className="flex w-full flex-col items-center justify-center rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/70 py-2.5 px-2 sm:flex-1 sm:border-0 sm:bg-transparent sm:py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
              SKU 总数
            </div>
            <div className="mt-0.5 text-xl font-semibold leading-tight text-foreground">
              {formatInt(summary.sku_count)}
            </div>
          </div>
          <div className="flex w-full flex-col items-center justify-center rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/70 py-2.5 px-2 sm:flex-1 sm:border-0 sm:bg-transparent sm:py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
              可售库存总量
            </div>
            <div className="mt-0.5 text-xl font-semibold leading-tight text-foreground">
              {formatInt(summary.total_available_qty)}
            </div>
          </div>
          <div className="flex w-full flex-col items-center justify-center rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/70 py-2.5 px-2 sm:flex-1 sm:border-0 sm:bg-transparent sm:py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
              缺货 SKU
            </div>
            <div
              className={cn(
                'mt-0.5 text-xl font-semibold leading-tight',
                summary.out_of_stock_count > 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-foreground'
              )}
            >
              {formatInt(summary.out_of_stock_count)}
            </div>
          </div>
          <div className="flex w-full flex-col items-center justify-center rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/70 py-2.5 px-2 sm:flex-1 sm:border-0 sm:bg-transparent sm:py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
              365+ 库龄库存
            </div>
            <div
              className={cn(
                'mt-0.5 text-xl font-semibold leading-tight',
                summary.total_age_365_plus_qty > 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-foreground'
              )}
            >
              {formatInt(summary.total_age_365_plus_qty)}
            </div>
          </div>
        </div>
      </div>

      <DataTableCard>
        <DataTableCardHeader className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div>
            <p className="dashboard-kicker">操作台账</p>
            <div className="text-base font-semibold text-foreground">库存明细表</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0 w-full sm:w-auto"
            onClick={exportToExcel}
            disabled={exporting || loading || rows.length === 0}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            {exporting ? '导出中...' : '导出 Excel'}
          </Button>
        </DataTableCardHeader>
        <DataTableCardBody className="overflow-auto" style={{ maxHeight: '600px' }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={DENSE_HEAD}>SKU</TableHead>
                <TableHead className={DENSE_HEAD}>ASIN</TableHead>
                <TableHead className={DENSE_HEAD}>品名</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>库存</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>0-90天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>91-180天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>181-270天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>271-365天</TableHead>
                <TableHead className={`text-right ${DENSE_HEAD}`}>超过365天</TableHead>
                <TableHead className={DENSE_HEAD}>建议操作</TableHead>
                <TableHead className={DENSE_HEAD}>库存状态</TableHead>
                <TableHead className={DENSE_HEAD}>库龄状态</TableHead>
                {shipmentColumns.map((col) => (
                  <TableHead
                    key={col.shipment_no}
                    className={`text-right ${DENSE_HEAD}`}
                    title={[
                      col.shipment_no,
                      col.eta_date ? `预计 ${col.eta_date.slice(5)} 到港` : '预计到港未知',
                    ].join('\n')}
                  >
                    {col.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={12 + shipmentColumns.length}
                    className="h-24 text-center text-muted-foreground"
                  >
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      正在加载库存数据...
                    </span>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <EmptyTableState
                  colSpan={12 + shipmentColumns.length}
                  message="当前筛选下暂无库存快照数据"
                />
              ) : (
                <>
                  {rows.map((row) => {
                    const stock = stockMeta(row.stock_status)
                    const aging = agingMeta(row.aging_status)
                    return (
                      <TableRow key={`${row.sku}::${row.asin || 'na'}`}>
                        <TableCell className={`font-medium ${DENSE_CELL}`}>{row.sku}</TableCell>
                        <TableCell className={DENSE_CELL}>{row.asin || '--'}</TableCell>
                        <TableCell className={DENSE_CELL}>{row.product_name || '--'}</TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>
                          {formatInt(row.available_qty)}
                        </TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>
                          {formatInt(row.age_0_90_qty)}
                        </TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>
                          {formatInt(row.age_91_180_qty)}
                        </TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>
                          {formatInt(row.age_181_270_qty)}
                        </TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>
                          {formatInt(row.age_271_365_qty)}
                        </TableCell>
                        <TableCell className={`text-right ${DENSE_CELL}`}>
                          {formatInt(row.age_365_plus_qty)}
                        </TableCell>
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
                        {shipmentColumns.map((col) => {
                          const qty = row.shipment_quantities?.[col.shipment_no]
                          return (
                            <TableCell
                              key={col.shipment_no}
                              className={`text-right tabular-nums ${DENSE_CELL}`}
                            >
                              {qty !== undefined ? formatInt(qty) : '--'}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    )
                  })}
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={3} className={DENSE_CELL}>
                      合计
                    </TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>
                      {formatInt(detailTotals.available_qty)}
                    </TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>
                      {formatInt(detailTotals.age_0_90_qty)}
                    </TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>
                      {formatInt(detailTotals.age_91_180_qty)}
                    </TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>
                      {formatInt(detailTotals.age_181_270_qty)}
                    </TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>
                      {formatInt(detailTotals.age_271_365_qty)}
                    </TableCell>
                    <TableCell className={`text-right ${DENSE_CELL}`}>
                      {formatInt(detailTotals.age_365_plus_qty)}
                    </TableCell>
                    <TableCell colSpan={3} className={DENSE_CELL} />
                    {shipmentColumns.map((col) => (
                      <TableCell
                        key={col.shipment_no}
                        className={`text-right tabular-nums ${DENSE_CELL}`}
                      >
                        {shipmentColumnTotals[col.shipment_no]
                          ? formatInt(shipmentColumnTotals[col.shipment_no])
                          : '--'}
                      </TableCell>
                    ))}
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
