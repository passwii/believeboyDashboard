'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { AlertTriangle, Download, Eye, EyeOff, Loader2 } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { useMobile } from '@/lib/hooks/use-mobile'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { formatDateInputValue, parseDateRangeInputValue } from '@/components/ui/date-picker'
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
import { clearClientCache, getClientCache, setClientCache } from '@/lib/client-cache'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { useNotifications } from '@/components/notifications'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import {
  HeaderSlotDateRange,
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
  TERM_HEADER_W_XL,
} from '@/components/terminal/header-filter-suite'
import { useHeaderRefresh, useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'

type ProjectOption = {
  id: number | null
  name: string
}

type WeeklyDataRow = {
  id: number
  project_id: number
  project_name: string
  country: string
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

/** 站点选项：本页仅支持 US/DE/UK（无 ALL——与 useUrlParam allowed 集合一致，保持页面原生选项集） */
const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

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

function WeeklyStatSkeleton() {
  return <Skeleton className="h-[132px] w-full rounded-none" />
}

function LoadingScrim({
  children,
  className = 'p-4',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/78 backdrop-blur-[2px]">
      <div className={className}>{children}</div>
    </div>
  )
}

// 骨架屏占位加载状态：用于切换项目/国家时的平滑过渡
type SkeletonState = 'idle' | 'loading' | 'visible'

const SKELETON_DELAY_MS = 80 // 骨架屏延迟显示，避免快速切换闪烁
const FADE_DURATION_MS = 250 // 内容淡入 + 骨架屏淡出的交叉时间

const API_BASE = '/api/backend'
const WEEKLY_DATA_CACHE_TTL_MS = 3 * 60 * 1000
const WEEKLY_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000

function weeklyDataCacheKey(
  projectId: number,
  country: CountryOption,
  startDate: string,
  endDate: string
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
    groupClass: 'bg-term-accent/15',
    headClass: 'bg-term-accent/10',
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
    groupClass: 'bg-term-warn/15',
    headClass: 'bg-term-warn/10',
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
    groupClass: 'bg-term-accent/15',
    headClass: 'bg-term-accent/10',
  },
] as const

const SUMMARY_COLUMNS = SUMMARY_COLUMN_GROUPS.flatMap((item) => item.columns)
const SUMMARY_COLUMN_SET = new Set<string>(SUMMARY_COLUMNS)
const DETAIL_CORE_COLUMNS = ['日期', 'SKU'] as const
const DETAIL_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
    groupClass: 'bg-term-accent/15',
    headClass: 'bg-term-accent/10',
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
    groupClass: 'bg-term-warn/15',
    headClass: 'bg-term-warn/10',
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
    groupClass: 'bg-term-accent/15',
    headClass: 'bg-term-accent/10',
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
    color: 'hsl(var(--chart-1))',
  },
  units_sold: {
    label: '销量',
    color: 'hsl(var(--chart-2))',
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
  acos: {
    label: 'ACOS',
    color: 'hsl(var(--chart-3))',
  },
  ctr: {
    label: '广告点击率',
    color: 'hsl(var(--warning))',
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
            return typeof maybeMsg === 'string' ? maybeMsg : JSON.stringify(item)
          }
          return String(item)
        })
        .join('; ')
    }
    if (payload.detail && typeof payload.detail === 'object') return JSON.stringify(payload.detail)
    return text
  } catch {
    return text
  }
}

function formatDateRange(start: string, end: string): string {
  return `${start} 至 ${end}`
}

const CURRENCY_SYMBOLS: Record<CountryOption, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

function getCurrencySymbol(country: CountryOption): string {
  return CURRENCY_SYMBOLS[country] || '$'
}

function formatCurrency(value: number, country: CountryOption = 'US'): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const symbol = getCurrencySymbol(country)
  return `${value < 0 ? '-' : ''}${symbol}${text}`
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

