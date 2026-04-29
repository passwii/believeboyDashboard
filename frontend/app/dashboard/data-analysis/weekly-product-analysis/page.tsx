'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Download, Eye, EyeOff, Loader2, ShoppingCart } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
  DataTableCardStatBar,
} from '@/components/ui/data-card'
import {
  DateRangePicker,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { BarSkeleton } from '@/components/ui/table-skeleton'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  clearClientCache,
  getClientCache,
  setClientCache,
} from '@/lib/client-cache'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import {
  CountrySelect,
  FilterField,
  RefreshButton,
} from '@/components/dashboard/console'

type ProjectOption = {
  id: number | null
  name: string
}

type WeeklyDataRow = {
  id: number
  project_id: number
  project_name: string
  report_start_date: string
  report_end_date: string
  version: number
  is_current: boolean
  row_count: number
  total_sales: number
  total_units: number
  total_ad_spend: number
  summary_row?: Record<string, unknown> | null
}

type WeeklySummaryItem = {
  row: WeeklyDataRow
  summary: Record<string, unknown>
}

type WeeklyViewTab = 'summary' | 'details'
type CountryOption = 'US' | 'DE' | 'UK'

type PT1DetailsResponse = {
  pt1_id: number
  report_start_date: string
  report_end_date: string
  has_next: boolean
  rows: Array<{
    id: number
    source_row_no: number
    sku?: string | null
    asin?: string | null
    raw_row?: Record<string, unknown> | null
  }>
}

function WeeklyFilterSkeleton({ width = 'w-full' }: { width?: string }) {
  return (
    <div className={`space-y-1.5 ${width}`}>
      <Skeleton className='h-3 w-14' />
      <Skeleton className='h-9 w-full' />
    </div>
  )
}

function WeeklyStatSkeleton() {
  return <Skeleton className='h-[132px] w-full rounded-lg' />
}

const API_BASE = '/api/backend'
const WEEKLY_DATA_CACHE_TTL_MS = 3 * 60 * 1000
const WEEKLY_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000

function weeklyDataCacheKey(
  projectId: number,
  country: CountryOption,
  startDate: string,
  endDate: string,
): string {
  return `weekly-analysis:data:${projectId}:${country}:${startDate || 'none'}:${endDate || 'none'}`
}

function weeklyDetailsCacheKey(pt1Id: number, country: CountryOption): string {
  return `weekly-analysis:details:v2:${pt1Id}:${country}`
}

const SUMMARY_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
    groupClass: 'bg-sky-500/15',
    headClass: 'bg-sky-500/10',
  },
  {
    title: '推广流量',
    columns: [
      '广告展示量',
      '广告点击量',
      '广告点击率',
      '广告订单量',
      '广告单占比',
      '广告转化率',
      '广告花费',
      '广告销售额',
      'CPC',
      'ACOS',
      'SP占比',
    ],
    groupClass: 'bg-orange-500/15',
    headClass: 'bg-orange-500/10',
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
    groupClass: 'bg-emerald-500/15',
    headClass: 'bg-emerald-500/10',
  },
  {
    title: '费用占比',
    columns: [
      '产品FOB',
      '成本占比',
      '销售头程',
      '头程占比',
      'FBA配送费',
      '配送费占比',
      '平台佣金',
      '佣金占比',
      '总成本',
      '总成本占比',
    ],
    groupClass: 'bg-amber-500/15',
    headClass: 'bg-amber-500/10',
  },
  {
    title: '财务结算',
    columns: [
      '实际销售额',
      '实际销售量',
      '实际退款额',
      '实际退款量',
      '平均售价',
      '退款率',
      '利润',
      '利润率',
    ],
    groupClass: 'bg-violet-500/15',
    headClass: 'bg-violet-500/10',
  },
] as const

const SUMMARY_COLUMNS = SUMMARY_COLUMN_GROUPS.flatMap((item) => item.columns)
const SUMMARY_COLUMN_SET = new Set<string>(SUMMARY_COLUMNS)
const DETAIL_CORE_COLUMNS = ['日期', 'SKU'] as const
const DETAIL_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
    groupClass: 'bg-sky-500/15',
    headClass: 'bg-sky-500/10',
  },
  {
    title: '库存',
    columns: ['库存'],
    groupClass: 'bg-slate-500/15',
    headClass: 'bg-slate-500/10',
  },
  {
    title: '推广流量',
    columns: [
      '广告展示量',
      '广告点击量',
      '广告点击率',
      '广告订单量',
      '广告单占比',
      '广告转化率',
      '广告花费',
      '广告销售额',
      'CPC',
      'ACOS',
      'SP占比',
    ],
    groupClass: 'bg-orange-500/15',
    headClass: 'bg-orange-500/10',
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
    groupClass: 'bg-emerald-500/15',
    headClass: 'bg-emerald-500/10',
  },
  {
    title: '费用占比',
    columns: [
      '产品FOB',
      '成本占比',
      '销售头程',
      '头程占比',
      'FBA配送费',
      '配送费占比',
      '平台佣金',
      '佣金占比',
      '总成本',
      '总成本占比',
    ],
    groupClass: 'bg-amber-500/15',
    headClass: 'bg-amber-500/10',
  },
  {
    title: '财务结算',
    columns: [
      '实际销售额',
      '实际销售量',
      '实际退款额',
      '实际退款量',
      '平均售价',
      '退款率',
      '利润',
      '利润率',
    ],
    groupClass: 'bg-violet-500/15',
    headClass: 'bg-violet-500/10',
  },
] as const
const DETAIL_BASE_COLUMNS = [
  ...DETAIL_CORE_COLUMNS,
  ...DETAIL_COLUMN_GROUPS.flatMap((group) => group.columns),
]
const DETAIL_BASE_COLUMN_SET = new Set<string>(DETAIL_BASE_COLUMNS)
const SUMMARY_PERCENT_COLUMNS = new Set([
  '总转化',
  '广告点击率',
  '广告单占比',
  '广告转化率',
  'ACOS',
  'SP占比',
  '自然流量占比',
  '自然单转化',
  '成本占比',
  '头程占比',
  '配送费占比',
  '佣金占比',
  '总成本占比',
  '利润率',
  '退款率',
])
const SUMMARY_CURRENCY_COLUMNS = new Set([
  '总销售额',
  '广告花费',
  '广告销售额',
  'CPC',
  '产品FOB',
  '销售头程',
  'FBA配送费',
  '平台佣金',
  '总成本',
  '利润',
  '实际销售额',
  '实际退款额',
  '平均售价',
])
const SUMMARY_INTEGER_COLUMNS = new Set([
  '总销量',
  '页面浏览量',
  '总访客',
  '广告展示量',
  '广告点击量',
  '广告订单量',
  '自然流量',
  '自然单',
  '实际销售量',
  '实际退款量',
])

const SUMMARY_WEEK_COLUMN_FALLBACK_WIDTH = 92
const DETAIL_STICKY_COLUMN_WIDTHS = [120, 220] as const
const DETAIL_STICKY_LEFT = [0, DETAIL_STICKY_COLUMN_WIDTHS[0]] as const

const chartConfig = {
  sales_amount: {
    label: '销售额',
    color: 'hsl(var(--chart-2))',
  },
  units_sold: {
    label: '销量',
    color: 'hsl(var(--primary))',
  },
  ad_spend: {
    label: '广告花费',
    color: 'hsl(var(--destructive))',
  },
  ad_clicks: {
    label: '广告点击量',
    color: 'hsl(var(--chart-4))',
  },
  organic_traffic: {
    label: '自然流量',
    color: 'hsl(var(--chart-5))',
  },
} satisfies ChartConfig

