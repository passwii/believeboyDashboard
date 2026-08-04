'use client'

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { FileDown, RefreshCw, Table2, TrendingDown, TrendingUp } from 'lucide-react'
import { useSession } from 'next-auth/react'
import type { DateRange } from 'react-day-picker'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  STICKY_LEFT_HEAD_CELL,
  STICKY_LEFT_CELL_HOVER,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useNotifications } from '@/components/notifications'
import { formatLocalTimestampForFilename, cn } from '@/lib/utils'
import { applyBorder, applyHeaderBorder, applyRowBorder } from '@/lib/excel-styles'
import { getCountryLabel } from '@/lib/country'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { CountrySelect } from '@/components/dashboard/console'
import {
  COUNTRY_TIMEZONE_MAP,
  DateRangePicker,
  getTodayInTimezone,
} from '@/components/ui/date-picker'

const API_BASE = '/api/backend'

type ProjectOption = { id: number; name: string }

type SeasonalRow = {
  project_id: number
  project_name: string
  sku: string
  country: string
  asin: string | null
  product_name: string | null
  available_inventory: number
  in_transit_quantity: number
  dms_90: number | null
  dms_30: number | null
  dms_14: number | null
  dms_7: number | null
  dms_90_yoy: number | null
  dms_30_yoy: number | null
  dms_14_yoy: number | null
  dms_7_yoy: number | null
  base_dms: number | null
  weighted_dms: number | null
  sellable_days: number | null
  sellout_date: string | null
  sellout_date_with_transit: string | null
  production_lead_days: number
  shipping_days: number
  estimated_replenishment_quantity: number | null
}

type Summary = {
  sku_count: number
  out_of_stock_risk_count: number
  healthy_count: number
  slow_moving_count: number
  pending_data_count: number
  total_available_inventory: number
  total_in_transit_quantity: number
}

type SeasonalResponse = {
  items: SeasonalRow[]
  summary: Summary
  page: number
  page_size: number
  total: number
  has_next: boolean
  from_date: string
  to_date: string
  compare_year_offset: number
}

function rowKey(row: Pick<SeasonalRow, 'sku' | 'country'>): string {
  return `${row.sku}::${row.country}`
}

