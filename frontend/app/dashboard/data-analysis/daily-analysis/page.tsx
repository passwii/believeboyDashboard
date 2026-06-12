'use client'

import { useEffect, useMemo, useState, useCallback, useRef, useId, useSyncExternalStore } from 'react'
import { DateRange } from 'react-day-picker'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileDown,
  Loader2,
  RefreshCcw,
  Target,
} from 'lucide-react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import {
  CountrySelect,
  FilterField,
  ProjectSelect,
  RefreshButton,
} from '@/components/dashboard/console'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
  DataTableCard,
  DataTableCardHeader,
  DataTableCardMetrics,
  DataTableCardBody,
} from '@/components/ui/data-card'
import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
} from '@/components/ui/date-picker'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { EmptyTableState } from '@/components/ui/empty-state'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { applyBorder, applyHeaderBorder } from '@/lib/excel-styles'
import { Skeleton } from '@/components/ui/skeleton'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type CountryOption = 'US' | 'DE' | 'UK'
type ViewTab = 'summary' | 'details'
const VIEW_TAB_ORDER: ViewTab[] = ['summary', 'details']

type MetricChartConfig = Record<string, { label: string; color: string }>
type DailyChartRow = {
  date: string
  compareMetricValue: number | null
} & Partial<Record<ChartMetricKey, number>>

type ProjectOption = {
  id: number | null
  name: string
}

type DailyAnalysisConsole = {
  project_id: number
  project_name: string
  country: string
  start_date: string
  end_date: string
  requested_days: number
  summary_days: number
  detail_rows: number
  sales_source_days: number
  ad_source_days: number
  inventory_source_days: number
  missing_dates: string[]
  latest_sales_date: string | null
  latest_ad_date: string | null
  latest_inventory_date: string | null
  business_source_days: number
  latest_business_date: string | null
}

type DailyAnalysisRow = {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  ordered_sales_amount: number
  conversion_rate: number
}

type DailyAnalysisDetailRow = DailyAnalysisRow & {
  sku: string
  asin: string | null
  in_transit_qty: number
}

type ProjectSkuOption = {
  sku: string
  asin: string | null
  fnsku: string | null
  product_name: string | null
  units_per_carton: number
  carton_length_cm: number | null
  carton_width_cm: number | null
  carton_height_cm: number | null
  carton_weight_kg: number | null
}

type DailyAnalysisResponse = {
  console: DailyAnalysisConsole
  summary_rows: DailyAnalysisRow[]
  detail_rows: DailyAnalysisDetailRow[]
  available_dates: Record<string, string[]>
}

type DailyAnalysisAllProjectsResponse = {
  summary_rows: DailyAnalysisRow[]
  detail_rows: DailyAnalysisDetailRow[]
  available_dates: Record<string, string[]>
  project_breakdown: Record<
    number,
    {
      project_name: string
      summary_rows: DailyAnalysisRow[]
      detail_rows: DailyAnalysisDetailRow[]
    }
  >
}

type DetailDisplayRow = {
  row: DailyAnalysisDetailRow
  rowKey: string
  showDate: boolean
  rowSpan: number
  isTintedGroup: boolean
  productName: string | null
}

type ChartMetricKey = keyof Pick<
  DailyAnalysisRow,
  | 'order_qty'
  | 'sales_amount'
  | 'impressions'
  | 'clicks'
  | 'cpc'
  | 'ad_spend'
  | 'ad_orders'
  | 'page_views'
  | 'units_ordered'
  | 'sessions'
  | 'conversion_rate'
>

const API_BASE = '/api/backend'
const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

const CHART_METRICS: Array<{ key: ChartMetricKey; label: string }> = [
  { key: 'order_qty', label: '订单' },
  { key: 'sales_amount', label: '销售额' },
  { key: 'impressions', label: '曝光量' },
  { key: 'clicks', label: '点击量' },
  { key: 'cpc', label: 'CPC' },
  { key: 'ad_spend', label: '广告花费' },
  { key: 'ad_orders', label: '广告订单' },
  { key: 'page_views', label: '页面浏览量' },
  { key: 'units_ordered', label: '销量' },
  { key: 'sessions', label: '访问量' },
  { key: 'conversion_rate', label: '转化率' },
]

const SINGLE_METRIC_CHART_CONFIG = {
  order_qty: { label: '订单', color: 'hsl(var(--chart-1))' },
  sales_amount: { label: '销售额', color: 'hsl(var(--chart-2))' },
  impressions: { label: '曝光量', color: 'hsl(var(--chart-3))' },
  clicks: { label: '点击量', color: 'hsl(var(--chart-4))' },
  cpc: { label: 'CPC', color: 'hsl(var(--chart-5))' },
  ad_spend: { label: '广告花费', color: 'hsl(var(--chart-4))' },
  ad_orders: { label: '广告订单', color: 'hsl(var(--chart-2))' },
  page_views: { label: '页面浏览量', color: 'hsl(var(--chart-6))' },
  units_ordered: { label: '销量', color: 'hsl(var(--chart-7))' },
  sessions: { label: '访问量', color: 'hsl(var(--chart-1))' },
  conversion_rate: { label: '转化率', color: 'hsl(var(--chart-3))' },
} satisfies MetricChartConfig

const EMPTY_SUMMARY_ROWS: DailyAnalysisRow[] = []
const EMPTY_DETAIL_ROWS: DailyAnalysisDetailRow[] = []

function getChartColor(key: ChartMetricKey): string {
  return SINGLE_METRIC_CHART_CONFIG[key]?.color ?? 'hsl(var(--chart-1))'
}

function authHeaders(): Record<string, string> {
  return {}
}

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Timezone utilities — all dates are calculated in the marketplace timezone (country),
// not the browser's local timezone, to match backend interpretation.
const COUNTRY_CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

