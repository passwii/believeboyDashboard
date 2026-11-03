'use client'

import { useEffect, useMemo, useState, useCallback, useRef, useSyncExternalStore } from 'react'
import { DateRange } from 'react-day-picker'
import { CalendarDays, Check, ChevronsUpDown, FileDown, Package } from 'lucide-react'
import { useSession } from 'next-auth/react'

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DailyAnalysisHeaderSlots } from '@/components/dashboard/daily-analysis-header-slots'
import { MetricSwitcherCard, type MetricDef } from '@/components/dashboard/metric-switcher-card'
import {
  GoalProgressStat,
  achievementPaceRatio,
  isGoalProgressScopeValid,
  type GoalRingItem,
} from '@/components/ui/goal-progress-rings'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import {
  COUNTRY_TIMEZONE_MAP,
  DateRangePicker,
  parseDateInputValue,
} from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { numericCell, numericHead } from '@/components/ui/table-presets'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import {
  useTerminalGlobalFilter,
  type TerminalDailyAnalysisFilterSync,
  type TerminalDailyAnalysisPageFilters,
  type TerminalGlobalFilterState,
} from '@/components/terminal/global-filter-context'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  addMonths,
  bucketDetailByMonth,
  bucketSummaryByMonth,
  dateToMonthKeyFromDate,
  generateMonthKeys,
} from '@/lib/aggregate'
import { useNotifications } from '@/components/notifications'
import { useGoalProgress } from '@/lib/use-goal-progress'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { applyBorder, applyDataRowBanding, applyHeaderBorder } from '@/lib/excel-styles'
import { downloadBlob } from '@/lib/download-blob'
import {
  buildSkuScopeKey,
  filterRowsBySkuScope,
  isDailyAnalysisExportBusy,
  shouldAcceptSkuOptions,
} from '@/lib/daily-analysis-sku-scope'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'
import { useIsMobile } from '@/hooks/use-mobile'
import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import styles from './daily-analysis-warm.module.css'

type CountryOption = 'US' | 'DE' | 'UK' | 'ALL'
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
  pending_order_qty: number
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
  is_active: boolean
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

type DailyAnalysisAllCountriesResponse = {
  console: DailyAnalysisConsole
  summary_rows: DailyAnalysisRow[]
  detail_rows: DailyAnalysisDetailRow[]
  available_dates: Record<string, string[]>
  country_breakdown: Record<
    string,
    {
      summary_rows: DailyAnalysisRow[]
      detail_rows: DailyAnalysisDetailRow[]
      currency: string
      source_currency: string
    }
  >
  currency: string
  currency_note: string | null
}

// BLF-913：全部项目 × 全部国家站点聚合（USD 基准）。
// 结构是 /all（按项目分桶）与 /all-countries（按国家分桶）的并集：
// 顶层 summary_rows / detail_rows 是 global 聚合（项目×国家求和），
// project_breakdown / country_breakdown 供两种下钻。
type DailyAnalysisAllProjectsCountriesResponse = {
  console: DailyAnalysisConsole
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
  country_breakdown: Record<
    string,
    {
      summary_rows: DailyAnalysisRow[]
      detail_rows: DailyAnalysisDetailRow[]
      currency: string
      source_currency: string
    }
  >
  currency: string
  currency_note: string | null
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
  { value: 'ALL', label: '全部站点' },
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

const REAL_COUNTRY_OPTIONS: CountryOption[] = ['US', 'DE', 'UK']

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
  order_qty: { label: '订单', color: 'var(--warm-ledger-color-accent)' },
  sales_amount: { label: '销售额', color: 'var(--warm-ledger-color-accent)' },
  impressions: { label: '曝光量', color: 'var(--warm-ledger-color-accent)' },
  clicks: { label: '点击量', color: 'var(--warm-ledger-color-accent)' },
  cpc: { label: 'CPC', color: 'var(--warm-ledger-color-accent)' },
  ad_spend: { label: '广告花费', color: 'var(--warm-ledger-color-accent)' },
  ad_orders: { label: '广告订单', color: 'var(--warm-ledger-color-accent)' },
  page_views: { label: '页面浏览量', color: 'var(--warm-ledger-color-accent)' },
  units_ordered: { label: '销量', color: 'var(--warm-ledger-color-accent)' },
  sessions: { label: '访问量', color: 'var(--warm-ledger-color-accent)' },
  conversion_rate: { label: '转化率', color: 'var(--warm-ledger-color-accent)' },
} satisfies MetricChartConfig

const EMPTY_SUMMARY_ROWS: DailyAnalysisRow[] = []
const EMPTY_DETAIL_ROWS: DailyAnalysisDetailRow[] = []

type WarmSkuSearchFieldProps = {
  value: string
  options: ProjectSkuOption[]
  loading: boolean
  onChange: (value: string) => void
  disabled?: boolean
  onOpen?: () => void
}

