'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download, Loader2, XCircle } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DateRangePicker,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

type CountryOption = 'US' | 'DE' | 'UK'

// Currency configuration by country
const CURRENCY_CONFIG: Record<CountryOption, { symbol: string; excelFmt: string }> = {
  US: { symbol: '$',  excelFmt: '$#,##0.00;[Red]-$#,##0.00' },
  DE: { symbol: '€', excelFmt: '#,##0.00;[Red]-#,##0.00 €' },
  UK: { symbol: '£', excelFmt: '£#,##0.00;[Red]-£#,##0.00' },
}

type ProjectOption = {
  id?: number
  name: string
}

type CheckState = 'idle' | 'checking' | 'done' | 'error'
type RunState = 'idle' | 'running' | 'done' | 'error'

type PaymentPeriodOverlap = {
  period_start_date: string
  period_end_date: string
  source_id: number
}

type PeriodCoverageInfo = {
  period_start_date: string
  period_end_date: string
  source_id: number
  covered_dates: string[]
}

type DataAvailability = {
  // Missing check (single-day only, NOT affected by periodic data)
  business_report_missing: string[]
  ad_report_missing: string[]
  inventory_missing: string[]
  // Periodic coverage info
  business_period_info: PeriodCoverageInfo[]
  ad_period_info: PeriodCoverageInfo[]
  // Missing but covered by periodic (can calculate, but daily data is incomplete)
  business_periodic_only_missing: string[]
  ad_periodic_only_missing: string[]
  // Payment info
  payment_periods_overlapping: PaymentPeriodOverlap[]
  payment_full_period_covered: boolean
  payment_daily_covered_dates: string[]
  payment_objective_empty_dates: string[]
  has_minimum_data: boolean
  weekly_availability: WeeklyAvailability[]
}

type WeeklyAvailability = {
  iso_year: number
  iso_week: number
  week_start_date: string
  week_end_date: string
  total_days: number
  business_report_available_days: number
  ad_report_available_days: number
  // Periodic coverage flag
  business_periodic_covered: boolean
  ad_periodic_covered: boolean
  payment_covered: boolean
  can_calculate: boolean
  is_partial: boolean
  business_missing_dates: string[]
  ad_missing_dates: string[]
  payment_objective_empty_dates?: string[]
}

type CalculationPeriod = {
  report_start_date: string
  report_end_date: string
  summary: Record<string, unknown>
  details: Record<string, unknown>[]
  is_partial?: boolean
  persisted?: boolean
  pt1_id?: number | null
  version?: number | null
  completeness?: {
    total_days: number
    available_business_days: number
    available_ad_days: number
    business_missing_dates: string[]
    ad_missing_dates: string[]
    payment_covered: boolean
    payment_type: string
    payment_missing: boolean
    payment_missing_dates?: string[]
    payment_objective_empty?: boolean
    payment_objective_empty_dates?: string[]
  }
}

type CalculationRunResponse = {
  project_id: number
  project_name: string
  country: string
  total_periods: number
  periods: CalculationPeriod[]
}

const API_BASE = '/api/backend'
const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const REPORT_ROWS = [
  { key: 'business_report', label: '业务报告', getMissing: (a: DataAvailability) => a.business_report_missing },
  { key: 'ad_report', label: '广告报告', getMissing: (a: DataAvailability) => a.ad_report_missing },
  { key: 'inventory', label: '库存报告', getMissing: (a: DataAvailability) => a.inventory_missing },
] as const