function eightWeeksAgoMondayDateString(): string {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysSinceMonday = (dayOfWeek + 6) % 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - daysSinceMonday - 56)
  const y = monday.getFullYear()
  const m = String(monday.getMonth() + 1).padStart(2, '0')
  const d = String(monday.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function authHeaders(): Record<string, string> {
  return {}
}

function lastSundayDateString(): string {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const daysToSubtract = dayOfWeek === 0 ? 7 : dayOfWeek
  const lastSunday = new Date(now)
  lastSunday.setDate(now.getDate() - daysToSubtract)
  const y = lastSunday.getFullYear()
  const m = String(lastSunday.getMonth() + 1).padStart(2, '0')
  const d = String(lastSunday.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseErrorBody(text: string, status: number): string {
  if (!text) return `请求失败 (${status})`
  try {
    const payload = JSON.parse(text) as {
      detail?: string | unknown[] | Record<string, unknown>
    }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((item: unknown) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const maybeMsg = (item as { msg?: unknown }).msg
            return typeof maybeMsg === 'string'
              ? maybeMsg
              : JSON.stringify(item)
          }
          return String(item)
        })
        .join('; ')
    }
    if (payload.detail && typeof payload.detail === 'object')
      return JSON.stringify(payload.detail)
    return text
  } catch {
    return text
  }
}

function formatDateRange(start: string, end: string): string {
  return `${start} 至 ${end}`
}

function formatCurrency(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

function formatWeekLabel(startDate: string, endDate: string): string {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const startMonth = start.getMonth() + 1
  const startDay = start.getDate()
  const endMonth = end.getMonth() + 1
  const endDay = end.getDate()
  return `${startMonth}/${startDay} - ${endMonth}/${endDay}`
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '')
    if (!normalized) return 0
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function safeDiv(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return numerator / denominator
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function formatSummaryCell(column: string, value: unknown): string {
  if (!hasValue(value)) return '-'

  const numeric = toNumber(value)
  const isNumeric =
    typeof value === 'number' ||
    (typeof value === 'string' &&
      value.trim() !== '' &&
      Number.isFinite(Number(value.replace(/,/g, ''))))
  if (!isNumeric) return String(value)

  if (SUMMARY_PERCENT_COLUMNS.has(column)) {
    return `${(numeric * 100).toFixed(2)}%`
  }
  if (SUMMARY_INTEGER_COLUMNS.has(column)) {
    return Math.round(numeric).toLocaleString('en-US')
  }
  if (SUMMARY_CURRENCY_COLUMNS.has(column)) {
    return formatCurrency(numeric)
  }
  return numeric.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function sumSummaryValue(
  rows: Array<Record<string, unknown>>,
  column: string,
): number {
  return rows.reduce((acc, row) => acc + toNumber(row[column]), 0)
}

function buildSummaryTotals(
  rows: Array<Record<string, unknown>>,
): Record<string, number> {
  const totals: Record<string, number> = {}
  SUMMARY_COLUMNS.forEach((column) => {
    totals[column] = sumSummaryValue(rows, column)
  })

  totals['总转化'] = safeDiv(totals['总销量'], totals['页面浏览量'])
  totals['广告点击率'] = safeDiv(totals['广告点击量'], totals['广告展示量'])
  totals['广告单占比'] = safeDiv(totals['广告订单量'], totals['总销量'])
  totals['广告转化率'] = safeDiv(totals['广告订单量'], totals['广告点击量'])
  totals['CPC'] = safeDiv(totals['广告花费'], totals['广告点击量'])
  totals['ACOS'] = safeDiv(totals['广告花费'], totals['广告销售额'])
  totals['SP占比'] = safeDiv(totals['广告花费'], totals['总销售额'])
  totals['自然流量占比'] = safeDiv(totals['自然流量'], totals['页面浏览量'])
  totals['自然单转化'] = safeDiv(totals['自然单'], totals['自然流量'])
  totals['成本占比'] = safeDiv(totals['产品FOB'], totals['实际销售额'])
  totals['头程占比'] = safeDiv(totals['销售头程'], totals['实际销售额'])
  totals['配送费占比'] = safeDiv(totals['FBA配送费'], totals['实际销售额'])
  totals['佣金占比'] = safeDiv(totals['平台佣金'], totals['实际销售额'])
  totals['总成本占比'] = safeDiv(totals['总成本'], totals['实际销售额'])
  totals['利润率'] = safeDiv(totals['利润'], totals['实际销售额'])
  totals['平均售价'] = safeDiv(totals['实际销售额'], totals['实际销售量'])
  totals['退款率'] = safeDiv(totals['实际退款额'], totals['实际销售额'])

  return totals
}

function buildSummaryForRow(row: WeeklyDataRow): Record<string, unknown> {
  const rawSummary =
    row.summary_row && typeof row.summary_row === 'object'
      ? row.summary_row
      : {}
  const summary: Record<string, unknown> = { ...rawSummary }

  if (!hasValue(summary['总销量'])) summary['总销量'] = row.total_units
  if (!hasValue(summary['总销售额'])) summary['总销售额'] = row.total_sales
  if (!hasValue(summary['广告花费'])) summary['广告花费'] = row.total_ad_spend
  if (!hasValue(summary['实际销售额'])) summary['实际销售额'] = row.total_sales
  if (!hasValue(summary['实际销售量'])) summary['实际销售量'] = row.total_units

  return summary
}

function buildDetailRow(
  rawRow: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!rawRow || typeof rawRow !== 'object') return {}
  return { ...rawRow }
}

function formatDetailCell(column: string, value: unknown): string {
  if (!hasValue(value)) return '-'
  if (column === '日期' || column === 'SKU') return String(value)
  return formatSummaryCell(column, value)
}

function sumAnyNumericColumn(
  rows: Array<Record<string, unknown>>,
  column: string,
): number | null {
  let hasNumeric = false
  const total = rows.reduce((acc, row) => {
    const raw = row[column]
    if (typeof raw === 'number') {
      hasNumeric = true
      return acc + toNumber(raw)
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const normalized = raw.trim().replace(/,/g, '')
      if (Number.isFinite(Number(normalized))) {
        hasNumeric = true
        return acc + toNumber(raw)
      }
    }
    return acc
  }, 0)
  return hasNumeric ? total : null
}

function getExcelNumberFormat(column: string): string | null {
  if (SUMMARY_PERCENT_COLUMNS.has(column)) return '0.00%'
  if (SUMMARY_CURRENCY_COLUMNS.has(column)) return '$#,##0.00;[Red]-$#,##0.00'
  if (SUMMARY_INTEGER_COLUMNS.has(column)) return '#,##0'
  if (column === '版本' || column === '记录数') return '#,##0'
  return null
}

function getExcelCellValue(column: string, value: unknown): string | number {
  if (!hasValue(value)) return '-'
  const isNumeric =
    typeof value === 'number' ||
    (typeof value === 'string' &&
      value.trim() !== '' &&
      Number.isFinite(Number(value.replace(/,/g, ''))))
  if (
    (SUMMARY_COLUMN_SET.has(column) ||
      SUMMARY_PERCENT_COLUMNS.has(column) ||
      SUMMARY_CURRENCY_COLUMNS.has(column) ||
      SUMMARY_INTEGER_COLUMNS.has(column)) &&
    isNumeric
  ) {
    return toNumber(value)
  }
  return String(value)
}

function autosizeWorksheetColumns(worksheet: import('exceljs').Worksheet) {
  worksheet.columns?.forEach((column) => {
    let maxLength = 12
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const raw = cell.value
      const text =
        raw === null || raw === undefined
          ? ''
          : typeof raw === 'object' && 'richText' in raw
            ? raw.richText.map((item) => item.text).join('')
            : String(raw)
      maxLength = Math.max(maxLength, Math.min(text.length + 4, 18))
    })
    column.width = maxLength
  })
}

function applyCellBorder(cell: import('exceljs').Cell, color = 'FFE2E8F0') {
  cell.border = {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  }
}

