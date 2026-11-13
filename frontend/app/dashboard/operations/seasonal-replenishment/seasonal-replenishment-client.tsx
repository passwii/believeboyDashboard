'use client'

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { FileDown, Table2, TrendingDown, TrendingUp } from 'lucide-react'
import { useSession } from 'next-auth/react'
import type { DateRange } from 'react-day-picker'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  HeaderSlotDateRange,
  HeaderSlotSelect,
  TERM_HEADER_W_LG,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
  TERM_HEADER_W_XL,
} from '@/components/terminal/header-filter-suite'
import { useHeaderRefresh, useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useNotifications } from '@/components/notifications'
import { formatLocalTimestampForFilename, cn } from '@/lib/utils'
import { applyBorder, applyDataRowBanding, applyHeaderBorder, applyRowBorder } from '@/lib/excel-styles'
import { getCountryLabel } from '@/lib/country'
import { downloadBlob } from '@/lib/download-blob'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { COUNTRY_TIMEZONE_MAP, getTodayInTimezone } from '@/components/ui/date-picker'
import styles from './seasonal-replenishment-warm.module.css'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

const API_BASE = '/api/backend'

/** header 插槽站点选项：保持页面原生选项集（含 ALL 聚合位，与迁移前 CountrySelect 一致） */
const COUNTRY_SLOT_OPTIONS = COUNTRY_OPTIONS.map((opt) => ({
  value: opt.value,
  label: opt.label,
}))

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
  if (current === null || yoy === null) return 'text-[var(--warm-ledger-color-text-muted)]'
  if (yoy === 0) return 'text-[var(--warm-ledger-color-text)]'
  if (current < yoy) return 'text-[var(--warm-ledger-color-negative)]'
  if (current > yoy) return 'text-[var(--warm-ledger-color-positive)]'
  return 'text-[var(--warm-ledger-color-text)]'
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