function WarmSkuSearchField({
  value,
  options,
  loading,
  onChange,
  disabled = false,
  onOpen,
}: WarmSkuSearchFieldProps) {
  const [open, setOpen] = useState(false)
  const selectedSku = options.find((option) => option.sku === value)
  const selectedSkuLabel = selectedSku
    ? `${selectedSku.sku}${selectedSku.product_name ? ` / ${selectedSku.product_name}` : ''}`
    : null

  const handleOpen = () => {
    onOpen?.()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => setOpen(disabled ? false : nextOpen)}
    >
      <DialogTrigger asChild>
        <WarmButton
          className={styles.skuTrigger}
          type="button"
          disabled={disabled}
          title={selectedSkuLabel ?? '搜索并选择 SKU（清空即恢复全部 SKU）'}
          aria-label={selectedSkuLabel ? `SKU ${selectedSkuLabel}` : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={handleOpen}
        >
          <span className={styles.skuTriggerLabel}>
            {selectedSkuLabel ?? (loading ? 'SKU 加载中…' : '全部 SKU')}
          </span>
          <ChevronsUpDown className={styles.skuChevron} aria-hidden="true" />
        </WarmButton>
      </DialogTrigger>
      <DialogContent
        className={styles.skuDialog}
      >
        <DialogTitle className="sr-only">搜索 SKU</DialogTitle>
        <Command className={styles.skuCommand}>
          <CommandInput className={styles.skuSearch} placeholder="搜索 SKU" />
          <CommandList className={styles.skuList}>
            <CommandEmpty className={styles.skuEmpty}>
              {loading ? 'SKU 加载中…' : '没有匹配的 SKU'}
            </CommandEmpty>
            <CommandItem
              value="__all__"
              onSelect={() => {
                onChange('')
                setOpen(false)
              }}
              className={styles.skuOption}
            >
              <Check
                className={value ? styles.skuCheck : styles.skuCheckSelected}
                aria-hidden="true"
              />
              <span className={styles.skuOptionLabel}>全部 SKU</span>
            </CommandItem>
            {options.map((option) => {
              const missingUnits = !option.units_per_carton || option.units_per_carton <= 0
              const isSelected = value === option.sku

              return (
                <CommandItem
                  key={option.sku}
                  value={option.sku}
                  disabled={missingUnits}
                  onSelect={() => {
                    if (missingUnits) return
                    onChange(option.sku)
                    setOpen(false)
                  }}
                  className={styles.skuOption}
                >
                  <Check
                    className={isSelected ? styles.skuCheckSelected : styles.skuCheck}
                    aria-hidden="true"
                  />
                  <span className={styles.skuOptionLabel}>{option.sku}</span>
                  {option.product_name ? (
                  <span className={styles.skuProductName} title={option.product_name}>
                    {option.product_name}
                  </span>
                  ) : null}
                  {missingUnits ? (
                    <span className={styles.skuMissingUnits}>未维护单箱数</span>
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
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

/** Returns today's calendar date as a Date in local time, calculated in the country's timezone. */
function getTodayInTimezone(country: string): Date {
  const timezoneCountry = country === 'ALL' ? 'US' : country
  const tz = COUNTRY_TIMEZONE_MAP[timezoneCountry] ?? 'UTC'
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
  const currentRangeLastDay = new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate()
  const isLastDayOfMonth = to.getDate() === currentRangeLastDay

  if (isFirstDayOfMonth && isLastDayOfMonth) {
    const monthSpan =
      (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1

    const previousStart = new Date(from.getFullYear(), from.getMonth() - monthSpan, 1)
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

/**
 * 把 summary 行展开为 chart row：date + 全部 metric 字段（保证 <Bar dataKey={selected}> /
 * <Line dataKey={selected}> 在 selected 切换时总能取到正确字段）+ compareMetricValue。
 *
 * `row` 可能 undefined（缺数据），用 0 兜底；`compareValue` 可能 null（缺对比数据），
 * 直接透传（recharts 对 null 会断点 / 缺柱）。
 */
function spreadSummaryRow(
  row: DailyAnalysisRow | undefined,
  date: string,
  compareValue: number | null
): Record<string, unknown> {
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
    compareMetricValue: compareValue,
  }
}

/**
 * 同上，但是针对 selectedSku 分支的 detail 行。注意 sku/asin/in_transit_qty 不参与
 * 图表渲染（MetricSwitcherCard 只看 metric 字段 + compareMetricValue + date），
 * 所以这里无需展开这三个字段；只需把 13 个 metric 字段全部写上。
 */
function spreadDetailRow(
  row: DailyAnalysisDetailRow | undefined,
  date: string,
  compareValue: number | null
): Record<string, unknown> {
  return spreadSummaryRow(row, date, compareValue)
}

function formatRangeLabel(range?: DateRange) {
  const normalized = normalizeDateRange(range)
  if (!normalized?.from || !normalized?.to) return '--'
  return `${formatYMD(normalized.from)} ~ ${formatYMD(normalized.to)}`
}

export async function exportDailyAnalysisToExcel(
  summaryRows: DailyAnalysisRow[],
  detailRows: DailyAnalysisDetailRow[],
  projectName: string,
  country: string,
  dateRange: string,
  skuOptions: ProjectSkuOption[],
  granularity: 'daily' | 'monthly' = 'daily'
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const now = new Date()
  const safeDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

  const summarySheetName = granularity === 'monthly' ? '月报汇总' : '日报汇总'
  const detailSheetName = granularity === 'monthly' ? 'SKU月度明细' : 'SKU明细'
  const dateColumnLabel = granularity === 'monthly' ? '月份' : '日期'
  // 月度桶 date 是 'YYYY-MM-01'，导出时按 'YYYY-MM' 展示；日度保持原样。
  const formatDateForExport = (raw: string): string =>
    granularity === 'monthly' ? raw.slice(0, 7) : raw

  // Sheet 1: 汇总
  const summarySheet = workbook.addWorksheet(summarySheetName, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  })

  const summaryCols = [
    { header: dateColumnLabel, key: 'date', width: 14 },
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

  const summaryHeaderRow = summarySheet.getRow(1)
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
    const excelRow = summarySheet.getRow(rowIndex + 2)
    excelRow.getCell(1).value = formatDateForExport(row.date)
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

    for (let colNumber = 1; colNumber <= summaryCols.length; colNumber += 1) {
      const cell = excelRow.getCell(colNumber)
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 1 ? 'center' : 'right',
      }
      applyBorder(cell)
    }
  })
  applyDataRowBanding({
    worksheet: summarySheet,
    startRow: 2,
    rowCount: summaryRows.length,
    columnCount: summaryCols.length,
  })

  // Sheet 2: SKU明细
  const detailSheet = workbook.addWorksheet(detailSheetName, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  })

  const detailCols = [
    { header: dateColumnLabel, key: 'date', width: 14 },
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

  const detailHeaderRow = detailSheet.getRow(1)
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

  const skuProductNameMap = new Map(skuOptions.map((s) => [s.sku, s.product_name ?? '']))

  detailRows.forEach((row, rowIndex) => {
    const productName = skuProductNameMap.get(row.sku) ?? ''
    const excelRow = detailSheet.getRow(rowIndex + 2)
    excelRow.getCell(1).value = formatDateForExport(row.date)
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

    for (let colNumber = 1; colNumber <= detailCols.length; colNumber += 1) {
      const cell = excelRow.getCell(colNumber)
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber <= 3 ? 'left' : 'right',
      }
      applyBorder(cell)
    }
  })
  // SKU明细 保留既有「按日期分组交替底纹」：底纹由下方分组循环按组序号统一铺，
  // 不接入逐行斑马（同一天的多行必须同色，作为「一天一色带」的阅读锚点）。
  let mergeStartRow = 2
  let groupIndex = 0
  for (let rowIndex = 1; rowIndex <= detailRows.length; rowIndex += 1) {
    const currentDate = detailRows[rowIndex]?.date
    const previousDate = detailRows[rowIndex - 1]?.date
    const isGroupBoundary = currentDate !== previousDate

    if (!isGroupBoundary) continue

    const mergeEndRow = rowIndex + 1
    const groupStartRow = mergeStartRow
    const groupRowCount = mergeEndRow - groupStartRow + 1
    const groupFill = groupIndex % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
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

    mergeStartRow = rowIndex + 2
    groupIndex += 1
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const safeProjectName = (projectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
  const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
  downloadBlob(blob, `${safeProjectName}_${safeCountryLabel}-销售数据-${safeDate}.xlsx`)
}

function lastSevenDaysRange(country: string): DateRange {
  const today = getTodayInTimezone(country)
  const end = today
  const start = addDays(end, -6)
  return { from: start, to: end }
}

function matchesDailyAnalysisFilterSync(
  sync: TerminalDailyAnalysisFilterSync | null,
  filters: TerminalGlobalFilterState,
  pageFilters: TerminalDailyAnalysisPageFilters
): boolean {
  return Boolean(
    sync &&
      sync.filters.projectId === filters.projectId &&
      sync.filters.country === filters.country &&
      sync.filters.dateFrom === filters.dateFrom &&
      sync.filters.dateTo === filters.dateTo &&
      sync.pageFilters.projectId === pageFilters.projectId &&
      sync.pageFilters.country === pageFilters.country
  )
}

function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 把 CHART_METRICS + SINGLE_METRIC_CHART_CONFIG 投影成 MetricSwitcherCard 需要的 MetricDef[]。
 * 保留 daily-analysis 原有的 format / isNegativeBetter 语义（metricIncreaseIsGood 取反）。
 * preferredChart 标注业务偏好：量级类（订单/销售额/曝光/点击/广告花费/广告订单/页面浏览/销量/访问量）
 * → bar；比率类（CPC/转化率）→ line。
 *
 * precision 标注 KPI 卡片 spring count-up 时对 raw 中间值四舍五入到的小数位数：
 *   - 整数量级（订单/曝光/点击/广告订单/页面浏览/销量/访问量/可售库存）→ 0
 *     否则 spring 中间值会出现 `1,234.5678` 这种小数。
 *   - 货币 / 比率（销售额/广告花费/CPC/转化率）→ 不设 precision，
 *     让 format 函数里的 toFixed 自己量化，避免二次量化出错。
 */
const LINE_METRICS: MetricDef<ChartMetricKey>[] = CHART_METRICS.map((m) => {
  const format = (val: number) => formatMetricCardValue(m.key, val)
  const isQuantizedByFormat =
    m.key === 'sales_amount' ||
    m.key === 'ad_spend' ||
    m.key === 'cpc' ||
    m.key === 'conversion_rate'
  return {
    key: m.key,
    label: SINGLE_METRIC_CHART_CONFIG[m.key]?.label ?? m.label,
    isNegativeBetter: !metricIncreaseIsGood(m.key),
    format,
    precision: isQuantizedByFormat ? undefined : 0,
    preferredChart: m.key === 'cpc' || m.key === 'conversion_rate' ? 'line' : 'bar',
  }
})

// 已下线 — DailyMetricChart（Bar/Line 切换）已被 MetricSwitcherCard 单线视图替代，
// 函数体内联删除以减少 ~270 行死代码。如需重新启用 Bar 视图，请参考 git 历史 `dbb77e7`。

export default function DailyAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const isMobile = useIsMobile()
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectListError, setProjectListError] = useState<string | null>(null)
  // 默认不预设 "all"：项目加载完成后由下方 effect 自动选中第一个真实项目，
  // 以满足"控制台默认选择第一个项目"的需求。
  // Page filters stay URL-backed; a resolved page selection seeds an empty global project.
  const [projectId] = useUrlParam<string>('project', '')
  const [country] = useUrlParam<CountryOption>('country', 'US', {
    allowed: ['US', 'DE', 'UK', 'ALL'],
  })
  const globalFilter = useTerminalGlobalFilter()
  const globalFilterReady = globalFilter.ready
  const globalProjectId = globalFilter.projectId
  const globalCountry = globalFilter.country
  const globalDateFrom = globalFilter.dateFrom
  const globalDateTo = globalFilter.dateTo
  const lastDailyAnalysisSync = globalFilter.lastDailyAnalysisSync
  const syncDailyAnalysisFilters = globalFilter.syncDailyAnalysisFilters
  const gfProjectId = globalFilterReady ? globalProjectId : null
  const gfCountry = globalFilterReady ? globalCountry : null
  const gfDateFrom = globalFilterReady ? globalDateFrom : null
  const gfDateTo = globalFilterReady ? globalDateTo : null

  // A resolved global project owns the page; otherwise resolved page filters seed global state.
  const gfProjectOwnedRef = useRef(false)
  const lastAppliedGfRef = useRef('')
  const defaultRange = useMemo(() => lastSevenDaysRange(country), [country])
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultRange)
  const resolvedGlobalCountry =
    gfCountry && ['US', 'DE', 'UK', 'ALL'].includes(gfCountry)
      ? (gfCountry as CountryOption)
      : country
  const currentPageDateFrom = dateRange?.from ? formatYMD(dateRange.from) : ''
  const currentPageDateTo = dateRange?.to ? formatYMD(dateRange.to) : ''
  const globalFiltersApplied =
    globalFilterReady &&
    (!gfProjectId ||
      (projectId === gfProjectId &&
        country === resolvedGlobalCountry &&
        Boolean(gfDateFrom && gfDateTo) &&
        currentPageDateFrom === gfDateFrom &&
        currentPageDateTo === gfDateTo))
  // 当用户在 DateRangePicker 里点了 preset 侧边栏时，记下触发的 preset label；
  // 手动选日期（onChange 第二参数 meta 为 undefined）会清掉它，之后按 days diff 判定粒度。
  const [datePresetKey, setDatePresetKey] = useState<string | undefined>(undefined)

  const syncPageAndGlobalFilters = useCallback(
    (
      nextProjectId: string,
      nextCountry: CountryOption,
      nextDateRange: DateRange | undefined
    ) => {
      syncDailyAnalysisFilters(
        {
          projectId: nextProjectId,
          country: nextCountry,
          dateFrom: nextDateRange?.from ? formatYMD(nextDateRange.from) : '',
          dateTo: nextDateRange?.to ? formatYMD(nextDateRange.to) : '',
        },
        { projectId: nextProjectId, country: nextCountry }
      )
    },
    [syncDailyAnalysisFilters]
  )

  useEffect(() => {
    if (!globalFilterReady) return

    if (gfProjectId) {
      const signature = JSON.stringify([gfProjectId, gfCountry, gfDateFrom, gfDateTo])
      if (signature === lastAppliedGfRef.current) return
      lastAppliedGfRef.current = signature
      gfProjectOwnedRef.current = true

      const globalFilters: TerminalGlobalFilterState = {
        projectId: gfProjectId,
        country: gfCountry ?? country,
        dateFrom: gfDateFrom ?? '',
        dateTo: gfDateTo ?? '',
      }
      const pageFilters: TerminalDailyAnalysisPageFilters = {
        projectId: gfProjectId,
        country: resolvedGlobalCountry,
      }
      if (
        !matchesDailyAnalysisFilterSync(
          lastDailyAnalysisSync,
          globalFilters,
          pageFilters
        )
      ) {
        syncDailyAnalysisFilters(globalFilters, pageFilters)
      }

      if (gfDateFrom && gfDateTo) {
        const from = parseDateInputValue(gfDateFrom)
        const to = parseDateInputValue(gfDateTo)
        if (from && to) {
          const rangeChanged =
            !dateRange?.from ||
            !dateRange.to ||
            formatYMD(dateRange.from) !== gfDateFrom ||
            formatYMD(dateRange.to) !== gfDateTo
          if (rangeChanged) {
            setDatePresetKey(undefined)
            setDateRange({ from, to })
          }
        }
      }
      return
    }

    const pageProjectResolved =
      projectId === 'all' ||
      (projectId
        ? projects.length === 0 || projects.some((project) => String(project.id) === projectId)
        : projects.length === 0)
    if (projectsLoading || !pageProjectResolved) return

    const pageFilters: TerminalDailyAnalysisPageFilters = { projectId, country }
    const lastSync = lastDailyAnalysisSync
    const lastSyncIsCurrent = Boolean(
      lastSync &&
        lastSync.filters.projectId === globalProjectId &&
        lastSync.filters.country === globalCountry &&
        lastSync.filters.dateFrom === globalDateFrom &&
        lastSync.filters.dateTo === globalDateTo
    )
    const pageOwnsSyncedRange = Boolean(
      lastSync &&
        lastSyncIsCurrent &&
        lastSync.filters.projectId === '' &&
        lastSync.pageFilters.country === country
    )
    const pageDateFrom = pageOwnsSyncedRange && lastSync
      ? lastSync.filters.dateFrom
      : dateRange?.from
        ? formatYMD(dateRange.from)
        : ''
    const pageDateTo = pageOwnsSyncedRange && lastSync
      ? lastSync.filters.dateTo
      : dateRange?.to
        ? formatYMD(dateRange.to)
        : ''
    const pageFiltersAsGlobal: TerminalGlobalFilterState = {
      projectId,
      country,
      dateFrom: pageDateFrom,
      dateTo: pageDateTo,
    }
    const syncedFrom = pageDateFrom ? parseDateInputValue(pageDateFrom) : undefined
    const syncedTo = pageDateTo ? parseDateInputValue(pageDateTo) : undefined
    const syncedRange: DateRange | undefined =
      syncedFrom || syncedTo ? { from: syncedFrom, to: syncedTo } : undefined

    const currentDateFrom = dateRange?.from ? formatYMD(dateRange.from) : ''
    const currentDateTo = dateRange?.to ? formatYMD(dateRange.to) : ''
    if (
      pageOwnsSyncedRange &&
      (currentDateFrom !== pageDateFrom || currentDateTo !== pageDateTo)
    ) {
      setDatePresetKey(undefined)
      setDateRange(syncedRange)
    }

    if (
      !matchesDailyAnalysisFilterSync(
        lastSync,
        pageFiltersAsGlobal,
        pageFilters
      )
    ) {
      syncPageAndGlobalFilters(projectId, country, syncedRange ?? dateRange)
    }
  }, [
    country,
    dateRange,
    gfCountry,
    gfDateFrom,
    gfDateTo,
    gfProjectId,
    globalCountry,
    globalDateFrom,
    globalDateTo,
    globalFilterReady,
    globalProjectId,
    lastDailyAnalysisSync,
    resolvedGlobalCountry,
    syncDailyAnalysisFilters,
    projectId,
    projects,
    projectsLoading,
    syncPageAndGlobalFilters,
  ])

  // 'daily' = 保持原样；'monthly' = 图表 / 表格 / Excel 全部按月汇总。
  const granularity = useMemo<'daily' | 'monthly'>(() => {
    if (
      datePresetKey === '本年度至今' ||
      datePresetKey === '上年度' ||
      datePresetKey === '上个季度'
    ) {
      return 'monthly'
    }
    if (dateRange?.from && dateRange?.to) {
      const days = getRangeDayCount({ from: dateRange.from, to: dateRange.to })
      if (days > 90) return 'monthly'
    }
    return 'daily'
  }, [datePresetKey, dateRange])
  const [activeTab, setActiveTab] = useState<ViewTab>('summary')

  const goalProjectId = globalFilterReady ? gfProjectId || projectId : ''
  const goalCountry = gfProjectId ? resolvedGlobalCountry : country
  const { goalProgress, goalLoading } = useGoalProgress(goalProjectId, goalCountry, session)
  const [data, setData] = useState<DailyAnalysisResponse | null>(null)
  const [rawComparisonSummaryRows, setComparisonSummaryRows] =
    useState<DailyAnalysisRow[]>(EMPTY_SUMMARY_ROWS)
  const [rawComparisonDetailRows, setComparisonDetailRows] =
    useState<DailyAnalysisDetailRow[]>(EMPTY_DETAIL_ROWS)
  const [loading, setLoading] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [skuOptions, setSkuOptions] = useState<ProjectSkuOption[]>([])
  const [skuOptionsScope, setSkuOptionsScope] = useState<string | null>(null)
  const [skuLoading, setSkuLoading] = useState(false)
  const [selectedSku, setSelectedSku] = useState('')
  const selectedSkuRef = useRef('')
  const skuScopeRef = useRef<string | null>(null)
  const skuRequestIdRef = useRef(0)
  const skuOptionsRequestedRef = useRef(false)
  // 视图模式：BEL-144 已彻底移除 Bar/Line 旧版 (DailyMetricChart)，统一使用 MetricSwitcherCard
  const latestLoadRequestRef = useRef(0)
  const currentSkuScope = useMemo(
    () => buildSkuScopeKey(projectId, country),
    [projectId, country]
  )

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  const loadProjects = useCallback(
    async (force = false) => {
      setProjectsLoading(true)
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(
          session,
          undefined,
          force ? { force: true } : undefined
        )
        setProjects(rows.filter((item) => item.id !== null))
        setProjectListError(null)
      } catch (fetchError) {
        const message =
          fetchError instanceof Error ? fetchError.message : '项目列表加载失败'
        setProjectListError(message)
        notify({
          type: 'error',
          title: '项目列表加载失败',
          message,
        })
      } finally {
        setProjectsLoading(false)
      }
    },
    [notify, session]
  )

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (!globalFilterReady || projectsLoading || projects.length === 0) return
    // 1. URL 没指定 projectId（空字符串）→ 选第一个
    // 2. URL 指定了 "all"（"全部项目"）→ 保留
    // 3. URL 指定了具体项目但项目列表里找不到（用户失去权限、项目被删除）→ 回退到第一个
    // BLF-925 follow-up：global-to-page effect runs first and marks its project as owned,
    // so this fallback cannot replace a global selection.
    if (gfProjectOwnedRef.current) return
    const isAllSentinel = projectId === 'all'
    const existsInList =
      projectId && !isAllSentinel && projects.some((p) => String(p.id) === projectId)
    if (!projectId || (!isAllSentinel && !existsInList)) {
      const first = projects.find((item) => item.id !== null)
      if (first?.id != null) {
        syncPageAndGlobalFilters(String(first.id), country, dateRange)
      }
    }
  }, [
    country,
    dateRange,
    globalFilterReady,
    projectId,
    projects,
    projectsLoading,
    syncPageAndGlobalFilters,
  ])

  const isAllProjects = projectId === 'all'

  // Page-owned country changes keep the existing last-seven-days reset behavior.
  useEffect(() => {
    const validGlobalCountry = gfProjectId ? resolvedGlobalCountry : null
    const globalCountryWillApply = Boolean(gfProjectId && validGlobalCountry && validGlobalCountry !== country)
    const lastSync = lastDailyAnalysisSync
    const lastSyncIsCurrent = Boolean(
      lastSync &&
        lastSync.filters.projectId === globalProjectId &&
        lastSync.filters.country === globalCountry &&
        lastSync.filters.dateFrom === globalDateFrom &&
        lastSync.filters.dateTo === globalDateTo
    )
    const atomicCountryWillApply = Boolean(
      lastSync &&
        lastSyncIsCurrent &&
        lastSync.pageFilters.country === globalCountry &&
        lastSync.pageFilters.country !== country
    )
    if (globalCountryWillApply || atomicCountryWillApply) return
    if (globalCountry === country) return
    setDateRange(defaultRange)
  }, [
    country,
    defaultRange,
    gfCountry,
    gfProjectId,
    globalCountry,
    globalDateFrom,
    globalDateTo,
    globalProjectId,
    lastDailyAnalysisSync,
    resolvedGlobalCountry,
  ])

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

      setRequestError(null)
      setLoading(true)
      const requestId = latestLoadRequestRef.current + 1
      latestLoadRequestRef.current = requestId
      try {
        if (isAllProjects) {
          if (country === 'ALL') {
            // BLF-913：全部项目 × 全部国家 — 单次请求后端聚合端点（USD 基准）。
            // 响应同时带 project_breakdown / country_breakdown 两种下钻；金额符号切 USD。
            if (projects.length === 0) return
            const allIds = projects.map((p) => String(p.id)).join(',')
            const allSearch = new URLSearchParams({
              project_ids: allIds,
              start_date: startDate,
              end_date: endDate,
              ...(skipRedis && { no_cache: 'true' }),
            })
            const allCompareSearch = previousRange
              ? new URLSearchParams({
                  project_ids: allIds,
                  start_date: formatYMD(previousRange.from!),
                  end_date: formatYMD(previousRange.to!),
                })
              : null

            // BEL-423：分析数据走 2min 客户端缓存（重复 mount 0 请求）；
            // "刷新数据"（skipRedis）force 跳过缓存。
            const [payload, comparePayload] = await Promise.all([
              fetchOpsJsonCached<DailyAnalysisAllProjectsCountriesResponse>(
                `${API_BASE}/api/v1/daily-analysis/all-projects-countries?${allSearch.toString()}`,
                { session, force: skipRedis, fallbackError: '销售数据加载失败' }
              ),
              allCompareSearch
                ? fetchOpsJsonCached<DailyAnalysisAllProjectsCountriesResponse>(
                    `${API_BASE}/api/v1/daily-analysis/all-projects-countries?${allCompareSearch.toString()}`,
                    { session, force: skipRedis, fallbackError: '销售数据对比加载失败' }
                  )
                : Promise.resolve(null),
            ])
            if (requestId !== latestLoadRequestRef.current) return
            setData({
              console: payload.console,
              summary_rows: payload.summary_rows,
              detail_rows: payload.detail_rows,
              available_dates: payload.available_dates,
            })
            setComparisonSummaryRows(comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS)
            setComparisonDetailRows(comparePayload?.detail_rows ?? EMPTY_DETAIL_ROWS)
            return
          }
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

          // BEL-423：分析数据走 2min 客户端缓存（重复 mount 0 请求）；
          // "刷新数据"（skipRedis）force 跳过缓存。
          const [payload, comparePayload] = await Promise.all([
            fetchOpsJsonCached<DailyAnalysisAllProjectsResponse>(
              `${API_BASE}/api/v1/daily-analysis/all?${search.toString()}`,
              { session, force: skipRedis, fallbackError: '销售数据加载失败' }
            ),
            compareSearch
              ? fetchOpsJsonCached<DailyAnalysisAllProjectsResponse>(
                  `${API_BASE}/api/v1/daily-analysis/all?${compareSearch.toString()}`,
                  { session, force: skipRedis, fallbackError: '销售数据对比加载失败' }
                )
              : Promise.resolve(null),
          ])
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
          setComparisonSummaryRows(comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS)
          setComparisonDetailRows(comparePayload?.detail_rows ?? EMPTY_DETAIL_ROWS)
        } else if (country === 'ALL') {
          // 跨国家站点聚合：仅支持单项目 + 国家=ALL；后端对 US/DE/UK 分别加载并求和。
          if (!projectId) {
            // BLF-882：项目列表加载中的早期调用静默跳过（列表就绪后 [loadData] effect 会自然触发）
            if (!projectsLoading) {
              notify({ type: 'error', title: '请先选择项目' })
            }
            return
          }
          const search = new URLSearchParams({
            project_id: projectId,
            start_date: startDate,
            end_date: endDate,
            ...(skipRedis && { no_cache: 'true' }),
          })
          const compareSearch = previousRange
            ? new URLSearchParams({
                project_id: projectId,
                start_date: formatYMD(previousRange.from!),
                end_date: formatYMD(previousRange.to!),
              })
            : null

          const [payload, comparePayload] = await Promise.all([
            fetchOpsJsonCached<DailyAnalysisAllCountriesResponse>(
              `${API_BASE}/api/v1/daily-analysis/all-countries?${search.toString()}`,
              { session, force: skipRedis, fallbackError: '跨国家销售数据加载失败' }
            ),
            compareSearch
              ? fetchOpsJsonCached<DailyAnalysisAllCountriesResponse>(
                  `${API_BASE}/api/v1/daily-analysis/all-countries?${compareSearch.toString()}`,
                  { session, force: skipRedis, fallbackError: '跨国家销售数据对比加载失败' }
                )
              : Promise.resolve(null),
          ])
          if (requestId !== latestLoadRequestRef.current) return
          setData({
            console: payload.console,
            summary_rows: payload.summary_rows,
            detail_rows: payload.detail_rows,
            available_dates: payload.available_dates,
          })
          setComparisonSummaryRows(comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS)
          setComparisonDetailRows(comparePayload?.detail_rows ?? EMPTY_DETAIL_ROWS)
        } else {
          if (!projectId) {
            // BLF-882：项目列表加载中的早期调用静默跳过（列表就绪后 [loadData] effect 会自然触发）
            if (!projectsLoading) {
              notify({ type: 'error', title: '请先选择项目' })
            }
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

          const [payload, comparePayload] = await Promise.all([
            fetchOpsJsonCached<DailyAnalysisResponse>(
              `${API_BASE}/api/v1/daily-analysis?${search.toString()}`,
              { session, force: skipRedis, fallbackError: '销售数据加载失败' }
            ),
            compareSearch
              ? fetchOpsJsonCached<DailyAnalysisResponse>(
                  `${API_BASE}/api/v1/daily-analysis?${compareSearch.toString()}`,
                  { session, force: skipRedis, fallbackError: '销售数据对比加载失败' }
                )
              : Promise.resolve(null),
          ])
          if (requestId !== latestLoadRequestRef.current) return
          setData(payload)
          setComparisonSummaryRows(comparePayload?.summary_rows ?? EMPTY_SUMMARY_ROWS)
          setComparisonDetailRows(comparePayload?.detail_rows ?? EMPTY_DETAIL_ROWS)
        }
      } catch (fetchError) {
        if (requestId !== latestLoadRequestRef.current) return
        const message = fetchError instanceof Error ? fetchError.message : '销售数据加载失败'
        setRequestError(message)
        notify({
          type: 'error',
          title: '销售数据加载失败',
          message,
        })
        setData(null)
        setComparisonSummaryRows(EMPTY_SUMMARY_ROWS)
        setComparisonDetailRows(EMPTY_DETAIL_ROWS)
      } finally {
        if (requestId !== latestLoadRequestRef.current) return
        setLoading(false)
      }
    },
    [projectId, country, dateRange, notify, isAllProjects, projects, projectsLoading, session]
  )
  const loadProjectSkus = useCallback(
    async (projectIdText: string, countryValue: string) => {
      const requestScope = buildSkuScopeKey(projectIdText, countryValue)
      const requestId = skuRequestIdRef.current + 1
      skuRequestIdRef.current = requestId
      const projectIdNum = Number(projectIdText)
      const projectName = projects.find((project) => project.id === projectIdNum)?.name
      if (!projectName || !requestScope || skuScopeRef.current !== requestScope) {
        if (skuScopeRef.current === requestScope) {
          setSkuOptions([])
          setSkuOptionsScope(null)
          setSkuLoading(false)
        }
        return
      }

      setSkuLoading(true)
      try {
        const allItems: ProjectSkuOption[] = []
        let nextPage = 1
        let hasNextPage = true

        while (hasNextPage) {
          // BLF-917：仅加载激活 SKU，下拉与表格都按 is_active 过滤。
          const params = new URLSearchParams({
            project_name: projectName,
            country: countryValue,
            is_active: 'true',
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
              is_active: boolean
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
              is_active: item.is_active,
            }))
          )
          hasNextPage = payload.has_next
          nextPage += 1
        }
        if (!shouldAcceptSkuOptions(requestId, skuRequestIdRef.current, requestScope, skuScopeRef.current)) {
          return
        }
        setSkuOptions(allItems)
        setSkuOptionsScope(requestScope)
      } catch (loadError) {
        if (!shouldAcceptSkuOptions(requestId, skuRequestIdRef.current, requestScope, skuScopeRef.current)) {
          return
        }
        setSkuOptions([])
        setSkuOptionsScope(null)
        notify({
          type: 'error',
          title: '项目 SKU 列表加载失败',
          message: loadError instanceof Error ? loadError.message : '加载失败',
        })
      } finally {
        if (shouldAcceptSkuOptions(requestId, skuRequestIdRef.current, requestScope, skuScopeRef.current)) {
          setSkuLoading(false)
        }
      }
    },
    [notify, projects]
  )

  useEffect(() => {
    skuScopeRef.current = currentSkuScope
    skuRequestIdRef.current += 1
    skuOptionsRequestedRef.current = false
    setSkuOptions([])
    setSkuOptionsScope(null)
    setSkuLoading(false)
    selectedSkuRef.current = ''
    setSelectedSku('')
  }, [currentSkuScope])

  // BEL-423 页内懒加载：SKU 列表从 mount 即分页拉取改为首打开 SKU 筛选器再拉取。
  // 默认不选 SKU 时主数据不需要它，选 SKU 前拉完即可。
  const ensureSkuOptions = useCallback(() => {
    if (skuOptionsRequestedRef.current) return
    if (!projectId || country === 'ALL') return
    const projectIdNum = Number(projectId)
    if (!projects.some((project) => project.id === projectIdNum)) return
    skuOptionsRequestedRef.current = true
    void loadProjectSkus(projectId, country)
  }, [country, loadProjectSkus, projectId, projects])

  // BLF-925：切换到「SKU 明细」Tab 时确保 SKU 列表已加载——品名列依赖 skuOptions
  // 查品名（BEL-423 懒加载只在打开 SKU 筛选器时拉取，直接进明细 Tab 会显示 --）。
  useEffect(() => {
    if (activeTab === 'details') {
      ensureSkuOptions()
    }
  }, [activeTab, ensureSkuOptions])

  useEffect(() => {
    if (!projectId || !globalFiltersApplied) return
    void loadData()
  }, [globalFiltersApplied, loadData, projectId])

  const rawSummaryRows = data?.summary_rows ?? EMPTY_SUMMARY_ROWS
  const rawDetailRows = data?.detail_rows ?? EMPTY_DETAIL_ROWS
  // granularity === 'monthly' 时把 summary / detail 行按月汇总（详见 lib/aggregate.ts）。
  // KPI 卡片、图表、表格、Excel 导出都通过这两个变量读数，自动获得月度视图。
  const goalRingItems = useMemo<GoalRingItem[]>(() => {
    if (!goalProgress || goalProgress.target_amount <= 0) return []

    const paceRatio = achievementPaceRatio(
      goalProgress.achieved_amount,
      goalProgress.target_amount,
      goalProgress.today_day,
      goalProgress.days_in_month
    )
    const money = (value: number) =>
      `${goalProgress.currency}${value.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`

    return [
      {
        key: 'pace',
        label: '截止今日完成率',
        shortLabel: '进度',
        value: goalProgress.completion_vs_daily,
        display: `${(goalProgress.completion_vs_daily * 100).toFixed(1)}%`,
        caption: `已完成 ${money(goalProgress.achieved_amount)} / 应完成 ${money(
          (goalProgress.target_amount * goalProgress.today_day) / goalProgress.days_in_month
        )}`,
        color: 'var(--warm-ledger-color-accent)',
      },
      {
        key: 'monthly',
        label: '实际月度完成率',
        shortLabel: '月度',
        value: goalProgress.completion_vs_monthly,
        display: `${(goalProgress.completion_vs_monthly * 100).toFixed(1)}%`,
        caption: `已完成 ${money(goalProgress.achieved_amount)} / 目标 ${money(goalProgress.target_amount)}`,
        color: 'var(--warm-ledger-color-text-soft)',
      },
      {
        key: 'pace_ratio',
        label: '达成速度',
        shortLabel: '速度',
        value: paceRatio ?? 0,
        display:
          paceRatio === null
            ? '--'
            : goalProgress.achieved_amount >= goalProgress.target_amount
              ? '已达标'
              : `${(paceRatio * 100).toFixed(1)}%`,
        caption: '当前日均 / 剩余所需日均',
        color: 'var(--warm-ledger-color-text-muted)',
      },
    ]
  }, [goalProgress])

  const showGoalProgressStat = isGoalProgressScopeValid(projectId, country)
  const goalHref = `/dashboard/operations/project-goals?project=${projectId}&country=${country}`

  const summaryRows = useMemo(
    () => (granularity === 'monthly' ? bucketSummaryByMonth(rawSummaryRows) : rawSummaryRows),
    [rawSummaryRows, granularity]
  )
  // BLF-917：SKU 明细 Tab 按当前项目/国家作用域内的 SKU info.is_active 过滤。
  // 作用域未匹配或 SKU 列表尚未加载时不强行过滤，避免旧请求把新明细筛空。
  const detailRows = useMemo(() => {
    const bucketed = granularity === 'monthly' ? bucketDetailByMonth(rawDetailRows) : rawDetailRows
    return filterRowsBySkuScope(bucketed, skuOptions, skuOptionsScope, currentSkuScope)
  }, [rawDetailRows, granularity, skuOptions, skuOptionsScope, currentSkuScope])
  const comparisonSummaryRows = useMemo(
    () =>
      granularity === 'monthly'
        ? bucketSummaryByMonth(rawComparisonSummaryRows)
        : rawComparisonSummaryRows,
    [rawComparisonSummaryRows, granularity]
  )
  // BLF-917：比较期明细同样只保留当前激活的 SKU，避免对比图混入历史 SKU。
  const comparisonDetailRows = useMemo(() => {
    const bucketed =
      granularity === 'monthly'
        ? bucketDetailByMonth(rawComparisonDetailRows)
        : rawComparisonDetailRows
    return filterRowsBySkuScope(bucketed, skuOptions, skuOptionsScope, currentSkuScope)
  }, [
    rawComparisonDetailRows,
    granularity,
    skuOptions,
    skuOptionsScope,
    currentSkuScope,
  ])
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
    [projects, projectId]
  )

  const chartDataRows = selectedSku ? filteredDetailRows : summaryRows

  const filteredComparisonRows = useMemo(() => {
    if (!selectedSku || comparisonDetailRows.length === 0) return EMPTY_DETAIL_ROWS
    return comparisonDetailRows.filter((row) => row.sku === selectedSku)
  }, [selectedSku, comparisonDetailRows])

  const comparisonDataRows = selectedSku ? filteredComparisonRows : comparisonSummaryRows

  const hasComparisonData = comparisonDataRows.length > 0
  // 对比语义：当前周期第 N 天 ↔ 上一周期第 N 天（同位日 position-aligned）。
  // 不能用"绝对 date 匹配"——上一周期是另一段时间（如 6/13~6/19），里面根本不会有 6/20；
  // 也不能用"按当前周期 index 取上一周期数组"——上一周期长度可能不同、且首日缺数据时索引会整体偏移。
  // 正确做法：用与 loadData 同一份 getPreviousPeriodRange 算出上一周期起止，
  // 再按"上一周期起始日 + N 天"在上一周期数据 Map（key = 上一周期自己的 date 字符串）里查。
  // 边界：上一周期某天缺数据时返回 null，recharts LineChart 会断点、BarChart 会缺柱，
  // KPI 卡片的 getPrevious 仍走 aggregateMetric(comparisonDataRows, k) 全量求和，行为与图表解耦。
  //
  // 关键：buildChartRows 接收 `selected` 参数（MetricSwitcherCard 内部当前选中 metric），
  // ——不在闭包里绑定任何 page.tsx 的"当前 metric" state。每次 selected 变化时由
  // renderLine(selected) 重新调用，保证 compareMetricValue 跟随 metric 切换。
  // 同时两个分支都展开所有 metric 字段到 row 上，让 <Bar dataKey={selected}> / <Line dataKey={selected}>
  // 在切换 metric 时也能立刻取到正确字段（不再依赖 [activeChartMetric] 这种动态 key）。
  const buildChartRows = useCallback(
    (selected: ChartMetricKey): Array<Record<string, unknown>> => {
      const normalizedRange = normalizeDateRange(dateRange)
      if (!normalizedRange?.from || !normalizedRange?.to) {
        return []
      }
      const allDates =
        granularity === 'monthly'
          ? generateMonthKeys(normalizedRange.from, normalizedRange.to)
          : generateDateRangeStrings(normalizedRange.from, normalizedRange.to)
      const previousRange = getPreviousPeriodRange(normalizedRange)
      const previousStart = previousRange?.from
      if (!previousStart || !previousRange?.to) {
        // 上一周期不可计算时只画当前周期；MetricSwitcherCard 看到 compareMetricValue
        // 全为 null 不会渲染对比 bar/line，仅显示当前周期。
        const summaryData = new Map(summaryRows.map((row) => [row.date, row]))
        const existingData = new Map(filteredDetailRows.map((row) => [row.date, row]))
        return allDates.map((date) =>
          selectedSku
            ? spreadDetailRow(existingData.get(date), date, null)
            : spreadSummaryRow(summaryData.get(date), date, null)
        )
      }

      if (selectedSku) {
        const existingData = new Map(filteredDetailRows.map((row) => [row.date, row]))
        // filteredComparisonRows 已经按 sku 过滤；按"上一周期自己的 date"建 Map。
        const comparisonDataByDate = new Map<string, DailyAnalysisDetailRow>()
        for (const compareRow of filteredComparisonRows) {
          if (compareRow.sku === selectedSku) {
            comparisonDataByDate.set(compareRow.date, compareRow)
          }
        }

        return allDates.map((date, index) => {
          const row = existingData.get(date)
          // 当前周期第 index 个桶 → 上一周期第 index 个桶（同位日 / 同位月）。
          const compareDate =
            granularity === 'monthly'
              ? dateToMonthKeyFromDate(addMonths(previousStart, index))
              : formatYMD(addDays(previousStart, index))
          const compareRow = comparisonDataByDate.get(compareDate)
          return spreadDetailRow(row, date, compareRow ? compareRow[selected] : null)
        })
      }

      const summaryData = new Map(summaryRows.map((row) => [row.date, row]))
      // 后端 summary_rows 已按 date 升序且同 date 唯一，Map 安全。
      const comparisonDataByDate = new Map(comparisonSummaryRows.map((row) => [row.date, row]))

      return allDates.map((date, index) => {
        const row = summaryData.get(date)
        // 当前周期第 index 个桶 → 上一周期第 index 个桶（同位日 / 同位月）。
        const compareDate =
          granularity === 'monthly'
            ? dateToMonthKeyFromDate(addMonths(previousStart, index))
            : formatYMD(addDays(previousStart, index))
        const compareRow = comparisonDataByDate.get(compareDate)
        return spreadSummaryRow(row, date, compareRow ? compareRow[selected] : null)
      })
    },
    [
      selectedSku,
      filteredDetailRows,
      filteredComparisonRows,
      summaryRows,
      comparisonSummaryRows,
      dateRange,
      granularity,
    ]
  )

  const summaryTableRows = selectedSku ? filteredDetailRows : summaryRows
  const dateRangeDisplay = consoleData
    ? `${consoleData.start_date} ~ ${consoleData.end_date}`
    : dateRange
      ? `${formatYMD(dateRange.from!)}${' ~ ' + formatYMD(dateRange.to!)}`
      : ''
  const exportDisabled = isDailyAnalysisExportBusy({
    exporting,
    loading,
    skuLoading,
    hasData: Boolean(data),
  })
  const handleExportExcel = async () => {
    if (exportDisabled) return
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
        granularity
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
    syncPageAndGlobalFilters(projectId, country, nextRange)
    await loadData(nextRange)
  }

  // —— BLF-826 阶段 B：head 插槽 + 全局刷新 ——
  // 刷新语义与原「控制台」RefreshButton 一致：当前筛选条件下强刷（跳 Redis/客户端缓存）。
  const refreshData = useCallback(() => loadData(undefined, true), [loadData])
  useHeaderRefresh(refreshData, { loading })

  const handleSkuChange = (value: string) => {
    selectedSkuRef.current = value
    setSelectedSku(value)
    setActiveTab('summary')
    void loadData()
  }

  // xl+ 项目/日期与站点由 Warm Ledger 全局筛选承载；中等宽度和移动端沿用同一状态源。
  const projectFilterValue = projectId || '__project_pending__'
  const projectFilterError = projectListError
    ? `项目列表加载失败：${projectListError}`
    : null
  const projectFilterOptions = [
    ...(!projectId
      ? [
          {
            value: '__project_pending__',
            label: projectsLoading ? '加载项目…' : '选择项目',
          },
        ]
      : []),
    ...(projectListError ? [] : [{ value: 'all', label: '全部项目' }]),
    ...(projectListError
      ? []
      : projects.flatMap((project) =>
          project.id == null ? [] : [{ value: String(project.id), label: project.name }]
        )),
  ]
  const handleProjectFilterChange = (nextProjectId: string) => {
    syncPageAndGlobalFilters(nextProjectId, country, dateRange)
  }
  const handleCountryFilterChange = (value: string) => {
    const nextCountry = value as CountryOption
    const nextRange = lastSevenDaysRange(nextCountry)
    setDateRange(nextRange)
    setDatePresetKey(undefined)
    syncPageAndGlobalFilters(projectId, nextCountry, nextRange)
  }
  const handleDateRangeChange = (range?: DateRange) => {
    setDateRange(range)
    setDatePresetKey(undefined)
    syncPageAndGlobalFilters(projectId, country, range)
  }
  const fallbackProjectDateControls = (
    <div className={cn(styles.fallbackPrimary, 'hidden items-center md:flex xl:hidden')}>
      <div className={styles.projectControl}>
        <WarmSelect
          id="daily-analysis-project-filter-fallback"
          label="项目"
          value={projectFilterValue}
          options={projectFilterOptions}
          onChange={handleProjectFilterChange}
          disabled={projectsLoading || !projectId || Boolean(projectListError)}
          error={projectFilterError}
          className={cn(styles.filterSelect, styles.projectSelect)}
        />
        {projectListError ? (
          <WarmButton
            className={styles.projectRetry}
            type="button"
            aria-label="重试项目列表加载"
            loading={projectsLoading}
            loadingLabel="正在重新加载项目列表"
            onClick={() => void loadProjects(true)}
          >
            重试
          </WarmButton>
        ) : null}
      </div>
      <DateRangePicker
        value={dateRange}
        timezone={COUNTRY_TIMEZONE_MAP[country === 'ALL' ? 'US' : country]}
        onChange={handleDateRangeChange}
        onApply={() => void loadData()}
        placeholder="选择日期范围"
        className={cn(styles.dateTrigger, styles.fallbackDateTrigger)}
        portalContainer={portalContainer}
        popoverClassName={cn(styles.datePopover, 'warm-ledger__date-picker-content')}
      />
    </div>
  )
  const fallbackSecondaryControls = (
    <div className={cn(styles.fallbackSecondary, 'hidden items-center md:flex xl:hidden')}>
      <WarmSelect
        id="daily-analysis-country-filter-fallback"
        label="站点"
        value={country}
        options={COUNTRY_OPTIONS}
        onChange={handleCountryFilterChange}
        className={cn(styles.filterSelect, styles.countrySelect)}
      />
      <WarmSkuSearchField
        value={selectedSku}
        options={skuOptions}
        loading={skuLoading}
        disabled={country === 'ALL'}
        onOpen={ensureSkuOptions}
        onChange={handleSkuChange}
      />
    </div>
  )
  const wideSecondaryControls = (
    <div className={cn(styles.wideSecondary, 'hidden items-center xl:flex')}>
      <WarmSkuSearchField
        value={selectedSku}
        options={skuOptions}
        loading={skuLoading}
        disabled={country === 'ALL'}
        onOpen={ensureSkuOptions}
        onChange={handleSkuChange}
      />
    </div>
  )

  // BLF-930 · 移动端：筛选控件下迁为正文顶部可折叠筛选条（短控件 1/2，宽控件 col-span-2）。
  // 摘要 = 当前项目名 · 站点 · 日期范围；展开态 grid-cols-2 完整四件套（项目/站点/日期/SKU）。
  // 数据经 props 与页面共享真相源：与 xl+ 全局四件套 / md~xl 降级三件套完全一致，联动天然同步。
  const mobileProjectLabel =
    projectId === 'all'
      ? '全部项目'
      : (projects.find((p) => String(p.id) === projectId)?.name ?? '')
  const mobileCountryLabel = country === 'ALL' ? '全部站点' : getCountryLabel(country)
  const mobileDateLabel =
    dateRange?.from && dateRange?.to
      ? `${formatYMD(dateRange.from)} ~ ${formatYMD(dateRange.to)}`
      : '未选日期'
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${mobileDateLabel}`

  const mobileFilterStrip = (
    <MobileFilterStrip
      summary={mobileFilterSummary}
      className={styles.mobileFilterStrip}
      controls={
        <>
          <div className={styles.mobileProjectControl}>
            <WarmSelect
              id="daily-analysis-project-filter-mobile"
              label="项目"
              value={projectFilterValue}
              options={projectFilterOptions}
              onChange={handleProjectFilterChange}
              disabled={projectsLoading || !projectId || Boolean(projectListError)}
              error={projectFilterError}
              className={cn(styles.filterSelect, styles.mobileSelect)}
            />
            {projectListError ? (
              <WarmButton
                className={styles.projectRetry}
                type="button"
                aria-label="重试项目列表加载"
                loading={projectsLoading}
                loadingLabel="正在重新加载项目列表"
                onClick={() => void loadProjects(true)}
              >
                重试
              </WarmButton>
            ) : null}
          </div>
          <WarmSelect
            id="daily-analysis-country-filter-mobile"
            label="站点"
            value={country}
            options={COUNTRY_OPTIONS}
            onChange={handleCountryFilterChange}
            className={cn(styles.filterSelect, styles.mobileSelect)}
          />
          <MobileFilterWide className={styles.mobileWide}>
            <DateRangePicker
              value={dateRange}
              timezone={COUNTRY_TIMEZONE_MAP[country === 'ALL' ? 'US' : country]}
              onChange={handleDateRangeChange}
              onApply={() => void loadData()}
              placeholder="选择日期范围"
              className={cn(styles.dateTrigger, styles.mobileDateTrigger)}
              portalContainer={portalContainer}
              popoverClassName={cn(styles.datePopover, 'warm-ledger__date-picker-content')}
            />
          </MobileFilterWide>
          <MobileFilterWide className={styles.mobileWide}>
            <WarmSkuSearchField
              value={selectedSku}
              options={skuOptions}
              loading={skuLoading}
              disabled={country === 'ALL'}
              onOpen={ensureSkuOptions}
              onChange={handleSkuChange}
            />
          </MobileFilterWide>
        </>
      }
    />
  )
  const headerSlots = (
    <DailyAnalysisHeaderSlots
      isMobile={isMobile}
      primaryControls={fallbackProjectDateControls}
      secondaryControls={
        <>
          {fallbackSecondaryControls}
          {wideSecondaryControls}
        </>
      }
      mobileControls={mobileFilterStrip}
    />
  )

  return (
    <div className={styles.page} data-warm-daily-analysis>
      {headerSlots}
      <section className={styles.chartRegion} aria-busy={loading || projectsLoading}>
        {requestError ? (
          <div
            className={styles.dataError}
            role="alert"
            aria-labelledby="daily-analysis-error-title"
          >
            <div className={styles.errorCopy}>
              <h2 id="daily-analysis-error-title">销售数据加载失败</h2>
              <p>{requestError}</p>
            </div>
            <WarmButton
              className={styles.retryButton}
              variant="secondary"
              loading={loading}
              loadingLabel="正在重试销售数据"
              onClick={refreshData}
            >
              重试
            </WarmButton>
          </div>
        ) : data && chartDataRows.length > 0 ? (
          <>
            {loading ? (
              <div className={styles.loadingStatus} role="status">
                正在更新销售数据
              </div>
            ) : null}
            <div className={styles.chartCard}>
              <MetricSwitcherCard<ChartMetricKey>
                metrics={LINE_METRICS}
                defaultMetric="sales_amount"
                chartKind="auto"
                showChartKindToggle
                colors={
                  Object.fromEntries(
                    LINE_METRICS.map((m) => [m.key, SINGLE_METRIC_CHART_CONFIG[m.key]?.color ?? ''])
                  ) as Partial<Record<ChartMetricKey, string>>
                }
                heightClass={isMobile ? 'h-[260px]' : 'h-[360px]'}
                extraContent={
                  showGoalProgressStat ? (
                    <GoalProgressStat
                      href={goalHref}
                      items={goalRingItems}
                      loading={goalLoading}
                    />
                  ) : null
                }
                getCurrent={(k) => aggregateMetric(chartDataRows, k)}
                getPrevious={(k) =>
                  comparisonDataRows.length > 0 ? aggregateMetric(comparisonDataRows, k) : null
                }
                renderLine={(selected) => buildChartRows(selected)}
                tooltipFormatter={(value, key) => formatMetricValue(key, value)}
                yAxisFormatter={(value, key) => formatAxisValue(key, value)}
                xTickFormatter={(value) => {
                  const parts = String(value).split('-')
                  const month = parts[1] ?? ''
                  // 月度桶 key = 'YYYY-MM-01'（第三段固定 '01'）；日度 key = 'YYYY-MM-DD'。
                  if (granularity === 'monthly' || parts.length < 3) {
                    return `${Number(month)}月`
                  }
                  const day = parts[2]
                  return isMobile ? `${month}/${day}` : `${month}月${day}日`
                }}
              />
            </div>
          </>
        ) : loading || projectsLoading ? (
          <div className={styles.chartStatus} role="status">
            正在加载销售数据
          </div>
        ) : data ? (
          <div className={styles.chartStatus} role="status">
            当前筛选范围内没有销售数据
          </div>
        ) : null}
      </section>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ViewTab)}
        className="w-full"
      >
        <div className={styles.tableSection}>
          <DataTableCard className={styles.tablePanel}>
            <DataTableCardHeader className={styles.tableHeader}>
              <div className={styles.tableHeading}>
                <h2>销售明细</h2>
              </div>
              <div className={styles.tableActions}>
                <WarmButton
                  type="button"
                  className={styles.exportButton}
                  onClick={() => void handleExportExcel()}
                  disabled={exportDisabled}
                  loading={exporting}
                  loadingLabel="正在导出销售数据"
                >
                  {!exporting ? (
                    <FileDown className={styles.exportIcon} aria-hidden="true" />
                  ) : null}
                  导出
                </WarmButton>
                <TabsMotionGroup id="daily-analysis-tabs">
                  <TabsList
                    variant="term"
                    className={cn(
                      styles.tabsList,
                      'grid h-auto w-full grid-cols-2 sm:w-[260px]'
                    )}
                  >
                    <SlidingTabsTrigger
                      value="summary"
                      activeValue={activeTab}
                      layoutId="daily-analysis-tab-indicator"
                      variant="term"
                    >
                      <CalendarDays aria-hidden />
                      每日汇总
                    </SlidingTabsTrigger>
                    <SlidingTabsTrigger
                      value="details"
                      activeValue={activeTab}
                      layoutId="daily-analysis-tab-indicator"
                      variant="term"
                    >
                      <Package aria-hidden />
                      SKU 明细
                    </SlidingTabsTrigger>
                  </TabsList>
                </TabsMotionGroup>
              </div>
            </DataTableCardHeader>

            <DataTableCardBody className={styles.tableBody}>
              <DirectionalTabTransition value={activeTab} order={VIEW_TAB_ORDER}>
                <TabsContent forceMount value={activeTab} className="m-0">
                  {activeTab === 'summary' ? (
                    <Table containerClassName={styles.tableScroll}>
                      <TableHeader className={cn(STICKY_TOP_ROW, styles.stickyHeader)}>
                        <TableRow className="border-0 hover:bg-transparent">
                          <TableHead className="min-w-[120px]">日期</TableHead>
                          <TableHead className={numericHead}>订单量</TableHead>
                          <TableHead className={numericHead}>销售额</TableHead>
                          <TableHead className={numericHead}>曝光量</TableHead>
                          <TableHead className={numericHead}>点击量</TableHead>
                          <TableHead className={numericHead}>CPC</TableHead>
                          <TableHead className={numericHead}>广告花费</TableHead>
                          <TableHead className={numericHead}>广告订单</TableHead>
                          <TableHead className={numericHead}>可售库存</TableHead>
                          <TableHead className={numericHead}>页面浏览量</TableHead>
                          <TableHead className={numericHead}>销量</TableHead>
                          <TableHead className={numericHead}>访问量</TableHead>
                          <TableHead className={numericHead}>转化率</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loading || (projectsLoading && !data) ? (
                          <TableSkeletonRows
                            columns={13}
                            rows={6}
                            widths={Array(13).fill('w-full max-w-[90px]')}
                            rowClassName="border-0"
                          />
                        ) : requestError ? (
                          <EmptyTableState colSpan={13} message="销售数据加载失败" />
                        ) : summaryTableRows.length ? (
                          summaryTableRows.map((row, index) => (
                            <TableRow
                              key={`${row.date}-${index}`}
                              className={cn(
                                index % 2 === 0 && 'bg-term-raised'
                              )}
                            >
                              <TableCell className="font-medium text-foreground">
                                {granularity === 'monthly' ? row.date.slice(0, 7) : row.date}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.order_qty.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {formatMoney(row.sales_amount)}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.impressions.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.clicks.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>{formatMoney(row.cpc)}</TableCell>
                              <TableCell className={numericCell}>
                                {formatMoney(row.ad_spend)}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.ad_orders.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.available_qty.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.page_views.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.units_ordered.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {row.sessions.toLocaleString('zh-CN')}
                              </TableCell>
                              <TableCell className={numericCell}>
                                {(row.conversion_rate * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                          ))
                        ) : data ? (
                          <EmptyTableState
                            colSpan={13}
                            message="当前筛选范围内还没有可展示的销售数据汇总。"
                          />
                        ) : null}
                      </TableBody>
                    </Table>
                  ) : (
                    <Table containerClassName={styles.tableScroll}>
                      <TableHeader className={cn(STICKY_TOP_ROW, styles.stickyHeader)}>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="min-w-[120px] bg-term-raised">
                            日期
                          </TableHead>
                          <TableHead className="min-w-[200px]">SKU</TableHead>
                          <TableHead className="min-w-[200px]">品名</TableHead>
                          <TableHead className={numericHead}>订单量</TableHead>
                          <TableHead className={numericHead}>销售额</TableHead>
                          <TableHead className={numericHead}>曝光量</TableHead>
                          <TableHead className={numericHead}>点击量</TableHead>
                          <TableHead className={numericHead}>CPC</TableHead>
                          <TableHead className={numericHead}>广告花费</TableHead>
                          <TableHead className={numericHead}>广告订单</TableHead>
                          <TableHead className={numericHead}>可售库存</TableHead>
                          <TableHead className={numericHead}>在途数量</TableHead>
                          <TableHead className={numericHead}>页面浏览量</TableHead>
                          <TableHead className={numericHead}>销量</TableHead>
                          <TableHead className={numericHead}>访问量</TableHead>
                          <TableHead className={numericHead}>转化率</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loading || (projectsLoading && !data) ? (
                          <TableSkeletonRows
                            columns={16}
                            rows={8}
                            widths={Array(16).fill('w-full max-w-[90px]')}
                          />
                        ) : requestError ? (
                          <EmptyTableState colSpan={16} message="销售数据加载失败" />
                        ) : detailDisplayRows.length ? (
                          detailDisplayRows.map(
                            ({ row, rowKey, showDate, rowSpan, isTintedGroup, productName }) => (
                              <TableRow
                                key={rowKey}
                                className={cn(
                                  'transition-colors',
                                  isTintedGroup
                                    ? 'bg-term-raised hover:bg-term-hover'
                                    : 'bg-term-panel hover:bg-term-hover'
                                )}
                              >
                                {showDate ? (
                                  <TableCell
                                    rowSpan={rowSpan}
                                    className={cn(
                                      'align-middle text-center font-semibold text-foreground',
                                      isTintedGroup ? 'bg-term-raised' : 'bg-term-panel'
                                    )}
                                  >
                                    {granularity === 'monthly' ? row.date.slice(0, 7) : row.date}
                                  </TableCell>
                                ) : null}
                                <TableCell>{row.sku}</TableCell>
                                <TableCell className="max-w-[200px] truncate text-muted-foreground">
                                  {productName || '--'}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.order_qty.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {formatMoney(row.sales_amount)}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.impressions.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.clicks.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {formatMoney(row.cpc)}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {formatMoney(row.ad_spend)}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.ad_orders.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.available_qty.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.in_transit_qty > 0 ? (
                                    <span className="font-medium text-[var(--warm-ledger-color-text-soft)]">
                                      {row.in_transit_qty.toLocaleString('zh-CN')}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">--</span>
                                  )}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.page_views.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.units_ordered.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {row.sessions.toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className={numericCell}>
                                  {(row.conversion_rate * 100).toFixed(2)}%
                                </TableCell>
                              </TableRow>
                            )
                          )
                        ) : data ? (
                          <EmptyTableState
                            colSpan={16}
                            message="当前筛选范围内还没有可展示的 SKU 销售数据明细。"
                          />
                        ) : null}
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