const EMPTY_SUMMARY: Summary = {
  sku_count: 0,
  out_of_stock_risk_count: 0,
  healthy_count: 0,
  slow_moving_count: 0,
  pending_data_count: 0,
  total_available_inventory: 0,
  total_in_transit_quantity: 0,
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '--'
  return value.toFixed(digits)
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatDate(value: string | null | undefined): string {
  return value || '--'
}

/** 同比单元格颜色：当前 < 去年 → 红；当前 > 去年 → 绿；相等/缺失 → 中性 */
function yoyDeltaClass(current: number | null, yoy: number | null): string {
  if (current === null || yoy === null) return 'text-muted-foreground'
  if (yoy === 0) return 'text-foreground'
  if (current < yoy) return 'text-rose-600 dark:text-rose-300'
  if (current > yoy) return 'text-emerald-600 dark:text-emerald-300'
  return 'text-foreground'
}

function YoySymbol({ current, yoy }: { current: number | null; yoy: number | null }) {
  if (current === null || yoy === null || yoy === 0) return null
  if (current < yoy) return <TrendingDown className="inline h-3 w-3" />
  if (current > yoy) return <TrendingUp className="inline h-3 w-3" />
  return null
}

function formatIsoDate(value: Date | undefined): string | null {
  if (!value) return null
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseIsoDate(value: string | null): Date | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}

function toStrMinusYear(toDate: Date): string {
  const d = new Date(toDate)
  d.setFullYear(d.getFullYear() - 1)
  return formatIsoDate(d) ?? ''
}

export default function SeasonalReplenishmentPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  // 项目 / 国家 / 同比 / 关键字 同步到 URL search param。
  // dateRange 暂时保留为本地 state（初始值仍从 URL ?from/?to 读，但用户改 picker 不写回 URL —— 与原行为一致）。
  const [projectId, setProjectId] = useUrlParam<string>('project', '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useUrlParam('country', 'US', {
    allowed: ['US', 'DE', 'UK', 'ALL'],
  })

  // 时间范围：默认 [今天 - 90 天, 今天]（B1 决定）
  const todayInTz = useMemo(() => {
    const tz = COUNTRY_TIMEZONE_MAP[country] || 'America/Los_Angeles'
    return getTodayInTimezone(tz)
  }, [country])
  const defaultFromDate = useMemo(() => {
    const d = new Date(todayInTz)
    d.setDate(d.getDate() - 89) // 90 天窗口，左端 = today - 89
    return d
  }, [todayInTz])

  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    // 仅从 URL 初始化一次，后续 picker 修改不再写回 URL（保持与重构前的语义一致）。
    if (typeof window === 'undefined') return { from: defaultFromDate, to: todayInTz }
    const params = new URLSearchParams(window.location.search)
    const fromParam = params.get('from')
    const toParam = params.get('to')
    if (fromParam && toParam) {
      const from = parseIsoDate(fromParam)
      const to = parseIsoDate(toParam)
      if (from && to) return { from, to }
    }
    return { from: defaultFromDate, to: todayInTz }
  })

  const [compareYearRaw, setCompareYearRaw] = useUrlParam<string>('compare', '')
  const compareYear = compareYearRaw === '1'
  const setCompareYear = (v: boolean) => setCompareYearRaw(v ? '1' : '')

  const [keyword, setKeyword] = useUrlParam<string>('keyword', '')
  const deferredKeyword = useDeferredValue(keyword)

  const [rows, setRows] = useState<SeasonalRow[]>([])
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // BEL-423："刷新重算"后的下一次加载跳过客户端缓存（拿后端最新重算结果）。
  const forceNextLoadRef = useRef(false)

  const currentProjectId = useMemo(() => {
    const parsed = Number(projectId)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [projectId])

  const fromDate = dateRange?.from
  const toDate = dateRange?.to
  const compareYearOffset = compareYear ? 1 : 0

  const tableTotals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          available_inventory: acc.available_inventory + (row.available_inventory ?? 0),
          in_transit_quantity: acc.in_transit_quantity + (row.in_transit_quantity ?? 0),
          dms_90: acc.dms_90 + (row.dms_90 ?? 0),
          dms_30: acc.dms_30 + (row.dms_30 ?? 0),
          dms_14: acc.dms_14 + (row.dms_14 ?? 0),
          dms_7: acc.dms_7 + (row.dms_7 ?? 0),
          dms_90_yoy: acc.dms_90_yoy + (row.dms_90_yoy ?? 0),
          dms_30_yoy: acc.dms_30_yoy + (row.dms_30_yoy ?? 0),
          dms_14_yoy: acc.dms_14_yoy + (row.dms_14_yoy ?? 0),
          dms_7_yoy: acc.dms_7_yoy + (row.dms_7_yoy ?? 0),
          base_dms: acc.base_dms + (row.base_dms ?? 0),
          weighted_dms: acc.weighted_dms + (row.weighted_dms ?? 0),
          estimated_replenishment_quantity:
            acc.estimated_replenishment_quantity + (row.estimated_replenishment_quantity ?? 0),
        }),
        {
          available_inventory: 0,
          in_transit_quantity: 0,
          dms_90: 0,
          dms_30: 0,
          dms_14: 0,
          dms_7: 0,
          dms_90_yoy: 0,
          dms_30_yoy: 0,
          dms_14_yoy: 0,
          dms_7_yoy: 0,
          base_dms: 0,
          weighted_dms: 0,
          estimated_replenishment_quantity: 0,
        }
      ),
    [rows]
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
            setProjectId(String(payload[0].id))
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
    if (!currentProjectId || !fromDate || !toDate) {
      setRows([])
      setSummary(EMPTY_SUMMARY)
      return
    }
    let active = true
    async function loadAnalysis() {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          country,
          from_date: formatIsoDate(fromDate)!,
          to_date: formatIsoDate(toDate)!,
          compare_year_offset: String(compareYearOffset),
          page: '1',
          page_size: '200',
        })
        if (currentProjectId) params.set('project_id', String(currentProjectId))
        if (deferredKeyword.trim()) params.set('keyword', deferredKeyword.trim())

        const url = `${API_BASE}/api/v1/seasonal-replenishment-analysis?${params.toString()}`
        // BEL-423：只读分析数据走 2min 客户端缓存（重复 mount 0 请求）；
        // 点过"刷新重算"后的本次加载 force 跳过缓存。
        const force = forceNextLoadRef.current
        forceNextLoadRef.current = false
        const payload = await fetchOpsJsonCached<SeasonalResponse>(url, { session, force })
        if (!active) return
        setRows(payload.items)
        setSummary(payload.summary)
      } catch (loadError) {
        if (!active) return
        setRows([])
        setSummary(EMPTY_SUMMARY)
        notify({
          type: 'error',
          title: '分析数据加载失败',
          message: loadError instanceof Error ? loadError.message : '分析数据加载失败',
        })
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAnalysis()
    return () => {
      active = false
    }
  }, [
    notify,
    country,
    currentProjectId,
    fromDate,
    toDate,
    compareYearOffset,
    deferredKeyword,
    refreshNonce,
    session,
  ])
  async function exportToExcel() {
    if (rows.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的季节性补货数据' })
      return
    }

    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('季节性补货', {
        views: [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }],
      })

      const baseColumns = [
        { header: 'SKU', key: 'sku', width: 18 },
        { header: '产品名称', key: 'product_name', width: 28 },
        { header: '店铺库存', key: 'available_inventory', width: 12 },
        { header: '在途', key: 'in_transit_quantity', width: 10 },
        { header: '90D', key: 'dms_90', width: 10 },
        { header: '30D', key: 'dms_30', width: 10 },
        { header: '14D', key: 'dms_14', width: 10 },
        { header: '7D', key: 'dms_7', width: 10 },
      ]
      const yoyColumns = [
        { header: '90D 同比', key: 'dms_90_yoy', width: 12 },
        { header: '30D 同比', key: 'dms_30_yoy', width: 12 },
        { header: '14D 同比', key: 'dms_14_yoy', width: 12 },
        { header: '7D 同比', key: 'dms_7_yoy', width: 12 },
      ]
      const tailColumns = [
        { header: 'DMS', key: 'base_dms', width: 10 },
        { header: '加权DMS', key: 'weighted_dms', width: 12 },
        { header: '可售天数', key: 'sellable_days', width: 12 },
        { header: '售卖截止', key: 'sellout_date', width: 14 },
        { header: '含在途截止', key: 'sellout_date_with_transit', width: 14 },
        { header: '预计数量', key: 'estimated_replenishment_quantity', width: 12 },
      ]
      const columns = [...baseColumns, ...(compareYear ? yoyColumns : []), ...tailColumns]

      const selectedProjectName =
        projects.find((p) => String(p.id) === projectId)?.name ?? '全部项目'

      worksheet.columns = columns.map((c) => ({ key: c.key, width: c.width }))
      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((c) => c.header)
      headerRow.height = 24
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        applyHeaderBorder(cell)
      })

      const yoyStart = 9
      const yoyEnd = compareYear ? yoyStart + 3 : yoyStart - 1
      const baseDmsCol = compareYear ? 13 : 9
      const wDmsCol = baseDmsCol + 1
      const sDaysCol = baseDmsCol + 2
      const estQtyCol = columns.length

      rows.forEach((row, index) => {
        const sheetRow = worksheet.getRow(index + 2)
        const values = [
          row.sku,
          row.product_name || '-',
          row.available_inventory,
          row.in_transit_quantity,
          row.dms_90,
          row.dms_30,
          row.dms_14,
          row.dms_7,
        ]
        if (compareYear) {
          values.push(row.dms_90_yoy, row.dms_30_yoy, row.dms_14_yoy, row.dms_7_yoy)
        }
        values.push(
          row.base_dms,
          row.weighted_dms,
          row.sellable_days,
          row.sellout_date || '-',
          row.sellout_date_with_transit || '-',
          row.estimated_replenishment_quantity
        )
        sheetRow.values = values

        for (let col = 1; col <= columns.length; col++) {
          const cell = sheetRow.getCell(col)
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          const isNumeric =
            col === 3 ||
            col === 4 ||
            (col >= 5 && col <= 8) ||
            (compareYear && col >= yoyStart && col <= yoyEnd) ||
            col === baseDmsCol ||
            col === wDmsCol ||
            col === sDaysCol ||
            col === estQtyCol
          cell.alignment = {
            vertical: 'middle',
            horizontal: col === 2 ? 'left' : isNumeric ? 'right' : 'left',
            wrapText: col !== 2,
          }
          if (col === 2 && row.product_name && row.product_name !== '-') {
            cell.note = row.product_name
          }
          if (col === 3 || col === 4) cell.numFmt = '#,##0'
          if (
            (col >= 5 && col <= 8) ||
            (compareYear && col >= yoyStart && col <= yoyEnd) ||
            col === baseDmsCol
          ) {
            cell.numFmt = '0.0000'
          }
          if (col === wDmsCol || col === sDaysCol) cell.numFmt = '0.00'
          if (col === estQtyCol) cell.numFmt = '#,##0'
          applyBorder(cell)
        }
      })

      const totalRow = worksheet.getRow(rows.length + 2)
      totalRow.getCell(1).value = '筛选结果合计'
      totalRow.getCell(3).value = tableTotals.available_inventory
      totalRow.getCell(4).value = tableTotals.in_transit_quantity
      totalRow.getCell(5).value = tableTotals.dms_90
      totalRow.getCell(6).value = tableTotals.dms_30
      totalRow.getCell(7).value = tableTotals.dms_14
      totalRow.getCell(8).value = tableTotals.dms_7
      if (compareYear) {
        totalRow.getCell(yoyStart).value = tableTotals.dms_90_yoy
        totalRow.getCell(yoyStart + 1).value = tableTotals.dms_30_yoy
        totalRow.getCell(yoyStart + 2).value = tableTotals.dms_14_yoy
        totalRow.getCell(yoyStart + 3).value = tableTotals.dms_7_yoy
      }
      totalRow.getCell(baseDmsCol).value = tableTotals.base_dms
      totalRow.getCell(wDmsCol).value = tableTotals.weighted_dms
      totalRow.getCell(estQtyCol).value = tableTotals.estimated_replenishment_quantity
      applyRowBorder(totalRow, 1, columns.length)
      totalRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
      })
      totalRow.getCell(3).numFmt = '#,##0'
      totalRow.getCell(4).numFmt = '#,##0'
      totalRow.getCell(5).numFmt = '0.0000'
      totalRow.getCell(6).numFmt = '0.0000'
      totalRow.getCell(7).numFmt = '0.0000'
      totalRow.getCell(8).numFmt = '0.0000'
      if (compareYear) {
        for (let c = yoyStart; c <= yoyStart + 3; c++) totalRow.getCell(c).numFmt = '0.0000'
      }
      totalRow.getCell(baseDmsCol).numFmt = '0.0000'
      totalRow.getCell(wDmsCol).numFmt = '0.00'
      totalRow.getCell(estQtyCol).numFmt = '#,##0'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      const safeProjectName = (selectedProjectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      const fromStr = formatIsoDate(fromDate) ?? 'from'
      const toStr = formatIsoDate(toDate) ?? 'to'
      link.href = url
      link.download = `${safeProjectName}_${safeCountryLabel}-季节性补货-${fromStr}_${toStr}${compareYear ? '-含同比' : ''}-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'inventory_replenishment.seasonal.export',
        targetType: 'inventory_replenishment',
        targetId: currentProjectId,
        after: {
          project_id: currentProjectId,
          project_name: selectedProjectName,
          country,
          from_date: fromStr,
          to_date: toStr,
          compare_year_offset: compareYearOffset,
          keyword: keyword.trim() || null,
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

  const statBarItems = [
    { label: 'SKU 总数', value: formatInt(summary.sku_count), highlight: false },
    { label: '总店铺库存', value: formatInt(summary.total_available_inventory), highlight: false },
    { label: '总在途库存', value: formatInt(summary.total_in_transit_quantity), highlight: false },
    { label: '有销量 SKU', value: formatInt(summary.healthy_count), highlight: false },
    {
      label: '待补数据',
      value: formatInt(summary.pending_data_count),
      highlight: summary.pending_data_count > 0,
    },
  ]

  const dateRangeValid = Boolean(fromDate && toDate && toDate.getTime() >= fromDate.getTime())
  const daysSpan =
    fromDate && toDate ? Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1 : 0

  return (
    <div className="w-full space-y-6">
      <div className="dashboard-surface">
        <div className="flex flex-col gap-3 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              季节性补货控制台
            </p>
            <h2 className="text-base font-semibold text-foreground leading-none">季节性补货分析</h2>
            <Badge
              variant="outline"
              className="ml-2 border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/50 dark:text-sky-300"
            >
              权重 90D×40% + 30D×30% + 14D×20% + 7D×10%
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!currentProjectId || loading || !dateRangeValid}
              onClick={() => {
                forceNextLoadRef.current = true
                setRefreshNonce((n) => n + 1)
              }}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? '重算中...' : '刷新重算'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || exporting || rows.length === 0}
              onClick={() => void exportToExcel()}
            >
              <FileDown className="mr-1.5 h-4 w-4" />
              {exporting ? '导出中...' : '导出 Excel'}
            </Button>
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-3">
              <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                项目
              </label>
              <div className="mt-1">
                {projectsLoading ? (
                  <Skeleton className="h-9 w-full rounded-lg" />
                ) : (
                  <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger className="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground">
                      <SelectValue placeholder="选择项目" />
                    </SelectTrigger>
                    <SelectContent align="start" side="bottom" sideOffset={8} collisionPadding={16}>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={String(project.id)}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            <div className="lg:col-span-2">
              <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                国家
              </label>
              <div className="mt-1">
                <CountrySelect
                  value={country}
                  onChange={(c) => {
                    setCountry(c as 'US' | 'DE' | 'UK' | 'ALL')
                  }}
                  triggerClassName="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                />
              </div>
            </div>
            <div className="lg:col-span-4">
              <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                历史窗口 [from, to]
              </label>
              <div className="mt-1">
                <DateRangePicker
                  value={dateRange}
                  onChange={(range) => {
                    setDateRange(range)
                  }}
                  className="h-9 w-full"
                  timezone={COUNTRY_TIMEZONE_MAP[country]}
                />
                {fromDate && toDate && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {daysSpan} 天 · {compareYear ? `同比 ${toStrMinusYear(toDate)}` : '无同比'}
                  </p>
                )}
              </div>
            </div>
            <div className="lg:col-span-2">
              <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                搜索 SKU / ASIN
              </label>
              <div className="mt-1">
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索 SKU / ASIN"
                  className="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                />
              </div>
            </div>
            <div className="lg:col-span-1">
              <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                同比开关
              </label>
              <div className="mt-2 flex items-center gap-2 h-9">
                <Switch checked={compareYear} onCheckedChange={setCompareYear} id="compare-yoy" />
                <label
                  htmlFor="compare-yoy"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  去年
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-border/70 px-4 py-3">
          {loading && rows.length === 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:divide-x lg:divide-border/60">
              {statBarItems.map((item, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex flex-col items-center justify-center rounded-lg border border-border/70 py-2.5 lg:flex-1 lg:rounded-none lg:border-0',
                    i === 0 && 'lg:pl-4',
                    i === statBarItems.length - 1 && 'lg:pr-4'
                  )}
                >
                  <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                    {item.label}
                  </div>
                  <div
                    className={cn(
                      'mt-0.5 text-xl font-semibold leading-tight',
                      item.highlight ? 'text-rose-600 dark:text-rose-300' : 'text-foreground'
                    )}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">季节性补货主表</h3>
          </div>
        </div>

        {!currentProjectId && !projectsLoading ? (
          <div className="dashboard-surface px-6 py-16 text-center text-sm text-muted-foreground">
            请先选择项目。
          </div>
        ) : !fromDate || !toDate ? (
          <div className="dashboard-surface px-6 py-16 text-center text-sm text-muted-foreground">
            请选择历史日期范围。
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="dashboard-surface space-y-3 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="dashboard-surface px-6 py-16 text-center text-sm text-muted-foreground">
            当前筛选条件下没有可分析的 SKU。
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <DataTableCard>
                <DataTableCardHeader className="px-4 py-3">
                  <div className="space-y-1">
                    <h3 className="text-base font-semibold text-foreground">
                      {fromDate ? formatIsoDate(fromDate) : ''} ~{' '}
                      {toDate ? formatIsoDate(toDate) : ''} · {rows.length} 个 SKU
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      主窗口右端 = to_date，4 个窗口向左回溯；权重 90D×40 + 30D×30 + 14D×20 + 7D×10
                    </p>
                  </div>
                </DataTableCardHeader>
                <DataTableCardBody>
                  <div className="relative">
                    {loading && rows.length > 0 ? (
                      <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))/0.95] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))/0.96] dark:text-foreground/72">
                        季节性补货主表更新中...
                      </div>
                    ) : null}
                    <Table
                      containerClassName="max-h-[72vh] overflow-auto border-t border-border/70 bg-transparent dark:border-border/85 rounded-none"
                      className={cn(
                        'min-w-[1600px] table-auto border-separate border-spacing-0 bg-transparent text-[13px]',
                        compareYear && 'min-w-[2100px]'
                      )}
                    >
                      <TableHeader>
                        <TableRow className="bg-transparent">
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} ${STICKY_LEFT_HEAD_CELL} min-w-[132px]`}
                          >
                            SKU
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[200px]`}
                          >
                            产品名称
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                          >
                            店铺库存
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[88px] text-right`}
                          >
                            在途
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            90D
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            30D
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            14D
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            7D
                          </TableHead>
                          {compareYear && (
                            <>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                90D 同比
                              </TableHead>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                30D 同比
                              </TableHead>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                14D 同比
                              </TableHead>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                7D 同比
                              </TableHead>
                            </>
                          )}
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[88px] text-right`}
                          >
                            DMS
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[100px] text-right`}
                          >
                            加权DMS
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[100px] text-right`}
                          >
                            可售天数
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                          >
                            售卖截止
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                          >
                            含在途截止
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[104px] text-right`}
                          >
                            预计数量
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row) => (
                          <TableRow
                            key={rowKey(row)}
                            className="group align-top odd:bg-[hsl(var(--surface-panel))] even:bg-[hsl(var(--surface-overlay))] hover:bg-sky-50/80 dark:odd:bg-[hsl(var(--surface-panel))] dark:even:bg-[hsl(var(--surface-overlay))] dark:hover:bg-sky-950/20"
                          >
                            <TableCell
                              className={`whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 ${STICKY_LEFT_CELL_HOVER} font-medium`}
                            >
                              {row.sku}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 font-medium text-foreground">
                              {row.product_name || '--'}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatInt(row.available_inventory)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatInt(row.in_transit_quantity)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatNumber(row.dms_90)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatNumber(row.dms_30)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatNumber(row.dms_14)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatNumber(row.dms_7)}
                            </TableCell>
                            {compareYear && (
                              <>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-border/80 text-right',
                                    yoyDeltaClass(row.dms_90, row.dms_90_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_90_yoy)}
                                  <YoySymbol current={row.dms_90} yoy={row.dms_90_yoy} />
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-border/80 text-right',
                                    yoyDeltaClass(row.dms_30, row.dms_30_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_30_yoy)}
                                  <YoySymbol current={row.dms_30} yoy={row.dms_30_yoy} />
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-border/80 text-right',
                                    yoyDeltaClass(row.dms_14, row.dms_14_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_14_yoy)}
                                  <YoySymbol current={row.dms_14} yoy={row.dms_14_yoy} />
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-border/80 text-right',
                                    yoyDeltaClass(row.dms_7, row.dms_7_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_7_yoy)}
                                  <YoySymbol current={row.dms_7} yoy={row.dms_7_yoy} />
                                </TableCell>
                              </>
                            )}
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right font-medium text-foreground">
                              {formatNumber(row.base_dms)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right font-medium text-foreground">
                              {formatNumber(row.weighted_dms)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                              {formatNumber(row.sellable_days)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                              {formatDate(row.sellout_date)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                              {formatDate(row.sellout_date_with_transit)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right font-medium text-foreground">
                              {formatInt(row.estimated_replenishment_quantity)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/40 font-semibold">
                          <TableCell
                            className={`whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 ${STICKY_LEFT_CELL_HOVER}`}
                          >
                            合计
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatInt(tableTotals.available_inventory)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatInt(tableTotals.in_transit_quantity)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatNumber(tableTotals.dms_90, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatNumber(tableTotals.dms_30, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatNumber(tableTotals.dms_14, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatNumber(tableTotals.dms_7, 4)}
                          </TableCell>
                          {compareYear && (
                            <>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_90_yoy, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_30_yoy, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_14_yoy, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_7_yoy, 4)}
                              </TableCell>
                            </>
                          )}
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatNumber(tableTotals.base_dms, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatNumber(tableTotals.weighted_dms)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                          <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                            {formatInt(tableTotals.estimated_replenishment_quantity)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </DataTableCardBody>
              </DataTableCard>
            </div>

            {/* 手机端：卡片列表 */}
            <div className="md:hidden space-y-3">
              {loading && rows.length > 0 ? (
                <div className="text-center text-xs text-muted-foreground py-2">
                  季节性补货主表更新中...
                </div>
              ) : null}
              {rows.map((row) => (
                <div key={rowKey(row)} className="dashboard-surface p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-foreground truncate">
                      {row.sku}
                    </span>
                  </div>
                  {row.product_name && (
                    <div className="text-xs text-muted-foreground">
                      产品名称: {row.product_name}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <span className="text-xs text-muted-foreground">店铺库存</span>
                      <div className="font-medium text-foreground">
                        {formatInt(row.available_inventory)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">在途</span>
                      <div className="font-medium text-foreground">
                        {formatInt(row.in_transit_quantity)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">加权 DMS</span>
                      <div className="font-medium text-foreground">
                        {formatNumber(row.weighted_dms)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">可售天数</span>
                      <div className="font-medium text-foreground">
                        {formatNumber(row.sellable_days)}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <div>售卖截止: {formatDate(row.sellout_date)}</div>
                    <div>含在途: {formatDate(row.sellout_date_with_transit)}</div>
                  </div>
                  <div className="text-sm">
                    <span className="text-xs text-muted-foreground">预计补货数量: </span>
                    <span className="font-medium text-foreground">
                      {formatInt(row.estimated_replenishment_quantity)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-4 text-sm text-foreground/80 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]">
        <div className="space-y-3">
          <div className="text-sm font-semibold text-foreground">口径说明</div>
          <div className="grid gap-2">
            <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
              <span className="mr-2 inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                日期范围
              </span>
              选定的 <code>[from, to]</code> 是历史回看窗口。主窗口右端 = <code>to_date</code>， 4
              个 DMS 分别向前回溯 90/30/14/7 天（双闭区间）。默认 <code>[today-89, today]</code>。
            </div>
            <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
              <span className="mr-2 inline-flex rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                权重
              </span>
              加权 DMS = <code>90D×40% + 30D×30% + 14D×20% + 7D×10%</code>，长周期高权重
              （季节性商品应看 90D 趋势而非近期噪音）。任一窗口缺失则按「可用窗口」重新归一化权重。
            </div>
            <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
              <span className="mr-2 inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                同比口径
              </span>
              开启「去年」开关后，额外算去年同期窗口（右端 = <code>to_date - 365</code>
              ，长度同上）。 单元格颜色：当前 &lt; 去年 → 红（下滑预警），当前 &gt; 去年 →
              绿（爬坡预警）。
            </div>
            <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
              <span className="mr-2 inline-flex rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                风险状态
              </span>
              季节性页面<b>不判定</b>风险状态（<code>健康/断货/滞销</code> 等标签不显示）， 因为
              today 之外的 to_date 会让「可售天数 - today」判定失效。请基于
              <code>售卖截止 / 含在途截止 / 预计补货数量</code> 自行决策。
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
