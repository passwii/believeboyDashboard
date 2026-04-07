'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { DateRange } from 'react-day-picker'
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ChevronsUpDown, FileDown, Loader2, RefreshCcw } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { DataCard, DataCardHeader, DataCardContent, DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { DirectionalTabTransition, SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { formatLocalTimestampForFilename } from '@/lib/utils'

type CountryOption = 'US' | 'DE' | 'UK'
type ViewTab = 'summary' | 'details'
const VIEW_TAB_ORDER: ViewTab[] = ['summary', 'details']

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
}

type DailyAnalysisDetailRow = DailyAnalysisRow & {
  sku: string
  asin: string | null
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

type DetailDisplayRow = {
  row: DailyAnalysisDetailRow
  rowKey: string
  showDate: boolean
  rowSpan: number
  isTintedGroup: boolean
}

type ChartMetricKey = keyof Pick<
  DailyAnalysisRow,
  'order_qty' | 'sales_amount' | 'impressions' | 'clicks' | 'cpc' | 'ad_spend' | 'ad_orders'
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
]

const SINGLE_METRIC_CHART_CONFIG = {
  order_qty: { label: '订单', color: 'hsl(var(--chart-1))' },
  sales_amount: { label: '销售额', color: 'hsl(var(--chart-2))' },
  impressions: { label: '曝光量', color: 'hsl(var(--chart-3))' },
  clicks: { label: '点击量', color: 'hsl(var(--chart-4))' },
  cpc: { label: 'CPC', color: 'hsl(var(--chart-5))' },
  ad_spend: { label: '广告花费', color: 'hsl(var(--chart-4))' },
  ad_orders: { label: '广告订单', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig

const EMPTY_SUMMARY_ROWS: DailyAnalysisRow[] = []
const EMPTY_DETAIL_ROWS: DailyAnalysisDetailRow[] = []

function authHeaders(): Record<string, string> {
  return {}
}

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  const dayCount = getRangeDayCount(normalized)
  return {
    from: addDays(normalized.from, -dayCount),
    to: addDays(normalized.from, -1),
  }
}

function getYesterdayRange(): DateRange {
  const yesterday = addDays(new Date(), -1)
  yesterday.setHours(0, 0, 0, 0)
  return { from: yesterday, to: yesterday }
}

function getLastWeekRange(): DateRange {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dayOfWeek = today.getDay()
  // Find Monday of current week (getDay(): Sunday=0, Monday=1, ..., Saturday=6)
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const currentWeekMonday = addDays(today, -daysSinceMonday)
  // Previous week: start = currentWeekMonday - 7, end = currentWeekMonday - 1
  return { from: addDays(currentWeekMonday, -7), to: addDays(currentWeekMonday, -1) }
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
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(1)}w`
  }
  return value.toFixed(0)
}

function metricIncreaseIsGood(metric: ChartMetricKey) {
  return metric !== 'cpc' && metric !== 'ad_spend'
}

function isBarMetric(metric: ChartMetricKey) {
  return metric === 'order_qty' || metric === 'ad_orders' || metric === 'sales_amount'
}

function aggregateMetric(rows: DailyAnalysisRow[], metric: ChartMetricKey) {
  if (!rows.length) return 0
  if (metric === 'cpc') {
    const totalClicks = rows.reduce((sum, row) => sum + row.clicks, 0)
    if (totalClicks <= 0) return 0
    const totalAdSpend = rows.reduce((sum, row) => sum + row.ad_spend, 0)
    return totalAdSpend / totalClicks
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
  dateRange: string
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const safeTimestamp = formatLocalTimestampForFilename(new Date())

  // Sheet 1: 汇总
  const summarySheet = workbook.addWorksheet('日报汇总', {
    views: [{ state: 'frozen', ySplit: 3 }],
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
  ]

  summarySheet.columns = summaryCols

  summarySheet.mergeCells(1, 1, 1, summaryCols.length)
  summarySheet.getCell(1, 1).value = `销售数据汇总 - ${projectName} - ${country}`
  summarySheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
  summarySheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  summarySheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  summarySheet.mergeCells(2, 1, 2, summaryCols.length)
  summarySheet.getCell(2, 1).value = `导出时间：${exportedAt}    日期范围：${dateRange}`
  summarySheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
  summarySheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
  summarySheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  const summaryHeaderRow = summarySheet.getRow(3)
  summaryHeaderRow.values = summaryCols.map((c) => c.header)
  summaryHeaderRow.height = 22
  summaryHeaderRow.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
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

    excelRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 ? 'center' : 'right' }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      }
    })
  })

  // Sheet 2: SKU明细
  const detailSheet = workbook.addWorksheet('SKU明细', {
    views: [{ state: 'frozen', ySplit: 3 }],
  })

  const detailCols = [
    { header: '日期', key: 'date', width: 14 },
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'ASIN', key: 'asin', width: 16 },
    { header: '订单量', key: 'order_qty', width: 12 },
    { header: '销售额', key: 'sales_amount', width: 14 },
    { header: '曝光量', key: 'impressions', width: 14 },
    { header: '点击量', key: 'clicks', width: 12 },
    { header: 'CPC', key: 'cpc', width: 12 },
    { header: '广告花费', key: 'ad_spend', width: 14 },
    { header: '广告订单', key: 'ad_orders', width: 14 },
    { header: '可售库存', key: 'available_qty', width: 14 },
  ]

  detailSheet.columns = detailCols

  detailSheet.mergeCells(1, 1, 1, detailCols.length)
  detailSheet.getCell(1, 1).value = `销售数据SKU明细 - ${projectName} - ${country}`
  detailSheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
  detailSheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  detailSheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  detailSheet.mergeCells(2, 1, 2, detailCols.length)
  detailSheet.getCell(2, 1).value = `导出时间：${exportedAt}    日期范围：${dateRange}    共 ${detailRows.length} 条`
  detailSheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
  detailSheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
  detailSheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  const detailHeaderRow = detailSheet.getRow(3)
  detailHeaderRow.values = detailCols.map((c) => c.header)
  detailHeaderRow.height = 22
  detailHeaderRow.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  detailRows.forEach((row, rowIndex) => {
    const excelRow = detailSheet.getRow(rowIndex + 4)
    excelRow.getCell(1).value = row.date
    excelRow.getCell(2).value = row.sku
    excelRow.getCell(3).value = row.asin || ''
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

    excelRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: colNumber <= 3 ? 'left' : 'right' }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      }
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

    for (let currentRow = groupStartRow; currentRow <= mergeEndRow; currentRow += 1) {
      const row = detailSheet.getRow(currentRow)
      for (let colNumber = 1; colNumber <= detailCols.length; colNumber += 1) {
        const cell = row.getCell(colNumber)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: groupFill },
        }
        cell.border = {
          top: { style: currentRow === groupStartRow ? 'medium' : 'thin', color: { argb: strongGroupBorder } },
          left: { style: colNumber === 1 ? 'medium' : 'thin', color: { argb: groupBorder } },
          bottom: { style: currentRow === mergeEndRow ? 'medium' : 'thin', color: { argb: strongGroupBorder } },
          right: { style: colNumber === detailCols.length ? 'medium' : 'thin', color: { argb: groupBorder } },
        }
      }
    }

    if (groupRowCount > 1) {
      detailSheet.mergeCells(groupStartRow, 1, mergeEndRow, 1)
    }

    const mergedDateCell = detailSheet.getCell(groupStartRow, 1)
    mergedDateCell.alignment = { vertical: 'middle', horizontal: 'center' }
    mergedDateCell.font = { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FF0F172A' } }
    mergedDateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupFill } }
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
  link.download = `销售数据-${projectName}-${country}-${safeTimestamp}.xlsx`
  link.click()
  window.URL.revokeObjectURL(url)
}

function lastSevenDaysRange(): DateRange {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
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
        type="button"
        variant="outline"
        className="h-10 w-[200px] justify-between px-3 font-normal shadow-sm"
        onClick={() => setOpen(true)}
      >
        <span className={cn('truncate text-left', value ? 'text-foreground' : 'text-muted-foreground')}>
          {selectedSku ? (
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium">{selectedSku.sku}</span>
              {selectedSku.product_name && (
                <span className="hidden truncate text-muted-foreground lg:inline">/ {selectedSku.product_name}</span>
              )}
            </span>
          ) : loading ? (
            'SKU 加载中...'
          ) : (
            '全部 SKU'
          )}
        </span>
        <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
      </Button>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <Command className="max-h-[70vh]">
          <CommandInput placeholder="搜索 SKU" />
          <CommandList>
            <CommandEmpty>{loading ? 'SKU 加载中...' : '没有匹配的 SKU'}</CommandEmpty>
            <CommandItem
              value="__all__"
              onSelect={() => {
                onChange('')
                setOpen(false)
              }}
              className={cn('flex items-center gap-2', !value && 'bg-accent')}
            >
              <Check className={cn('h-4 w-4 shrink-0', !value ? 'opacity-100' : 'opacity-0')} />
              <span className="font-medium">全部 SKU</span>
            </CommandItem>
            {options.map((option) => {
              const missingUnits = !option.units_per_carton || option.units_per_carton <= 0
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
                  className={cn(missingUnits && 'opacity-50 cursor-not-allowed')}
                >
                  <Check className={cn('h-4 w-4 shrink-0', value === option.sku ? 'opacity-100' : 'opacity-0')} />
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate flex-1 font-medium">{option.sku}</span>
                    {option.product_name && (
                      <span className="shrink-0 truncate max-w-[200px] text-muted-foreground text-xs">
                        {option.product_name}
                      </span>
                    )}
                    {missingUnits && (
                      <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
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
    <div className="space-y-1.5">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

export default function DailyAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  const defaultRange = useMemo(() => lastSevenDaysRange(), [])
  const [projectId, setProjectId] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultRange)
  const [activeTab, setActiveTab] = useState<ViewTab>('summary')
  const [activeChartMetric, setActiveChartMetric] = useState<ChartMetricKey>('order_qty')

  const [data, setData] = useState<DailyAnalysisResponse | null>(null)
  const [comparisonSummaryRows, setComparisonSummaryRows] = useState<DailyAnalysisRow[]>(EMPTY_SUMMARY_ROWS)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [skuOptions, setSkuOptions] = useState<ProjectSkuOption[]>([])
  const [skuLoading, setSkuLoading] = useState(false)
  const [selectedSku, setSelectedSku] = useState('')

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(rows.filter((item) => item.id !== null))
      } catch (fetchError) {
        notify({ type: 'error', title: '项目列表加载失败', message: fetchError instanceof Error ? fetchError.message : '项目列表加载失败' })
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

  const loadData = useCallback(async (rangeOverride?: DateRange) => {
    if (!projectId) {
      notify({ type: 'error', title: '请先选择项目' })
      return
    }
    const effectiveRange = normalizeDateRange(rangeOverride ?? dateRange)
    if (!effectiveRange?.from || !effectiveRange?.to) {
      notify({ type: 'error', title: '请选择开始和结束日期' })
      return
    }

    const startDate = formatYMD(effectiveRange.from)
    const endDate = formatYMD(effectiveRange.to)
    const previousRange = getPreviousPeriodRange(effectiveRange)

    setLoading(true)
    try {
      const search = new URLSearchParams({
        project_id: projectId,
        country,
        start_date: startDate,
        end_date: endDate,
        ...(selectedSku && { sku: selectedSku }),
      })
      const compareSearch = previousRange
        ? new URLSearchParams({
            project_id: projectId,
            country,
            start_date: formatYMD(previousRange.from!),
            end_date: formatYMD(previousRange.to!),
            ...(selectedSku && { sku: selectedSku }),
          })
        : null

      const [response, compareResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/daily-analysis?${search.toString()}`, {
          headers: authHeaders(),
          cache: 'no-store',
        }),
        compareSearch
          ? fetch(`${API_BASE}/api/v1/daily-analysis?${compareSearch.toString()}`, {
              headers: authHeaders(),
              cache: 'no-store',
            })
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
      const comparePayload = compareResponse ? ((await compareResponse.json()) as DailyAnalysisResponse) : null
      setData(payload)
      setComparisonSummaryRows(comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS)
    } catch (fetchError) {
      notify({ type: 'error', title: '销售数据加载失败', message: fetchError instanceof Error ? fetchError.message : '销售数据加载失败' })
      setData(null)
      setComparisonSummaryRows(EMPTY_SUMMARY_ROWS)
    } finally {
      setLoading(false)
    }
}, [projectId, country, dateRange, selectedSku, notify])

  const loadProjectSkus = useCallback(async (projectIdText: string, countryValue: string) => {
    const projectIdNum = Number(projectIdText)
    const projectName = projects.find((project) => project.id === projectIdNum)?.name
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
        const response = await fetch(`${API_BASE}/api/v1/sku-info?${params.toString()}`, {
          headers: authHeaders(),
          cache: 'no-store',
        })
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
          }))
        )
        hasNextPage = payload.has_next
        nextPage += 1
      }

      setSkuOptions(allItems)
    } catch (loadError) {
      setSkuOptions([])
      notify({ type: 'error', title: '项目 SKU 列表加载失败', message: loadError instanceof Error ? loadError.message : '加载失败' })
    } finally {
      setSkuLoading(false)
    }
  }, [notify, projects])

  useEffect(() => {
    if (!projectId) return
    void loadProjectSkus(projectId, country)
  }, [projectId, country, loadProjectSkus])

  useEffect(() => {
    if (!projectId) return
    void loadData()
  }, [projectId, country, selectedSku, loadData])

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

      while (endIndex < rowsToGroup.length && rowsToGroup[endIndex].date === groupDate) {
        endIndex += 1
      }

      const rowSpan = endIndex - index
      const isTintedGroup = groupIndex % 2 === 0

      for (let currentIndex = index; currentIndex < endIndex; currentIndex += 1) {
        const row = rowsToGroup[currentIndex]
        groupedRows.push({
          row,
          rowKey: `${row.date}-${row.sku}-${row.asin ?? 'no-asin'}-${currentIndex}`,
          showDate: currentIndex === index,
          rowSpan: currentIndex === index ? rowSpan : 0,
          isTintedGroup,
        })
      }

      index = endIndex
      groupIndex += 1
    }

    return groupedRows
  }, [detailRows, filteredDetailRows, selectedSku])

  const selectedProjectName = useMemo(
    () => projects.find((p) => String(p.id) === projectId)?.name ?? '',
    [projects, projectId]
  )
  const activeChartMetricLabel = CHART_METRICS.find((item) => item.key === activeChartMetric)?.label ?? '订单'

  const chartDataRows = selectedSku ? filteredDetailRows : summaryRows

  const filteredComparisonRows = useMemo(() => {
    if (!selectedSku || comparisonSummaryRows.length === 0) return EMPTY_SUMMARY_ROWS
    return EMPTY_SUMMARY_ROWS
  }, [selectedSku, comparisonSummaryRows])

  const metricCards = useMemo(() => {
    return CHART_METRICS.map((metric) => {
      const currentValue = aggregateMetric(chartDataRows, metric.key)
      const hasComparison = comparisonSummaryRows.length > 0
      const previousValue = hasComparison ? aggregateMetric(comparisonSummaryRows, metric.key) : 0
      const diff = currentValue - previousValue
      const percentChange = previousValue === 0 ? null : (diff / previousValue) * 100
      const isPositiveDirection = percentChange === null ? true : (metricIncreaseIsGood(metric.key) ? percentChange >= 0 : percentChange <= 0)

      return {
        ...metric,
        currentValue,
        previousValue,
        percentChange,
        isPositiveDirection,
        hasComparison,
        showComparisonBadge: comparisonSummaryRows.length > 0,
      }
    })
  }, [chartDataRows, comparisonSummaryRows, selectedSku])
  const comparisonRange = useMemo(() => getPreviousPeriodRange(dateRange), [dateRange])
  const hasComparisonData = !selectedSku && comparisonSummaryRows.length > 0
  const chartRows = useMemo(() => {
    const normalizedRange = normalizeDateRange(dateRange)
    if (!normalizedRange?.from || !normalizedRange?.to) {
      return []
    }
    const allDates = generateDateRangeStrings(normalizedRange.from, normalizedRange.to)

    if (selectedSku) {
      const existingData = new Map(filteredDetailRows.map((row) => [row.date, row]))
      return allDates.map((date) => {
        const row = existingData.get(date)
        return {
          date,
          [activeChartMetric]: row ? row[activeChartMetric] : 0,
          compareMetricValue: null,
        }
      })
    }

    const summaryData = new Map(summaryRows.map((row) => [row.date, row]))
    const comparisonData = new Map(comparisonSummaryRows.map((row) => [row.date, row]))

    return allDates.map((date) => {
      const row = summaryData.get(date)
      const compareRow = comparisonData.get(date)
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
        compareMetricValue: compareRow ? compareRow[activeChartMetric] : null,
      }
    })
  }, [selectedSku, filteredDetailRows, summaryRows, comparisonSummaryRows, activeChartMetric, dateRange])

  const summaryTableRows = selectedSku ? filteredDetailRows : summaryRows
  const dateRangeDisplay = consoleData ? `${consoleData.start_date} ~ ${consoleData.end_date}` : (dateRange ? `${formatYMD(dateRange.from!)}${' ~ ' + formatYMD(dateRange.to!)}` : '')
  const handleExportExcel = async () => {
    if (!data) return
    setExporting(true)
    try {
      const exportSummaryRows = selectedSku ? filteredDetailRows : summaryRows
      const exportDetailRows = selectedSku ? filteredDetailRows : detailRows
      await exportDailyAnalysisToExcel(exportSummaryRows, exportDetailRows, selectedProjectName, country, dateRangeDisplay)
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
    <div className="space-y-5 lg:space-y-6">
      <DataCard>
        <DataCardHeader
          title="销售数据策展台"
          titleClassName="text-2xl tracking-tight"
          badge={<p className="dashboard-kicker">Analysis Console</p>}
        />
        <div className="dashboard-toolbar flex-nowrap items-end gap-3 border-0 shadow-none">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">项目</div>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-10 w-[160px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none [&>span]:truncate dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">国家站点</div>
              <Select value={country} onValueChange={(value) => setCountry(value as CountryOption)}>
                <SelectTrigger className="h-10 w-[140px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none [&>span]:truncate dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="国家站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">SKU</div>
              <SearchableSkuField
                value={selectedSku}
                options={skuOptions}
                loading={skuLoading}
                onChange={(value) => {
                  setSelectedSku(value)
                  setActiveTab('summary')
                }}
              />
            </div>

            <div className="space-y-2">
              <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">日期范围</div>
              <div className="flex flex-wrap items-center gap-2">
                <DateRangePicker
                  value={dateRange}
                  onChange={setDateRange}
                  className="h-10 w-[240px]"
                  onApply={() => void loadData()}
                />
                <div className="flex items-center gap-1">
                  <Button type="button" variant="secondary" className="h-10 px-3" onClick={() => {
                    if (!dateRange?.from) return
                    const newFrom = new Date(dateRange.from)
                    newFrom.setMonth(newFrom.getMonth() - 1)
                    const newTo = new Date(newFrom)
                    newTo.setMonth(newTo.getMonth() + 1)
                    newTo.setDate(newTo.getDate() - 1)
                    void handleQuickRange({ from: newFrom, to: newTo })
                  }} title="前一个月">
                    <ChevronLeft className="h-4 w-4" />
                    <span className="sr-only sm:not-sr-only sm:ml-1">上月</span>
                  </Button>
                  <Button type="button" variant="secondary" className="h-10 px-3" onClick={() => {
                    const nextRange = getNextMonthRange(dateRange)
                    if (!nextRange) return
                    void handleQuickRange(nextRange)
                  }} title="后一个月">
                    <span className="sr-only sm:not-sr-only sm:mr-1">下月</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-1">
                <Button type="button" variant="secondary" className="h-10 px-3" onClick={() => void handleQuickRange(getYesterdayRange())}>
                  昨天
                </Button>
                <Button type="button" variant="secondary" className="h-10 px-3" onClick={() => void handleQuickRange(lastSevenDaysRange())}>
                  近7天
                </Button>
              </div>
              <Button
                type="button"
                onClick={() => void loadData()}
                disabled={loading || projectsLoading}
                className="h-10 px-5"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                刷新视图
              </Button>
            </div>
          </div>
        </div>
      </DataCard>

      <DataCard>
        <DataCardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-border/60 bg-background/85 px-3 py-1 text-foreground">
              对比区间：{formatRangeLabel(comparisonRange)}
            </Badge>
          </div>
          {summaryRows.length ? (
            <>
              <div className="px-2 md:px-4">
                <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
                  {metricCards.map((metric) => {
                    const isActive = metric.key === activeChartMetric
                    const showIncrease = metric.percentChange === null ? true : metric.percentChange >= 0
                    const usePositiveColor = metric.percentChange === null ? true : metric.isPositiveDirection

                    return (
                      <button
                        key={metric.key}
                        type="button"
                        onClick={() => setActiveChartMetric(metric.key)}
                        className={cn(
                          'rounded-lg border px-3 py-3 text-left transition-all duration-200',
                          isActive
                            ? 'border-primary/45 bg-primary text-primary-foreground shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.72)]'
                            : 'border-border/70 bg-[hsl(var(--surface-soft))]/86 text-foreground hover:-translate-y-0.5 hover:border-border hover:bg-background'
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className={cn('text-xs font-semibold tracking-tight', isActive ? 'text-primary-foreground/88' : 'text-muted-foreground')}>
                            {metric.label}
                          </div>
                          {metric.showComparisonBadge ? (
                            <div
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold backdrop-blur-sm',
                                isActive
                                  ? usePositiveColor
                                    ? 'border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(220,252,231,0.92))] text-[hsl(var(--success))] shadow-[0_10px_24px_-14px_rgba(255,255,255,0.9)]'
                                    : 'border-white/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(254,226,226,0.92))] text-[hsl(var(--destructive))] shadow-[0_10px_24px_-14px_rgba(255,255,255,0.9)]'
                                  : usePositiveColor
                                    ? 'border-[hsl(var(--success))/0.28] bg-[hsl(var(--success))/0.12] text-[hsl(var(--success))]'
                                    : 'border-destructive/25 bg-destructive/12 text-destructive'
                              )}
                            >
                              {showIncrease ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                              {metric.percentChange === null ? '--' : `${Math.abs(metric.percentChange).toFixed(1)}%`}
                            </div>
                          ) : (
                            <div className="h-[28px] w-[60px]" />
                          )}
                        </div>

                        <div className="mt-3 space-y-0.5">
                          <div className={cn('text-[1.25rem] font-semibold tracking-tight', isActive ? 'text-primary-foreground' : 'text-foreground')}>
                            {formatMetricCardValue(metric.key, metric.currentValue)}
                          </div>
                          {metric.hasComparison ? (
                            <div className={cn('text-xs', isActive ? 'text-primary-foreground/72' : 'text-muted-foreground')}>
                              对比 {formatMetricCardValue(metric.key, metric.previousValue)}
                            </div>
                          ) : (
                            <div className={cn('text-xs', isActive ? 'text-primary-foreground/72' : 'text-muted-foreground')}>
                              {selectedSku ? 'SKU 明细' : '暂无对比'}
                            </div>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-lg bg-[hsl(var(--surface-soft))]/82 p-4 md:p-5">
                <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <div className="inline-flex items-center gap-2 rounded-full bg-background/72 px-3 py-1.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SINGLE_METRIC_CHART_CONFIG[activeChartMetric].color }} />
                    当前周期
                  </div>
                  {hasComparisonData ? (
                    isBarMetric(activeChartMetric) ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--surface-soft))] px-3 py-1.5 dark:bg-[hsl(var(--surface-strong))]">
                    <span className="h-3 w-3 rounded-sm border border-border/70" style={{ backgroundColor: 'rgba(148,163,184,0.28)' }} />
                        上一个周期
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--surface-soft))] px-3 py-1.5 dark:bg-[hsl(var(--surface-strong))]">
                        <span className="w-5 border-t-2 border-dashed border-border/70" />
                        上一个周期
                      </div>
                    )
                  ) : null}
                </div>

                <ChartContainer
                  config={SINGLE_METRIC_CHART_CONFIG}
                  className="h-[360px] w-full md:h-[420px]"
                >
                  <ComposedChart
                    key={activeChartMetric}
                    data={chartRows}
                    margin={{ top: 28, right: 24, left: 8, bottom: 18 }}
                  >
                    <defs>
                      <linearGradient id={`salesDataLine-${activeChartMetric}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={`var(--color-${activeChartMetric})`} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={`var(--color-${activeChartMetric})`} stopOpacity={0.04} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.18)" strokeDasharray="0" />
                    <XAxis
                      dataKey="date"
                      axisLine={false}
                      tickLine={false}
                      tickMargin={18}
                      tick={{ fontSize: 12, fill: '#71717a' }}
                      tickFormatter={(value) => {
                        const [, month, day] = String(value).split('-')
                        return `${month}月${day}日`
                      }}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tickMargin={16}
                      tick={{ fontSize: 12, fill: '#71717a' }}
                      tickFormatter={(value) => formatAxisValue(activeChartMetric, Number(value))}
                    />
                    <ChartTooltip
                      itemSorter={(item) => (item.dataKey === activeChartMetric ? -1 : 1)}
                      cursor={{ stroke: 'rgba(15,23,42,0.18)', strokeDasharray: '4 4' }}
                      content={
                        <ChartTooltipContent
                          indicator="line"
                          labelFormatter={(_, payload) => {
                            const date = payload?.[0]?.payload?.date
                            return typeof date === 'string' ? date : ''
                          }}
                          formatter={(value, name, item) => (
                            <div className="flex w-full items-center justify-between gap-4">
                              <span className="font-medium" style={{ color: item.color || undefined }}>
                                {typeof name === 'string' ? name : activeChartMetricLabel}
                              </span>
                              <span className="font-mono font-medium text-foreground">
                                {typeof value === 'number' ? formatMetricValue(activeChartMetric, value) : String(value ?? '')}
                              </span>
                            </div>
                          )}
                        />
                      }
                    />
                    {isBarMetric(activeChartMetric) ? (
                      <>
                        {hasComparisonData ? (
                          <Bar
                            dataKey="compareMetricValue"
                            name="上一个周期"
                            fill="rgba(148,163,184,0.28)"
                            radius={[10, 10, 0, 0]}
                            barSize={16}
                            isAnimationActive
                            animationDuration={320}
                            animationEasing="ease-out"
                          />
                        ) : null}
                        <Bar
                          dataKey={activeChartMetric}
                          name={activeChartMetricLabel}
                          fill={`var(--color-${activeChartMetric})`}
                          radius={[10, 10, 0, 0]}
                          barSize={16}
                          isAnimationActive
                          animationDuration={360}
                          animationEasing="ease-out"
                        />
                      </>
                    ) : (
                      <>
                        {hasComparisonData ? (
                          <Line
                            type="monotone"
                            dataKey="compareMetricValue"
                            name="上一个周期"
                            stroke="rgba(148,163,184,0.9)"
                            strokeWidth={2.5}
                            strokeDasharray="6 6"
                            dot={false}
                            isAnimationActive
                            animationDuration={320}
                            animationEasing="ease-out"
                          />
                        ) : null}
                        <Line
                          type="monotone"
                          dataKey={activeChartMetric}
                          name={activeChartMetricLabel}
                          stroke={`var(--color-${activeChartMetric})`}
                          strokeWidth={4}
                          dot={false}
                          isAnimationActive
                          animationDuration={360}
                          animationEasing="ease-out"
                          activeDot={{
                            r: 6,
                            fill: `var(--color-${activeChartMetric})`,
                            stroke: '#fff',
                            strokeWidth: 2,
                          }}
                        />
                      </>
                    )}
                  </ComposedChart>
                </ChartContainer>
              </div>
            </>
          ) : (
            <div className="flex min-h-[320px] items-center justify-center rounded-lg bg-[hsl(var(--surface-soft))]/82 px-6 text-center">
              <div className="space-y-2">
                <div className="text-base font-semibold text-foreground">图表区域暂时没有内容</div>
                <div className="text-sm text-muted-foreground">当前筛选范围内暂无可用于绘图的数据</div>
              </div>
            </div>
          )}
        </DataCardContent>
      </DataCard>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ViewTab)} className="w-full">
        <DataTableCard>
          <DataTableCardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between pb-4">
            <div>
              <p className="dashboard-kicker">Operational Ledger</p>
              <div className="text-base font-semibold text-foreground">销售数据工作区</div>
            </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleExportExcel()}
                  disabled={exporting || !data}
                  className="h-10 px-4"
                >
                  {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
                  导出 Excel
                </Button>
                <TabsMotionGroup id="daily-analysis-tabs">
                  <TabsList className="grid h-auto w-full grid-cols-2 border border-border/70 bg-[hsl(var(--surface-soft))]/90 p-1 sm:w-[260px] dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]">
                    <SlidingTabsTrigger value="summary" activeValue={activeTab} layoutId="daily-analysis-tab-indicator" className="py-2.5">每日汇总</SlidingTabsTrigger>
                    <SlidingTabsTrigger value="details" activeValue={activeTab} layoutId="daily-analysis-tab-indicator" className="py-2.5">SKU 明细</SlidingTabsTrigger>
                  </TabsList>
                </TabsMotionGroup>
              </div>
          </DataTableCardHeader>

          <DataTableCardBody>
            <DirectionalTabTransition value={activeTab} order={VIEW_TAB_ORDER}>
            <TabsContent forceMount value={activeTab} className="m-0">
            {activeTab === 'summary' ? (
                  <Table noWrapperRounded containerClassName="bg-[hsl(var(--surface-panel))]/94 dark:bg-[hsl(var(--surface-panel))]/96">
                  <TableHeader className="bg-[hsl(var(--surface-soft))]/72 dark:bg-[hsl(var(--surface-strong))]">
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableHead className="min-w-[120px]">日期</TableHead>
                      <TableHead>订单量</TableHead>
                      <TableHead>销售额</TableHead>
                      <TableHead>曝光量</TableHead>
                      <TableHead>点击量</TableHead>
                      <TableHead>CPC</TableHead>
                      <TableHead>广告花费</TableHead>
                      <TableHead>广告订单</TableHead>
                      <TableHead>可售库存</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 6 }).map((_, index) => (
                        <TableRow key={`summary-skeleton-${index}`} className="border-0">
                          {Array.from({ length: 9 }).map((__, cellIndex) => (
                            <TableCell key={cellIndex}>
                              <Skeleton className="h-4 w-full max-w-[90px]" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : summaryTableRows.length ? (
                      summaryTableRows.map((row, index) => (
                      <TableRow key={`${row.date}-${index}`} className={cn(index % 2 === 0 && 'bg-[hsl(var(--surface-soft))]/45 dark:bg-[hsl(var(--surface-strong))]/70')}>
                          <TableCell className="font-medium text-foreground">{row.date}</TableCell>
                          <TableCell>{row.order_qty.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.sales_amount)}</TableCell>
                          <TableCell>{row.impressions.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.clicks.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.cpc)}</TableCell>
                          <TableCell>{formatMoney(row.ad_spend)}</TableCell>
                          <TableCell>{row.ad_orders.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.available_qty.toLocaleString('zh-CN')}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <EmptyTableState colSpan={9} message="当前筛选范围内还没有可展示的销售数据汇总。" />
                    )}
                  </TableBody>
              </Table>
            ) : (
                  <Table noWrapperRounded containerClassName="bg-[hsl(var(--surface-panel))]/96 dark:bg-[hsl(var(--surface-panel))]/98">
                  <TableHeader className="bg-[hsl(var(--surface-soft))]/82 dark:bg-[hsl(var(--surface-strong))]">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="min-w-[120px] bg-[hsl(var(--surface-soft))]/9 dark:bg-[hsl(var(--surface-strong))]">日期</TableHead>
                      <TableHead className="min-w-[140px]">SKU</TableHead>
                      <TableHead className="min-w-[140px]">ASIN</TableHead>
                      <TableHead>订单量</TableHead>
                      <TableHead>销售额</TableHead>
                      <TableHead>曝光量</TableHead>
                      <TableHead>点击量</TableHead>
                      <TableHead>CPC</TableHead>
                      <TableHead>广告花费</TableHead>
                      <TableHead>广告订单</TableHead>
                      <TableHead>可售库存</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <TableRow key={`detail-skeleton-${index}`}>
                          {Array.from({ length: 11 }).map((__, cellIndex) => (
                            <TableCell key={cellIndex}>
                              <Skeleton className="h-4 w-full max-w-[90px]" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : detailDisplayRows.length ? (
                      detailDisplayRows.map(({ row, rowKey, showDate, rowSpan, isTintedGroup }) => (
                        <TableRow
                          key={rowKey}
                          className={cn(
                            'transition-colors',
                            isTintedGroup
                              ? 'bg-[hsl(var(--primary))]/[0.045] hover:bg-[hsl(var(--primary))]/[0.075]'
                              : 'bg-background hover:bg-[hsl(var(--surface-subtle))]/40'
                          )}
                        >
                          {showDate ? (
                            <TableCell
                              rowSpan={rowSpan}
                              className={cn(
                                'align-middle text-center font-semibold text-foreground',
                                isTintedGroup
                                  ? 'bg-[hsl(var(--primary))]/[0.1]'
                                  : 'bg-[hsl(var(--surface-soft))]/0'
                              )}
                            >
                              {row.date}
                            </TableCell>
                          ) : null}
                          <TableCell>{row.sku}</TableCell>
                          <TableCell>{row.asin || '--'}</TableCell>
                          <TableCell>{row.order_qty.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.sales_amount)}</TableCell>
                          <TableCell>{row.impressions.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.clicks.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.cpc)}</TableCell>
                          <TableCell>{formatMoney(row.ad_spend)}</TableCell>
                          <TableCell>{row.ad_orders.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.available_qty.toLocaleString('zh-CN')}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <EmptyTableState colSpan={11} message="当前筛选范围内还没有可展示的 SKU 销售数据明细。" />
                    )}
                  </TableBody>
              </Table>
            )}
            </TabsContent>
            </DirectionalTabTransition>
          </DataTableCardBody>
        </DataTableCard>
      </Tabs>
    </div>
  )
}