function fillSummaryWorksheet(
  worksheet: import('exceljs').Worksheet,
  summaryRows: WeeklySummaryItem[],
  summaryTotals: Record<string, number>,
  meta: {
    projectName: string
    country: CountryOption
    startDate: string
    endDate: string
  },
) {
  const lastColumn = SUMMARY_COLUMNS.length + 2
  worksheet.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }]
  worksheet.mergeCells(1, 1, 1, lastColumn)
  worksheet.getCell(1, 1).value = '按周产品分析 - 汇总'
  worksheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  worksheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }

  worksheet.mergeCells(2, 1, 2, lastColumn)
  worksheet.getCell(2, 1).value =
    `店铺：${meta.projectName}    站点：${meta.country}    日期：${meta.startDate} 至 ${meta.endDate}`
  worksheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  worksheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }

  const groupRow = worksheet.getRow(4)
  const headRow = worksheet.getRow(5)
  groupRow.getCell(1).value = '周次'
  groupRow.getCell(2).value = '日期范围'
  worksheet.mergeCells(4, 1, 5, 1)
  worksheet.mergeCells(4, 2, 5, 2)

  let currentColumn = 3
  SUMMARY_COLUMN_GROUPS.forEach((group) => {
    const start = currentColumn
    group.columns.forEach((column) => {
      headRow.getCell(currentColumn).value = column
      currentColumn += 1
    })
    worksheet.mergeCells(4, start, 4, currentColumn - 1)
    const groupCell = groupRow.getCell(start)
    groupCell.value = group.title
    groupCell.alignment = { vertical: 'middle', horizontal: 'center' }
    groupCell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    const color =
      group.title === '销售'
        ? 'FFDCEEFF'
        : group.title === '推广流量'
          ? 'FFFFE6D5'
          : group.title === '自然流量'
            ? 'FFDDF7EA'
            : group.title === '费用占比'
              ? 'FFFCE7C3'
              : 'FFEADFEE'
    groupCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: color },
    }
    applyCellBorder(groupCell)
  })
  ;[groupRow, headRow].forEach((row) => {
    row.eachCell((cell) => {
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
      if (!cell.fill || !('fgColor' in cell.fill)) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
      }
      applyCellBorder(cell, 'FFCBD5E1')
    })
  })

  let rowIndex = 6
  summaryRows.forEach((item, index) => {
    const row = worksheet.getRow(rowIndex)
    row.getCell(1).value = `第${index + 1}周`
    row.getCell(2).value = formatDateRange(
      item.row.report_start_date,
      item.row.report_end_date,
    )
    SUMMARY_COLUMNS.forEach((column, idx) => {
      const cell = row.getCell(idx + 3)
      const value = getExcelCellValue(column, item.summary[column])
      cell.value = value
      cell.alignment = {
        vertical: 'middle',
        horizontal: typeof value === 'number' ? 'right' : 'left',
      }
      const numFmt = getExcelNumberFormat(column)
      if (typeof value === 'number' && numFmt) cell.numFmt = numFmt
      applyCellBorder(cell)
    })
    row.getCell(1).font = { name: 'Microsoft YaHei', bold: true }
    row.getCell(2).font = { name: 'Microsoft YaHei' }
    applyCellBorder(row.getCell(1))
    applyCellBorder(row.getCell(2))
    rowIndex += 1
  })

  const totalRow = worksheet.getRow(rowIndex)
  totalRow.getCell(1).value = '合计'
  totalRow.getCell(2).value = `${summaryRows.length} 周`
  SUMMARY_COLUMNS.forEach((column, idx) => {
    const cell = totalRow.getCell(idx + 3)
    cell.value = summaryTotals[column] ?? 0
    cell.alignment = { vertical: 'middle', horizontal: 'right' }
    const numFmt = getExcelNumberFormat(column)
    if (numFmt) cell.numFmt = numFmt
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: {
        argb:
          column === '利润' || column === '利润率' ? 'FF047857' : 'FF0F172A',
      },
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF8FAFC' },
    }
    applyCellBorder(cell, 'FFCBD5E1')
  })
  ;[1, 2].forEach((col) => {
    const cell = totalRow.getCell(col)
    cell.font = { name: 'Microsoft YaHei', bold: true }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF8FAFC' },
    }
    applyCellBorder(cell, 'FFCBD5E1')
  })

  worksheet.columns = [
    { width: 12 },
    { width: 24 },
    ...SUMMARY_COLUMNS.map((column) => ({
      width: SUMMARY_PERCENT_COLUMNS.has(column)
        ? 12
        : SUMMARY_CURRENCY_COLUMNS.has(column)
          ? 14
          : 12,
    })),
  ]
}

function fillDetailWorksheet(
  worksheet: import('exceljs').Worksheet,
  detailColumns: string[],
  detailRows: Array<Record<string, unknown>>,
  detailGroupMeta: {
    groups: Array<{ title: string; columns: string[] }>
    extras: string[]
  },
  detailTotals: Record<string, number>,
  detailExtraTotals: Record<string, number | null>,
  meta: {
    weekLabel: string
    weekRange: string
    projectName: string
    country: CountryOption
  },
) {
  const lastColumn = detailColumns.length
  worksheet.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }]
  worksheet.mergeCells(1, 1, 1, lastColumn)
  worksheet.getCell(1, 1).value = '按周产品分析 - SKU明细'
  worksheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  worksheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }

  worksheet.mergeCells(2, 1, 2, lastColumn)
  worksheet.getCell(2, 1).value =
    `店铺：${meta.projectName}    站点：${meta.country}    周次：${meta.weekLabel}    日期：${meta.weekRange}`
  worksheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  worksheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }

  const groupRow = worksheet.getRow(4)
  const headRow = worksheet.getRow(5)
  worksheet.mergeCells(4, 1, 5, 1)
  worksheet.mergeCells(4, 2, 5, 2)
  groupRow.getCell(1).value = '日期'
  groupRow.getCell(2).value = 'SKU'

  let currentColumn = 3
  detailGroupMeta.groups.forEach((group) => {
    const start = currentColumn
    group.columns.forEach((column) => {
      headRow.getCell(currentColumn).value = column
      currentColumn += 1
    })
    worksheet.mergeCells(4, start, 4, currentColumn - 1)
    const groupCell = groupRow.getCell(start)
    groupCell.value = group.title
    groupCell.alignment = { vertical: 'middle', horizontal: 'center' }
    groupCell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    const color =
      group.title === '销售'
        ? 'FFDCEEFF'
        : group.title === '推广流量'
          ? 'FFFFE6D5'
          : group.title === '自然流量'
            ? 'FFDDF7EA'
            : group.title === '费用占比'
              ? 'FFFCE7C3'
              : 'FFEADFEE'
    groupCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: color },
    }
    applyCellBorder(groupCell)
  })

  detailGroupMeta.extras.forEach((column) => {
    worksheet.mergeCells(4, currentColumn, 5, currentColumn)
    const cell = groupRow.getCell(currentColumn)
    cell.value = column
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    }
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF1F5F9' },
    }
    applyCellBorder(cell, 'FFCBD5E1')
    currentColumn += 1
  })
  ;[groupRow, headRow].forEach((row) => {
    row.eachCell((cell) => {
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
      if (!cell.fill || !('fgColor' in cell.fill)) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
      }
      applyCellBorder(cell, 'FFCBD5E1')
    })
  })

  let rowIndex = 6
  detailRows.forEach((rowData) => {
    const row = worksheet.getRow(rowIndex)
    detailColumns.forEach((column, idx) => {
      const cell = row.getCell(idx + 1)
      const value = getExcelCellValue(column, rowData[column])
      cell.value = value
      cell.alignment = {
        vertical: 'middle',
        horizontal:
          column === '日期' || column === 'SKU' || typeof value !== 'number'
            ? 'left'
            : 'right',
      }
      const numFmt = getExcelNumberFormat(column)
      if (typeof value === 'number' && numFmt) cell.numFmt = numFmt
      applyCellBorder(cell)
    })
    rowIndex += 1
  })

  const totalRow = worksheet.getRow(rowIndex)
  detailColumns.forEach((column, idx) => {
    const cell = totalRow.getCell(idx + 1)
    if (column === '日期') {
      cell.value = '合计'
    } else if (column === 'SKU') {
      cell.value = `${detailRows.length} 行`
    } else if (SUMMARY_COLUMN_SET.has(column)) {
      cell.value = detailTotals[column] ?? 0
    } else if (
      detailExtraTotals[column] !== null &&
      detailExtraTotals[column] !== undefined
    ) {
      cell.value = detailExtraTotals[column] as number
    } else {
      cell.value = '-'
    }
    cell.font = { name: 'Microsoft YaHei', bold: true }
    cell.alignment = {
      vertical: 'middle',
      horizontal: typeof cell.value === 'number' ? 'right' : 'left',
    }
    const numFmt = getExcelNumberFormat(column)
    if (typeof cell.value === 'number' && numFmt) cell.numFmt = numFmt
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF8FAFC' },
    }
    applyCellBorder(cell, 'FFCBD5E1')
  })

  worksheet.columns = detailColumns.map((column) => ({
    width:
      column === '日期'
        ? 14
        : column === 'SKU'
          ? 22
          : SUMMARY_PERCENT_COLUMNS.has(column)
            ? 12
            : SUMMARY_CURRENCY_COLUMNS.has(column)
              ? 14
              : 12,
  }))
  autosizeWorksheetColumns(worksheet)
}