function getISOWeek(dateStr: string): string {
  const date = new Date(dateStr)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`
}

type PeriodCompleteness = {
  total_days: number
  available_business_days: number
  available_ad_days: number
  business_missing_dates: string[]
  ad_missing_dates: string[]
  payment_covered: boolean
  payment_type: string
  payment_missing: boolean
  payment_missing_dates?: string[]
}

function extractCompleteness(row: WeeklyDataRow): {
  isPartial: boolean
  completeness: PeriodCompleteness | null
} {
  const raw = row.summary_row
  if (!raw || typeof raw !== 'object') return { isPartial: false, completeness: null }
  const isPartial = raw._is_partial === true
  const comp = raw._completeness as PeriodCompleteness | undefined
  return { isPartial, completeness: comp ?? null }
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

function formatSummaryCell(column: string, value: unknown, country: CountryOption = 'US'): string {
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
    return formatCurrency(numeric, country)
  }
  return numeric.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function sumSummaryValue(rows: Array<Record<string, unknown>>, column: string): number {
  return rows.reduce((acc, row) => acc + toNumber(row[column]), 0)
}

function buildSummaryTotals(rows: Array<Record<string, unknown>>): Record<string, number> {
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
  const rawSummary = row.summary_row && typeof row.summary_row === 'object' ? row.summary_row : {}
  const summary: Record<string, unknown> = { ...rawSummary }

  if (!hasValue(summary['总销量'])) summary['总销量'] = row.total_units
  if (!hasValue(summary['总销售额'])) summary['总销售额'] = row.total_sales
  if (!hasValue(summary['广告花费'])) summary['广告花费'] = row.total_ad_spend
  if (!hasValue(summary['实际销售额'])) summary['实际销售额'] = row.total_sales
  if (!hasValue(summary['实际销售量'])) summary['实际销售量'] = row.total_units

  return summary
}

function buildDetailRow(
  rawRow: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!rawRow || typeof rawRow !== 'object') return {}
  return { ...rawRow }
}

function formatDetailCell(column: string, value: unknown, country: CountryOption = 'US'): string {
  if (!hasValue(value)) return '-'
  if (column === '日期' || column === 'SKU') return String(value)
  return formatSummaryCell(column, value, country)
}

function sumAnyNumericColumn(rows: Array<Record<string, unknown>>, column: string): number | null {
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
  }
) {
  const lastColumn = SUMMARY_COLUMNS.length + 2
  worksheet.views = [{ state: 'frozen', ySplit: 2, xSplit: 2 }]

  const groupRow = worksheet.getRow(1)
  const headRow = worksheet.getRow(2)
  groupRow.getCell(1).value = '周次'
  groupRow.getCell(2).value = '日期范围'
  worksheet.mergeCells(1, 1, 2, 1)
  worksheet.mergeCells(1, 2, 2, 2)

  let currentColumn = 3
  SUMMARY_COLUMN_GROUPS.forEach((group) => {
    const start = currentColumn
    group.columns.forEach((column) => {
      headRow.getCell(currentColumn).value = column
      currentColumn += 1
    })
    worksheet.mergeCells(1, start, 1, currentColumn - 1)
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

  let rowIndex = 3
  summaryRows.forEach((item, index) => {
    const row = worksheet.getRow(rowIndex)
    const { isPartial } = extractCompleteness(item.row)
    const weekLabel = getISOWeek(item.row.report_start_date)
    row.getCell(1).value = isPartial ? `${weekLabel} *` : weekLabel
    row.getCell(2).value = formatDateRange(item.row.report_start_date, item.row.report_end_date)
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
      // 数据不全的行用浅黄色背景标注
      if (isPartial) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF3CD' },
        }
      }
    })
    row.getCell(1).font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: isPartial ? { argb: 'FFB45309' } : { argb: 'FF0F172A' },
    }
    row.getCell(2).font = { name: 'Microsoft YaHei' }
    applyCellBorder(row.getCell(1))
    applyCellBorder(row.getCell(2))
    if (isPartial) {
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
    }
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
        argb: column === '利润' || column === '利润率' ? 'FF047857' : 'FF0F172A',
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

  // 添加说明行
  const noteRow = worksheet.getRow(rowIndex)
  worksheet.mergeCells(rowIndex, 1, rowIndex, lastColumn)
  noteRow.getCell(1).value = '* 黄色背景标记：该周数据不完整，仅供参考'
  noteRow.getCell(1).font = {
    name: 'Microsoft YaHei',
    size: 9,
    italic: true,
    color: { argb: 'FFB45309' },
  }
  noteRow.getCell(1).alignment = {
    vertical: 'middle',
    horizontal: 'left',
  }
  rowIndex += 1

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
  }
) {
  const lastColumn = detailColumns.length
  worksheet.views = [{ state: 'frozen', ySplit: 2, xSplit: 2 }]

  const groupRow = worksheet.getRow(1)
  const headRow = worksheet.getRow(2)
  worksheet.mergeCells(1, 1, 2, 1)
  worksheet.mergeCells(1, 2, 2, 2)
  groupRow.getCell(1).value = '日期'
  groupRow.getCell(2).value = 'SKU'

  let currentColumn = 3
  detailGroupMeta.groups.forEach((group) => {
    const start = currentColumn
    group.columns.forEach((column) => {
      headRow.getCell(currentColumn).value = column
      currentColumn += 1
    })
    worksheet.mergeCells(1, start, 1, currentColumn - 1)
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
    worksheet.mergeCells(1, currentColumn, 2, currentColumn)
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

  let rowIndex = 3
  detailRows.forEach((rowData) => {
    const row = worksheet.getRow(rowIndex)
    detailColumns.forEach((column, idx) => {
      const cell = row.getCell(idx + 1)
      const value = getExcelCellValue(column, rowData[column])
      cell.value = value
      cell.alignment = {
        vertical: 'middle',
        horizontal:
          column === '日期' || column === 'SKU' || typeof value !== 'number' ? 'left' : 'right',
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
    } else if (detailExtraTotals[column] !== null && detailExtraTotals[column] !== undefined) {
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
  const isMobile = useMobile()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  // 项目 / 国家 / 起止日期 同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住选择。
  // 默认日期用 useMemo 锁定（保持与原 useState 一致的"挂载时一次性快照"语义）。
  const defaultFrom = useMemo(() => eightWeeksAgoMondayDateString(), [])
  const defaultTo = useMemo(() => lastSundayDateString(), [])
  const [projectId, setProjectId] = useUrlParam<string>('project', '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useUrlParam<CountryOption>('country', 'US', {
    allowed: ['US', 'DE', 'UK'],
  })
  const [startDate, setStartDate] = useUrlParam<string>('from', defaultFrom)
  const [endDate, setEndDate] = useUrlParam<string>('to', defaultTo)

  const [data, setData] = useState<WeeklyDataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<WeeklyViewTab>('summary')
  const [selectedWeekId, setSelectedWeekId] = useState('')
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<Array<Record<string, unknown>>>([])
  const [inventorySnapshotAt, setInventorySnapshotAt] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [visibleLines, setVisibleLines] = useState({
    sales_amount: true,
    units_sold: true,
    ad_spend: true,
    ad_clicks: false,
    organic_traffic: false,
    acos: false,
    ctr: false,
  })

  // 骨架屏状态：切换项目/国家时显示骨架屏
  const [skeletonState, setSkeletonState] = useState<SkeletonState>('idle')
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const latestRequestIdRef = useRef(0)
  const latestDetailsRequestIdRef = useRef(0)
  const summaryWeekHeadRef = useRef<HTMLTableCellElement | null>(null)
  const [summaryWeekColumnWidth, setSummaryWeekColumnWidth] = useState(
    SUMMARY_WEEK_COLUMN_FALLBACK_WIDTH
  )

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectLoadError(null)
    try {
      const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
      setProjects(payload)
      if (payload.length > 0) {
        // 1. URL 没指定 projectId（空字符串）→ 选第一个
        // 2. URL 指定了具体项目但项目列表里找不到（用户失去权限、项目被删除）→ 回退到第一个
        // 注意：这里用 payload（刚 fetch 到的），不用 projects（state 还是旧值）。
        const existsInList = projectId && payload.some((p) => String(p.id) === projectId)
        if (!projectId || !existsInList) {
          setProjectId(String(payload[0].id))
        }
      }
    } catch (loadError) {
      setProjectLoadError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
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
      const cacheKey = weeklyDataCacheKey(parsedProjectId, country, startDate, endDate)
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
          }
        )
        if (!response.ok) {
          throw new Error(parseErrorBody(await response.text(), response.status))
        }

        const payload = (await response.json()) as WeeklyDataRow[]
        if (latestRequestIdRef.current !== requestId) return
        setData(payload)
        setClientCache(cacheKey, payload)
      } catch (loadError) {
        if (latestRequestIdRef.current !== requestId) return
        if (!hasCachedPayload) {
          setData([])
          setError(loadError instanceof Error ? loadError.message : '产品分析数据加载失败')
        }
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [projectId, country, startDate, endDate]
  )

  const loadWeeklyDetails = useCallback(
    async (options?: { force?: boolean }) => {
      const pt1Id = Number(selectedWeekId)
      if (!pt1Id) {
        latestDetailsRequestIdRef.current += 1
        setDetailRows([])
        setDetailsError(null)
        setInventorySnapshotAt(null)
        return
      }

      const useCache = !options?.force
      const cacheKey = weeklyDetailsCacheKey(pt1Id, country)
      const cachedRows = useCache
        ? getClientCache<Array<Record<string, unknown>>>(cacheKey, WEEKLY_DETAILS_CACHE_TTL_MS)
        : null
      const hasCachedRows = Array.isArray(cachedRows)
      if (cachedRows) {
        setDetailRows(cachedRows)
        setDetailsError(null)
      } else {
        setDetailRows([])
      }

      const requestId = latestDetailsRequestIdRef.current + 1
      latestDetailsRequestIdRef.current = requestId

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
            }
          )
          if (!response.ok) {
            throw new Error(parseErrorBody(await response.text(), response.status))
          }

          const payload = (await response.json()) as PT1DetailsResponse
          if (latestDetailsRequestIdRef.current !== requestId) return
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
              { cache: 'no-store', headers: authHeaders() }
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

        if (latestDetailsRequestIdRef.current !== requestId) return
        setDetailRows(merged)
        setInventorySnapshotAt(hasInventoryForPeriod ? 'available' : null)
        setClientCache(cacheKey, merged, { persist: false })
      } catch (loadError) {
        if (latestDetailsRequestIdRef.current !== requestId) return
        if (!hasCachedRows) {
          setDetailRows([])
          setDetailsError(loadError instanceof Error ? loadError.message : 'SKU明细 加载失败')
        }
      } finally {
        if (latestDetailsRequestIdRef.current === requestId) {
          setDetailsLoading(false)
        }
      }
    },
    [selectedWeekId, country, projectId]
  )

  const handleRecomputeHistory = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId) {
      setError('请先选择店铺')
      return
    }

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
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      const payload = (await response.json()) as { recomputed?: number }
      clearClientCache(weeklyDataCacheKey(parsedProjectId, country, startDate, endDate))
      if (selectedWeekId) {
        clearClientCache(weeklyDetailsCacheKey(Number(selectedWeekId), country))
      }
      await loadWeeklyData({ force: true })
      notify({
        type: 'success',
        title: '周度数据重算完成',
        message: `已重算并持久化 ${Number(payload.recomputed || 0)} 个周报`,
      })
    } catch (recomputeError) {
      setError(recomputeError instanceof Error ? recomputeError.message : '历史周报重算失败')
      notify({
        type: 'error',
        title: '周度数据重算失败',
        message: recomputeError instanceof Error ? recomputeError.message : '历史周报重算失败',
      })
    } finally {
      setRecomputing(false)
    }
  }, [notify, projectId, country, startDate, endDate, selectedWeekId, loadWeeklyData])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // 骨架屏加载：切换项目/国家站点时显示骨架屏过渡
  useEffect(() => {
    if (!projectId || projectsLoading) return

    // 清理之前的定时器
    if (skeletonTimerRef.current) {
      clearTimeout(skeletonTimerRef.current)
      skeletonTimerRef.current = null
    }

    // 延迟显示骨架屏（避免快速切换闪烁），同时开始加载数据
    skeletonTimerRef.current = setTimeout(() => {
      setSkeletonState((prev) => (prev === 'idle' ? 'loading' : prev))
    }, SKELETON_DELAY_MS)

    void loadWeeklyData()
      .then(() => {
        // 加载完成后，开始 content 淡入，250ms 后骨架屏消失
        setSkeletonState('visible')
      })
      .finally(() => {
        // 兜底：确保骨架屏不会永久卡住
        setSkeletonState('visible')
      })
  }, [projectId, projectsLoading, loadWeeklyData])

  // 首次加载时设置为可见
  useEffect(() => {
    if (data.length > 0 && skeletonState === 'idle') {
      setSkeletonState('visible')
    }
  }, [data.length, skeletonState])

  useEffect(() => {
    latestDetailsRequestIdRef.current += 1
    setSelectedWeekId('')
    setDetailRows([])
    setDetailsError(null)
    setInventorySnapshotAt(null)
    setDetailsLoading(false)
  }, [projectId, country, startDate, endDate])

  const trendRows = useMemo(() => {
    if (!data || data.length === 0) return []
    return [...data].sort((a, b) => {
      const dateOrder = String(a.report_start_date).localeCompare(String(b.report_start_date))
      if (dateOrder !== 0) return dateOrder
      return Number(a.id || 0) - Number(b.id || 0)
    })
  }, [data])

  const trendPoints = useMemo(() => {
    if (!trendRows || trendRows.length === 0) return []
    return trendRows.map((row) => {
      const summary = buildSummaryForRow(row)
      const adImpressions = toNumber(summary['广告展示量']) || 1
      const adClicks = toNumber(summary['广告点击量']) || 0
      const adSpend = toNumber(summary['广告花费']) || 0
      const adSales = toNumber(summary['广告销售额']) || 1
      const pageViews = toNumber(summary['页面浏览量']) || 1
      const totalSales = Number(row.total_sales || 0) || 1
      return {
        week_label: getISOWeek(row.report_start_date),
        start_date: row.report_start_date,
        end_date: row.report_end_date,
        sales_amount: Number(row.total_sales || 0),
        units_sold: Number(row.total_units || 0),
        ad_spend: Number(row.total_ad_spend || 0),
        ad_clicks: adClicks,
        organic_traffic: toNumber(summary['自然流量']),
        acos: safeDiv(adSpend, adSales) * 100,
        ctr: safeDiv(adClicks, adImpressions) * 100,
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
      }
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
      sales: prevSales !== 0 ? ((lastSales - prevSales) / Math.abs(prevSales)) * 100 : 0,
      units: prevUnits !== 0 ? ((lastUnits - prevUnits) / Math.abs(prevUnits)) * 100 : 0,
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
        setSummaryWeekColumnWidth((prev) => (prev === nextWidth ? prev : nextWidth))
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
      if (prev && summaryRows.some((item) => String(item.row.id) === prev)) return prev
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

    const groupedColumns = new Set<string>(groups.flatMap((group) => group.columns))
    const coreColumnSet = new Set<string>(DETAIL_CORE_COLUMNS)
    const extras = detailColumns.filter(
      (column) => !coreColumnSet.has(column) && !groupedColumns.has(column)
    )
    const headClassByColumn: Record<string, string> = {}
    groups.forEach((group) => {
      group.columns.forEach((column) => {
        headClassByColumn[column] = group.headClass
      })
    })
    return { groups, extras, headClassByColumn }
  }, [detailColumns])

  const detailTotals = useMemo(() => buildSummaryTotals(detailRows), [detailRows])

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
    const projectName = projects.find((item) => String(item.id) === projectId)?.name ?? '未命名店铺'
    if (summaryRows.length === 0) {
      setError('当前没有可导出的周汇总数据。')
      return
    }

    const targetWeekId = selectedWeekId || String(summaryRows[0]?.row.id || '')
    const targetWeek =
      summaryRows.find((item) => String(item.row.id) === targetWeekId) ?? summaryRows[0]
    if (!targetWeek) {
      setError('当前没有可导出的周次数据。')
      return
    }

    setExporting(true)
    setError(null)
    setDetailsError(null)

    try {
      let exportDetailRows = detailRows
      if (String(targetWeek.row.id) !== selectedWeekId || detailRows.length === 0) {
        const cacheKey = weeklyDetailsCacheKey(Number(targetWeek.row.id), country)
        const cachedRows = getClientCache<Array<Record<string, unknown>>>(
          cacheKey,
          WEEKLY_DETAILS_CACHE_TTL_MS
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
              }
            )
            if (!response.ok) {
              throw new Error(parseErrorBody(await response.text(), response.status))
            }
            const payload = (await response.json()) as PT1DetailsResponse
            merged.push(...payload.rows.map((row) => buildDetailRow(row.raw_row)))
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
                      (key) => key !== 'ASIN' && !DETAIL_BASE_COLUMN_SET.has(key)
                    )
                  )
                )
              ),
            ]

      const exportDetailColumnSet = new Set<string>(exportDetailColumns)
      const exportGroups = DETAIL_COLUMN_GROUPS.map((group) => ({
        ...group,
        columns: group.columns.filter((column) => exportDetailColumnSet.has(column)),
      })).filter((group) => group.columns.length > 0)
      const exportGroupedColumns = new Set<string>(exportGroups.flatMap((group) => group.columns))
      const exportExtras = exportDetailColumns.filter(
        (column) =>
          !DETAIL_CORE_COLUMNS.includes(column as (typeof DETAIL_CORE_COLUMNS)[number]) &&
          !exportGroupedColumns.has(column)
      )
      const exportDetailTotals = buildSummaryTotals(exportDetailRows)
      const exportDetailExtraTotals = Object.fromEntries(
        exportExtras.map((column) => [column, sumAnyNumericColumn(exportDetailRows, column)])
      )

      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const summarySheet = workbook.addWorksheet('汇总', {
        views: [{ state: 'frozen', ySplit: 2, showGridLines: false }],
      })
      fillSummaryWorksheet(summarySheet, summaryRows, summaryTotals, {
        projectName,
        country,
        startDate,
        endDate,
      })

      const detailSheet = workbook.addWorksheet('SKU明细', {
        views: [{ state: 'frozen', ySplit: 2, showGridLines: false }],
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
          weekLabel: getISOWeek(targetWeek.row.report_start_date),
          weekRange: formatDateRange(
            targetWeek.row.report_start_date,
            targetWeek.row.report_end_date
          ),
        }
      )

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      const safeProjectName = (projectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      link.href = url
      link.download = `${safeProjectName}_${safeCountryLabel}-按周产品分析-${safeTimestamp}.xlsx`
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
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
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

  // —— Header 化：head 插槽 + 全局刷新（BLF-826 范式，蓝本 return-analysis）——
  // 刷新语义（计划 §1.4「页面多 tab」）：重拉「当前激活 tab」的数据集——
  //   汇总 tab → loadWeeklyData({ force: true })（跳 3min 自建客户端缓存）
  //   明细 tab → loadWeeklyDetails({ force: true })（跳 5min 自建客户端缓存）
  // handler 用 ref 桥接：每次渲染指向最新闭包，触发时永远读到当前 tab 与最新筛选。
  const refreshActiveTabRef = useRef<() => Promise<void>>(() => Promise.resolve())
  refreshActiveTabRef.current = () =>
    activeTab === 'details' ? loadWeeklyDetails({ force: true }) : loadWeeklyData({ force: true })
  useHeaderRefresh(() => refreshActiveTabRef.current(), {
    loading: activeTab === 'details' ? detailsLoading : loading,
  })

  // 筛选控件 portal 进 Top Header 中段插槽（项目(店铺) / 站点 / 日期范围，term 规格）
  const filterControls = (
    <>
      <HeaderSlotSelect
        value={projectId}
        onChange={setProjectId}
        options={projects.map((project) => ({
          value: String(project.id),
          label: project.name,
        }))}
        placeholder={projectsLoading ? '店铺加载中…' : '选择店铺'}
        disabled={projectsLoading || projects.length === 0}
        widthClass={TERM_HEADER_W_MD}
        title="项目（店铺）筛选"
      />
      <HeaderSlotSelect
        value={country}
        onChange={(value) => setCountry(value as CountryOption)}
        options={COUNTRY_OPTIONS}
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
      />
      <HeaderSlotDateRange
        value={parseDateRangeInputValue(startDate, endDate)}
        onChange={(range) => {
          setStartDate(formatDateInputValue(range?.from))
          setEndDate(formatDateInputValue(range?.to))
        }}
        widthClass={TERM_HEADER_W_XL}
      />
    </>
  )
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileProjectLabel = projects.find((p) => String(p.id) === projectId)?.name ?? projectId
  const mobileCountryLabel = getCountryLabel(country)
  const mobileDateLabel =
    startDate && endDate ? `${startDate} ~ ${endDate}` : '未选日期'
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
            placeholder={projectsLoading ? '店铺加载中…' : '选择店铺'}
            disabled={projectsLoading || projects.length === 0}
            widthClass={TERM_HEADER_W_MD}
            title="项目（店铺）筛选"
          />
          <HeaderSlotSelect
            value={country}
            onChange={(value) => setCountry(value as CountryOption)}
            options={COUNTRY_OPTIONS}
            widthClass={TERM_HEADER_W_SM}
            title="站点筛选"
          />
          <MobileFilterWide>
            <HeaderSlotDateRange
              value={parseDateRangeInputValue(startDate, endDate)}
              onChange={(range) => {
                setStartDate(formatDateInputValue(range?.from))
                setEndDate(formatDateInputValue(range?.to))
              }}
              widthClass={TERM_HEADER_W_XL}
            />
          </MobileFilterWide>
        </>
      }
    />
  )

  return (
    <div className="w-full space-y-6">
      {/* Header 化：筛选控件已上移 Top Header 中段插槽，页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}

      {/* 错误反馈：原由控制台卡片承载，控制台移除后保留为独立块（数据逻辑不变） */}
      {projectLoadError ? (
        <div className="overflow-hidden rounded-none border border-term-border bg-term-panel text-term-text">
          <div className="px-4 pb-4 pt-2">
            <ErrorState title="项目加载失败" message={projectLoadError} className="py-4" />
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="overflow-hidden rounded-none border border-term-border bg-term-panel text-term-text">
          <div className="px-4 pb-4 pt-2">
            <ErrorState title="数据加载失败" message={error} className="py-4" />
          </div>
        </div>
      ) : null}

      <div className="dashboard-surface overflow-hidden">
        <DataCardHeader
          title="周度趋势"
          className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
          action={
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    sales_amount: !prev.sales_amount,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.sales_amount
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-border/70 bg-term-panel/70 text-muted-foreground line-through dark:border-border/80 dark:bg-term-raised'
                }`}
              >
                {visibleLines.sales_amount ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: 'hsl(var(--chart-2))' }}
                />
                销售额
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    units_sold: !prev.units_sold,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${ visibleLines.units_sold ? 'border-term-accent/30 bg-term-accent/10 text-term-accent dark:text-term-accent' : 'border-border/70 bg-term-panel/70 text-muted-foreground line-through dark:border-border/80 dark:bg-term-raised' }`}
              >
                {visibleLines.units_sold ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: 'hsl(var(--primary))' }}
                />
                销量
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    ad_spend: !prev.ad_spend,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${ visibleLines.ad_spend ? 'border-term-neg/30 bg-term-neg/10 text-term-neg dark:text-term-neg' : 'border-border/70 bg-term-panel/70 text-muted-foreground line-through dark:border-border/80 dark:bg-term-raised' }`}
              >
                {visibleLines.ad_spend ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: 'hsl(var(--destructive))' }}
                />
                广告花费
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    ad_clicks: !prev.ad_clicks,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${ visibleLines.ad_clicks ? 'border-term-accent/30 bg-term-accent/10 text-term-accent dark:text-term-accent' : 'border-border/70 bg-term-panel/70 text-muted-foreground line-through dark:border-border/80 dark:bg-term-raised' }`}
              >
                {visibleLines.ad_clicks ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: 'hsl(var(--chart-4))' }}
                />
                广告点击量
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    organic_traffic: !prev.organic_traffic,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${ visibleLines.organic_traffic ? 'border-term-warn/30 bg-term-warn/10 text-term-warn dark:text-term-warn' : 'border-muted bg-muted/30 text-muted-foreground line-through' }`}
              >
                {visibleLines.organic_traffic ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: 'hsl(var(--chart-5))' }}
                />
                自然流量
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    acos: !prev.acos,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.acos
                    ? 'border-chart-3/30 bg-chart-3/10 text-chart-3 dark:text-chart-3'
                    : 'border-muted bg-muted/30 text-muted-foreground line-through'
                }`}
              >
                {visibleLines.acos ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: 'hsl(var(--chart-3))',
                    border: '2px dashed hsl(var(--chart-3))',
                    background: 'transparent',
                  }}
                />
                ACOS
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    ctr: !prev.ctr,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.ctr
                    ? 'border-warning/30 bg-warning/10 text-warning dark:text-warning'
                    : 'border-muted bg-muted/30 text-muted-foreground line-through'
                }`}
              >
                {visibleLines.ctr ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: 'hsl(var(--warning))',
                    border: '2px dashed hsl(var(--warning))',
                    background: 'transparent',
                  }}
                />
                广告点击率
              </button>
            </div>
          }
        />
        <DataTableCardStatBar
          className="border-b border-border/70 bg-term-raised"
          items={[
            {
              label: '销售额合计',
              value: formatCurrency(totals.sales_amount, country),
              highlight: true,
            },
            { label: '销量合计', value: totals.units_sold.toLocaleString() },
            { label: '广告花费合计', value: formatCurrency(totals.ad_spend, country) },
          ]}
        />
        <div className="relative px-2 pt-4 sm:px-6 sm:pt-6">
          {loading && data.length > 0 ? (
            <div className="mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
              趋势数据更新中...
            </div>
          ) : null}
          {showSummarySkeleton ? (
            <Skeleton className="h-[320px] w-full" />
          ) : trendPoints.length > 0 ? (
            <div className="rounded-none bg-term-panel/82 p-3 sm:p-4">
              <ChartContainer config={chartConfig} className="aspect-auto h-[320px] w-full">
                <ComposedChart
                  accessibilityLayer
                  data={trendPoints}
                  margin={
                    isMobile
                      ? { top: 8, right: 4, left: -16, bottom: 0 }
                      : { top: 10, right: 50, left: 0, bottom: 0 }
                  }
                >
                  <CartesianGrid
                    vertical={false}
                    stroke="rgba(148,163,184,0.18)"
                    strokeDasharray="0"
                  />
                  <XAxis
                    dataKey="week_label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={10}
                    minTickGap={32}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                  />
                  {/* 手机端隐藏双 Y 轴（规则：图表区域手机端优化），tooltip 仍可读精确值 */}
                  {!isMobile && (
                    <YAxis
                      yAxisId="primary"
                      tickFormatter={(v) => {
                        const num = Number(v)
                        if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(1)}M`
                        if (Math.abs(num) >= 1000) return `${(num / 1000).toFixed(1)}k`
                        return num.toLocaleString()
                      }}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                      width={52}
                    />
                  )}
                  {/* Secondary Y-axis for percentages */}
                  {!isMobile && (
                    <YAxis
                      yAxisId="percent"
                      orientation="right"
                      domain={[0, 'auto']}
                      tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={4}
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                      width={40}
                    />
                  )}
                  <ChartTooltip
                    cursor={{
                      stroke: 'rgba(15,23,42,0.18)',
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
                            acos: 'ACOS',
                            ctr: '广告点击率',
                          }
                          const displayName = nameMap[String(name)] || String(name)
                          const metricKey = String(name)
                          const isCurrencyMetric =
                            metricKey === 'sales_amount' || metricKey === 'ad_spend'
                          const isPercentMetric = metricKey === 'acos' || metricKey === 'ctr'
                          return (
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">{displayName}</span>
                              <span className="font-medium">
                                {isCurrencyMetric
                                  ? formatCurrency(Number(value), country)
                                  : isPercentMetric
                                    ? `${Number(value).toFixed(2)}%`
                                    : Number(value).toLocaleString()}
                              </span>
                            </div>
                          )
                        }}
                        indicator="dot"
                      />
                    }
                  />
                  {/* Sales Amount Bar */}
                  {visibleLines.sales_amount ? (
                    <Bar
                      yAxisId="primary"
                      type="monotone"
                      dataKey="sales_amount"
                      fill="var(--color-sales_amount)"
                      radius={[4, 4, 0, 0]}
                      barSize={isMobile ? 14 : 24}
                      opacity={0.9}
                    />
                  ) : null}
                  {/* Units Sold Bar */}
                  {visibleLines.units_sold ? (
                    <Bar
                      yAxisId="primary"
                      type="monotone"
                      dataKey="units_sold"
                      fill="var(--color-units_sold)"
                      radius={[4, 4, 0, 0]}
                      barSize={isMobile ? 14 : 24}
                      opacity={0.7}
                    />
                  ) : null}
                  {/* Ad Spend Line */}
                  {visibleLines.ad_spend ? (
                    <Line
                      yAxisId="primary"
                      type="monotone"
                      dataKey="ad_spend"
                      stroke="var(--color-ad_spend)"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: 'var(--color-ad_spend)', strokeWidth: 0 }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                    />
                  ) : null}
                  {/* Ad Clicks Line */}
                  {visibleLines.ad_clicks ? (
                    <Line
                      yAxisId="primary"
                      type="monotone"
                      dataKey="ad_clicks"
                      stroke="var(--color-ad_clicks)"
                      strokeWidth={2}
                      dot={{ r: 3, fill: 'var(--color-ad_clicks)', strokeWidth: 0 }}
                      activeDot={{ r: 5, strokeWidth: 0 }}
                    />
                  ) : null}
                  {/* Organic Traffic Line */}
                  {visibleLines.organic_traffic ? (
                    <Line
                      yAxisId="primary"
                      type="monotone"
                      dataKey="organic_traffic"
                      stroke="var(--color-organic_traffic)"
                      strokeWidth={2}
                      dot={{ r: 3, fill: 'var(--color-organic_traffic)', strokeWidth: 0 }}
                      activeDot={{ r: 5, strokeWidth: 0 }}
                    />
                  ) : null}
                  {/* ACOS Line (percentage on secondary axis) */}
                  {visibleLines.acos ? (
                    <Line
                      yAxisId="percent"
                      type="monotone"
                      dataKey="acos"
                      stroke="var(--color-acos)"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: 'var(--color-acos)', strokeWidth: 0 }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                      strokeDasharray="5 5"
                    />
                  ) : null}
                  {/* CTR Line (percentage on secondary axis) */}
                  {visibleLines.ctr ? (
                    <Line
                      yAxisId="percent"
                      type="monotone"
                      dataKey="ctr"
                      stroke="var(--color-ctr)"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: 'var(--color-ctr)', strokeWidth: 0 }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                      strokeDasharray="5 5"
                    />
                  ) : null}
                </ComposedChart>
              </ChartContainer>
              {/* Legend */}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {visibleLines.sales_amount && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span className="h-3 w-3 rounded-sm bg-[hsl(var(--chart-1))]" />
                    销售额
                  </div>
                )}
                {visibleLines.units_sold && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span className="h-3 w-3 rounded-sm bg-[hsl(var(--chart-2))]" />
                    销量
                  </div>
                )}
                {visibleLines.ad_spend && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span className="h-3 w-3 rounded-full bg-[hsl(var(--destructive))]" />
                    广告花费
                  </div>
                )}
                {visibleLines.ad_clicks && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span className="h-3 w-3 rounded-full bg-[hsl(var(--chart-4))]" />
                    广告点击量
                  </div>
                )}
                {visibleLines.organic_traffic && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span className="h-3 w-3 rounded-full bg-[hsl(var(--chart-5))]" />
                    自然流量
                  </div>
                )}
                {visibleLines.acos && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span
                      className="h-3 w-3 rounded-full bg-[hsl(var(--chart-3))]"
                      style={{
                        border: '2px dashed hsl(var(--chart-3))',
                        background: 'transparent',
                      }}
                    />
                    ACOS
                  </div>
                )}
                {visibleLines.ctr && (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-background/72 px-2.5 py-1 text-xs">
                    <span
                      className="h-3 w-3 rounded-full bg-[hsl(var(--warning))]"
                      style={{
                        border: '2px dashed hsl(var(--warning))',
                        background: 'transparent',
                      }}
                    />
                    广告点击率
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-none border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              暂无趋势数据
            </div>
          )}
          {loading && trendPoints.length > 0 ? (
            <LoadingScrim className="w-full px-4">
              <Skeleton className="h-[320px] w-full rounded-none" />
            </LoadingScrim>
          ) : null}
        </div>
      </div>

      {/* 骨架屏过渡包装 */}
      <div
        className={cn(
          'transition-all relative',
          skeletonState === 'loading' ? 'opacity-0' : 'opacity-100'
        )}
        style={{
          transitionDuration: skeletonState === 'loading' ? '0ms' : `${FADE_DURATION_MS}ms`,
        }}
      >
        {/* 骨架屏覆盖层：切换项目/国家时覆盖表格区域 */}
        {skeletonState === 'loading' && (
          <div className="absolute inset-0 z-10 rounded-none border border-border/70 bg-background">
            <div className="space-y-4 p-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
              <Skeleton className="h-[320px] w-full" />
              <BarSkeleton rows={5} />
            </div>
          </div>
        )}
        <DataTableCard className="animate-enter">
          <DataTableCardHeader className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
            <div>
              <div className="text-base font-semibold text-foreground">每周分析明细</div>
              <p className="text-sm text-muted-foreground"></p>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {activeTab === 'details' ? (
                <Select
                  value={selectedWeekId}
                  onValueChange={setSelectedWeekId}
                  disabled={summaryRows.length === 0}
                >
                  <SelectTrigger className="h-10 w-full border-border/70 bg-term-panel shadow-none dark:border-border/85 dark:bg-term-overlay sm:w-[250px]">
                    <SelectValue placeholder="选择周次" />
                  </SelectTrigger>
                  <SelectContent>
                    <TooltipProvider delayDuration={0}>
                      {summaryRows.map((item, index) => {
                        const { isPartial } = extractCompleteness(item.row)
                        return (
                          <SelectItem key={item.row.id} value={String(item.row.id)}>
                            {getISOWeek(item.row.report_start_date)} ·{' '}
                            {formatDateRange(
                              item.row.report_start_date,
                              item.row.report_end_date
                            )}
                            {isPartial && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="ml-1.5 inline-block">
                                    <AlertTriangle className="h-3.5 w-3.5 text-term-warn" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent sideOffset={4}>
                                  数据不完整，仅供参考
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </SelectItem>
                        )
                      })}
                    </TooltipProvider>
                  </SelectContent>
                </Select>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="h-9 min-h-[44px] sm:min-h-0"
                onClick={() => void exportWeeklyAnalysis()}
                disabled={exporting || summaryRows.length === 0}
              >
                {exporting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                导出 Excel
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 min-h-[44px] sm:min-h-0"
                onClick={() => void handleRecomputeHistory()}
                disabled={recomputing || loading || !projectId}
              >
                {recomputing ? '重新核算中...' : '重新核算'}
              </Button>
              <div className="inline-flex rounded-none border border-border/70 bg-muted/20 p-1 dark:border-border/80 dark:bg-term-raised">
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === 'summary' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                  onClick={() => setActiveTab('summary')}
                >
                  周汇总
                </button>
                <button
                  type="button"
                  className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === 'details' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                  onClick={() => setActiveTab('details')}
                >
                  SKU明细
                </button>
              </div>
            </div>
          </DataTableCardHeader>
          <DataTableCardBody className="relative">
            {activeTab === 'summary' && loading && summaryRows.length > 0 ? (
              <div className="mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                周汇总更新中...
              </div>
            ) : null}
            {activeTab === 'details' && detailsLoading && detailRows.length > 0 ? (
              <div className="mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                SKU 明细更新中...
              </div>
            ) : null}
            {activeTab === 'summary' ? (
              showSummarySkeleton ? (
                <BarSkeleton rows={5} />
              ) : summaryRows.length > 0 ? (
                <Table
                  containerClassName="w-full max-w-full overflow-x-auto"
                  className="w-max min-w-[4200px] table-fixed text-xs"
                >
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableHead
                        ref={summaryWeekHeadRef}
                        rowSpan={2}
                        className="sticky z-40 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap"
                        style={{ left: 0 }}
                      >
                        周次
                      </TableHead>
                      <TableHead
                        rowSpan={2}
                        className="sticky z-40 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap"
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
                    <TableRow className="bg-muted/30">
                      {SUMMARY_COLUMN_GROUPS.flatMap((group) =>
                        group.columns.map((column) => (
                          <TableHead
                            key={column}
                            className={`border-r px-2 py-1.5 text-center whitespace-nowrap ${group.headClass}`}
                          >
                            {column}
                          </TableHead>
                        ))
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TooltipProvider delayDuration={0}>
                      {summaryRows.map((item, index) => {
                        const row = item.row
                        const { isPartial } = extractCompleteness(row)
                        const rowBg = row.is_current ? 'bg-background' : 'bg-muted/20'
                        return (
                          <TableRow
                            key={row.id}
                            className={!row.is_current ? 'bg-muted/15' : undefined}
                          >
                            <TableCell
                              className={`sticky z-20 border-r border-border px-2 py-1.5 text-center font-medium whitespace-nowrap ${rowBg}`}
                              style={{ left: 0 }}
                            >
                              <span className="inline-flex items-center gap-1">
                                {getISOWeek(row.report_start_date)}
                                {isPartial && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-block">
                                        <AlertTriangle className="h-3.5 w-3.5 text-term-warn" />
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent sideOffset={4}>
                                      数据不完整，仅供参考
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </span>
                            </TableCell>
                            <TableCell
                              className={`sticky z-20 border-r border-border px-2 py-1.5 text-center whitespace-nowrap ${rowBg}`}
                              style={{ left: summaryWeekColumnWidth }}
                            >
                              {formatDateRange(row.report_start_date, row.report_end_date)}
                            </TableCell>
                            {SUMMARY_COLUMNS.map((column) => (
                              <TableCell
                                key={`${row.id}-${column}`}
                                className="border-r px-2 py-1.5 text-right tabular-nums"
                              >
                                {formatSummaryCell(column, item.summary[column], country)}
                              </TableCell>
                            ))}
                          </TableRow>
                        )
                      })}
                    </TooltipProvider>
                  </TableBody>
                  <TableFooter>
                    <TableRow className="bg-muted font-semibold hover:bg-muted">
                      <TableCell
                        className="sticky z-30 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap"
                        style={{ left: 0 }}
                      >
                        合计
                      </TableCell>
                      <TableCell
                        className="sticky z-30 border-r border-border bg-muted px-2 py-2 text-center whitespace-nowrap"
                        style={{ left: summaryWeekColumnWidth }}
                      >
                        {summaryRows.length} 周
                      </TableCell>
                      {SUMMARY_COLUMNS.map((column) => (
                        <TableCell
                          key={`summary-total-${column}`}
                          className="border-r px-2 py-2 text-right tabular-nums"
                        >
                          {formatSummaryCell(column, summaryTotals[column], country)}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableFooter>
                </Table>
              ) : (
                <div className="rounded-none border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  当前筛选条件暂无产品分析周汇总数据
                </div>
              )
            ) : showDetailsSkeleton ? (
              <BarSkeleton rows={8} />
            ) : detailsError ? (
              <div className="rounded-none border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {detailsError}
              </div>
            ) : detailRows.length > 0 ? (
              <Table
                containerClassName="w-full max-w-full overflow-x-auto"
                className="w-max min-w-[3600px] table-fixed text-xs"
              >
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead
                      rowSpan={2}
                      className="sticky z-40 border-r border-border bg-muted px-3 py-2 text-center whitespace-nowrap"
                      style={{
                        left: DETAIL_STICKY_LEFT[0],
                        minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0],
                      }}
                    >
                      日期
                    </TableHead>
                    <TableHead
                      rowSpan={2}
                      className="sticky z-40 border-r border-border bg-muted px-3 py-2 text-center whitespace-nowrap"
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
                        className="border-r px-2 py-2 text-center whitespace-nowrap bg-muted/20"
                      >
                        {column}
                      </TableHead>
                    ))}
                  </TableRow>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    {detailGroupMeta.groups.map((group) =>
                      group.columns.map((column) => (
                        <TableHead
                          key={column}
                          className={`border-r px-2 py-1.5 text-center whitespace-nowrap ${detailGroupMeta.headClassByColumn[column] || ''}`}
                        >
                          {column}
                        </TableHead>
                      ))
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
                          {formatDetailCell(column, row[column], country)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-muted font-semibold hover:bg-muted">
                    {detailColumns.map((column) => {
                      if (column === '日期')
                        return (
                          <TableCell
                            key="detail-total-date"
                            className="sticky z-30 border-r border-border bg-muted px-2 py-2 text-left"
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
                            key="detail-total-sku"
                            className="sticky z-30 border-r border-border bg-muted px-2 py-2 text-left"
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
                            className="border-r px-2 py-2 text-right tabular-nums"
                          >
                            {formatDetailCell(column, detailTotals[column], country)}
                          </TableCell>
                        )
                      const extraTotal = detailExtraTotals[column]
                      return (
                        <TableCell
                          key={`detail-total-${column}`}
                          className="border-r px-2 py-2 text-right tabular-nums"
                        >
                          {extraTotal === null
                            ? '-'
                            : formatDetailCell(column, extraTotal, country)}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                </TableFooter>
              </Table>
            ) : (
              <div className="rounded-none border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                当前周次暂无 SKU明细 数据
              </div>
            )}
            {activeTab === 'summary' && loading && summaryRows.length > 0 ? (
              <LoadingScrim className="w-full px-6 py-8">
                <BarSkeleton rows={6} className="w-full" />
              </LoadingScrim>
            ) : null}
            {activeTab === 'details' && detailsLoading && detailRows.length > 0 ? (
              <LoadingScrim className="w-full px-6 py-8">
                <BarSkeleton rows={8} className="w-full" />
              </LoadingScrim>
            ) : null}
          </DataTableCardBody>
        </DataTableCard>
      </div>
    </div>
  )
}