/** Returns today's calendar date as a Date in local time, calculated in the country's timezone. */
function getTodayInTimezone(country: string): Date {
  const tz = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz }) // YYYY-MM-DD in target TZ
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function addDays(date: Date, amount: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function normalizeDateRange(range?: DateRange) {
  if (!range?.from || !range?.to) return undefined
  const from = new Date(range.from)
  const to = new Date(range.to)
  from.setHours(0, 0, 0, 0)
  to.setHours(0, 0, 0, 0)
  return { from, to }
}

function getRangeDayCount(range?: DateRange) {
  if (!range?.from || !range?.to) return 0
  const diff = range.to.getTime() - range.from.getTime()
  return Math.floor(diff / 86400000) + 1
}

function generateDateRangeStrings(from: Date, to: Date): string[] {
  const dates: string[] = []
  const current = new Date(from)
  while (current <= to) {
    dates.push(formatYMD(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

function getPreviousPeriodRange(range?: DateRange): DateRange | undefined {
  const normalized = normalizeDateRange(range)
  if (!normalized) return undefined

  const { from, to } = normalized

  const isFirstDayOfMonth = from.getDate() === 1
  const currentRangeLastDay = new Date(
    to.getFullYear(),
    to.getMonth() + 1,
    0,
  ).getDate()
  const isLastDayOfMonth = to.getDate() === currentRangeLastDay

  if (isFirstDayOfMonth && isLastDayOfMonth) {
    const monthSpan =
      (to.getFullYear() - from.getFullYear()) * 12 +
      (to.getMonth() - from.getMonth()) +
      1

    const previousStart = new Date(
      from.getFullYear(),
      from.getMonth() - monthSpan,
      1,
    )
    const previousEnd = new Date(from.getFullYear(), from.getMonth(), 0)
    return { from: previousStart, to: previousEnd }
  }

  const dayCount = getRangeDayCount(normalized)
  return {
    from: addDays(normalized.from, -dayCount),
    to: addDays(normalized.from, -1),
  }
}


function getNextMonthRange(range?: DateRange): DateRange | undefined {
  const normalized = normalizeDateRange(range)
  if (!normalized) return undefined
  const year = normalized.to.getFullYear()
  const month = normalized.to.getMonth()
  // Calculate next month (handle year overflow)
  const nextYear = month === 11 ? year + 1 : year
  const nextMonth = month === 11 ? 0 : month + 1
  // First day of next month
  const from = new Date(nextYear, nextMonth, 1)
  // Last day of next month (day 0 of the month after = last day of target month)
  const to = new Date(nextYear, nextMonth + 1, 0)
  return { from, to }
}

function formatMetricValue(metric: ChartMetricKey, value: number) {
  if (metric === 'sales_amount' || metric === 'cpc' || metric === 'ad_spend') {
    return formatMoney(value)
  }
  if (metric === 'conversion_rate') {
    return `${(value * 100).toFixed(2)}%`
  }
  return value.toLocaleString('zh-CN')
}

function formatMetricCardValue(metric: ChartMetricKey, value: number) {
  if (metric === 'sales_amount' || metric === 'ad_spend') {
    if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(2)}k`
    return `$${formatMoney(value)}`
  }
  if (metric === 'cpc') {
    return `$${formatMoney(value)}`
  }
  if (metric === 'conversion_rate') {
    return `${(value * 100).toFixed(2)}%`
  }
  return value.toLocaleString('zh-CN')
}

function formatAxisValue(metric: ChartMetricKey, value: number) {
  if (metric === 'cpc') {
    return value.toFixed(2)
  }
  if (metric === 'sales_amount' || metric === 'ad_spend') {
    if (Math.abs(value) >= 1000) {
      return `$${(value / 1000).toFixed(1)}k`
    }
    return `$${value.toFixed(0)}`
  }
  if (metric === 'conversion_rate') {
    return `${(value * 100).toFixed(1)}%`
  }
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(1)}w`
  }
  return value.toFixed(0)
}

function metricIncreaseIsGood(metric: ChartMetricKey) {
  return metric !== 'cpc' && metric !== 'ad_spend'
}

function isBarMetric(metric: ChartMetricKey) {
  return (
    metric === 'order_qty' ||
    metric === 'ad_orders' ||
    metric === 'sales_amount' ||
    metric === 'units_ordered'
  )
}

function aggregateMetric(rows: DailyAnalysisRow[], metric: ChartMetricKey) {
  if (!rows.length) return 0
  if (metric === 'cpc') {
    const totalClicks = rows.reduce((sum, row) => sum + row.clicks, 0)
    if (totalClicks <= 0) return 0
    const totalAdSpend = rows.reduce((sum, row) => sum + row.ad_spend, 0)
    return totalAdSpend / totalClicks
  }
  if (metric === 'conversion_rate') {
    const totalPageViews = rows.reduce((sum, row) => sum + row.page_views, 0)
    const totalUnitsOrdered = rows.reduce((sum, row) => sum + row.units_ordered, 0)
    if (totalPageViews <= 0) return 0
    return totalUnitsOrdered / totalPageViews
  }
  return rows.reduce((sum, row) => sum + row[metric], 0)
}

function formatRangeLabel(range?: DateRange) {
  const normalized = normalizeDateRange(range)
  if (!normalized?.from || !normalized?.to) return '--'
  return `${formatYMD(normalized.from)} ~ ${formatYMD(normalized.to)}`
}

async function exportDailyAnalysisToExcel(
  summaryRows: DailyAnalysisRow[],
  detailRows: DailyAnalysisDetailRow[],
  projectName: string,
  country: string,
  dateRange: string,
  skuOptions: ProjectSkuOption[],
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const now = new Date()
  const safeDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

  // Sheet 1: 汇总
  const summarySheet = workbook.addWorksheet('日报汇总', {
    views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
  })

  const summaryCols = [
    { header: '日期', key: 'date', width: 14 },
    { header: '订单量', key: 'order_qty', width: 12 },
    { header: '销售额', key: 'sales_amount', width: 14 },
    { header: '曝光量', key: 'impressions', width: 14 },
    { header: '点击量', key: 'clicks', width: 12 },
    { header: 'CPC', key: 'cpc', width: 12 },
    { header: '广告花费', key: 'ad_spend', width: 14 },
    { header: '广告订单', key: 'ad_orders', width: 14 },
    { header: '可售库存', key: 'available_qty', width: 14 },
    { header: '页面浏览量', key: 'page_views', width: 14 },
    { header: '销量', key: 'units_ordered', width: 12 },
    { header: '访问量', key: 'sessions', width: 12 },
    { header: '转化率', key: 'conversion_rate', width: 12 },
  ]

  summarySheet.columns = summaryCols

  summarySheet.mergeCells(1, 1, 1, summaryCols.length)
  summarySheet.getCell(1, 1).value =
    `销售数据汇总 - ${projectName} - ${country}`
  summarySheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  summarySheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }
  summarySheet.getCell(1, 1).alignment = {
    vertical: 'middle',
    horizontal: 'left',
  }

  summarySheet.mergeCells(2, 1, 2, summaryCols.length)
  summarySheet.getCell(2, 1).value =
    `导出时间：${exportedAt}    日期范围：${dateRange}`
  summarySheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  summarySheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }
  summarySheet.getCell(2, 1).alignment = {
    vertical: 'middle',
    horizontal: 'left',
  }

  const summaryHeaderRow = summarySheet.getRow(3)
  summaryHeaderRow.values = summaryCols.map((c) => c.header)
  summaryHeaderRow.height = 22
  summaryHeaderRow.eachCell((cell) => {
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    }
    applyHeaderBorder(cell)
  })

  summaryRows.forEach((row, rowIndex) => {
    const excelRow = summarySheet.getRow(rowIndex + 4)
    excelRow.getCell(1).value = row.date
    excelRow.getCell(2).value = row.order_qty
    excelRow.getCell(3).value = row.sales_amount
    excelRow.getCell(3).numFmt = '#,##0.00'
    excelRow.getCell(4).value = row.impressions
    excelRow.getCell(5).value = row.clicks
    excelRow.getCell(6).value = row.cpc
    excelRow.getCell(6).numFmt = '#,##0.00'
    excelRow.getCell(7).value = row.ad_spend
    excelRow.getCell(7).numFmt = '#,##0.00'
    excelRow.getCell(8).value = row.ad_orders
    excelRow.getCell(9).value = row.available_qty
    excelRow.getCell(10).value = row.page_views
    excelRow.getCell(11).value = row.units_ordered
    excelRow.getCell(12).value = row.sessions
    excelRow.getCell(13).value = row.conversion_rate
    excelRow.getCell(13).numFmt = '0.00%'

    excelRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 1 ? 'center' : 'right',
      }
      applyBorder(cell)
    })
  })

  // Sheet 2: SKU明细
  const detailSheet = workbook.addWorksheet('SKU明细', {
    views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
  })

  const detailCols = [
    { header: '日期', key: 'date', width: 14 },
    { header: 'SKU', key: 'sku', width: 18 },
    { header: '品名', key: 'product_name', width: 32 },
    { header: '订单量', key: 'order_qty', width: 12 },
    { header: '销售额', key: 'sales_amount', width: 14 },
    { header: '曝光量', key: 'impressions', width: 14 },
    { header: '点击量', key: 'clicks', width: 12 },
    { header: 'CPC', key: 'cpc', width: 12 },
    { header: '广告花费', key: 'ad_spend', width: 14 },
    { header: '广告订单', key: 'ad_orders', width: 14 },
    { header: '可售库存', key: 'available_qty', width: 14 },
    { header: '在途数量', key: 'in_transit_qty', width: 14 },
    { header: '页面浏览量', key: 'page_views', width: 14 },
    { header: '销量', key: 'units_ordered', width: 12 },
    { header: '访问量', key: 'sessions', width: 12 },
    { header: '转化率', key: 'conversion_rate', width: 12 },
  ]

  detailSheet.columns = detailCols

  detailSheet.mergeCells(1, 1, 1, detailCols.length)
  detailSheet.getCell(1, 1).value =
    `销售数据SKU明细 - ${projectName} - ${country}`
  detailSheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  detailSheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }
  detailSheet.getCell(1, 1).alignment = {
    vertical: 'middle',
    horizontal: 'left',
  }

  detailSheet.mergeCells(2, 1, 2, detailCols.length)
  detailSheet.getCell(2, 1).value =
    `导出时间：${exportedAt}    日期范围：${dateRange}    共 ${detailRows.length} 条`
  detailSheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  detailSheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }
  detailSheet.getCell(2, 1).alignment = {
    vertical: 'middle',
    horizontal: 'left',
  }

  const detailHeaderRow = detailSheet.getRow(3)
  detailHeaderRow.values = detailCols.map((c) => c.header)
  detailHeaderRow.height = 22
  detailHeaderRow.eachCell((cell) => {
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    }
    applyHeaderBorder(cell)
  })

  const skuProductNameMap = new Map(
    skuOptions.map((s) => [s.sku, s.product_name ?? ''])
  )

  detailRows.forEach((row, rowIndex) => {
    const productName = skuProductNameMap.get(row.sku) ?? ''
    const excelRow = detailSheet.getRow(rowIndex + 4)
    excelRow.getCell(1).value = row.date
    excelRow.getCell(2).value = row.sku
    excelRow.getCell(3).value = productName
    excelRow.getCell(4).value = row.order_qty
    excelRow.getCell(5).value = row.sales_amount
    excelRow.getCell(5).numFmt = '#,##0.00'
    excelRow.getCell(6).value = row.impressions
    excelRow.getCell(7).value = row.clicks
    excelRow.getCell(8).value = row.cpc
    excelRow.getCell(8).numFmt = '#,##0.00'
    excelRow.getCell(9).value = row.ad_spend
    excelRow.getCell(9).numFmt = '#,##0.00'
    excelRow.getCell(10).value = row.ad_orders
    excelRow.getCell(11).value = row.available_qty
    excelRow.getCell(12).value = row.in_transit_qty
    excelRow.getCell(13).value = row.page_views
    excelRow.getCell(14).value = row.units_ordered
    excelRow.getCell(15).value = row.sessions
    excelRow.getCell(16).value = row.conversion_rate
    excelRow.getCell(16).numFmt = '0.00%'

    excelRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber <= 3 ? 'left' : 'right',
      }
      applyBorder(cell)
    })
  })

  let mergeStartRow = 4
  let groupIndex = 0
  for (let rowIndex = 1; rowIndex <= detailRows.length; rowIndex += 1) {
    const currentDate = detailRows[rowIndex]?.date
    const previousDate = detailRows[rowIndex - 1]?.date
    const isGroupBoundary = currentDate !== previousDate

    if (!isGroupBoundary) continue

    const mergeEndRow = rowIndex + 3
    const groupStartRow = mergeStartRow
    const groupRowCount = mergeEndRow - groupStartRow + 1
    const isEvenGroup = groupIndex % 2 === 0
    const groupFill = isEvenGroup ? 'FFFFFFFF' : 'FFF8FAFC'
    const groupBorder = 'FFCBD5E1'
    const strongGroupBorder = 'FF94A3B8'

    for (
      let currentRow = groupStartRow;
      currentRow <= mergeEndRow;
      currentRow += 1
    ) {
      const row = detailSheet.getRow(currentRow)
      for (let colNumber = 1; colNumber <= detailCols.length; colNumber += 1) {
        const cell = row.getCell(colNumber)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: groupFill },
        }
        cell.border = {
          top: {
            style: currentRow === groupStartRow ? 'medium' : 'thin',
            color: { argb: strongGroupBorder },
          },
          left: {
            style: colNumber === 1 ? 'medium' : 'thin',
            color: { argb: groupBorder },
          },
          bottom: {
            style: currentRow === mergeEndRow ? 'medium' : 'thin',
            color: { argb: strongGroupBorder },
          },
          right: {
            style: colNumber === detailCols.length ? 'medium' : 'thin',
            color: { argb: groupBorder },
          },
        }
      }
    }

    if (groupRowCount > 1) {
      detailSheet.mergeCells(groupStartRow, 1, mergeEndRow, 1)
    }

    const mergedDateCell = detailSheet.getCell(groupStartRow, 1)
    mergedDateCell.alignment = { vertical: 'middle', horizontal: 'center' }
    mergedDateCell.font = {
      name: 'Microsoft YaHei',
      size: 11,
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    mergedDateCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: groupFill },
    }
    mergedDateCell.border = {
      top: { style: 'medium', color: { argb: strongGroupBorder } },
      left: { style: 'medium', color: { argb: groupBorder } },
      bottom: { style: 'medium', color: { argb: strongGroupBorder } },
      right: { style: 'medium', color: { argb: groupBorder } },
    }

    mergeStartRow = rowIndex + 4
    groupIndex += 1
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `销售数据-${projectName}-${country}-${safeDate}.xlsx`
  link.click()
  window.URL.revokeObjectURL(url)
}