function parseDateStr(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function formatDayAbbr(dateStr: string) {
  const d = parseDateStr(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function buildWeekDates(startDate: string, endDate: string): string[] {
  const start = parseDateStr(startDate)
  const end = parseDateStr(endDate)
  const dates: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    dates.push(formatDateInputValue(cur) ?? '')
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

interface AvailabilityGridProps {
  startDate: string
  endDate: string
  availability: DataAvailability
}

function AvailabilityGrid({ startDate, endDate, availability }: AvailabilityGridProps) {
  const dates = useMemo(() => buildWeekDates(startDate, endDate), [startDate, endDate])

  // Build coverage map for each date (with safety checks for API compatibility)
  const coverageMap = useMemo(() => {
    // Single-day data (missing)
    const businessMissingSet = new Set(availability.business_report_missing || [])
    const adMissingSet = new Set(availability.ad_report_missing || [])
    // Periodic only covered (no daily, but has periodic)
    const businessPeriodicOnlySet = new Set(availability.business_periodic_only_missing || [])
    const adPeriodicOnlySet = new Set(availability.ad_periodic_only_missing || [])

    // Payment: compute real periodic coverage and objective-empty dates
    const paymentDailySet = new Set(availability.payment_daily_covered_dates || [])
    const paymentObjectiveEmptySet = new Set(availability.payment_objective_empty_dates || [])
    const paymentPeriodDates = new Set<string>()
    for (const p of availability.payment_periods_overlapping || []) {
      const start = parseDateStr(p.period_start_date)
      const end = parseDateStr(p.period_end_date)
      const cur = new Date(start)
      while (cur <= end) {
        paymentPeriodDates.add(formatDateInputValue(cur) ?? '')
        cur.setDate(cur.getDate() + 1)
      }
    }
    const paymentPeriodicOnlySet = new Set<string>()
    for (const d of dates) {
      if (!paymentDailySet.has(d) && paymentPeriodDates.has(d)) {
        paymentPeriodicOnlySet.add(d)
      }
    }

    return {
      business: {
        hasData: (d: string) => !businessMissingSet.has(d) && !businessPeriodicOnlySet.has(d),
        isPeriodicOnly: (d: string) => businessPeriodicOnlySet.has(d),
        isMissing: (d: string) => businessMissingSet.has(d),
      },
      ad: {
        hasData: (d: string) => !adMissingSet.has(d) && !adPeriodicOnlySet.has(d),
        isPeriodicOnly: (d: string) => adPeriodicOnlySet.has(d),
        isMissing: (d: string) => adMissingSet.has(d),
      },
      payment: {
        hasData: (d: string) => paymentDailySet.has(d),
        isPeriodicOnly: (d: string) => paymentPeriodicOnlySet.has(d),
        isObjectiveEmpty: (d: string) => paymentObjectiveEmptySet.has(d) && !paymentDailySet.has(d) && !paymentPeriodicOnlySet.has(d),
        isMissing: (d: string) => !paymentDailySet.has(d) && !paymentPeriodicOnlySet.has(d) && !paymentObjectiveEmptySet.has(d),
      },
    }
  }, [availability, dates])

  // Inventory missing set
  const inventoryMissingSet = useMemo(
    () => new Set(availability.inventory_missing || []),
    [availability.inventory_missing],
  )

  // Check if any periodic coverage exists (with safety checks for API compatibility)
  const hasPeriodicData = useMemo(() => ({
    business: availability.business_period_info?.length > 0,
    ad: availability.ad_period_info?.length > 0,
    payment: availability.payment_periods_overlapping?.length > 0,
  }), [availability])

  // Check if periodic data covers all dates (for right column indicator)
  const periodicCoversAllDates = useMemo(() => {
    const businessPeriodDates = new Set<string>()
    const adPeriodDates = new Set<string>()
    for (const p of availability.business_period_info || []) {
      for (const d of p.covered_dates || []) {
        businessPeriodDates.add(d)
      }
    }
    for (const p of availability.ad_period_info || []) {
      for (const d of p.covered_dates || []) {
        adPeriodDates.add(d)
      }
    }
    return {
      business: dates.length > 0 && dates.every(d => businessPeriodDates.has(d)),
      ad: dates.length > 0 && dates.every(d => adPeriodDates.has(d)),
    }
  }, [availability, dates])

  const getCellClass = (hasData: boolean, isPeriodicOnly: boolean, isObjectiveEmpty: boolean, isMissing: boolean) => {
    if (hasData) return 'bg-emerald-500'
    if (isPeriodicOnly) return 'bg-blue-500 border-2 border-dashed border-blue-300 dark:border-blue-600'
    if (isObjectiveEmpty) return 'bg-amber-500'
    return 'bg-rose-500'
  }

  const getCellIcon = (hasData: boolean, isPeriodicOnly: boolean, isObjectiveEmpty: boolean, _isMissing: boolean) => {
    if (hasData) return <CheckCircle2 className="h-4 w-4 text-white" />
    if (isPeriodicOnly) return <span className="text-xs text-white">P</span>
    if (isObjectiveEmpty) return <AlertTriangle className="h-4 w-4 text-white" />
    return <XCircle className="h-4 w-4 text-white" />
  }

  const getCellTitle = (label: string, d: string, hasData: boolean, isPeriodicOnly: boolean, isObjectiveEmpty: boolean, isMissing: boolean) => {
    if (hasData) return `${label} ${d} 有单日数据`
    if (isPeriodicOnly) return `${label} ${d} 周期性数据兜底`
    if (isObjectiveEmpty) return `${label} ${d} 已导入，但当日客观无数据`
    return `${label} ${d} 缺少数据`
  }

  return (
    <div className="space-y-3">
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded bg-emerald-500" />
          <span className="text-muted-foreground">单日数据</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded border-2 border-dashed border-blue-400 bg-blue-500" />
          <span className="text-muted-foreground">周期性兜底</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded bg-amber-500" />
          <span className="text-muted-foreground">已导入但客观无数据</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded bg-rose-500" />
          <span className="text-muted-foreground">缺失</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded bg-blue-500" />
          <span className="text-muted-foreground">有周期性数据</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded border border-dashed border-muted-foreground/40" />
          <span className="text-muted-foreground">无周期性数据</span>
        </div>
      </div>

      {/* Grid */}
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[520px]"
          style={{ gridTemplateColumns: `120px repeat(${dates.length}, 1fr) 100px` }}
        >
          {/* Header row */}
          <div className="flex items-center border border-b-0 border-border/60 bg-[hsl(var(--surface-subtle))] px-2 py-2 text-xs font-semibold text-muted-foreground">
            报表类型
          </div>
          {dates.map((d) => {
            const weekdayIdx = (parseDateStr(d).getDay() + 6) % 7 // Mon=0
            return (
              <div
                key={d}
                className="flex flex-col items-center justify-center border border-b-0 border-border/60 bg-[hsl(var(--surface-subtle))] px-1 py-2 text-xs"
              >
                <span className="text-[10px] text-muted-foreground">{WEEKDAY_LABELS[weekdayIdx]}</span>
                <span className="font-medium">{formatDayAbbr(d)}</span>
              </div>
            )
          })}
          {/* Header: Periodic column */}
          <div className="flex items-center justify-center border border-b-0 border-border/60 bg-[hsl(var(--surface-subtle))] px-2 py-2 text-xs font-semibold text-muted-foreground">
            周期性数据
          </div>

          {/* Business Report row */}
          <div className="flex items-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] px-2 py-2.5 text-sm font-medium">
            业务报告
          </div>
          {dates.map((d) => {
            const { hasData, isPeriodicOnly, isMissing } = coverageMap.business
            return (
              <div
                key={d}
                title={getCellTitle('业务报告', d, hasData(d), isPeriodicOnly(d), false, isMissing(d))}
                className={cn(
                  'flex items-center justify-center border border-t-0 border-border/60 py-2.5 transition-colors',
                  getCellClass(hasData(d), isPeriodicOnly(d), false, isMissing(d)),
                )}
              >
                {getCellIcon(hasData(d), isPeriodicOnly(d), false, isMissing(d))}
              </div>
            )
          })}
          {/* Business: Periodic column */}
          <div
            className={cn(
              'flex items-center justify-center border border-t-0 border-border/60 py-2.5 text-xs',
              hasPeriodicData.business ? 'bg-blue-500 text-white' : 'bg-[hsl(var(--surface-panel))] text-muted-foreground border-dashed',
            )}
            title={hasPeriodicData.business
              ? `有周期性数据（覆盖 ${availability.business_period_info.map(p => `${p.period_start_date}~${p.period_end_date}`).join(', ')}）`
              : '无周期性数据'}
          >
            {hasPeriodicData.business ? (
              <div className="flex flex-col items-center">
                <span className="font-medium">{periodicCoversAllDates.business ? '全周期' : '部分'}</span>
                <span className="text-[10px] opacity-80">P</span>
              </div>
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </div>

          {/* Ad Report row */}
          <div className="flex items-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] px-2 py-2.5 text-sm font-medium">
            广告报告
          </div>
          {dates.map((d) => {
            const { hasData, isPeriodicOnly, isMissing } = coverageMap.ad
            return (
              <div
                key={d}
                title={getCellTitle('广告报告', d, hasData(d), isPeriodicOnly(d), false, isMissing(d))}
                className={cn(
                  'flex items-center justify-center border border-t-0 border-border/60 py-2.5 transition-colors',
                  getCellClass(hasData(d), isPeriodicOnly(d), false, isMissing(d)),
                )}
              >
                {getCellIcon(hasData(d), isPeriodicOnly(d), false, isMissing(d))}
              </div>
            )
          })}
          {/* Ad: Periodic column */}
          <div
            className={cn(
              'flex items-center justify-center border border-t-0 border-border/60 py-2.5 text-xs',
              hasPeriodicData.ad ? 'bg-blue-500 text-white' : 'bg-[hsl(var(--surface-panel))] text-muted-foreground border-dashed',
            )}
            title={hasPeriodicData.ad
              ? `有周期性数据（覆盖 ${availability.ad_period_info.map(p => `${p.period_start_date}~${p.period_end_date}`).join(', ')}）`
              : '无周期性数据'}
          >
            {hasPeriodicData.ad ? (
              <div className="flex flex-col items-center">
                <span className="font-medium">{periodicCoversAllDates.ad ? '全周期' : '部分'}</span>
                <span className="text-[10px] opacity-80">P</span>
              </div>
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </div>

          {/* Inventory Report row */}
          <div className="flex items-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] px-2 py-2.5 text-sm font-medium">
            库存报告
          </div>
          {dates.map((d) => {
            const isMissing = inventoryMissingSet.has(d)
            return (
              <div
                key={d}
                title={isMissing ? `库存报告 缺少 ${d}` : `库存报告 ${d} 有数据`}
                className={cn(
                  'flex items-center justify-center border border-t-0 border-border/60 py-2.5 transition-colors',
                  isMissing ? 'bg-rose-500' : 'bg-emerald-500',
                )}
              >
                {isMissing ? (
                  <XCircle className="h-4 w-4 text-white" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-white" />
                )}
              </div>
            )
          })}
          {/* Inventory: N/A */}
          <div className="flex items-center justify-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] py-2.5 text-xs text-muted-foreground border-dashed">
            -
          </div>

          {/* Payment report row */}
          <div className="flex items-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] px-2 py-2.5 text-sm font-medium">
            付款报告
          </div>
          {dates.map((d) => {
            const { hasData, isPeriodicOnly, isObjectiveEmpty, isMissing } = coverageMap.payment
            return (
              <div
                key={d}
                title={getCellTitle('付款报告', d, hasData(d), isPeriodicOnly(d), isObjectiveEmpty(d), isMissing(d))}
                className={cn(
                  'flex items-center justify-center border border-t-0 border-border/60 py-2.5 transition-colors',
                  getCellClass(hasData(d), isPeriodicOnly(d), isObjectiveEmpty(d), isMissing(d)),
                )}
              >
                {getCellIcon(hasData(d), isPeriodicOnly(d), isObjectiveEmpty(d), isMissing(d))}
              </div>
            )
          })}
          {/* Payment: Periodic column */}
          <div
            className={cn(
              'flex items-center justify-center border border-t-0 border-border/60 py-2.5 text-xs',
              hasPeriodicData.payment ? 'bg-blue-500 text-white' : 'bg-[hsl(var(--surface-panel))] text-muted-foreground border-dashed',
            )}
            title={hasPeriodicData.payment
              ? `有周期性数据（覆盖 ${availability.payment_periods_overlapping.map(p => `${p.period_start_date}~${p.period_end_date}`).join(', ')}）`
              : '无周期性数据'}
          >
            {hasPeriodicData.payment ? (
              <div className="flex flex-col items-center">
                <span className="font-medium">{availability.payment_full_period_covered ? '全周期' : '部分'}</span>
                <span className="text-[10px] opacity-80">P</span>
              </div>
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function getLastWeekRange() {
  const now = new Date()
  const day = now.getDay()
  const distanceToCurrentMonday = day === 0 ? 6 : day - 1
  const currentMonday = new Date(now)
  currentMonday.setDate(now.getDate() - distanceToCurrentMonday)
  const lastWeekMonday = new Date(currentMonday)
  lastWeekMonday.setDate(currentMonday.getDate() - 7)
  const lastWeekSunday = new Date(lastWeekMonday)
  lastWeekSunday.setDate(lastWeekMonday.getDate() + 6)
  return {
    start: formatDateInputValue(lastWeekMonday) ?? '',
    end: formatDateInputValue(lastWeekSunday) ?? '',
  }
}

function formatNumber(value: unknown, fractionDigits = 2): string {
  if (value === null || value === undefined) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return num.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

function formatPercent(value: unknown): string {
  if (value === null || value === undefined) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return `${(num * 100).toFixed(1)}%`
}

const SUMMARY_DISPLAY_COLUMNS = [
  { key: '总销售额', label: '总销售额', fmt: 'currency' as const },
  { key: '总销量', label: '总销量' },
  { key: '实际销售额', label: '实际销售额', fmt: 'currency' as const },
  { key: '利润', label: '利润', fmt: 'currency' as const },
  { key: '利润率', label: '利润率', fmt: 'percent' as const },
  { key: '广告花费', label: '广告花费', fmt: 'currency' as const },
  { key: 'ACOS', label: 'ACOS', fmt: 'percent' as const },
  { key: 'CPC', label: 'CPC', fmt: 'currency' as const },
  { key: '页面浏览量', label: '页面浏览量' },
  { key: '总访客', label: '总访客' },
  { key: '总转化', label: '总转化', fmt: 'percent' as const },
]

const DETAIL_DISPLAY_COLUMNS = [
  { key: 'SKU', label: 'SKU' },
  { key: 'ASIN', label: 'ASIN' },
  { key: '总销量', label: '总销量' },
  { key: '总销售额', label: '总销售额', fmt: 'currency' as const },
  { key: '广告花费', label: '广告花费', fmt: 'currency' as const },
  { key: '广告销售额', label: '广告销售额', fmt: 'currency' as const },
  { key: 'ACOS', label: 'ACOS', fmt: 'percent' as const },
  { key: '利润', label: '利润', fmt: 'currency' as const },
  { key: '利润率', label: '利润率', fmt: 'percent' as const },
]

// --- Excel export column definitions (match Weekly Product Analysis format) ---

const EXPORT_SUMMARY_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
  },
  {
    title: '推广流量',
    columns: [
      '广告展示量', '广告点击量', '广告点击率', '广告订单量', '广告单占比',
      '广告转化率', '广告花费', '广告销售额', 'CPC', 'ACOS', 'SP占比',
    ],
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
  },
  {
    title: '费用占比',
    columns: [
      '产品FOB', '成本占比', '销售头程', '头程占比', 'FBA配送费', '配送费占比',
      '平台佣金', '佣金占比', '总成本', '总成本占比',
    ],
  },
  {
    title: '财务结算',
    columns: [
      '实际销售额', '实际销售量', '实际退款额', '实际退款量',
      '平均售价', '退款率', '利润', '利润率',
    ],
  },
] as const

const EXPORT_SUMMARY_COLUMNS = EXPORT_SUMMARY_COLUMN_GROUPS.flatMap((g) => g.columns)
const EXPORT_SUMMARY_COLUMN_SET = new Set<string>(EXPORT_SUMMARY_COLUMNS)

const EXPORT_DETAIL_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
  },
  {
    title: '库存',
    columns: ['库存'],
  },
  {
    title: '推广流量',
    columns: [
      '广告展示量', '广告点击量', '广告点击率', '广告订单量', '广告单占比',
      '广告转化率', '广告花费', '广告销售额', 'CPC', 'ACOS', 'SP占比',
    ],
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
  },
  {
    title: '费用占比',
    columns: [
      '产品FOB', '成本占比', '销售头程', '头程占比', 'FBA配送费', '配送费占比',
      '平台佣金', '佣金占比', '总成本', '总成本占比',
    ],
  },
  {
    title: '财务结算',
    columns: [
      '实际销售额', '实际销售量', '实际退款额', '实际退款量',
      '平均售价', '退款率', '利润', '利润率',
    ],
  },
] as const

const EXPORT_DETAIL_COLUMNS = ['日期', 'SKU', ...EXPORT_DETAIL_COLUMN_GROUPS.flatMap((g) => g.columns)]

const EXPORT_PERCENT_COLUMNS = new Set([
  '总转化', '广告点击率', '广告单占比', '广告转化率',
  'ACOS', 'SP占比', '自然流量占比', '自然单转化',
  '成本占比', '头程占比', '配送费占比', '佣金占比',
  '总成本占比', '利润率', '退款率',
])

const EXPORT_CURRENCY_COLUMNS = new Set([
  '总销售额', '广告花费', '广告销售额', 'CPC',
  '产品FOB', '销售头程', 'FBA配送费', '平台佣金',
  '总成本', '利润', '实际销售额', '实际退款额', '平均售价',
])

const EXPORT_INTEGER_COLUMNS = new Set([
  '总销量', '页面浏览量', '总访客', '广告展示量', '广告点击量',
  '广告订单量', '自然流量', '自然单', '实际销售量', '实际退款量',
])

const GROUP_COLORS: Record<string, string> = {
  '销售': 'FFDCEEFF',
  '推广流量': 'FFFFE6D5',
  '自然流量': 'FFDDF7EA',
  '费用占比': 'FFFCE7C3',
  '库存': 'FFF1F5F9',
  '财务结算': 'FFEADFEE',
}

function toExportNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  const text = String(value).replace(/,/g, '')
  const num = Number(text)
  return Number.isFinite(num) ? num : 0
}

function getExportNumberFormat(column: string, targetCountry: CountryOption = 'US'): string | null {
  if (EXPORT_PERCENT_COLUMNS.has(column)) return '0.00%'
  if (EXPORT_CURRENCY_COLUMNS.has(column)) return CURRENCY_CONFIG[targetCountry].excelFmt
  if (EXPORT_INTEGER_COLUMNS.has(column)) return '#,##0'
  return null
}

function getExportCellValue(column: string, value: unknown): string | number {
  if (value === null || value === undefined) return '-'
  const isNumeric =
    typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.replace(/,/g, ''))))
  if ((EXPORT_SUMMARY_COLUMN_SET.has(column) || column === '库存') && isNumeric) {
    return toExportNumber(value)
  }
  return String(value)
}

function applyCellBorder(cell: import('exceljs').Cell, color = 'FFE2E8F0') {
  cell.border = {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  }
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
            ? raw.richText.map((item: { text: string }) => item.text).join('')
            : String(raw)
      maxLength = Math.max(maxLength, Math.min(text.length + 4, 18))
    })
    column.width = maxLength
  })
}

function getISOWeek(dateStr: string): string {
  const date = new Date(dateStr)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`
}

interface ProductCalculationPanelProps {
  session: ReturnType<typeof useSession>['data']
}

export default function ProductCalculationPanel({ session }: ProductCalculationPanelProps) {
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (
    session?.user?.operatorNameZh ||
    session?.user?.name ||
    session?.user?.email ||
    session?.user?.id ||
    ''
  ).trim()

  const initialDateRange = getLastWeekRange()

  // Projects
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  // Filters
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(initialDateRange.start)
  const [endDate, setEndDate] = useState(initialDateRange.end)

  // Check
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [availability, setAvailability] = useState<DataAvailability | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  // Run
  const [runState, setRunState] = useState<RunState>('idle')
  const [periods, setPeriods] = useState<CalculationPeriod[]>([])
  const [runError, setRunError] = useState<string | null>(null)

  // UI
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(data as ProjectOption[])
      } catch (error) {
        setProjectLoadError(normalizeErrorMessage(error, '项目列表加载失败'))
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  const selectedProject = useMemo(
    () => projects.find((p) => p.name === selectedProjectName),
    [projects, selectedProjectName],
  )

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate
  const canCheck =
    Boolean(selectedProject?.id) && dateRangeValid && checkState !== 'checking'

  const authHeaders: Record<string, string> = {}
  if (isAdmin) authHeaders['X-Is-Admin'] = 'true'

  async function handleCheck() {
    if (!selectedProject?.id) return
    setCheckState('checking')
    setCheckError(null)
    setAvailability(null)
    setRunState('idle')
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '检查数据失败' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : '检查数据失败')
      }

      const data: DataAvailability = await res.json()
      setAvailability(data)
      setCheckState('done')
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : '检查数据失败')
      setCheckState('error')
    }
  }

  async function handleRun() {
    if (!selectedProject?.id) return
    setRunState('running')
    setRunError(null)
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
          current_only: true,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '执行核算失败' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : '执行核算失败')
      }

      const data: CalculationRunResponse = await res.json()
      setPeriods(data.periods || [])
      setRunState('done')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : '执行核算失败')
      setRunState('error')
    }
  }

  async function handleExport() {
    if (periods.length === 0) return

    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    wb.creator = 'BelieveBoy'
    wb.created = new Date()

    const projectLabel = selectedProjectName || '未知项目'

    // ===== Sheet 1: 汇总 =====
    const summarySheet = wb.addWorksheet('汇总', {
      views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
    })
    const lastCol = EXPORT_SUMMARY_COLUMNS.length + 2

    summarySheet.mergeCells(1, 1, 1, lastCol)
    summarySheet.getCell(1, 1).value = '产品核算 - 汇总'
    summarySheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
    summarySheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

    summarySheet.mergeCells(2, 1, 2, lastCol)
    summarySheet.getCell(2, 1).value = `店铺：${projectLabel}    站点：${country}    日期：${startDate} 至 ${endDate}`
    summarySheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
    summarySheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

    const groupRow = summarySheet.getRow(4)
    const headRow = summarySheet.getRow(5)
    summarySheet.mergeCells(4, 1, 5, 1)
    summarySheet.mergeCells(4, 2, 5, 2)
    groupRow.getCell(1).value = '周次'
    groupRow.getCell(2).value = '日期范围'

    let col = 3
    EXPORT_SUMMARY_COLUMN_GROUPS.forEach((group) => {
      const start = col
      group.columns.forEach((column) => {
        headRow.getCell(col).value = column
        col += 1
      })
      summarySheet.mergeCells(4, start, 4, col - 1)
      const gc = groupRow.getCell(start)
      gc.value = group.title
      gc.alignment = { vertical: 'middle', horizontal: 'center' }
      gc.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
      gc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_COLORS[group.title] || 'FFE2E8F0' } }
      applyCellBorder(gc)
    })
    ;[groupRow, headRow].forEach((row) => {
      row.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        if (!cell.fill || !('fgColor' in cell.fill)) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        }
        applyCellBorder(cell, 'FFCBD5E1')
      })
    })

    let rowIdx = 6
    periods.forEach((period) => {
      const row = summarySheet.getRow(rowIdx)
      const weekLabel = getISOWeek(period.report_start_date)
      row.getCell(1).value = period.is_partial ? `${weekLabel} *` : weekLabel
      row.getCell(2).value = `${period.report_start_date} 至 ${period.report_end_date}`
      EXPORT_SUMMARY_COLUMNS.forEach((column, idx) => {
        const cell = row.getCell(idx + 3)
        const val = getExportCellValue(column, period.summary[column])
        cell.value = val
        cell.alignment = { vertical: 'middle', horizontal: typeof val === 'number' ? 'right' : 'left' }
        const numFmt = getExportNumberFormat(column, country)
        if (typeof val === 'number' && numFmt) cell.numFmt = numFmt
        applyCellBorder(cell)
        if (period.is_partial) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
        }
      })
      row.getCell(1).font = { name: 'Microsoft YaHei', bold: true, color: period.is_partial ? { argb: 'FFB45309' } : { argb: 'FF0F172A' } }
      row.getCell(2).font = { name: 'Microsoft YaHei' }
      applyCellBorder(row.getCell(1))
      applyCellBorder(row.getCell(2))
      if (period.is_partial) {
        row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
        row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
      }
      rowIdx += 1
    })

    // Totals row
    const totalRow = summarySheet.getRow(rowIdx)
    totalRow.getCell(1).value = '合计'
    totalRow.getCell(2).value = `${periods.length} 周期`
    EXPORT_SUMMARY_COLUMNS.forEach((column, idx) => {
      const cell = totalRow.getCell(idx + 3)
      const sum = periods.reduce((acc, p) => acc + toExportNumber(p.summary[column]), 0)
      cell.value = sum
      cell.alignment = { vertical: 'middle', horizontal: 'right' }
      const numFmt = getExportNumberFormat(column, country)
      if (numFmt) cell.numFmt = numFmt
      cell.font = { name: 'Microsoft YaHei', bold: true, color: column === '利润' || column === '利润率' ? { argb: 'FF047857' } : { argb: 'FF0F172A' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
      applyCellBorder(cell, 'FFCBD5E1')
    })
    ;[1, 2].forEach((c) => {
      const cell = totalRow.getCell(c)
      cell.font = { name: 'Microsoft YaHei', bold: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
      applyCellBorder(cell, 'FFCBD5E1')
    })

    // Note row
    const hasPartial = periods.some((p) => p.is_partial)
    if (hasPartial) {
      rowIdx += 1
      summarySheet.mergeCells(rowIdx, 1, rowIdx, lastCol)
      const noteCell = summarySheet.getCell(rowIdx, 1)
      noteCell.value = '* 黄色背景标记：该周期数据不完整，仅供参考'
      noteCell.font = { name: 'Microsoft YaHei', size: 9, italic: true, color: { argb: 'FFB45309' } }
      noteCell.alignment = { vertical: 'middle', horizontal: 'left' }
    }

    summarySheet.columns = [
      { width: 12 }, { width: 24 },
      ...EXPORT_SUMMARY_COLUMNS.map((col) => ({
        width: EXPORT_PERCENT_COLUMNS.has(col) ? 12 : EXPORT_CURRENCY_COLUMNS.has(col) ? 14 : 12,
      })),
    ]

    // ===== Sheet 2: SKU明细 =====
    const allDetailRows: Array<{ periodLabel: string; row: Record<string, unknown> }> = []
    periods.forEach((period) => {
      const periodLabel = `${period.report_start_date} ~ ${period.report_end_date}`
      period.details.forEach((detail) => {
        allDetailRows.push({ periodLabel, row: { ...detail, '日期': period.report_end_date } })
      })
    })

    const detailSheet = wb.addWorksheet('SKU明细', {
      views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
    })
    const dLastCol = EXPORT_DETAIL_COLUMNS.length

    detailSheet.mergeCells(1, 1, 1, dLastCol)
    detailSheet.getCell(1, 1).value = '产品核算 - SKU明细'
    detailSheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
    detailSheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

    detailSheet.mergeCells(2, 1, 2, dLastCol)
    detailSheet.getCell(2, 1).value = `店铺：${projectLabel}    站点：${country}    日期：${startDate} 至 ${endDate}`
    detailSheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
    detailSheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

    const dGroupRow = detailSheet.getRow(4)
    const dHeadRow = detailSheet.getRow(5)
    detailSheet.mergeCells(4, 1, 5, 1)
    dGroupRow.getCell(1).value = '日期'
    detailSheet.mergeCells(4, 2, 5, 2)
    dGroupRow.getCell(2).value = 'SKU'

    let dCol = 3
    EXPORT_DETAIL_COLUMN_GROUPS.forEach((group) => {
      const start = dCol
      group.columns.forEach((column) => {
        dHeadRow.getCell(dCol).value = column
        dCol += 1
      })
      detailSheet.mergeCells(4, start, 4, dCol - 1)
      const gc = dGroupRow.getCell(start)
      gc.value = group.title
      gc.alignment = { vertical: 'middle', horizontal: 'center' }
      gc.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
      gc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_COLORS[group.title] || 'FFE2E8F0' } }
      applyCellBorder(gc)
    })
    ;[dGroupRow, dHeadRow].forEach((row) => {
      row.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        if (!cell.fill || !('fgColor' in cell.fill)) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        }
        applyCellBorder(cell, 'FFCBD5E1')
      })
    })

    let dRowIdx = 6
    let currentPeriodLabel = ''
    periods.forEach((period) => {
      const periodLabel = `${period.report_start_date} ~ ${period.report_end_date}`
      // Period separator row
      if (periodLabel !== currentPeriodLabel && periods.length > 1) {
        const sepRow = detailSheet.getRow(dRowIdx)
        detailSheet.mergeCells(dRowIdx, 1, dRowIdx, dLastCol)
        sepRow.getCell(1).value = `周期: ${periodLabel}${period.is_partial ? ' (数据不完整)' : ''}`
        sepRow.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F766E' } }
        sepRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }
        sepRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' }
        dRowIdx += 1
        currentPeriodLabel = periodLabel
      }

      period.details.forEach((detail) => {
        const row = detailSheet.getRow(dRowIdx)
        EXPORT_DETAIL_COLUMNS.forEach((column, idx) => {
          const cell = row.getCell(idx + 1)
          let val: string | number = ''
          if (column === '日期') {
            val = period.report_end_date
          } else if (column === 'SKU') {
            val = String(detail['SKU'] ?? '')
          } else {
            val = getExportCellValue(column, detail[column])
          }
          ;(cell.value as import('exceljs').CellValue) = val
          cell.alignment = {
            vertical: 'middle',
            horizontal: column === '日期' || column === 'SKU' || typeof val !== 'number' ? 'left' : 'right',
          }
          const numFmt = getExportNumberFormat(column, country)
          if (typeof val === 'number' && numFmt) cell.numFmt = numFmt
          applyCellBorder(cell)
        })
        dRowIdx += 1
      })

      // Period summary row
      const summaryExcelRow = detailSheet.getRow(dRowIdx)
      EXPORT_DETAIL_COLUMNS.forEach((column, idx) => {
        const cell = summaryExcelRow.getCell(idx + 1)
        if (column === '日期') cell.value = period.report_end_date
        else if (column === 'SKU') cell.value = '汇总'
        else {
          const val = getExportCellValue(column, period.summary[column])
          cell.value = val
          const numFmt = getExportNumberFormat(column, country)
          if (typeof val === 'number' && numFmt) cell.numFmt = numFmt
        }
        cell.font = { name: 'Microsoft YaHei', bold: true }
        cell.alignment = { vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'right' : 'left' }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }
        applyCellBorder(cell)
      })
      dRowIdx += 1

      // Blank spacer
      dRowIdx += 1
    })

    detailSheet.columns = EXPORT_DETAIL_COLUMNS.map((col) => ({
      width: col === '日期' ? 14 : col === 'SKU' ? 22 : EXPORT_PERCENT_COLUMNS.has(col) ? 12 : EXPORT_CURRENCY_COLUMNS.has(col) ? 14 : 12,
    }))
    autosizeWorksheetColumns(detailSheet)

    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `产品核算-${selectedProjectName}-${country}-${startDate}~${endDate}.xlsx`
    link.click()
    URL.revokeObjectURL(url)
  }

  function renderCell(value: unknown, fmt?: 'percent' | 'currency') {
    if (value === null || value === undefined) return <span className="text-muted-foreground">-</span>
    if (fmt === 'percent') return <span>{formatPercent(value)}</span>
    if (fmt === 'currency') {
      const sym = CURRENCY_CONFIG[country].symbol
      return <span>{sym}{formatNumber(value)}</span>
    }
    return <span>{formatNumber(value)}</span>
  }

  const detailColCount = DETAIL_DISPLAY_COLUMNS.length

  return (
    <div className="space-y-4">
      {/* Filter Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">核算参数</CardTitle>
          <CardDescription className="text-xs">
            选择项目、站点和日期范围，系统将检查数据完整性后执行核算。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {/* Project */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                项目
              </label>
              <Select
                value={selectedProjectName}
                onValueChange={(value) => {
                  setSelectedProjectName(value)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                  setExpandedIndex(null)
                }}
                disabled={projectsLoading || projects.length === 0}
              >
                <SelectTrigger className="h-10 max-w-full">
                  <SelectValue
                    placeholder={
                      projectsLoading
                        ? '项目加载中...'
                        : projectLoadError
                          ? projectLoadError
                          : projects.length
                            ? '请选择项目'
                            : '暂无可选项目'
                    }
                  />
                </SelectTrigger>
                <SelectContent className="max-h-64 overflow-y-auto">
                  {projects.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Country */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                站点
              </label>
              <Select value={country} onValueChange={(value) => setCountry(value as CountryOption)}>
                <SelectTrigger className="h-10 max-w-full">
                  <SelectValue placeholder="请选择站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date Range */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                日期范围
              </label>
              <DateRangePicker
                value={parseDateRangeInputValue(startDate, endDate)}
                onChange={(range) => {
                  setStartDate(formatDateInputValue(range?.from) ?? startDate)
                  setEndDate(formatDateInputValue(range?.to) ?? endDate)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
                className="h-10"
              />
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCheck()}
              disabled={!canCheck}
            >
              {checkState === 'checking' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              检查数据
            </Button>

            <Button
              size="sm"
              onClick={() => void handleRun()}
              disabled={
                checkState !== 'done' ||
                !availability ||
                !availability.has_minimum_data ||
                runState === 'running'
              }
            >
              {runState === 'running' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              执行核算
            </Button>
          </div>

          {checkError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {checkError}
            </div>
          )}

          {runError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {runError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data Availability */}
      {availability && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">数据可用性</CardTitle>
            <CardDescription className="text-xs">
              {startDate} — {endDate}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Grid table */}
            <AvailabilityGrid
              startDate={startDate}
              endDate={endDate}
              availability={availability}
            />

            {/* Minimum Data Summary */}
            <div className="flex items-center gap-2 border-t border-[hsl(var(--border))] pt-2.5">
              {availability.has_minimum_data ? (
                <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" />
                  可执行核算
                  {availability.weekly_availability?.some((w) => w.is_partial) && (
                    <span className="ml-1 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-sm font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                      <AlertTriangle className="h-4 w-4" />
                      部分周数据不完整
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-sm font-medium text-rose-600 dark:text-rose-300">
                  <XCircle className="h-4 w-4" />
                  数据不足，无法执行核算（缺少核心报表数据）
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {runState === 'done' && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">核算结果</CardTitle>
                <CardDescription className="text-xs">
                  共 {periods.length} 个周期
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleExport()}
                disabled={periods.length === 0}
              >
                <Download className="mr-1 h-4 w-4" />
                导出 Excel
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {periods.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                无核算数据
              </div>
            ) : (
              <div className="space-y-3">
                {periods.map((period, idx) => {
                  const isExpanded = expandedIndex === idx
                  return (
                    <div key={idx} className="space-y-1">
                      {/* Summary row */}
                      <div
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                          isExpanded
                            ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/30'
                            : 'hover:bg-muted/30'
                        }`}
                        onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            setExpandedIndex(isExpanded ? null : idx)
                          }
                        }}
                      >
                        <button
                          className="rounded p-0.5 hover:bg-accent shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpandedIndex(isExpanded ? null : idx)
                          }}
                          title={isExpanded ? '收起明细' : '展开明细'}
                        >
                          {isExpanded ? (
                            <ArrowUp className="h-4 w-4" />
                          ) : (
                            <ArrowDown className="h-4 w-4" />
                          )}
                        </button>

                        <span className="shrink-0 font-medium text-sm">
                          {period.report_start_date} ~ {period.report_end_date}
                          {period.persisted && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              已写入PT1
                            </span>
                          )}
                          {period.is_partial && period.completeness && (
                            <span
                              className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium leading-none text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                              title={`数据不完整：业务报告 ${period.completeness.available_business_days}/${period.completeness.total_days} 天，广告报告 ${period.completeness.available_ad_days}/${period.completeness.total_days} 天${period.completeness.payment_missing ? '，缺少付款数据' : ''}`}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              {period.completeness.available_business_days}/{period.completeness.total_days}天
                            </span>
                          )}
                        </span>

                        <span className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
                          <span>总销售额: {renderCell(period.summary['总销售额'])}</span>
                          <span>利润: {renderCell(period.summary['利润'])}</span>
                          <span>利润率: {renderCell(period.summary['利润率'], 'percent')}</span>
                          <span>ACOS: {renderCell(period.summary['ACOS'], 'percent')}</span>
                        </span>
                      </div>

                      {/* Detail table */}
                      {isExpanded && (
                        <div className="overflow-x-auto rounded-md border">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b bg-muted/50">
                                {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                  <th
                                    key={col.key}
                                    className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                                  >
                                    {col.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {period.details.length === 0 ? (
                                <tr>
                                  <td
                                    colSpan={detailColCount}
                                    className="px-3 py-4 text-center text-muted-foreground"
                                  >
                                    无 SKU 明细
                                  </td>
                                </tr>
                              ) : (
                                period.details.map((detail, dIdx) => (
                                  <tr
                                    key={dIdx}
                                    className="border-b border-[hsl(var(--border))] hover:bg-muted/20"
                                  >
                                    {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                      <td
                                        key={col.key}
                                        className="px-3 py-1.5 text-right whitespace-nowrap"
                                      >
                                        {renderCell(detail[col.key], col.fmt)}
                                      </td>
                                    ))}
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