export default function WeeklyProductAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectId, setProjectId] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(eightWeeksAgoMondayDateString())
  const [endDate, setEndDate] = useState(lastSundayDateString())

  const [data, setData] = useState<WeeklyDataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<WeeklyViewTab>('summary')
  const [selectedWeekId, setSelectedWeekId] = useState('')
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<Array<Record<string, unknown>>>(
    [],
  )
  const [inventorySnapshotAt, setInventorySnapshotAt] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)
  const [recomputeMessage, setRecomputeMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const [visibleLines, setVisibleLines] = useState({
    sales_amount: true,
    units_sold: true,
    ad_spend: true,
    ad_clicks: true,
    organic_traffic: true,
  })

  const latestRequestIdRef = useRef(0)
  const summaryWeekHeadRef = useRef<HTMLTableCellElement | null>(null)
  const [summaryWeekColumnWidth, setSummaryWeekColumnWidth] = useState(
    SUMMARY_WEEK_COLUMN_FALLBACK_WIDTH,
  )

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectLoadError(null)
    try {
      const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
      setProjects(payload)
      if (payload.length > 0 && !projectId) {
        setProjectId(String(payload[0].id))
      }
    } catch (loadError) {
      setProjectLoadError(
        loadError instanceof Error ? loadError.message : '项目列表加载失败',
      )
    } finally {
      setProjectsLoading(false)
    }
  }, [projectId, session])

  const loadWeeklyData = useCallback(
    async (options?: { force?: boolean }) => {
      const parsedProjectId = Number(projectId)
      if (!parsedProjectId) {
        setError('请先选择店铺')
        setData([])
        return
      }

      const useCache = !options?.force
      const cacheKey = weeklyDataCacheKey(
        parsedProjectId,
        country,
        startDate,
        endDate,
      )
      const cachedPayload = useCache
        ? getClientCache<WeeklyDataRow[]>(cacheKey, WEEKLY_DATA_CACHE_TTL_MS)
        : null
      const hasCachedPayload = Array.isArray(cachedPayload)
      if (cachedPayload) {
        setData(cachedPayload)
        setError(null)
      }

      const requestId = latestRequestIdRef.current + 1
      latestRequestIdRef.current = requestId

      setLoading(!hasCachedPayload)
      if (!hasCachedPayload) {
        setError(null)
      }

      try {
        const search = new URLSearchParams({
          project_id: String(parsedProjectId),
          country,
        })
        if (startDate) search.set('start_date', startDate)
        if (endDate) search.set('end_date', endDate)

        const response = await fetch(
          `${API_BASE}/api/v1/product-analysis/weekly?${search.toString()}`,
          {
            cache: 'no-store',
            headers: authHeaders(),
          },
        )
        if (!response.ok) {
          throw new Error(
            parseErrorBody(await response.text(), response.status),
          )
        }

        const payload = (await response.json()) as WeeklyDataRow[]
        if (latestRequestIdRef.current !== requestId) return
        setData(payload)
        setClientCache(cacheKey, payload)
      } catch (loadError) {
        if (latestRequestIdRef.current !== requestId) return
        if (!hasCachedPayload) {
          setData([])
          setError(
            loadError instanceof Error
              ? loadError.message
              : '产品分析数据加载失败',
          )
        }
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [projectId, country, startDate, endDate],
  )

  const loadWeeklyDetails = useCallback(
    async (options?: { force?: boolean }) => {
      const pt1Id = Number(selectedWeekId)
      if (!pt1Id) {
        setDetailRows([])
        setDetailsError(null)
        setInventorySnapshotAt(null)
        return
      }

      const useCache = !options?.force
      const cacheKey = weeklyDetailsCacheKey(pt1Id, country)
      const cachedRows = useCache
        ? getClientCache<Array<Record<string, unknown>>>(
            cacheKey,
            WEEKLY_DETAILS_CACHE_TTL_MS,
          )
        : null
      const hasCachedRows = Array.isArray(cachedRows)
      if (cachedRows) {
        setDetailRows(cachedRows)
        setDetailsError(null)
      } else {
        setDetailRows([])
      }

      setDetailsLoading(!hasCachedRows)
      setDetailsError(null)
      try {
        const merged: Array<Record<string, unknown>> = []
        let page = 1
        let hasNext = true
        let pt1StartDate = ''
        let pt1EndDate = ''

        while (hasNext) {
          const search = new URLSearchParams({
            page: String(page),
            page_size: '1000',
            country,
          })
          const response = await fetch(
            `${API_BASE}/api/v1/product-analysis/pt1/${pt1Id}/details?${search.toString()}`,
            {
              cache: 'no-store',
              headers: authHeaders(),
            },
          )
          if (!response.ok) {
            throw new Error(
              parseErrorBody(await response.text(), response.status),
            )
          }

          const payload = (await response.json()) as PT1DetailsResponse
          if (page === 1) {
            pt1StartDate = payload.report_start_date
            pt1EndDate = payload.report_end_date
          }
          merged.push(...payload.rows.map((row) => buildDetailRow(row.raw_row)))
          hasNext = payload.has_next
          page += 1
        }

        // Fetch the latest inventory snapshot within the selected PT1 date range.
        let hasInventoryForPeriod = false
        try {
          const parsedProjectId = Number(projectId)
          if (parsedProjectId && pt1StartDate && pt1EndDate) {
            const inventorySearch = new URLSearchParams({
              project_id: String(parsedProjectId),
              country,
              start_date: pt1StartDate,
              end_date: pt1EndDate,
            })
            const invResponse = await fetch(
              `${API_BASE}/api/v1/product-analysis/inventory/current?${inventorySearch.toString()}`,
              { cache: 'no-store', headers: authHeaders() },
            )
            if (invResponse.ok) {
              const invPayload = (await invResponse.json()) as {
                rows?: Array<{ sku?: string | null; available_qty?: number | null }>
              }
              const invRows = invPayload?.rows ?? []
              if (invRows.length > 0) {
                hasInventoryForPeriod = true
              }
              const skuInventoryMap: Record<string, number> = {}
              invRows.forEach((invRow) => {
                if (invRow.sku) {
                  skuInventoryMap[String(invRow.sku).toLowerCase()] =
                    Number(invRow.available_qty) || 0
                }
              })
              merged.forEach((row) => {
                const rowSku = String(row['SKU'] || '').toLowerCase()
                row['库存'] = skuInventoryMap[rowSku] ?? 0
              })
            }
          }
        } catch {
          // inventory snapshot is optional, ignore errors
        }

        // Default to 0 inventory when no snapshot is available.
        if (!hasInventoryForPeriod) {
          merged.forEach((row) => {
            row['库存'] = 0
          })
        }

        setDetailRows(merged)
        setInventorySnapshotAt(hasInventoryForPeriod ? 'available' : null)
        setClientCache(cacheKey, merged, { persist: false })
      } catch (loadError) {
        if (!hasCachedRows) {
          setDetailRows([])
          setDetailsError(
            loadError instanceof Error ? loadError.message : 'SKU明细 加载失败',
          )
        }
      } finally {
        setDetailsLoading(false)
      }
    },
    [selectedWeekId, country, projectId],
  )

  const handleRecomputeHistory = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId) {
      setError('请先选择店铺')
      return
    }

    setRecomputeMessage(null)
    setRecomputing(true)
    try {
      const search = new URLSearchParams({
        project_id: String(parsedProjectId),
        country,
      })
      if (startDate) search.set('start_date', startDate)
      if (endDate) search.set('end_date', endDate)

      const response = await fetch(
        `${API_BASE}/api/v1/product-analysis/weekly/recompute?${search.toString()}`,
        {
          method: 'POST',
          headers: authHeaders(),
        },
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      const payload = (await response.json()) as { recomputed?: number }
      clearClientCache(
        weeklyDataCacheKey(parsedProjectId, country, startDate, endDate),
      )
      if (selectedWeekId) {
        clearClientCache(weeklyDetailsCacheKey(Number(selectedWeekId), country))
      }
      await loadWeeklyData({ force: true })
      if (activeTab === 'details') {
        await loadWeeklyDetails({ force: true })
      }
      setRecomputeMessage(
        `已按最新 SKU cost 重算 ${Number(payload.recomputed || 0)} 个历史周报`,
      )
      notify({ type: 'success', title: '周度数据重算完成', message: `已重算 ${Number(payload.recomputed || 0)} 个历史周报` })
    } catch (recomputeError) {
      setError(
        recomputeError instanceof Error
          ? recomputeError.message
          : '历史周报重算失败',
      )
      notify({ type: 'error', title: '周度数据重算失败', message: recomputeError instanceof Error ? recomputeError.message : '历史周报重算失败' })
    } finally {
      setRecomputing(false)
    }
  }, [
    notify,
    projectId,
    country,
    startDate,
    endDate,
    selectedWeekId,
    loadWeeklyData,
    activeTab,
    loadWeeklyDetails,
  ])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (!projectId || projectsLoading) return
    void loadWeeklyData()
  }, [projectId, projectsLoading, loadWeeklyData])

  const trendRows = useMemo(() => {
    if (!data || data.length === 0) return []
    return [...data].sort((a, b) => {
      const dateOrder = String(a.report_start_date).localeCompare(
        String(b.report_start_date),
      )
      if (dateOrder !== 0) return dateOrder
      return Number(a.id || 0) - Number(b.id || 0)
    })
  }, [data])

  const trendPoints = useMemo(() => {
    if (!trendRows || trendRows.length === 0) return []
    return trendRows.map((row) => {
      const summary = buildSummaryForRow(row)
      return {
        week_label: formatWeekLabel(row.report_start_date, row.report_end_date),
        start_date: row.report_start_date,
        end_date: row.report_end_date,
        sales_amount: Number(row.total_sales || 0),
        units_sold: Number(row.total_units || 0),
        ad_spend: Number(row.total_ad_spend || 0),
        ad_clicks: toNumber(summary['广告点击量']),
        organic_traffic: toNumber(summary['自然流量']),
      }
    })
  }, [trendRows])

  const totals = useMemo(() => {
    return data.reduce(
      (acc, row) => {
        return {
          sales_amount: acc.sales_amount + Number(row.total_sales || 0),
          units_sold: acc.units_sold + Number(row.total_units || 0),
          ad_spend: acc.ad_spend + Number(row.total_ad_spend || 0),
        }
      },
      {
        sales_amount: 0,
        units_sold: 0,
        ad_spend: 0,
      },
    )
  }, [data])

  const trends = useMemo(() => {
    if (!trendRows || trendRows.length < 2) return { sales: 0, units: 0, ad: 0 }
    const last = trendRows[trendRows.length - 1]
    const prev = trendRows[trendRows.length - 2]
    const lastSales = Number(last.total_sales || 0)
    const prevSales = Number(prev.total_sales || 0)
    const lastUnits = Number(last.total_units || 0)
    const prevUnits = Number(prev.total_units || 0)
    const lastAd = Number(last.total_ad_spend || 0)
    const prevAd = Number(prev.total_ad_spend || 0)

    return {
      sales:
        prevSales !== 0
          ? ((lastSales - prevSales) / Math.abs(prevSales)) * 100
          : 0,
      units:
        prevUnits !== 0
          ? ((lastUnits - prevUnits) / Math.abs(prevUnits)) * 100
          : 0,
      ad: prevAd !== 0 ? ((lastAd - prevAd) / Math.abs(prevAd)) * 100 : 0,
    }
  }, [trendRows])

  const summaryRows = useMemo<WeeklySummaryItem[]>(() => {
    return trendRows.map((row) => ({ row, summary: buildSummaryForRow(row) }))
  }, [trendRows])

  const summaryTotals = useMemo(() => {
    return buildSummaryTotals(summaryRows.map((item) => item.summary))
  }, [summaryRows])

  useEffect(() => {
    if (activeTab !== 'summary') return
    const headerCell = summaryWeekHeadRef.current
    if (!headerCell) return

    const updateWidth = () => {
      const nextWidth = Math.ceil(headerCell.getBoundingClientRect().width)
      if (nextWidth > 0) {
        setSummaryWeekColumnWidth((prev) =>
          prev === nextWidth ? prev : nextWidth,
        )
      }
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateWidth)
    observer.observe(headerCell)
    return () => observer.disconnect()
  }, [activeTab, summaryRows.length])

  useEffect(() => {
    setSelectedWeekId((prev) => {
      if (prev && summaryRows.some((item) => String(item.row.id) === prev))
        return prev
      return summaryRows.length > 0 ? String(summaryRows[0].row.id) : ''
    })
  }, [summaryRows])

  useEffect(() => {
    if (activeTab !== 'details') return
    void loadWeeklyDetails()
  }, [activeTab, loadWeeklyDetails])

  const detailColumns = useMemo(() => {
    if (detailRows.length === 0) return DETAIL_BASE_COLUMNS
    const extra = new Set<string>()
    detailRows.forEach((row) => {
      Object.keys(row).forEach((key) => {
        if (key === 'ASIN') return
        if (!DETAIL_BASE_COLUMN_SET.has(key)) {
          extra.add(key)
        }
      })
    })
    return [...DETAIL_BASE_COLUMNS, ...Array.from(extra)]
  }, [detailRows])

  const detailGroupMeta = useMemo(() => {
    const detailColumnSet = new Set<string>(detailColumns)
    const groups = DETAIL_COLUMN_GROUPS.map((group) => ({
      ...group,
      columns: group.columns.filter((column) => detailColumnSet.has(column)),
    })).filter((group) => group.columns.length > 0)

    const groupedColumns = new Set<string>(
      groups.flatMap((group) => group.columns),
    )
    const coreColumnSet = new Set<string>(DETAIL_CORE_COLUMNS)
    const extras = detailColumns.filter(
      (column) => !coreColumnSet.has(column) && !groupedColumns.has(column),
    )
    const headClassByColumn: Record<string, string> = {}
    groups.forEach((group) => {
      group.columns.forEach((column) => {
        headClassByColumn[column] = group.headClass
      })
    })
    return { groups, extras, headClassByColumn }
  }, [detailColumns])

  const detailTotals = useMemo(
    () => buildSummaryTotals(detailRows),
    [detailRows],
  )

  const detailExtraTotals = useMemo(() => {
    const totals: Record<string, number | null> = {}
    detailGroupMeta.extras.forEach((column) => {
      totals[column] = sumAnyNumericColumn(detailRows, column)
    })
    return totals
  }, [detailRows, detailGroupMeta.extras])
  const showSummarySkeleton = loading && data.length === 0
  const showDetailsSkeleton = detailsLoading && detailRows.length === 0

  const exportWeeklyAnalysis = useCallback(async () => {
    const projectName =
      projects.find((item) => String(item.id) === projectId)?.name ??
      '未命名店铺'
    if (summaryRows.length === 0) {
      setError('当前没有可导出的周汇总数据。')
      return
    }

    const targetWeekId = selectedWeekId || String(summaryRows[0]?.row.id || '')
    const targetWeek =
      summaryRows.find((item) => String(item.row.id) === targetWeekId) ??
      summaryRows[0]
    if (!targetWeek) {
      setError('当前没有可导出的周次数据。')
      return
    }

    setExporting(true)
    setError(null)
    setDetailsError(null)

    try {
      let exportDetailRows = detailRows
      if (
        String(targetWeek.row.id) !== selectedWeekId ||
        detailRows.length === 0
      ) {
        const cacheKey = weeklyDetailsCacheKey(
          Number(targetWeek.row.id),
          country,
        )
        const cachedRows = getClientCache<Array<Record<string, unknown>>>(
          cacheKey,
          WEEKLY_DETAILS_CACHE_TTL_MS,
        )
        if (cachedRows) {
          exportDetailRows = cachedRows
        } else {
          const merged: Array<Record<string, unknown>> = []
          let page = 1
          let hasNext = true

          while (hasNext) {
            const search = new URLSearchParams({
              page: String(page),
              page_size: '1000',
              country,
            })
            const response = await fetch(
              `${API_BASE}/api/v1/product-analysis/pt1/${targetWeek.row.id}/details?${search.toString()}`,
              {
                cache: 'no-store',
                headers: authHeaders(),
              },
            )
            if (!response.ok) {
              throw new Error(
                parseErrorBody(await response.text(), response.status),
              )
            }
            const payload = (await response.json()) as PT1DetailsResponse
            merged.push(
              ...payload.rows.map((row) => buildDetailRow(row.raw_row)),
            )
            hasNext = payload.has_next
            page += 1
          }

          exportDetailRows = merged
          setClientCache(cacheKey, merged, { persist: false })
        }
      }

      const exportDetailColumns =
        exportDetailRows.length === 0
          ? DETAIL_BASE_COLUMNS
          : [
              ...DETAIL_BASE_COLUMNS,
              ...Array.from(
                new Set(
                  exportDetailRows.flatMap((row) =>
                    Object.keys(row).filter(
                      (key) =>
                        key !== 'ASIN' && !DETAIL_BASE_COLUMN_SET.has(key),
                    ),
                  ),
                ),
              ),
            ]

      const exportDetailColumnSet = new Set<string>(exportDetailColumns)
      const exportGroups = DETAIL_COLUMN_GROUPS.map((group) => ({
        ...group,
        columns: group.columns.filter((column) =>
          exportDetailColumnSet.has(column),
        ),
      })).filter((group) => group.columns.length > 0)
      const exportGroupedColumns = new Set<string>(
        exportGroups.flatMap((group) => group.columns),
      )
      const exportExtras = exportDetailColumns.filter(
        (column) =>
          !DETAIL_CORE_COLUMNS.includes(
            column as (typeof DETAIL_CORE_COLUMNS)[number],
          ) && !exportGroupedColumns.has(column),
      )
      const exportDetailTotals = buildSummaryTotals(exportDetailRows)
      const exportDetailExtraTotals = Object.fromEntries(
        exportExtras.map((column) => [
          column,
          sumAnyNumericColumn(exportDetailRows, column),
        ]),
      )

      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const summarySheet = workbook.addWorksheet('汇总', {
        views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
      })
      fillSummaryWorksheet(summarySheet, summaryRows, summaryTotals, {
        projectName,
        country,
        startDate,
        endDate,
      })

      const detailSheet = workbook.addWorksheet('SKU明细', {
        views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
      })
      fillDetailWorksheet(
        detailSheet,
        exportDetailColumns,
        exportDetailRows,
        { groups: exportGroups, extras: exportExtras },
        exportDetailTotals,
        exportDetailExtraTotals,
        {
          projectName,
          country,
          weekLabel: `第${summaryRows.findIndex((item) => item.row.id === targetWeek.row.id) + 1}周`,
          weekRange: formatDateRange(
            targetWeek.row.report_start_date,
            targetWeek.row.report_end_date,
          ),
        },
      )

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `按周产品分析-${projectName}-${country}-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'product_analysis.weekly.export',
        targetType: 'product_analysis_weekly',
        targetId: projectId,
        after: {
          project_id: projectId,
          project_name: projectName,
          country,
          start_date: startDate,
          end_date: endDate,
          summary_count: summaryRows.length,
          detail_count: exportDetailRows.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      )
    } finally {
      setExporting(false)
    }
  }, [
    country,
    detailRows,
    endDate,
    projectId,
    projects,
    selectedWeekId,
    startDate,
    summaryRows,
    summaryTotals,
  ])

  return (
    <div className='w-full space-y-6'>
      <DataCard>
        <DataCardHeader
          title='按周产品分析'
          titleClassName='text-2xl tracking-tight'
          badge={<p className='dashboard-kicker'>Analysis Console</p>}
        />
        <DataCardContent className="flex flex-wrap items-end gap-3">
          {projectsLoading ? (
            <WeeklyFilterSkeleton width="min-w-[180px]" />
          ) : (
            <FilterField label="店铺">
              <Select
                value={projectId}
                onValueChange={setProjectId}
                disabled={projects.length === 0}
              >
                <SelectTrigger className="h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <SelectValue placeholder="请选择店铺" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
          )}
          <FilterField label="国家站点">
            <CountrySelect
              value={country}
              onChange={(value) => setCountry(value as CountryOption)}
              triggerClassName="h-9"
            />
          </FilterField>
          <FilterField label="日期范围">
            <DateRangePicker
              value={parseDateRangeInputValue(startDate, endDate)}
              onChange={(range) => {
                setStartDate(formatDateInputValue(range?.from))
                setEndDate(formatDateInputValue(range?.to))
              }}
              className="h-9"
            />
          </FilterField>
          <RefreshButton
            onClick={() => void loadWeeklyData({ force: true })}
            loading={loading}
            label="刷新数据"
            variant="outline"
            className="h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]"
          />
        </DataCardContent>

        {projectLoadError ? (
          <div className='border-t border-border/70 px-6 pb-4 pt-2'>
            <div className='rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
              {projectLoadError}
            </div>
          </div>
        ) : null}
        {error ? (
          <div className='border-t border-border/70 px-6 pb-4 pt-2'>
            <div className='rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
              {error}
            </div>
          </div>
        ) : null}
        {recomputeMessage ? (
          <div className='border-t border-border/70 px-6 pb-4 pt-2'>
            <div className='rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300'>
              {recomputeMessage}
            </div>
          </div>
        ) : null}
      </DataCard>

      <DataCard>
        <DataCardHeader
          title='周度趋势'
          badge={<p className='dashboard-kicker'>Weekly Trend</p>}
          
          action={
            <div className='flex flex-wrap items-center justify-center gap-2 sm:justify-end'>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    sales_amount: !prev.sales_amount,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.sales_amount
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-border/70 bg-[hsl(var(--surface-soft))]/70 text-muted-foreground line-through dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                }`}
              >
                {visibleLines.sales_amount ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--chart-2))' }}
                />
                销售额
              </button>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    units_sold: !prev.units_sold,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.units_sold
                    ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                    : 'border-border/70 bg-[hsl(var(--surface-soft))]/70 text-muted-foreground line-through dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                }`}
              >
                {visibleLines.units_sold ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--primary))' }}
                />
                销量
              </button>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    ad_spend: !prev.ad_spend,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.ad_spend
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                    : 'border-border/70 bg-[hsl(var(--surface-soft))]/70 text-muted-foreground line-through dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                }`}
              >
                {visibleLines.ad_spend ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--destructive))' }}
                />
                广告花费
              </button>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    ad_clicks: !prev.ad_clicks,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.ad_clicks
                    ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                    : 'border-border/70 bg-[hsl(var(--surface-soft))]/70 text-muted-foreground line-through dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                }`}
              >
                {visibleLines.ad_clicks ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--chart-4))' }}
                />
                广告点击量
              </button>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    organic_traffic: !prev.organic_traffic,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.organic_traffic
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : 'border-muted bg-muted/30 text-muted-foreground line-through'
                }`}
              >
                {visibleLines.organic_traffic ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--chart-5))' }}
                />
                自然流量
              </button>
            </div>
          }
        />
        <DataTableCardStatBar
          className='border-b border-border/70 bg-[hsl(var(--surface-subtle))]'
          items={[
            {
              label: '销售额合计',
              value: formatCurrency(totals.sales_amount),
              highlight: true,
            },
            { label: '销量合计', value: totals.units_sold.toLocaleString() },
            { label: '广告花费合计', value: formatCurrency(totals.ad_spend) },
          ]}
        />
        <div className='px-2 pt-4 sm:px-6 sm:pt-6'>
          {loading && data.length > 0 ? (
            <div className='mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm'>
              趋势数据更新中...
            </div>
          ) : null}
          {showSummarySkeleton ? (
            <Skeleton className='h-[320px] w-full' />
          ) : trendPoints.length > 0 ? (
            <ChartContainer
              config={chartConfig}
              className='aspect-auto h-[320px] w-full'
            >
              <AreaChart
                accessibilityLayer
                data={trendPoints}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id='fillSales' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--color-sales_amount)'
                      stopOpacity={0.7}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-sales_amount)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                  <linearGradient id='fillUnits' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--color-units_sold)'
                      stopOpacity={0.7}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-units_sold)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                  <linearGradient id='fillAd' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--color-ad_spend)'
                      stopOpacity={0.7}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-ad_spend)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                  <linearGradient id='fillAdClicks' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--color-ad_clicks)'
                      stopOpacity={0.5}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-ad_clicks)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                  <linearGradient
                    id='fillOrganicTraffic'
                    x1='0'
                    y1='0'
                    x2='0'
                    y2='1'
                  >
                    <stop
                      offset='5%'
                      stopColor='var(--color-organic_traffic)'
                      stopOpacity={0.5}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-organic_traffic)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke='hsl(var(--border))'
                  strokeOpacity={0.5}
                />
                <XAxis
                  dataKey='week_label'
                  tickLine={false}
                  axisLine={false}
                  tickMargin={12}
                  minTickGap={32}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                />
                <YAxis
                  tickFormatter={(v) => Number(v).toLocaleString()}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={12}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  width={70}
                />
                <ChartTooltip
                  cursor={{
                    stroke: 'hsl(var(--muted-foreground))',
                    strokeWidth: 1,
                    strokeDasharray: '4 4',
                  }}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => String(value)}
                      formatter={(value, name) => {
                        const nameMap: Record<string, string> = {
                          sales_amount: '销售额',
                          units_sold: '销量',
                          ad_spend: '广告花费',
                          ad_clicks: '广告点击量',
                          organic_traffic: '自然流量',
                        }
                        const displayName =
                          nameMap[String(name)] || String(name)
                        const metricKey = String(name)
                        const isCurrencyMetric =
                          metricKey === 'sales_amount' ||
                          metricKey === 'ad_spend'
                        return (
                          <div className='flex items-center justify-between gap-4'>
                            <span className='text-muted-foreground'>
                              {displayName}
                            </span>
                            <span className='font-medium'>
                              {isCurrencyMetric
                                ? formatCurrency(Number(value))
                                : Number(value).toLocaleString()}
                            </span>
                          </div>
                        )
                      }}
                      indicator='dot'
                    />
                  }
                />
                {visibleLines.sales_amount ? (
                  <Area
                    type='monotone'
                    dataKey='sales_amount'
                    stroke='var(--color-sales_amount)'
                    fill='url(#fillSales)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ) : null}
                {visibleLines.units_sold ? (
                  <Area
                    type='monotone'
                    dataKey='units_sold'
                    stroke='var(--color-units_sold)'
                    fill='url(#fillUnits)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ) : null}
                {visibleLines.ad_spend ? (
                  <Area
                    type='monotone'
                    dataKey='ad_spend'
                    stroke='var(--color-ad_spend)'
                    fill='url(#fillAd)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ) : null}
                {visibleLines.ad_clicks ? (
                  <Area
                    type='monotone'
                    dataKey='ad_clicks'
                    stroke='var(--color-ad_clicks)'
                    fill='url(#fillAdClicks)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ) : null}
                {visibleLines.organic_traffic ? (
                  <Area
                    type='monotone'
                    dataKey='organic_traffic'
                    stroke='var(--color-organic_traffic)'
                    fill='url(#fillOrganicTraffic)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                ) : null}
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className='rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
              暂无趋势数据
            </div>
          )}
        </div>
      </DataCard>

      <DataTableCard className='animate-enter'>
        <DataTableCardHeader className='flex flex-wrap items-center justify-between gap-3 px-6 py-4'>
          <div>
            <p className='dashboard-kicker'>Operational Ledger</p>
            <div className='text-base font-semibold text-foreground'>
              每周分析明细
            </div>
            <p className='text-sm text-muted-foreground'>
            </p>
            <div className='mt-2 rounded-md border border-amber-200/70 bg-amber-50/80 px-3 py-2 text-xs text-amber-900'>
              备注：利润 = 实际销售额 - 总成本 - 广告花费 - 实际退款额
            </div>
          </div>
          <div className='ml-auto flex flex-wrap items-center justify-end gap-2'>
            {activeTab === 'details' ? (
              <>
                <Select
                  value={selectedWeekId}
                  onValueChange={setSelectedWeekId}
                  disabled={summaryRows.length === 0}
                >
                  <SelectTrigger className='h-8 w-[250px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]'>
                    <SelectValue placeholder='选择周次' />
                  </SelectTrigger>
                  <SelectContent>
                    {summaryRows.map((item, index) => (
                      <SelectItem key={item.row.id} value={String(item.row.id)}>
                        第{index + 1}周 ·{' '}
                        {formatDateRange(
                          item.row.report_start_date,
                          item.row.report_end_date,
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type='button'
                  variant='outline'
                  className='h-8 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]'
                  onClick={() => void loadWeeklyDetails({ force: true })}
                  disabled={!selectedWeekId || detailsLoading}
                >
                  {detailsLoading ? '加载中...' : '刷新 SKU明细'}
                </Button>
              </>
            ) : null}
            <Button
              type='button'
              variant='outline'
              className='h-8'
              onClick={() => void exportWeeklyAnalysis()}
              disabled={exporting || summaryRows.length === 0}
            >
              {exporting ? (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              ) : (
                <Download className='mr-2 h-4 w-4' />
              )}
              导出 Excel
            </Button>
            <Button
              type='button'
              variant='outline'
              className='h-8'
              onClick={() => void handleRecomputeHistory()}
              disabled={recomputing || loading || !projectId}
            >
              {recomputing ? '重新核算中...' : '重新核算'}
            </Button>
            <div className='inline-flex rounded-md border border-border/70 bg-muted/20 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'>
              <button
                type='button'
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === 'summary' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                onClick={() => setActiveTab('summary')}
              >
                周汇总
              </button>
              <button
                type='button'
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === 'details' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                onClick={() => setActiveTab('details')}
              >
                SKU明细
              </button>
            </div>
          </div>
        </DataTableCardHeader>
        <DataTableCardBody>
          {activeTab === 'summary' && loading && summaryRows.length > 0 ? (
            <div className='mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm'>
              周汇总更新中...
            </div>
          ) : null}
          {activeTab === 'details' &&
          detailsLoading &&
          detailRows.length > 0 ? (
            <div className='mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm'>
              SKU 明细更新中...
            </div>
          ) : null}
          {activeTab === 'summary' ? (
            showSummarySkeleton ? (
              <BarSkeleton rows={5} />
            ) : summaryRows.length > 0 ? (
              <Table
                containerClassName='w-full max-w-full overflow-x-auto'
                className='w-max min-w-[4200px] table-fixed text-xs'
              >
                <TableHeader>
                  <TableRow className='bg-muted/30 hover:bg-muted/30'>
                    <TableHead
                      ref={summaryWeekHeadRef}
                      rowSpan={2}
                      className='sticky z-40 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap'
                      style={{ left: 0 }}
                    >
                      周次
                    </TableHead>
                    <TableHead
                      rowSpan={2}
                      className='sticky z-40 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap'
                      style={{ left: summaryWeekColumnWidth }}
                    >
                      日期范围
                    </TableHead>
                    {SUMMARY_COLUMN_GROUPS.map((group) => (
                      <TableHead
                        key={group.title}
                        colSpan={group.columns.length}
                        className={`border-r px-2 py-2 text-center text-foreground ${group.groupClass}`}
                      >
                        {group.title}
                      </TableHead>
                    ))}
                  </TableRow>
                  <TableRow className='bg-muted/20 hover:bg-muted/20'>
                    {SUMMARY_COLUMN_GROUPS.map((group) =>
                      group.columns.map((column) => (
                        <TableHead
                          key={column}
                          className={`border-r px-2 py-1.5 text-center whitespace-nowrap ${group.headClass}`}
                        >
                          {column}
                        </TableHead>
                      )),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summaryRows.map((item, index) => {
                    const row = item.row
                    const rowBg = row.is_current
                      ? 'bg-background'
                      : 'bg-muted/20'
                    return (
                      <TableRow
                        key={row.id}
                        className={!row.is_current ? 'bg-muted/15' : undefined}
                      >
                        <TableCell
                          className={`sticky z-20 border-r border-border px-2 py-1.5 text-center font-medium whitespace-nowrap ${rowBg}`}
                          style={{ left: 0 }}
                        >
                          第{index + 1}周
                        </TableCell>
                        <TableCell
                          className={`sticky z-20 border-r border-border px-2 py-1.5 text-center whitespace-nowrap ${rowBg}`}
                          style={{ left: summaryWeekColumnWidth }}
                        >
                          {formatDateRange(
                            row.report_start_date,
                            row.report_end_date,
                          )}
                        </TableCell>
                        {SUMMARY_COLUMNS.map((column) => (
                          <TableCell
                            key={`${row.id}-${column}`}
                            className='border-r px-2 py-1.5 text-right tabular-nums'
                          >
                            {formatSummaryCell(column, item.summary[column])}
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow className='bg-muted font-semibold hover:bg-muted'>
                    <TableCell
                      className='sticky z-30 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap'
                      style={{ left: 0 }}
                    >
                      合计
                    </TableCell>
                    <TableCell
                      className='sticky z-30 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap'
                      style={{ left: summaryWeekColumnWidth }}
                    >
                      {summaryRows.length} 周
                    </TableCell>
                    {SUMMARY_COLUMNS.map((column) => (
                      <TableCell
                        key={`summary-total-${column}`}
                        className='border-r px-2 py-2 text-right tabular-nums'
                      >
                        {formatSummaryCell(column, summaryTotals[column])}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              </Table>
            ) : (
              <div className='rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
                当前筛选条件暂无产品分析周汇总数据
              </div>
            )
          ) : showDetailsSkeleton ? (
            <BarSkeleton rows={8} />
          ) : detailsError ? (
            <div className='rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
              {detailsError}
            </div>
          ) : detailRows.length > 0 ? (
            <Table
              containerClassName='w-full max-w-full overflow-x-auto'
              className='w-max min-w-[3600px] table-fixed text-xs'
            >
              <TableHeader>
                <TableRow className='bg-muted/30 hover:bg-muted/30'>
                  <TableHead
                    rowSpan={2}
                    className='sticky z-40 border-r border-border bg-muted px-3 py-2 text-center whitespace-nowrap'
                    style={{
                      left: DETAIL_STICKY_LEFT[0],
                      minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0],
                    }}
                  >
                    日期
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='sticky z-40 border-r border-border bg-muted px-3 py-2 text-center whitespace-nowrap'
                    style={{
                      left: DETAIL_STICKY_LEFT[1],
                      minWidth: DETAIL_STICKY_COLUMN_WIDTHS[1],
                    }}
                  >
                    SKU
                  </TableHead>
                  {detailGroupMeta.groups.map((group) => (
                    <TableHead
                      key={group.title}
                      colSpan={group.columns.length}
                      className={`border-r px-2 py-2 text-center text-foreground ${group.groupClass}`}
                    >
                      {group.title}
                    </TableHead>
                  ))}
                  {detailGroupMeta.extras.map((column) => (
                    <TableHead
                      key={`detail-extra-top-${column}`}
                      rowSpan={2}
                      className='border-r px-2 py-2 text-center whitespace-nowrap bg-muted/20'
                    >
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow className='bg-muted/20 hover:bg-muted/20'>
                  {detailGroupMeta.groups.map((group) =>
                    group.columns.map((column) => (
                      <TableHead
                        key={column}
                        className={`border-r px-2 py-1.5 text-center whitespace-nowrap ${detailGroupMeta.headClassByColumn[column] || ''}`}
                      >
                        {column}
                      </TableHead>
                    )),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detailRows.map((row, idx) => (
                  <TableRow key={`detail-${idx}`}>
                    {detailColumns.map((column) => (
                      <TableCell
                        key={`detail-${idx}-${column}`}
                        className={`border-r px-2 py-1.5 tabular-nums whitespace-nowrap ${column === '日期' || column === 'SKU' ? 'sticky z-20 border-border bg-background text-left' : 'text-right'}`}
                        style={
                          column === '日期'
                            ? {
                                left: DETAIL_STICKY_LEFT[0],
                                minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0],
                              }
                            : column === 'SKU'
                              ? {
                                  left: DETAIL_STICKY_LEFT[1],
                                  minWidth: DETAIL_STICKY_COLUMN_WIDTHS[1],
                                }
                              : undefined
                        }
                      >
                        {formatDetailCell(column, row[column])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className='bg-muted font-semibold hover:bg-muted'>
                  {detailColumns.map((column) => {
                    if (column === '日期')
                      return (
                        <TableCell
                          key='detail-total-date'
                          className='sticky z-30 border-r border-border bg-muted px-2 py-2 text-left'
                          style={{
                            left: DETAIL_STICKY_LEFT[0],
                            minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0],
                          }}
                        >
                          合计
                        </TableCell>
                      )
                    if (column === 'SKU')
                      return (
                        <TableCell
                          key='detail-total-sku'
                          className='sticky z-30 border-r border-border bg-muted px-2 py-2 text-left'
                          style={{
                            left: DETAIL_STICKY_LEFT[1],
                            minWidth: DETAIL_STICKY_COLUMN_WIDTHS[1],
                          }}
                        >
                          {detailRows.length} 行
                        </TableCell>
                      )
                    if (SUMMARY_COLUMN_SET.has(column))
                      return (
                        <TableCell
                          key={`detail-total-${column}`}
                          className='border-r px-2 py-2 text-right tabular-nums'
                        >
                          {formatDetailCell(column, detailTotals[column])}
                        </TableCell>
                      )
                    const extraTotal = detailExtraTotals[column]
                    return (
                      <TableCell
                        key={`detail-total-${column}`}
                        className='border-r px-2 py-2 text-right tabular-nums'
                      >
                        {extraTotal === null
                          ? '-'
                          : formatDetailCell(column, extraTotal)}
                      </TableCell>
                    )
                  })}
                </TableRow>
              </TableFooter>
            </Table>
          ) : (
            <div className='rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
              当前周次暂无 SKU明细 数据
            </div>
          )}
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}