function lastSevenDaysRange(country: string): DateRange {
  const today = getTodayInTimezone(country)
  const end = today
  const start = addDays(end, -6)
  return { from: start, to: end }
}

function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function SearchableSkuField({
  value,
  options,
  loading,
  onChange,
}: {
  value: string
  options: ProjectSkuOption[]
  loading: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selectedSku = options.find((option) => option.sku === value)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
        <Button
          type='button'
          variant='outline'
          className='h-9 w-[200px] justify-between px-3 font-normal shadow-sm'
          onClick={() => setOpen(true)}
        >
        <span
          className={cn(
            'truncate text-left',
            value ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {selectedSku ? (
            <span className='flex items-center gap-1.5'>
              <span className='truncate font-medium'>{selectedSku.sku}</span>
              {selectedSku.product_name && (
                <span className='hidden truncate text-muted-foreground lg:inline'>
                  / {selectedSku.product_name}
                </span>
              )}
            </span>
          ) : loading ? (
            'SKU 加载中...'
          ) : (
            '全部 SKU'
          )}
        </span>
        <ChevronsUpDown className='ml-1 h-4 w-4 shrink-0 opacity-50' />
      </Button>
      <DialogContent aria-describedby="sku-search-dialog-description" className='overflow-hidden p-0 sm:max-w-xl'>
        <span id="sku-search-dialog-description" className="sr-only">搜索并选择 SKU</span>
        <Command className='max-h-[70vh]'>
          <CommandInput placeholder='搜索 SKU' />
          <CommandList>
            <CommandEmpty>
              {loading ? 'SKU 加载中...' : '没有匹配的 SKU'}
            </CommandEmpty>
            <CommandItem
              value='__all__'
              onSelect={() => {
                onChange('')
                setOpen(false)
              }}
              className={cn('flex items-center gap-2', !value && 'bg-accent')}
            >
              <Check
                className={cn(
                  'h-4 w-4 shrink-0',
                  !value ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className='font-medium'>全部 SKU</span>
            </CommandItem>
            {options.map((option) => {
              const missingUnits =
                !option.units_per_carton || option.units_per_carton <= 0
              return (
                <CommandItem
                  key={option.sku}
                  value={option.sku}
                  disabled={missingUnits}
                  onSelect={() => {
                    if (!missingUnits) {
                      onChange(option.sku)
                      setOpen(false)
                    }
                  }}
                  className={cn(
                    missingUnits && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      value === option.sku ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <div className='flex min-w-0 flex-1 items-center gap-2'>
                    <span className='truncate flex-1 font-medium'>
                      {option.sku}
                    </span>
                    {option.product_name && (
                      <span className='shrink-0 truncate max-w-[200px] text-muted-foreground text-xs'>
                        {option.product_name}
                      </span>
                    )}
                    {missingUnits && (
                      <span className='shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300'>
                        未维护单箱数
                      </span>
                    )}
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function FilterSkeleton() {
  return (
    <div className='space-y-1.5'>
      <Skeleton className='h-3 w-16' />
      <Skeleton className='h-10 w-full' />
    </div>
  )
}

function DailyMetricChart({
  rows,
  metric,
  isBar,
  color,
  showComparison,
  isMobile,
}: {
  rows: DailyChartRow[]
  metric: ChartMetricKey
  isBar: boolean
  color: string
  showComparison: boolean
  isMobile?: boolean
}) {
  const chartId = useId().replace(/:/g, '')
  const currentGradientId = `${chartId}-${metric}-current`
  const compareGradientId = `${chartId}-${metric}-compare`
  const lineGlowId = `${chartId}-${metric}-glow`

  const tooltipContent = ({
    active,
    payload,
    label,
  }: {
    active?: boolean
    payload?: Array<{
      color?: string
      dataKey?: string | number
      name?: string | number
      value?: unknown
    }>
    label?: string
  }) => {
    if (!active || !payload?.length) return null

    return (
      <div className='grid min-w-[10rem] gap-1.5 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl dark:border-border/95 dark:bg-[hsl(var(--surface-panel))]'>
        <div className='font-medium'>{label ?? ''}</div>
        <div className='grid gap-1.5'>
          {payload
            .filter((item) => item.value !== null && item.value !== undefined)
            .map((item, index) => {
              const itemLabel =
                (typeof item.name === 'string' || typeof item.name === 'number'
                  ? String(item.name)
                  : '') ||
                (item.dataKey === 'compareMetricValue'
                  ? '上一个周期'
                  : SINGLE_METRIC_CHART_CONFIG[metric].label)
              const value =
                typeof item.value === 'number'
                  ? formatMetricValue(metric, item.value)
                  : String(item.value ?? '')

              return (
                <div
                  key={`${item.dataKey ?? item.name ?? 'value'}-${index}`}
                  className='flex items-center justify-between gap-4'
                >
                  <span
                    className='font-medium'
                    style={{ color: item.color || undefined }}
                  >
                    {itemLabel}
                  </span>
                  <span className='font-mono font-medium text-foreground'>
                    {value}
                  </span>
                </div>
              )
            })}
        </div>
      </div>
    )
  }

  const mobileChartMargin = isBar
    ? { top: 12, right: 4, left: -12, bottom: 8 }
    : { top: 12, right: 4, left: -12, bottom: 8 }
  const desktopChartMargin = { top: 20, right: 8, left: 0, bottom: 12 }
  const chartMargin = isMobile ? mobileChartMargin : desktopChartMargin
  const tickFontSize = isMobile ? 10 : 12
  const lineStrokeWidth = isMobile ? 2 : 3
  const barRadius = isMobile ? [4, 4, 0, 0] as [number, number, number, number] : [8, 8, 0, 0] as [number, number, number, number]

  return (
    <div className='h-[300px] w-full md:h-[420px]'>
      <ResponsiveContainer width='100%' height='100%'>
        {isBar ? (
          <BarChart
            data={rows}
            margin={chartMargin}
            barGap={8}
          >
            <defs>
              <linearGradient id={currentGradientId} x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0%' stopColor={color} stopOpacity={0.98} />
                <stop offset='100%' stopColor={color} stopOpacity={0.72} />
              </linearGradient>
              <linearGradient id={compareGradientId} x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0%' stopColor='rgba(148,163,184,0.42)' />
                <stop offset='100%' stopColor='rgba(148,163,184,0.18)' />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke='rgba(148,163,184,0.18)'
              strokeDasharray='0'
            />
            <XAxis
              dataKey='date'
              axisLine={false}
              tickLine={false}
              tickMargin={isMobile ? 8 : 18}
              tick={{ fontSize: tickFontSize, fill: '#71717a' }}
              tickFormatter={(value) => {
                const [, month, day] = String(value).split('-')
                return isMobile ? `${month}/${day}` : `${month}月${day}日`
              }}
            />
            {!isMobile && (
              <YAxis
                axisLine={false}
                tickLine={false}
                tickMargin={16}
                tick={{ fontSize: 12, fill: '#71717a' }}
                domain={[0, 'auto']}
                tickFormatter={(value) =>
                  formatAxisValue(metric, Number(value))
                }
              />
            )}
            <Tooltip
              cursor={false}
              content={tooltipContent}
            />
            {showComparison ? (
              <Bar
                dataKey='compareMetricValue'
                name='上一个周期'
                fill={`url(#${compareGradientId})`}
                radius={barRadius}
                barSize={12}
                isAnimationActive
                animationDuration={320}
                animationEasing='ease-out'
                activeBar={{
                  fill: 'rgba(148,163,184,0.6)',
                  fillOpacity: 1,
                  stroke: 'rgba(148,163,184,0.8)',
                  strokeWidth: 2,
                }}
              />
            ) : null}
            <Bar
              dataKey={metric}
              name={SINGLE_METRIC_CHART_CONFIG[metric].label}
              fill={`url(#${currentGradientId})`}
              radius={barRadius}
              minPointSize={rows.some((row) => Number(row[metric] ?? 0) > 0) ? 2 : 0}
              barSize={12}
              isAnimationActive
              animationDuration={360}
              animationEasing='ease-out'
              activeBar={{
                fill: color,
                fillOpacity: 1,
                stroke: '#fff',
                strokeWidth: 2,
              }}
            />
          </BarChart>
        ) : (
          <LineChart
            data={rows}
            margin={chartMargin}
          >
            <defs>
              <filter id={lineGlowId} x='-20%' y='-20%' width='140%' height='140%'>
                <feGaussianBlur stdDeviation='3' result='blur' />
                <feColorMatrix
                  in='blur'
                  type='matrix'
                  values='1 0 0 0 0
                          0 1 0 0 0
                          0 0 1 0 0
                          0 0 0 0.2 0'
                  result='glow'
                />
                <feMerge>
                  <feMergeNode in='glow' />
                  <feMergeNode in='SourceGraphic' />
                </feMerge>
              </filter>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke='rgba(148,163,184,0.18)'
              strokeDasharray='0'
            />
            <XAxis
              dataKey='date'
              axisLine={false}
              tickLine={false}
              tickMargin={isMobile ? 6 : 12}
              tick={{ fontSize: isMobile ? 10 : 11, fill: '#71717a' }}
              tickFormatter={(value) => {
                const [, month, day] = String(value).split('-')
                return isMobile ? `${month}/${day}` : `${month}月${day}日`
              }}
            />
            {!isMobile && (
              <YAxis
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                tick={{ fontSize: 11, fill: '#71717a' }}
                domain={[0, 'auto']}
                tickFormatter={(value) =>
                  formatAxisValue(metric, Number(value))
                }
              />
            )}
            <Tooltip
              cursor={false}
              content={tooltipContent}
            />
            {showComparison ? (
              <Line
                type='monotone'
                dataKey='compareMetricValue'
                name='上一个周期'
                stroke='rgba(148,163,184,0.9)'
                strokeWidth={isMobile ? 2 : 2.5}
                strokeDasharray='6 6'
                dot={false}
                isAnimationActive
                animationDuration={320}
                animationEasing='ease-out'
              />
            ) : null}
            <Line
              type='monotone'
              dataKey={metric}
              name={SINGLE_METRIC_CHART_CONFIG[metric].label}
              stroke={color}
              strokeWidth={lineStrokeWidth}
              style={{ filter: `url(#${lineGlowId})` }}
              dot={false}
              isAnimationActive
              animationDuration={360}
              animationEasing='ease-out'
              activeDot={{
                r: 5,
                fill: color,
                stroke: '#fff',
                strokeWidth: 2,
              }}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

export default function DailyAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const isMobile = useIsMobile()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState<string>('all')
  const [country, setCountry] = useState<CountryOption>('US')
  const defaultRange = useMemo(() => lastSevenDaysRange(country), [country])
  const [dateRange, setDateRange] = useState<DateRange | undefined>(
    defaultRange,
  )
  const [activeTab, setActiveTab] = useState<ViewTab>('summary')
  const [activeChartMetric, setActiveChartMetric] =
    useState<ChartMetricKey>('order_qty')

  const [goalProgress, setGoalProgress] = useState<{
    target_amount: number
    achieved_amount: number
    completion_vs_monthly: number
    completion_vs_daily: number
    today_day: number
    days_in_month: number
    currency: string
  } | null>(null)
  const [goalLoading, setGoalLoading] = useState(false)
  const [data, setData] = useState<DailyAnalysisResponse | null>(null)
  const [comparisonSummaryRows, setComparisonSummaryRows] =
    useState<DailyAnalysisRow[]>(EMPTY_SUMMARY_ROWS)
  const [comparisonDetailRows, setComparisonDetailRows] =
    useState<DailyAnalysisDetailRow[]>(EMPTY_DETAIL_ROWS)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [skuOptions, setSkuOptions] = useState<ProjectSkuOption[]>([])
  const [skuLoading, setSkuLoading] = useState(false)
  const [selectedSku, setSelectedSku] = useState('')
  const selectedSkuRef = useRef('')
  const [metricCardPage, setMetricCardPage] = useState(0)
  const METRICS_PER_PAGE = 6
  const latestLoadRequestRef = useRef(0)

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(rows.filter((item) => item.id !== null))
      } catch (fetchError) {
        notify({
          type: 'error',
          title: '项目列表加载失败',
          message:
            fetchError instanceof Error
              ? fetchError.message
              : '项目列表加载失败',
        })
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [notify, session])

  useEffect(() => {
    if (projectId || projects.length === 0) return
    const first = projects.find((item) => item.id !== null)
    if (first?.id != null) setProjectId(String(first.id))
  }, [projectId, projects])

  const isAllProjects = projectId === 'all'

  // When country changes, reset dateRange to "last 7 days in that country's timezone".
  useEffect(() => {
    setDateRange(defaultRange)
  }, [country, defaultRange])

  const loadData = useCallback(
    async (rangeOverride?: DateRange, clearCache: boolean = false) => {
      const effectiveRange = normalizeDateRange(rangeOverride ?? dateRange)
      if (!effectiveRange?.from || !effectiveRange?.to) {
        notify({ type: 'error', title: '请选择开始和结束日期' })
        return
      }

      // skipRedis: when refreshing, bypass server-side Redis cache
      const skipRedis = clearCache

      const startDate = formatYMD(effectiveRange.from)
      const endDate = formatYMD(effectiveRange.to)
      const previousRange = getPreviousPeriodRange(effectiveRange)

      setLoading(true)
      const requestId = latestLoadRequestRef.current + 1
      latestLoadRequestRef.current = requestId
      try {
        if (isAllProjects) {
          if (projects.length === 0) return
          const ids = projects.map((p) => String(p.id)).join(',')
          const search = new URLSearchParams({
            project_ids: ids,
            country,
            start_date: startDate,
            end_date: endDate,
            ...(skipRedis && { no_cache: 'true' }),
          })
          const compareSearch = previousRange
            ? new URLSearchParams({
                project_ids: ids,
                country,
                start_date: formatYMD(previousRange.from!),
                end_date: formatYMD(previousRange.to!),
              })
            : null

          const [response, compareResponse] = await Promise.all([
            fetch(`${API_BASE}/api/v1/daily-analysis/all?${search.toString()}`, {
              headers: authHeaders(),
              cache: 'no-store',
            }),
            compareSearch
              ? fetch(
                  `${API_BASE}/api/v1/daily-analysis/all?${compareSearch.toString()}`,
                  {
                    headers: authHeaders(),
                    cache: 'no-store',
                  },
                )
              : Promise.resolve(null),
          ])
          if (!response.ok) {
            const payload = await response.json().catch(() => null)
            throw new Error(payload?.detail || '销售数据加载失败')
          }
          if (compareResponse && !compareResponse.ok) {
            const payload = await compareResponse.json().catch(() => null)
            throw new Error(payload?.detail || '销售数据对比加载失败')
          }

          const payload = (await response.json()) as DailyAnalysisAllProjectsResponse
          const comparePayload = compareResponse
            ? ((await compareResponse.json()) as DailyAnalysisAllProjectsResponse)
            : null
          if (requestId !== latestLoadRequestRef.current) return
          setData({
            console: {
              project_id: 0,
              project_name: '全部项目',
              country,
              start_date: startDate,
              end_date: endDate,
              requested_days: 0,
              summary_days: payload.summary_rows.length,
              detail_rows: payload.detail_rows.length,
              sales_source_days: 0,
              ad_source_days: 0,
              inventory_source_days: 0,
              business_source_days: 0,
              missing_dates: [],
              latest_sales_date: null,
              latest_ad_date: null,
              latest_inventory_date: null,
              latest_business_date: null,
            },
            summary_rows: payload.summary_rows,
            detail_rows: payload.detail_rows,
            available_dates: payload.available_dates,
          })
          setComparisonSummaryRows(
            comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS,
          )
          setComparisonDetailRows(
            comparePayload?.detail_rows ?? EMPTY_DETAIL_ROWS,
          )
        } else {
          if (!projectId) {
            notify({ type: 'error', title: '请先选择项目' })
            return
          }
          const search = new URLSearchParams({
            project_id: projectId,
            country,
            start_date: startDate,
            end_date: endDate,
            ...(selectedSkuRef.current && { sku: selectedSkuRef.current }),
            ...(skipRedis && { no_cache: 'true' }),
          })
          const compareSearch = previousRange
            ? new URLSearchParams({
                project_id: projectId,
                country,
                start_date: formatYMD(previousRange.from!),
                end_date: formatYMD(previousRange.to!),
                ...(selectedSkuRef.current && { sku: selectedSkuRef.current }),
              })
            : null

          const [response, compareResponse] = await Promise.all([
            fetch(`${API_BASE}/api/v1/daily-analysis?${search.toString()}`, {
              headers: authHeaders(),
              cache: 'no-store',
            }),
            compareSearch
              ? fetch(
                  `${API_BASE}/api/v1/daily-analysis?${compareSearch.toString()}`,
                  {
                    headers: authHeaders(),
                    cache: 'no-store',
                  },
                )
              : Promise.resolve(null),
          ])
          if (!response.ok) {
            const payload = await response.json().catch(() => null)
            throw new Error(payload?.detail || '销售数据加载失败')
          }
          if (compareResponse && !compareResponse.ok) {
            const payload = await compareResponse.json().catch(() => null)
            throw new Error(payload?.detail || '销售数据对比加载失败')
          }

          const payload = (await response.json()) as DailyAnalysisResponse
          const comparePayload = compareResponse
            ? ((await compareResponse.json()) as DailyAnalysisResponse)
            : null
          if (requestId !== latestLoadRequestRef.current) return
          setData(payload)
          setComparisonSummaryRows(
            comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS,
          )
          setComparisonDetailRows(
            comparePayload?.detail_rows ?? EMPTY_DETAIL_ROWS,
          )
        }
      } catch (fetchError) {
        if (requestId !== latestLoadRequestRef.current) return
        notify({
          type: 'error',
          title: '销售数据加载失败',
          message:
            fetchError instanceof Error
              ? fetchError.message
              : '销售数据加载失败',
        })
        setData(null)
        setComparisonSummaryRows(EMPTY_SUMMARY_ROWS)
        setComparisonDetailRows(EMPTY_DETAIL_ROWS)
      } finally {
        if (requestId !== latestLoadRequestRef.current) return
        setLoading(false)
      }
    },
    [projectId, country, dateRange, notify, isAllProjects, projects],
  )

  const loadProjectSkus = useCallback(
    async (projectIdText: string, countryValue: string) => {
      const projectIdNum = Number(projectIdText)
      const projectName = projects.find(
        (project) => project.id === projectIdNum,
      )?.name
      if (!projectName) {
        setSkuOptions([])
        return
      }

      setSkuLoading(true)
      try {
        const allItems: ProjectSkuOption[] = []
        let nextPage = 1
        let hasNextPage = true

        while (hasNextPage) {
          const params = new URLSearchParams({
            project_name: projectName,
            country: countryValue,
            page: String(nextPage),
            page_size: '200',
          })
          const response = await fetch(
            `${API_BASE}/api/v1/sku-info?${params.toString()}`,
            {
              headers: authHeaders(),
              cache: 'no-store',
            },
          )
          if (!response.ok) throw new Error(await response.text())

          const payload = (await response.json()) as {
            items: Array<{
              sku: string
              asin: string | null
              fnsku: string | null
              product_name: string | null
              units_per_carton: number
              carton_length_cm: number | null
              carton_width_cm: number | null
              carton_height_cm: number | null
              carton_weight_kg: number | null
            }>
            has_next: boolean
          }
          allItems.push(
            ...payload.items.map((item) => ({
              sku: item.sku,
              asin: item.asin,
              fnsku: item.fnsku,
              product_name: item.product_name,
              units_per_carton: item.units_per_carton,
              carton_length_cm: item.carton_length_cm,
              carton_width_cm: item.carton_width_cm,
              carton_height_cm: item.carton_height_cm,
              carton_weight_kg: item.carton_weight_kg,
            })),
          )
          hasNextPage = payload.has_next
          nextPage += 1
        }

        setSkuOptions(allItems)
      } catch (loadError) {
        setSkuOptions([])
        notify({
          type: 'error',
          title: '项目 SKU 列表加载失败',
          message: loadError instanceof Error ? loadError.message : '加载失败',
        })
      } finally {
        setSkuLoading(false)
      }
    },
    [notify, projects],
  )

  useEffect(() => {
    if (!projectId) return
    selectedSkuRef.current = ''
    setSelectedSku('')
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    void loadProjectSkus(projectId, country)
  }, [projectId, country, loadProjectSkus])

  useEffect(() => {
    if (!projectId) return
    void loadData()
  }, [loadData])

  // Fetch current month goal progress
  useEffect(() => {
    if (!projectId || isAllProjects) {
      setGoalProgress(null)
      return
    }
    const year = new Date().getFullYear()
    const month = new Date().getMonth() + 1
    setGoalLoading(true)
    fetch(
      `${API_BASE}/api/v1/project-goals/progress?project_id=${projectId}&country=${country}&year=${year}`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        const monthly = (data.monthly_progress ?? []).find(
          (m: { month: number }) => m.month === month,
        )
        if (monthly) setGoalProgress(monthly)
      })
      .catch(() => {
        /* silently fail */
      })
      .finally(() => setGoalLoading(false))
  }, [projectId, country])

  const summaryRows = data?.summary_rows ?? EMPTY_SUMMARY_ROWS
  const detailRows = data?.detail_rows ?? EMPTY_DETAIL_ROWS
  const consoleData = data?.console ?? null

  const filteredDetailRows = useMemo(() => {
    if (!selectedSku) return EMPTY_DETAIL_ROWS
    return detailRows.filter((row) => row.sku === selectedSku)
  }, [detailRows, selectedSku])

  const detailDisplayRows = useMemo<DetailDisplayRow[]>(() => {
    const rowsToGroup = selectedSku ? filteredDetailRows : detailRows
    const groupedRows: DetailDisplayRow[] = []
    let index = 0
    let groupIndex = 0

    while (index < rowsToGroup.length) {
      const groupDate = rowsToGroup[index].date
      let endIndex = index + 1

      while (
        endIndex < rowsToGroup.length &&
        rowsToGroup[endIndex].date === groupDate
      ) {
        endIndex += 1
      }

      const rowSpan = endIndex - index
      const isTintedGroup = groupIndex % 2 === 0

      for (
        let currentIndex = index;
        currentIndex < endIndex;
        currentIndex += 1
      ) {
        const row = rowsToGroup[currentIndex]
        const skuInfo = skuOptions.find((s) => s.sku === row.sku)
        groupedRows.push({
          row,
          rowKey: `${row.date}-${row.sku}-${row.asin ?? 'no-asin'}-${currentIndex}`,
          showDate: currentIndex === index,
          rowSpan: currentIndex === index ? rowSpan : 0,
          isTintedGroup,
          productName: skuInfo?.product_name ?? null,
        })
      }

      index = endIndex
      groupIndex += 1
    }

    return groupedRows
  }, [detailRows, filteredDetailRows, selectedSku, skuOptions])

  const selectedProjectName = useMemo(
    () => projects.find((p) => String(p.id) === projectId)?.name ?? '',
    [projects, projectId],
  )
  const activeChartMetricLabel =
    CHART_METRICS.find((item) => item.key === activeChartMetric)?.label ??
    '订单'

  const chartDataRows = selectedSku ? filteredDetailRows : summaryRows

  const filteredComparisonRows = useMemo(() => {
    if (!selectedSku || comparisonDetailRows.length === 0)
      return EMPTY_DETAIL_ROWS
    return comparisonDetailRows.filter((row) => row.sku === selectedSku)
  }, [selectedSku, comparisonDetailRows])

  const comparisonDataRows = selectedSku
    ? filteredComparisonRows
    : comparisonSummaryRows

  const metricCards = useMemo(() => {
    return CHART_METRICS.map((metric) => {
      const currentValue = aggregateMetric(chartDataRows, metric.key)
      const hasComparison = comparisonDataRows.length > 0
      const previousValue = hasComparison
        ? aggregateMetric(comparisonDataRows, metric.key)
        : 0
      const diff = currentValue - previousValue
      const percentChange =
        previousValue === 0 ? null : (diff / previousValue) * 100
      const isPositiveDirection =
        percentChange === null
          ? true
          : metricIncreaseIsGood(metric.key)
            ? percentChange >= 0
            : percentChange <= 0

      return {
        ...metric,
        currentValue,
        previousValue,
        percentChange,
        isPositiveDirection,
        hasComparison,
        showComparisonBadge: comparisonDataRows.length > 0,
      }
    })
  }, [chartDataRows, comparisonDataRows])
  const comparisonRange = useMemo(
    () => getPreviousPeriodRange(dateRange),
    [dateRange],
  )
  const hasComparisonData = comparisonDataRows.length > 0
  const chartRows = useMemo(() => {
    const normalizedRange = normalizeDateRange(dateRange)
    if (!normalizedRange?.from || !normalizedRange?.to) {
      return []
    }
    const allDates = generateDateRangeStrings(
      normalizedRange.from,
      normalizedRange.to,
    )

    if (selectedSku) {
      const existingData = new Map(
        filteredDetailRows.map((row) => [row.date, row]),
      )
      const comparisonDataByIndex = filteredComparisonRows
      return allDates.map((date, index) => {
        const row = existingData.get(date)
        const compareRow = comparisonDataByIndex[index]
        return {
          date,
          [activeChartMetric]: row ? row[activeChartMetric] : 0,
          compareMetricValue: compareRow ? compareRow[activeChartMetric] : null,
        }
      })
    }

    const summaryData = new Map(summaryRows.map((row) => [row.date, row]))
    const comparisonDataByIndex = comparisonSummaryRows

    return allDates.map((date, index) => {
      const row = summaryData.get(date)
      const compareRow = comparisonDataByIndex[index]
      return {
        date,
        order_qty: row?.order_qty ?? 0,
        sales_amount: row?.sales_amount ?? 0,
        impressions: row?.impressions ?? 0,
        clicks: row?.clicks ?? 0,
        cpc: row?.cpc ?? 0,
        ad_spend: row?.ad_spend ?? 0,
        ad_orders: row?.ad_orders ?? 0,
        available_qty: row?.available_qty ?? 0,
        page_views: row?.page_views ?? 0,
        units_ordered: row?.units_ordered ?? 0,
        sessions: row?.sessions ?? 0,
        ordered_sales_amount: row?.ordered_sales_amount ?? 0,
        conversion_rate: row?.conversion_rate ?? 0,
        compareMetricValue: compareRow ? compareRow[activeChartMetric] : null,
      }
    })
  }, [
    selectedSku,
    filteredDetailRows,
    filteredComparisonRows,
    summaryRows,
    comparisonSummaryRows,
    activeChartMetric,
    dateRange,
  ])

  const summaryTableRows = selectedSku ? filteredDetailRows : summaryRows
  const dateRangeDisplay = consoleData
    ? `${consoleData.start_date} ~ ${consoleData.end_date}`
    : dateRange
      ? `${formatYMD(dateRange.from!)}${' ~ ' + formatYMD(dateRange.to!)}`
      : ''
  const handleExportExcel = async () => {
    if (!data) return
    setExporting(true)
    try {
      const exportSummaryRows = selectedSku ? filteredDetailRows : summaryRows
      const exportDetailRows = selectedSku ? filteredDetailRows : detailRows
      await exportDailyAnalysisToExcel(
        exportSummaryRows,
        exportDetailRows,
        selectedProjectName,
        country,
        dateRangeDisplay,
        skuOptions,
      )
      await logClientOperation({
        action: 'daily_analysis.export',
        targetType: 'daily_analysis',
        targetId: projectId || null,
        after: {
          project_id: projectId || null,
          project_name: selectedProjectName,
          country,
          date_range: dateRangeDisplay,
          selected_sku: selectedSku || null,
          summary_count: exportSummaryRows.length,
          detail_count: exportDetailRows.length,
        },
      })
    } catch (exportError) {
      console.error('导出失败:', exportError)
    } finally {
      setExporting(false)
    }
  }

  const handleQuickRange = async (nextRange: DateRange) => {
    setDateRange(nextRange)
    await loadData(nextRange)
  }

  return (
    <div className='space-y-5 lg:space-y-6'>
      <DataCard>
        <DataCardHeader
          title='控制台'
          titleClassName='text-2xl tracking-tight'
        />
        <div className='space-y-0'>
          {/* 筛选区 — 桌面端横向排列（无标签） */}
          <div className='dashboard-toolbar hidden md:flex flex-wrap items-center gap-3 px-4 py-4 lg:px-6 lg:py-5'>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="h-9 w-[140px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none [&>span]:truncate dark:border-border/85 dark:bg-[hsl(var(--surface-overlay)]">
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部项目</SelectItem>
                {projects.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <CountrySelect value={country} onChange={(value) => setCountry(value as CountryOption)} triggerClassName="h-9 w-[120px]" />
            <SearchableSkuField value={selectedSku} options={skuOptions} loading={skuLoading} onChange={(value) => { selectedSkuRef.current = value; setSelectedSku(value); setActiveTab('summary'); void loadData() }} />
            <DateRangePicker value={dateRange} onChange={setDateRange} className='h-9 w-[220px]' timezone={COUNTRY_TIMEZONE_MAP[country]} onApply={() => void loadData()} />
            <RefreshButton onClick={() => void loadData(undefined, true)} loading={loading || projectsLoading} label="刷新数据" size="default" variant="outline" className="h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]" />
          </div>
          {/* 筛选区 — 手机端 2 列网格（无标签） */}
          <div className='dashboard-toolbar md:hidden px-4 py-3'>
            <div className='grid grid-cols-2 gap-2'>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="项目" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部项目</SelectItem>
                  {projects.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <CountrySelect value={country} onChange={(value) => setCountry(value as CountryOption)} triggerClassName="h-9" />
            </div>
            <div className='mt-2'>
              <div className='grid grid-cols-2 gap-2'>
                <SearchableSkuField value={selectedSku} options={skuOptions} loading={skuLoading} onChange={(value) => { selectedSkuRef.current = value; setSelectedSku(value); setActiveTab('summary'); void loadData() }} />
                <DateRangePicker value={dateRange} onChange={setDateRange} className='h-9 w-full' timezone={COUNTRY_TIMEZONE_MAP[country]} onApply={() => void loadData()} />
              </div>
            </div>
            <div className='flex gap-2 mt-2'>
              <RefreshButton onClick={() => void loadData(undefined, true)} loading={loading || projectsLoading} label="刷新" size="sm" variant="outline" className="flex-1 h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]" />
              <Button type='button' variant='outline' size='sm' onClick={() => void handleQuickRange(lastSevenDaysRange(country))} className='flex-1 h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85'>近7天</Button>
            </div>
          </div>
          {goalProgress && goalProgress.target_amount > 0 && (
            <div className='dashboard-toolbar flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/50 px-4 py-3 md:px-6'>
              <Target className='h-4 w-4 shrink-0 text-blue-500' />
              <div className='text-xs font-medium text-foreground shrink-0'>{new Date().getMonth() + 1}月目标<span className='ml-1.5 text-muted-foreground'>{goalProgress.today_day}/{goalProgress.days_in_month}日</span></div>
              <div className='flex items-center gap-1.5 shrink-0'>
                <div className='w-20 md:w-24 rounded-full bg-muted/70 h-1'><div className='h-full rounded-full transition-all' style={{ width: `${Math.min(goalProgress.completion_vs_monthly * 100, 100)}%`, background: goalProgress.completion_vs_monthly >= 1 ? '#22c55e' : '#3b82f6' }} /></div>
                <span className='text-xs font-semibold tabular-nums'>{(goalProgress.completion_vs_monthly * 100).toFixed(1)}%</span>
              </div>
              <div className='flex items-center gap-1.5 shrink-0'>
                <div className='w-20 md:w-24 rounded-full bg-muted/70 h-1'><div className='h-full rounded-full transition-all' style={{ width: `${Math.min(goalProgress.completion_vs_daily * 100, 100)}%`, background: goalProgress.completion_vs_daily >= 1 ? '#22c55e' : '#8b5cf6' }} /></div>
                <span className='text-xs font-semibold tabular-nums'>{(goalProgress.completion_vs_daily * 100).toFixed(1)}%</span>
              </div>
              <span className='text-xs text-muted-foreground truncate'>{goalProgress.currency}{goalProgress.achieved_amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {goalProgress.currency}{goalProgress.target_amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <Link href={`/dashboard/data-analysis/project-goals?project=${projectId}&country=${country}`} className='shrink-0 text-xs text-blue-500 hover:text-blue-600 hover:underline'>目标详情 →</Link>
            </div>
          )}
        </div>
      </DataCard>

      <DataCard>
        <DataCardContent className='space-y-4'>
          {comparisonDataRows.length > 0 && (
            <div className='flex flex-wrap items-center gap-2'>
              <Badge
                variant='outline'
                className='border-border/60 bg-background/85 px-3 py-1 text-foreground'
              >
                对比区间：{formatRangeLabel(comparisonRange)}
              </Badge>
            </div>
          )}
          {(summaryRows.length || (selectedSku && filteredDetailRows.length)) ? (
            <>
              {/* 桌面端：左右箭头 + 网格 */}
              <div className='hidden sm:flex items-center gap-2'>
                <button
                  type='button'
                  onClick={() => setMetricCardPage((p) => Math.max(0, p - 1))}
                  disabled={metricCardPage === 0}
                  className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-30'
                >
                  <ChevronLeft className='h-4 w-4' />
                </button>
                <DataTableCardMetrics className='grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 flex-1'>
                  {metricCards
                    .slice(metricCardPage * METRICS_PER_PAGE, (metricCardPage + 1) * METRICS_PER_PAGE)
                    .map((metric) => {
                      const isActive = metric.key === activeChartMetric
                      const showIncrease = metric.percentChange === null ? true : metric.percentChange >= 0
                      const usePositiveColor = metric.percentChange === null ? true : metric.isPositiveDirection
                      return (
                        <button
                          key={metric.key}
                          type='button'
                          onClick={() => setActiveChartMetric(metric.key)}
                          className={cn(
                            'rounded-lg border px-3 py-3 text-left transition-all duration-200',
                            isActive
                              ? 'border-primary/45 bg-primary text-primary-foreground shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.72)]'
                              : 'border-border/70 bg-[hsl(var(--surface-soft))]/86 text-foreground hover:-translate-y-0.5 hover:border-border hover:bg-background',
                          )}
                        >
                          <div className='flex items-start justify-between gap-2'>
                            <div className={cn('text-xs font-semibold tracking-tight', isActive ? 'text-primary-foreground/88' : 'text-muted-foreground')}>
                              {metric.label}
                            </div>
                            {metric.showComparisonBadge ? (
                              <div className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold backdrop-blur-sm',
                                isActive
                                  ? usePositiveColor
                                    ? 'border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(220,252,231,0.92))] text-[hsl(var(--success))] shadow-[0_10px_24px_-14px_rgba(255,255,255,0.9)]'
                                    : 'border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(254,226,226,0.92))] text-[hsl(var(--destructive))] shadow-[0_10px_24px_-14px_rgba(255,255,255,0.9)]'
                                  : usePositiveColor
                                    ? 'border-[hsl(var(--success))/0.28] bg-[hsl(var(--success))/0.12] text-[hsl(var(--success))]'
                                    : 'border-destructive/25 bg-destructive/12 text-destructive',
                              )}>
                                {showIncrease ? <ArrowUp className='h-3 w-3' /> : <ArrowDown className='h-3 w-3' />}
                                {metric.percentChange === null ? '--' : `${Math.abs(metric.percentChange).toFixed(1)}%`}
                              </div>
                            ) : <div className='h-[28px] w-[60px]' />}
                          </div>
                          <div className='mt-3 space-y-0.5'>
                            <div className={cn('text-[1.25rem] font-semibold tracking-tight', isActive ? 'text-primary-foreground' : 'text-foreground')}>
                              {formatMetricCardValue(metric.key, metric.currentValue)}
                            </div>
                            <div className={cn('text-xs', isActive ? 'text-primary-foreground/72' : 'text-muted-foreground')}>
                              {metric.hasComparison ? `对比 ${formatMetricCardValue(metric.key, metric.previousValue)}` : (selectedSku ? 'SKU 明细' : '暂无对比')}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                </DataTableCardMetrics>
                <button
                  type='button'
                  onClick={() => setMetricCardPage((p) => Math.min(Math.ceil(metricCards.length / METRICS_PER_PAGE) - 1, p + 1))}
                  disabled={metricCardPage >= Math.ceil(metricCards.length / METRICS_PER_PAGE) - 1}
                  className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-30'
                >
                  <ChevronRight className='h-4 w-4' />
                </button>
              </div>
              {/* 手机端：左右滑动 + 指示点 */}
              <div className='sm:hidden'>
                {/* 可滑动容器 */}
                <div
                  className='flex gap-2 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1 scrollbar-hide'
                  style={{ WebkitOverflowScrolling: 'touch' }}
                >
                  {metricCards.map((metric) => {
                    const isActive = metric.key === activeChartMetric
                    const showIncrease = metric.percentChange === null ? true : metric.percentChange >= 0
                    const usePositiveColor = metric.percentChange === null ? true : metric.isPositiveDirection
                    return (
                      <button
                        key={metric.key}
                        type='button'
                        onClick={() => setActiveChartMetric(metric.key)}
                        className={cn(
                          'flex-none snap-start rounded-lg border px-3 py-2.5 text-left transition-all duration-200 w-[calc(50%-0.25rem)]',
                          isActive
                            ? 'border-primary/45 bg-primary text-primary-foreground shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.72)]'
                            : 'border-border/70 bg-[hsl(var(--surface-soft))]/86 text-foreground',
                        )}
                      >
                        <div className='flex items-start justify-between gap-1.5'>
                          <div className={cn('text-[10px] font-semibold tracking-tight', isActive ? 'text-primary-foreground/88' : 'text-muted-foreground')}>
                            {metric.label}
                          </div>
                          {metric.showComparisonBadge ? (
                            <div className={cn(
                              'flex-none inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm',
                              isActive
                                ? usePositiveColor
                                  ? 'border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(220,252,231,0.92))] text-[hsl(var(--success))]'
                                  : 'border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(254,226,226,0.92))] text-[hsl(var(--destructive))]'
                                : usePositiveColor
                                  ? 'border-[hsl(var(--success))/0.28] bg-[hsl(var(--success))/0.12] text-[hsl(var(--success))]'
                                  : 'border-destructive/25 bg-destructive/12 text-destructive',
                            )}>
                              {showIncrease ? <ArrowUp className='h-2.5 w-2.5' /> : <ArrowDown className='h-2.5 w-2.5' />}
                              {metric.percentChange === null ? '--' : `${Math.abs(metric.percentChange).toFixed(1)}%`}
                            </div>
                          ) : null}
                        </div>
                        <div className='mt-2 space-y-0.5'>
                          <div className={cn('text-[1.1rem] font-semibold tracking-tight', isActive ? 'text-primary-foreground' : 'text-foreground')}>
                            {formatMetricCardValue(metric.key, metric.currentValue)}
                          </div>
                          <div className={cn('text-[10px]', isActive ? 'text-primary-foreground/72' : 'text-muted-foreground')}>
                            {metric.hasComparison ? `对比 ${formatMetricCardValue(metric.key, metric.previousValue)}` : (selectedSku ? 'SKU 明细' : '暂无对比')}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
                {/* 指示点（当前激活的卡片的对应点高亮） */}
                <div className='flex justify-center gap-1.5 mt-1'>
                  {Array.from({ length: Math.ceil(metricCards.length / METRICS_PER_PAGE) }).map((_, i) => {
                    const startIdx = i * METRICS_PER_PAGE
                    const endIdx = startIdx + METRICS_PER_PAGE
                    const isActiveGroup = metricCards.slice(startIdx, endIdx).some(m => m.key === activeChartMetric)
                    return (
                      <button
                        key={i}
                        type='button'
                        onClick={() => setMetricCardPage(i)}
                        className={cn(
                          'h-1.5 rounded-full transition-all',
                          isActiveGroup ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                        )}
                      />
                    )
                  })}
                </div>
              </div>

              <div className={cn('rounded-lg bg-[hsl(var(--surface-soft))]/82', isMobile ? 'px-1 pt-2 pb-0' : 'p-4 md:p-5')}>
                <div className={cn('mb-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground', isMobile && 'mb-2 gap-2 px-1')}>
                  <div className={cn('inline-flex items-center gap-2 rounded-full bg-background/72 px-3 py-1.5', isMobile && 'px-2 py-1 text-[10px]')}>
                    <span
                      className='h-2.5 w-2.5 rounded-full'
                      style={{
                        backgroundColor:
                          SINGLE_METRIC_CHART_CONFIG[activeChartMetric].color,
                      }}
                    />
                    当前周期
                  </div>
                  {hasComparisonData ? (
                    isBarMetric(activeChartMetric) ? (
                      <div className='inline-flex items-center gap-2 rounded-full bg-[hsl(var(--surface-soft))] px-3 py-1.5 dark:bg-[hsl(var(--surface-strong))]'>
                        <span
                          className='h-3 w-3 rounded-sm border border-border/70'
                          style={{ backgroundColor: 'rgba(148,163,184,0.28)' }}
                        />
                        上一个周期
                      </div>
                    ) : (
                      <div className='inline-flex items-center gap-2 rounded-full bg-[hsl(var(--surface-soft))] px-3 py-1.5 dark:bg-[hsl(var(--surface-strong))]'>
                        <span className='w-5 border-t-2 border-dashed border-border/70' />
                        上一个周期
                      </div>
                    )
                  ) : null}
                </div>

                <DailyMetricChart
                  rows={chartRows as DailyChartRow[]}
                  metric={activeChartMetric}
                  isBar={isBarMetric(activeChartMetric)}
                  color={getChartColor(activeChartMetric)}
                  showComparison={hasComparisonData}
                  isMobile={isMobile}
                />
              </div>
            </>
          ) : (
            <div className='flex min-h-[320px] items-center justify-center rounded-lg bg-[hsl(var(--surface-soft))]/82 px-6 text-center'>
              <div className='space-y-2'>
                <div className='text-base font-semibold text-foreground'>
                  图表区域暂时没有内容
                </div>
                <div className='text-sm text-muted-foreground'>
                  当前筛选范围内暂无可用于绘图的数据
                </div>
              </div>
            </div>
          )}
        </DataCardContent>
      </DataCard>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ViewTab)}
        className='w-full'
      >
        <div className="sticky top-0 z-30">
        <DataTableCard>
          <DataTableCardHeader className='flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center lg:justify-between pb-3 sm:pb-4 px-4 md:px-6'>
            <div>
              <div className='text-sm sm:text-base font-semibold text-foreground'>
                销售数据工作区
              </div>
            </div>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => void handleExportExcel()}
                disabled={exporting || !data}
                className='h-9 px-3 sm:px-4 w-full sm:w-auto'
              >
                {exporting ? (
                  <Loader2 className='mr-1.5 sm:mr-2 h-4 w-4 animate-spin' />
                ) : (
                  <FileDown className='mr-1.5 sm:mr-2 h-4 w-4' />
                )}
                导出
              </Button>
              <TabsMotionGroup id='daily-analysis-tabs'>
                <TabsList className='grid h-auto w-full grid-cols-2 border border-border/70 bg-[hsl(var(--surface-soft))]/90 p-1 sm:w-[260px] dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'>
                  <SlidingTabsTrigger
                    value='summary'
                    activeValue={activeTab}
                    layoutId='daily-analysis-tab-indicator'
                    className='py-2'
                  >
                    每日汇总
                  </SlidingTabsTrigger>
                  <SlidingTabsTrigger
                    value='details'
                    activeValue={activeTab}
                    layoutId='daily-analysis-tab-indicator'
                    className='py-2'
                  >
                    SKU 明细
                  </SlidingTabsTrigger>
                </TabsList>
              </TabsMotionGroup>
            </div>
          </DataTableCardHeader>

          <DataTableCardBody>
            <DirectionalTabTransition value={activeTab} order={VIEW_TAB_ORDER}>
              <TabsContent forceMount value={activeTab} className='m-0'>
                {activeTab === 'summary' ? (
                  <Table
                    containerClassName='bg-[hsl(var(--surface-panel))]/94 dark:bg-[hsl(var(--surface-panel))]/96 max-h-[calc(100vh-16rem)] overflow-auto'
                  >
                    <TableHeader className={STICKY_TOP_ROW}>
                      <TableRow className='border-0 hover:bg-transparent'>
                        <TableHead className='min-w-[120px]'>日期</TableHead>
                        <TableHead>订单量</TableHead>
                        <TableHead>销售额</TableHead>
                        <TableHead>曝光量</TableHead>
                        <TableHead>点击量</TableHead>
                        <TableHead>CPC</TableHead>
                        <TableHead>广告花费</TableHead>
                        <TableHead>广告订单</TableHead>
                        <TableHead>可售库存</TableHead>
                        <TableHead>页面浏览量</TableHead>
                        <TableHead>销量</TableHead>
                        <TableHead>访问量</TableHead>
                        <TableHead>转化率</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loading ? (
                        <TableSkeletonRows
                          columns={13}
                          rows={6}
                          widths={Array(13).fill('w-full max-w-[90px]')}
                          rowClassName='border-0'
                        />
                      ) : summaryTableRows.length ? (
                        summaryTableRows.map((row, index) => (
                          <TableRow
                            key={`${row.date}-${index}`}
                            className={cn(
                              index % 2 === 0 &&
                                'bg-[hsl(var(--surface-soft))]/45 dark:bg-[hsl(var(--surface-strong))]/70',
                            )}
                          >
                            <TableCell className='font-medium text-foreground'>
                              {row.date}
                            </TableCell>
                            <TableCell>
                              {row.order_qty.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {formatMoney(row.sales_amount)}
                            </TableCell>
                            <TableCell>
                              {row.impressions.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {row.clicks.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>{formatMoney(row.cpc)}</TableCell>
                            <TableCell>{formatMoney(row.ad_spend)}</TableCell>
                            <TableCell>
                              {row.ad_orders.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {row.available_qty.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {row.page_views.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {row.units_ordered.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {row.sessions.toLocaleString('zh-CN')}
                            </TableCell>
                            <TableCell>
                              {(row.conversion_rate * 100).toFixed(2)}%
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <EmptyTableState
                          colSpan={13}
                          message='当前筛选范围内还没有可展示的销售数据汇总。'
                        />
                      )}
                    </TableBody>
                  </Table>
                ) : (
                  <Table
                    containerClassName='bg-[hsl(var(--surface-panel))]/96 dark:bg-[hsl(var(--surface-panel))]/98 max-h-[calc(100vh-16rem)] overflow-auto'
                  >
                    <TableHeader className={STICKY_TOP_ROW}>
                      <TableRow className='hover:bg-transparent'>
                        <TableHead className='min-w-[120px] bg-[hsl(var(--surface-soft))]/9 dark:bg-[hsl(var(--surface-strong))]'>
                          日期
                        </TableHead>
                        <TableHead className='min-w-[200px]'>SKU</TableHead>
                        <TableHead className='min-w-[200px]'>品名</TableHead>
                        <TableHead>订单量</TableHead>
                        <TableHead>销售额</TableHead>
                        <TableHead>曝光量</TableHead>
                        <TableHead>点击量</TableHead>
                        <TableHead>CPC</TableHead>
                        <TableHead>广告花费</TableHead>
                        <TableHead>广告订单</TableHead>
                        <TableHead>可售库存</TableHead>
                        <TableHead>在途数量</TableHead>
                        <TableHead>页面浏览量</TableHead>
                        <TableHead>销量</TableHead>
                        <TableHead>访问量</TableHead>
                        <TableHead>转化率</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loading ? (
                        <TableSkeletonRows
                          columns={15}
                          rows={8}
                          widths={Array(15).fill('w-full max-w-[90px]')}
                        />
                      ) : detailDisplayRows.length ? (
                        detailDisplayRows.map(
                          ({
                            row,
                            rowKey,
                            showDate,
                            rowSpan,
                            isTintedGroup,
                            productName,
                          }) => (
                            <TableRow
                              key={rowKey}
                              className={cn(
                                'transition-colors',
                                isTintedGroup
                                  ? 'bg-[hsl(var(--primary))]/[0.045] hover:bg-[hsl(var(--primary))]/[0.075]'
                                  : 'bg-background hover:bg-[hsl(var(--surface-subtle))]/40',
                              )}
                            >
                              {showDate ? (
                                <TableCell
                                  rowSpan={rowSpan}
                                  className={cn(
                                    'align-middle text-center font-semibold text-foreground',
                                    isTintedGroup
                                      ? 'bg-[hsl(var(--primary))]/[0.1]'
                                      : 'bg-[hsl(var(--surface-soft))]/0',
                                  )}
                                >
                                  {row.date}
                                </TableCell>
                              ) : null}
                              <TableCell>{row.sku}</TableCell>
                              <TableCell className='max-w-[200px] truncate text-muted-foreground'>
                                {productName || '--'}
                              </TableCell>
                              <TableCell>
                                {row.order_qty.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {formatMoney(row.sales_amount)}
                              </TableCell>
                              <TableCell>
                                {row.impressions.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {row.clicks.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>{formatMoney(row.cpc)}</TableCell>
                              <TableCell>{formatMoney(row.ad_spend)}</TableCell>
                              <TableCell>
                                {row.ad_orders.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {row.available_qty.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {row.in_transit_qty > 0 ? (
                                  <span className="font-medium text-blue-600 dark:text-blue-400">
                                    {row.in_transit_qty.toLocaleString('zh-CN')}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">--</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {row.page_views.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {row.units_ordered.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {row.sessions.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell>
                                {(row.conversion_rate * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                          ),
                        )
                      ) : (
                        <EmptyTableState
                          colSpan={15}
                          message='当前筛选范围内还没有可展示的 SKU 销售数据明细。'
                        />
                      )}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
            </DirectionalTabTransition>
          </DataTableCardBody>
        </DataTableCard>
      </div>
      </Tabs>
    </div>
  )
}