function WarmTable({
  className,
  containerClassName,
  children,
  ...props
}: ComponentProps<typeof Table>) {
  return (
    <div
      className={cn(styles.tableScroll, 'warm-ledger-table-scroll', containerClassName)}
      data-warm-table-scroll="seasonal-replenishment"
      tabIndex={0}
    >
      <Table
        {...props}
        containerClassName="overflow-visible"
        className={cn(styles.table, className)}
      >
        {children}
      </Table>
    </div>
  )
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
  const [loadError, setLoadError] = useState<string | null>(null)
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
  const warmState =
    loadError
      ? 'error'
      : projectsLoading || (loading && rows.length === 0)
        ? 'loading'
        : rows.length === 0
          ? 'empty'
          : 'ready'

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
      setLoadError(null)
      return
    }
    let active = true
    async function loadAnalysis() {
      setLoading(true)
      setLoadError(null)
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
        setLoadError(null)
      } catch (loadError) {
        if (!active) return
        setRows([])
        setSummary(EMPTY_SUMMARY)
        setLoadError(loadError instanceof Error ? loadError.message : '分析数据加载失败')
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
      applyDataRowBanding({
        worksheet,
        startRow: 2,
        rowCount: rows.length,
        columnCount: columns.length,
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
      const safeTimestamp = formatLocalTimestampForFilename()
      const safeProjectName = (selectedProjectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      const fromStr = formatIsoDate(fromDate) ?? 'from'
      const toStr = formatIsoDate(toDate) ?? 'to'
      const filename = `${safeProjectName}_${safeCountryLabel}-季节性补货-${fromStr}_${toStr}${compareYear ? '-含同比' : ''}-${safeTimestamp}.xlsx`
      downloadBlob(blob, filename)
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
          filename,
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

  const daysSpan =
    fromDate && toDate ? Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1 : 0
  // 日期旁天数提示：48px header 放不下额外文本，收敛为日期 trigger 的 title tooltip
  const dateRangeHint =
    fromDate && toDate
      ? `${daysSpan} 天 · ${compareYear ? `同比 ${toStrMinusYear(toDate)}` : '无同比'}`
      : ''

  // —— Header 化：全局刷新 = 原「刷新重算」语义（BEL-423） ——
  // 置 force 标志 + 触发重载（refreshNonce），下一次加载跳过 2min 客户端缓存，
  // 拿后端最新重算结果；loading 上报给头部刷新按钮（转圈/禁点）。
  const handleRefreshRecalc = () => {
    forceNextLoadRef.current = true
    setRefreshNonce((n) => n + 1)
  }
  // ref 桥接：触发时永远执行最新闭包，防过期 state
  const handleRefreshRecalcRef = useRef(handleRefreshRecalc)
  handleRefreshRecalcRef.current = handleRefreshRecalc
  useHeaderRefresh(() => handleRefreshRecalcRef.current(), { loading })

  // 5 个筛选控件 portal 进 Top Header 中段插槽（项目 / 站点 / 日期范围 / 关键词 / 同比开关）
  const filterControls = (
    <>
      <div className="contents" data-filter-control="project">
        <HeaderSlotSelect
          value={projectId}
          onChange={setProjectId}
          options={projects.map((project) => ({
            value: String(project.id),
            label: project.name,
          }))}
          placeholder={projectsLoading ? '项目加载中…' : '选择项目'}
          disabled={projectsLoading}
          widthClass={TERM_HEADER_W_MD}
          title="项目筛选"
        />
      </div>
      <div className="contents" data-filter-control="country">
        <HeaderSlotSelect
          value={country}
          onChange={(value) => setCountry(value as 'US' | 'DE' | 'UK' | 'ALL')}
          options={COUNTRY_SLOT_OPTIONS}
          widthClass={TERM_HEADER_W_SM}
          title="站点筛选"
        />
      </div>
      <div className="contents" data-filter-control="date">
        <div className="shrink-0" title={dateRangeHint || undefined}>
          <HeaderSlotDateRange
            value={dateRange}
            onChange={setDateRange}
            timezone={COUNTRY_TIMEZONE_MAP[country]}
            widthClass={TERM_HEADER_W_XL}
          />
        </div>
      </div>
      {/* 关键词输入沿用 header 控件高度，视觉由页面本地 Warm 样式接管。 */}
      <div className="contents" data-filter-control="keyword">
        <Input
          size="lg"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索 SKU / ASIN"
          className={cn('shrink-0', TERM_HEADER_W_LG)}
          title="关键词筛选（SKU / ASIN）"
        />
      </div>
      {/* 「去年」同比开关：保持与 header 控件同高，标签使用界面 sans */}
      <div
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--warm-ledger-radius-inner)] border border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-2.5"
        data-filter-control="compare"
      >
        <Switch checked={compareYear} onCheckedChange={setCompareYear} id="compare-yoy" />
        <label htmlFor="compare-yoy" className={styles.filterLabel}>
          去年
        </label>
      </div>
    </>
  )
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileProjectLabel = projects.find((p) => String(p.id) === projectId)?.name ?? projectId
  const mobileCountryLabel = country === 'ALL' ? '全部站点' : getCountryLabel(country)
  const mobileDateLabel =
    dateRange?.from && dateRange?.to
      ? `${formatIsoDate(dateRange.from) ?? ''} ~ ${formatIsoDate(dateRange.to) ?? ''}`
      : '未选日期'
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${mobileDateLabel}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <HeaderSlotSelect
            value={projectId}
            onChange={setProjectId}
            options={projects.map((project) => ({
              value: String(project.id),
              label: project.name,
            }))}
            placeholder={projectsLoading ? '项目加载中…' : '选择项目'}
            disabled={projectsLoading}
            widthClass={TERM_HEADER_W_MD}
            title="项目筛选"
          />
          <HeaderSlotSelect
            value={country}
            onChange={(value) => setCountry(value as 'US' | 'DE' | 'UK' | 'ALL')}
            options={COUNTRY_SLOT_OPTIONS}
            widthClass={TERM_HEADER_W_SM}
            title="站点筛选"
          />
          <MobileFilterWide>
            <HeaderSlotDateRange
              value={dateRange}
              onChange={setDateRange}
              timezone={COUNTRY_TIMEZONE_MAP[country]}
              widthClass={TERM_HEADER_W_XL}
            />
          </MobileFilterWide>
          <MobileFilterWide>
            <Input
              size="lg"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索 SKU / ASIN"
              className={cn('w-full', TERM_HEADER_W_LG)}
              title="关键词筛选（SKU / ASIN）"
            />
          </MobileFilterWide>
          <div className="flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--warm-ledger-radius-inner)] border border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-2.5">
            <Switch checked={compareYear} onCheckedChange={setCompareYear} id="compare-yoy-mobile" />
            <label htmlFor="compare-yoy-mobile" className={styles.filterLabel}>
              去年
            </label>
          </div>
        </>
      }
    />
  )

  return (
    <div
      className={styles.page}
      data-warm-page="seasonal-replenishment"
      data-warm-state={warmState}
    >
      {/* Header 化：5 个筛选控件（项目/站点/日期/关键词/同比）已上移 Top Header 中段插槽，页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}

      {loadError ? (
        <div className={styles.errorNotice} data-warm-state="error">
          <div className={styles.errorCopy}>
            <h2 className={styles.errorTitle} data-warm-state="error">
              季节性补货数据加载失败
            </h2>
            <p className={styles.errorMessage}>{loadError}</p>
          </div>
          <WarmButton variant="secondary" onClick={handleRefreshRecalc}>
            重试
          </WarmButton>
        </div>
      ) : null}

      {/* 5 格统计条（原控制台内容，保留） */}
      {!loadError && (
        <div className={styles.summaryPanel} data-warm-summary="seasonal-replenishment">
        <div>
          {loading && rows.length === 0 ? (
            <div className={styles.summaryGrid} data-warm-state="loading">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : (
            <div className={styles.summaryGrid}>
              {statBarItems.map((item, i) => (
                <div key={i} className={styles.summaryItem}>
                  <div className={styles.summaryLabel}>
                    {item.label}
                  </div>
                  <div
                    className={styles.summaryValue}
                    data-tone={item.highlight ? 'negative' : undefined}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      )}

      {!loadError && (
        <div>
        <div className={styles.tableToolbar}>
          <div className={styles.tableTitleRow}>
            <Table2 className="h-4 w-4 text-[var(--warm-ledger-color-text-muted)]" />
            <h3 className={styles.tableTitle}>季节性补货主表</h3>
            {/* 权重 Badge（原控制台标题行内容，保留） */}
            <Badge
              variant="outline"
              className="border-[color:var(--warm-ledger-color-accent)] bg-[var(--warm-ledger-color-accent-soft)] text-[var(--warm-ledger-color-accent)]"
            >
              权重 90D×40% + 30D×30% + 14D×20% + 7D×10%
            </Badge>
          </div>
          {/* 导出（原控制台内容，保留；「刷新重算」按钮已删除，由头部全局刷新接管） */}
          <WarmButton
            type="button"
            variant="secondary"
            disabled={loading || exporting || rows.length === 0}
            onClick={() => void exportToExcel()}
          >
            <FileDown className="mr-1.5 h-4 w-4" />
            {exporting ? '导出中...' : '导出 Excel'}
          </WarmButton>
        </div>

        {!currentProjectId && !projectsLoading ? (
          <div className={styles.stateNotice} data-warm-state="empty">
            请先选择项目。
          </div>
        ) : !fromDate || !toDate ? (
          <div className={styles.stateNotice} data-warm-state="empty">
            请选择历史日期范围。
          </div>
        ) : loading && rows.length === 0 ? (
          <div className={styles.loadingPanel} data-warm-state="loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateNotice} data-warm-state="empty">
            当前筛选条件下没有可分析的 SKU。
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <DataTableCard className={styles.tablePanel}>
                <DataTableCardHeader>
                  <div className="space-y-1">
                    <h3 className={styles.tableHeaderTitle}>
                      {fromDate ? formatIsoDate(fromDate) : ''} ~{' '}
                      {toDate ? formatIsoDate(toDate) : ''} · {rows.length} 个 SKU
                    </h3>
                    <p className="text-xs text-[var(--warm-ledger-color-text-muted)]">
                      主窗口右端 = to_date，4 个窗口向左回溯；权重 90D×40 + 30D×30 + 14D×20 + 7D×10
                    </p>
                  </div>
                </DataTableCardHeader>
                <DataTableCardBody>
                  <div className="relative">
                    {loading && rows.length > 0 ? (
                      <div className={styles.updateNotice}>
                        季节性补货主表更新中...
                      </div>
                    ) : null}
                    <WarmTable className={cn(compareYear && 'min-w-[2100px]')}>
                      <TableHeader>
                        <TableRow className="bg-transparent">
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} ${STICKY_LEFT_HEAD_CELL} min-w-[132px]`}
                          >
                            SKU
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[200px]`}
                          >
                            产品名称
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                          >
                            店铺库存
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[88px] text-right`}
                          >
                            在途
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            90D
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            30D
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            14D
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                          >
                            7D
                          </TableHead>
                          {compareYear && (
                            <>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                90D 同比
                              </TableHead>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                30D 同比
                              </TableHead>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                14D 同比
                              </TableHead>
                              <TableHead
                                className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                              >
                                7D 同比
                              </TableHead>
                            </>
                          )}
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[88px] text-right`}
                          >
                            DMS
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[100px] text-right`}
                          >
                            加权DMS
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[100px] text-right`}
                          >
                            可售天数
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[116px]`}
                          >
                            售卖截止
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[116px]`}
                          >
                            含在途截止
                          </TableHead>
                          <TableHead
                            className={`h-11 whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--warm-ledger-color-text-muted)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_TOP_ROW} min-w-[104px] text-right`}
                          >
                            预计数量
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row) => (
                          <TableRow
                            key={rowKey(row)}
                            className="group align-top odd:bg-[var(--warm-ledger-color-panel)] even:bg-[var(--warm-ledger-color-raised)] hover:bg-[var(--warm-ledger-color-accent-soft)] dark:odd:bg-[var(--warm-ledger-color-panel)] dark:even:bg-[var(--warm-ledger-color-raised)]"
                          >
                            <TableCell
                              className={`whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_LEFT_CELL_HOVER} font-medium`}
                            >
                              {row.sku}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] font-medium text-[var(--warm-ledger-color-text)]">
                              {row.product_name || '--'}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatInt(row.available_inventory)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatInt(row.in_transit_quantity)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatNumber(row.dms_90)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatNumber(row.dms_30)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatNumber(row.dms_14)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatNumber(row.dms_7)}
                            </TableCell>
                            {compareYear && (
                              <>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] text-right',
                                    yoyDeltaClass(row.dms_90, row.dms_90_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_90_yoy)}
                                  <YoySymbol current={row.dms_90} yoy={row.dms_90_yoy} />
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] text-right',
                                    yoyDeltaClass(row.dms_30, row.dms_30_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_30_yoy)}
                                  <YoySymbol current={row.dms_30} yoy={row.dms_30_yoy} />
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] text-right',
                                    yoyDeltaClass(row.dms_14, row.dms_14_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_14_yoy)}
                                  <YoySymbol current={row.dms_14} yoy={row.dms_14_yoy} />
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] text-right',
                                    yoyDeltaClass(row.dms_7, row.dms_7_yoy)
                                  )}
                                >
                                  {formatNumber(row.dms_7_yoy)}
                                  <YoySymbol current={row.dms_7} yoy={row.dms_7_yoy} />
                                </TableCell>
                              </>
                            )}
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right font-medium text-[var(--warm-ledger-color-text)]">
                              {formatNumber(row.base_dms)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right font-medium text-[var(--warm-ledger-color-text)]">
                              {formatNumber(row.weighted_dms)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                              {formatNumber(row.sellable_days)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)]">
                              {formatDate(row.sellout_date)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)]">
                              {formatDate(row.sellout_date_with_transit)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right font-medium text-[var(--warm-ledger-color-text)]">
                              {formatInt(row.estimated_replenishment_quantity)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-[var(--warm-ledger-color-raised)] font-semibold">
                          <TableCell
                            className={`whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] ${STICKY_LEFT_CELL_HOVER}`}
                          >
                            合计
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)]" />
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatInt(tableTotals.available_inventory)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatInt(tableTotals.in_transit_quantity)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatNumber(tableTotals.dms_90, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatNumber(tableTotals.dms_30, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatNumber(tableTotals.dms_14, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatNumber(tableTotals.dms_7, 4)}
                          </TableCell>
                          {compareYear && (
                            <>
                              <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                                {formatNumber(tableTotals.dms_90_yoy, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                                {formatNumber(tableTotals.dms_30_yoy, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                                {formatNumber(tableTotals.dms_14_yoy, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                                {formatNumber(tableTotals.dms_7_yoy, 4)}
                              </TableCell>
                            </>
                          )}
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatNumber(tableTotals.base_dms, 4)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatNumber(tableTotals.weighted_dms)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)]" />
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)]" />
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)]" />
                          <TableCell className="whitespace-nowrap border-b border-r border-[color:var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle text-[13px] text-[var(--warm-ledger-color-text)] last:border-r-0 dark:border-[color:var(--warm-ledger-color-hairline)] dark:text-[var(--warm-ledger-color-text)] text-right">
                            {formatInt(tableTotals.estimated_replenishment_quantity)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </WarmTable>
                  </div>
                </DataTableCardBody>
              </DataTableCard>
            </div>

            {/* 手机端：卡片列表 */}
            <div className="md:hidden space-y-3">
              {loading && rows.length > 0 ? (
                <div className="text-center text-xs text-[var(--warm-ledger-color-text-muted)] py-2">
                  季节性补货主表更新中...
                </div>
              ) : null}
              {rows.map((row) => (
                <div key={rowKey(row)} className={cn(styles.mobileCard, 'space-y-3')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-[var(--warm-ledger-color-text)] truncate">
                      {row.sku}
                    </span>
                  </div>
                  {row.product_name && (
                    <div className="text-xs text-[var(--warm-ledger-color-text-muted)]">
                      产品名称: {row.product_name}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <span className="text-xs text-[var(--warm-ledger-color-text-muted)]">店铺库存</span>
                      <div className="font-medium text-[var(--warm-ledger-color-text)]">
                        {formatInt(row.available_inventory)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-[var(--warm-ledger-color-text-muted)]">在途</span>
                      <div className="font-medium text-[var(--warm-ledger-color-text)]">
                        {formatInt(row.in_transit_quantity)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-[var(--warm-ledger-color-text-muted)]">加权 DMS</span>
                      <div className="font-medium text-[var(--warm-ledger-color-text)]">
                        {formatNumber(row.weighted_dms)}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-[var(--warm-ledger-color-text-muted)]">可售天数</span>
                      <div className="font-medium text-[var(--warm-ledger-color-text)]">
                        {formatNumber(row.sellable_days)}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--warm-ledger-color-text-muted)]">
                    <div>售卖截止: {formatDate(row.sellout_date)}</div>
                    <div>含在途: {formatDate(row.sellout_date_with_transit)}</div>
                  </div>
                  {/* 历史多周期销量（展开保留完整字段） */}
                  <details className="text-xs text-[var(--warm-ledger-color-text-muted)]">
                    <summary className="cursor-pointer py-1 font-medium text-[var(--warm-ledger-color-text-soft)] hover:text-[var(--warm-ledger-color-text)]">
                      查看周期销量明细 (90D / 30D / 14D / 7D)
                    </summary>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1.5 pb-1 text-xs">
                      <div>90D 销量: {formatNumber(row.dms_90)}</div>
                      <div>30D 销量: {formatNumber(row.dms_30)}</div>
                      <div>14D 销量: {formatNumber(row.dms_14)}</div>
                      <div>7D 销量: {formatNumber(row.dms_7)}</div>
                    </div>
                  </details>
                  <div className="text-sm">
                    <span className="text-xs text-[var(--warm-ledger-color-text-muted)]">预计补货数量: </span>
                    <span className="font-medium text-[var(--warm-ledger-color-text)]">
                      {formatInt(row.estimated_replenishment_quantity)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        </div>
      )}

      <div className={styles.callout}>
        <div className="space-y-3">
          <div className={styles.calloutHeader}>口径说明</div>
          <div className={styles.calloutGrid}>
            <div className={styles.calloutItem}>
              <span className={styles.calloutTag}>
                日期范围
              </span>
              选定的 <code>[from, to]</code> 是历史回看窗口。主窗口右端 = <code>to_date</code>， 4
              个 DMS 分别向前回溯 90/30/14/7 天（双闭区间）。默认 <code>[today-89, today]</code>。
            </div>
            <div className={styles.calloutItem}>
              <span className={styles.calloutTag}>
                权重
              </span>
              加权 DMS = <code>90D×40% + 30D×30% + 14D×20% + 7D×10%</code>，长周期高权重
              （季节性商品应看 90D 趋势而非近期噪音）。任一窗口缺失则按「可用窗口」重新归一化权重。
            </div>
            <div className={styles.calloutItem}>
              <span className={styles.calloutTag}>
                同比口径
              </span>
              开启「去年」开关后，额外算去年同期窗口（右端 = <code>to_date - 365</code>
              ，长度同上）。 单元格颜色：当前 &lt; 去年 → 红（下滑预警），当前 &gt; 去年 →
              绿（爬坡预警）。
            </div>
            <div className={styles.calloutItem}>
              <span className={styles.calloutTag}>
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
