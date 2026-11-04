'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  XCircle,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { formatDateInputValue } from '@/components/ui/date-picker'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { pickSessionDisplayName } from '@/lib/auth/display-name'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { exportProductAnalysisToExcel } from '@/lib/product-analysis-export'
import styles from '../product-analysis-warm.module.css'

type CountryOption = 'US' | 'DE' | 'UK'

// Currency configuration by country
const CURRENCY_CONFIG: Record<CountryOption, { symbol: string; excelFmt: string }> = {
  US: { symbol: '$', excelFmt: '$#,##0.00;[Red]-$#,##0.00' },
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
  {
    key: 'business_report',
    label: '业务报告',
    getMissing: (a: DataAvailability) => a.business_report_missing,
  },
  { key: 'ad_report', label: '广告报告', getMissing: (a: DataAvailability) => a.ad_report_missing },
  { key: 'inventory', label: '库存报告', getMissing: (a: DataAvailability) => a.inventory_missing },
] as const

function WarmPanel({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={styles.panel} aria-label={title} data-warm-panel="true">
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
        {actions ? <div className={styles.panelActions}>{actions}</div> : null}
      </header>
      <div className={styles.panelBody}>{children}</div>
    </section>
  )
}

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
        isObjectiveEmpty: (d: string) =>
          paymentObjectiveEmptySet.has(d) &&
          !paymentDailySet.has(d) &&
          !paymentPeriodicOnlySet.has(d),
        isMissing: (d: string) =>
          !paymentDailySet.has(d) &&
          !paymentPeriodicOnlySet.has(d) &&
          !paymentObjectiveEmptySet.has(d),
      },
    }
  }, [availability, dates])

  // Inventory missing set
  const inventoryMissingSet = useMemo(
    () => new Set(availability.inventory_missing || []),
    [availability.inventory_missing]
  )

  // Check if any periodic coverage exists (with safety checks for API compatibility)
  const hasPeriodicData = useMemo(
    () => ({
      business: availability.business_period_info?.length > 0,
      ad: availability.ad_period_info?.length > 0,
      payment: availability.payment_periods_overlapping?.length > 0,
    }),
    [availability]
  )

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
      business: dates.length > 0 && dates.every((d) => businessPeriodDates.has(d)),
      ad: dates.length > 0 && dates.every((d) => adPeriodDates.has(d)),
    }
  }, [availability, dates])

  const getCellStatus = (
    hasData: boolean,
    isPeriodicOnly: boolean,
    isObjectiveEmpty: boolean,
    isMissing: boolean
  ) => {
    if (hasData) return 'available'
    if (isPeriodicOnly) return 'periodic'
    if (isObjectiveEmpty) return 'objective-empty'
    if (isMissing) return 'missing'
    return 'empty'
  }

  const getCellIcon = (
    hasData: boolean,
    isPeriodicOnly: boolean,
    isObjectiveEmpty: boolean,
    _isMissing: boolean
  ) => {
    if (hasData) return <CheckCircle2 aria-hidden />
    if (isPeriodicOnly) return <span aria-hidden>P</span>
    if (isObjectiveEmpty) return <AlertTriangle aria-hidden />
    return <XCircle aria-hidden />
  }

  const getCellTitle = (
    label: string,
    d: string,
    hasData: boolean,
    isPeriodicOnly: boolean,
    isObjectiveEmpty: boolean,
    isMissing: boolean
  ) => {
    if (hasData) return `${label} ${d} 有单日数据`
    if (isPeriodicOnly) return `${label} ${d} 周期性数据兜底`
    if (isObjectiveEmpty) return `${label} ${d} 已导入，但当日客观无数据`
    return `${label} ${d} 缺少数据`
  }

  return (
    <div className={styles.availability}>
      <div className={styles.legend} aria-label="数据可用性图例">
        {[
          ['available', '单日数据'],
          ['periodic', '周期性兜底'],
          ['objective-empty', '已导入但客观无数据'],
          ['missing', '缺失'],
          ['full-periodic', '有周期性数据'],
          ['no-periodic', '无周期性数据'],
        ].map(([tone, label]) => (
          <span key={tone} className={styles.legendItem}>
            <span className={styles.legendSwatch} data-tone={tone} aria-hidden />
            {label}
          </span>
        ))}
      </div>

      <div className={styles.availabilityScroller}>
        <div
          className={styles.availabilityGrid}
          style={{ gridTemplateColumns: `120px repeat(${dates.length}, 1fr) 100px` }}
        >
          <div className={styles.availabilityHead} data-align="start">
            报表类型
          </div>
          {dates.map((d) => {
            const weekdayIdx = (parseDateStr(d).getDay() + 6) % 7
            return (
              <div key={d} className={styles.availabilityHead}>
                <span>{WEEKDAY_LABELS[weekdayIdx]}</span>
                <span>{formatDayAbbr(d)}</span>
              </div>
            )
          })}
          <div className={styles.availabilityHead}>周期性数据</div>

          <div className={styles.availabilityRowLabel}>业务报告</div>
          {dates.map((d) => {
            const { hasData, isPeriodicOnly, isMissing } = coverageMap.business
            const status = getCellStatus(hasData(d), isPeriodicOnly(d), false, isMissing(d))
            return (
              <div
                key={d}
                title={getCellTitle(
                  '业务报告',
                  d,
                  hasData(d),
                  isPeriodicOnly(d),
                  false,
                  isMissing(d)
                )}
                className={styles.availabilityCell}
                data-status={status}
              >
                {getCellIcon(hasData(d), isPeriodicOnly(d), false, isMissing(d))}
              </div>
            )
          })}
          <div
            className={styles.availabilityCell}
            data-status={hasPeriodicData.business ? 'periodic' : 'empty'}
            title={
              hasPeriodicData.business
                ? `有周期性数据（覆盖 ${availability.business_period_info.map((p) => `${p.period_start_date}~${p.period_end_date}`).join(', ')}）`
                : '无周期性数据'
            }
          >
            {hasPeriodicData.business
              ? `${periodicCoversAllDates.business ? '全周期' : '部分'} · P`
              : '-'}
          </div>

          <div className={styles.availabilityRowLabel}>广告报告</div>
          {dates.map((d) => {
            const { hasData, isPeriodicOnly, isMissing } = coverageMap.ad
            const status = getCellStatus(hasData(d), isPeriodicOnly(d), false, isMissing(d))
            return (
              <div
                key={d}
                title={getCellTitle(
                  '广告报告',
                  d,
                  hasData(d),
                  isPeriodicOnly(d),
                  false,
                  isMissing(d)
                )}
                className={styles.availabilityCell}
                data-status={status}
              >
                {getCellIcon(hasData(d), isPeriodicOnly(d), false, isMissing(d))}
              </div>
            )
          })}
          <div
            className={styles.availabilityCell}
            data-status={hasPeriodicData.ad ? 'periodic' : 'empty'}
            title={
              hasPeriodicData.ad
                ? `有周期性数据（覆盖 ${availability.ad_period_info.map((p) => `${p.period_start_date}~${p.period_end_date}`).join(', ')}）`
                : '无周期性数据'
            }
          >
            {hasPeriodicData.ad ? `${periodicCoversAllDates.ad ? '全周期' : '部分'} · P` : '-'}
          </div>

          <div className={styles.availabilityRowLabel}>库存报告</div>
          {dates.map((d) => {
            const isMissing = inventoryMissingSet.has(d)
            return (
              <div
                key={d}
                title={isMissing ? `库存报告 缺少 ${d}` : `库存报告 ${d} 有数据`}
                className={styles.availabilityCell}
                data-status={isMissing ? 'missing' : 'available'}
              >
                {isMissing ? <XCircle aria-hidden /> : <CheckCircle2 aria-hidden />}
              </div>
            )
          })}
          <div className={styles.availabilityCell} data-status="empty">
            -
          </div>

          <div className={styles.availabilityRowLabel}>付款报告</div>
          {dates.map((d) => {
            const { hasData, isPeriodicOnly, isObjectiveEmpty, isMissing } = coverageMap.payment
            const status = getCellStatus(
              hasData(d),
              isPeriodicOnly(d),
              isObjectiveEmpty(d),
              isMissing(d)
            )
            return (
              <div
                key={d}
                title={getCellTitle(
                  '付款报告',
                  d,
                  hasData(d),
                  isPeriodicOnly(d),
                  isObjectiveEmpty(d),
                  isMissing(d)
                )}
                className={styles.availabilityCell}
                data-status={status}
              >
                {getCellIcon(hasData(d), isPeriodicOnly(d), isObjectiveEmpty(d), isMissing(d))}
              </div>
            )
          })}
          <div
            className={styles.availabilityCell}
            data-status={hasPeriodicData.payment ? 'periodic' : 'empty'}
            title={
              hasPeriodicData.payment
                ? `有周期性数据（覆盖 ${availability.payment_periods_overlapping.map((p) => `${p.period_start_date}~${p.period_end_date}`).join(', ')}）`
                : '无周期性数据'
            }
          >
            {hasPeriodicData.payment
              ? `${availability.payment_full_period_covered ? '全周期' : '部分'} · P`
              : '-'}
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

interface ProductAnalysisPanelProps {
  session: ReturnType<typeof useSession>['data']
}

export default function ProductAnalysisPanel({ session }: ProductAnalysisPanelProps) {
  const isAdmin = Boolean(session?.user?.isAdmin)
  // BLF-1441：操作人只取 user_accounts.full_name（无姓名时为空，
  // 不回落运营名 / 登录名 / 邮箱）。规则见 lib/auth/display-name.ts。
  const currentOperator = pickSessionDisplayName(session?.user) ?? ''

  const initialDateRange = getLastWeekRange()

  // Projects
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsRefreshing, setProjectsRefreshing] = useState(false)
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

  const refreshProjects = useCallback(async (force = false) => {
    if (force) setProjectsRefreshing(true)
    else setProjectsLoading(true)
    setProjectLoadError(null)
    try {
      const data = await fetchManagedProjectsCached<ProjectOption[]>(session, false, { force })
      setProjects(data as ProjectOption[])
      setSelectedProjectName((current) =>
        data.some((project) => project.name === current) ? current : data[0]?.name ?? ''
      )
    } catch (error) {
      setProjectLoadError(normalizeErrorMessage(error, '项目列表加载失败'))
    } finally {
      setProjectsLoading(false)
      setProjectsRefreshing(false)
    }
  }, [session])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])
  useHeaderRefresh(() => refreshProjects(true), { loading: projectsRefreshing })

  const selectedProject = useMemo(
    () => projects.find((p) => p.name === selectedProjectName),
    [projects, selectedProjectName]
  )

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate
  const canCheck = Boolean(selectedProject?.id) && dateRangeValid && checkState !== 'checking'

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
    if (!selectedProject?.id) return
    await exportProductAnalysisToExcel({
      periods,
      projectName: selectedProjectName || '未知项目',
      country,
      startDate,
      endDate,
    })
  }

  function renderCell(value: unknown, fmt?: 'percent' | 'currency') {
    if (value === null || value === undefined)
      return <span className={styles.mutedValue}>—</span>
    if (fmt === 'percent') return <span>{formatPercent(value)}</span>
    if (fmt === 'currency') {
      const sym = CURRENCY_CONFIG[country].symbol
      return (
        <span>
          {sym}
          {formatNumber(value)}
        </span>
      )
    }
    return <span>{formatNumber(value)}</span>
  }

  const detailColCount = DETAIL_DISPLAY_COLUMNS.length
  const projectOptions = projects.map((project) => ({
    value: project.name,
    label: project.name,
  }))
  const today = formatDateInputValue(new Date()) ?? ''

  return (
    <div className={styles.stack} data-warm-product-analysis-panel="true">
      <WarmPanel title="核算参数">
        <div className={styles.filters}>
          <WarmSelect
            id="product-analysis-project"
            label="项目"
            value={selectedProjectName}
            options={projectOptions}
            onChange={(value) => {
              setSelectedProjectName(value)
              setCheckState('idle')
              setAvailability(null)
              setRunState('idle')
              setPeriods([])
              setExpandedIndex(null)
            }}
            placeholder={
              projectsLoading
                ? '项目加载中...'
                : projects.length
                  ? '请选择项目'
                  : '暂无可选项目'
            }
            disabled={projectsLoading || projects.length === 0}
            error={projectLoadError}
            className={styles.projectField}
          />

          <WarmSelect
            id="product-analysis-country"
            label="站点"
            value={country}
            options={COUNTRY_OPTIONS}
            onChange={(value) => setCountry(value as CountryOption)}
            className={styles.countryField}
          />

          <div className={`${styles.field} ${styles.dateField}`}>
            <span className={styles.fieldLabel}>日期范围</span>
            <div className={styles.dateInputs}>
              <input
                id="product-analysis-start-date"
                type="date"
                aria-label="开始日期"
                max={today}
                className={styles.dateInput}
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
              />
              <input
                id="product-analysis-end-date"
                type="date"
                aria-label="结束日期"
                max={today}
                className={styles.dateInput}
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
              />
            </div>
          </div>

          <div className={`${styles.field} ${styles.actionField}`}>
            <div className={styles.buttonRow}>
              <WarmButton
                variant="secondary"
                onClick={() => void handleCheck()}
                disabled={!canCheck}
                loading={checkState === 'checking'}
                loadingLabel="正在检查数据"
              >
                {checkState !== 'checking' ? <CheckCircle2 aria-hidden /> : null}
                检查数据
              </WarmButton>
              <WarmButton
                variant="primary"
                onClick={() => void handleRun()}
                disabled={
                  checkState !== 'done' ||
                  !availability ||
                  !availability.has_minimum_data ||
                  runState === 'running'
                }
                loading={runState === 'running'}
                loadingLabel="正在执行核算"
              >
                执行核算
              </WarmButton>
            </div>
          </div>
        </div>

        {checkError ? (
          <div className={styles.error} role="alert">
            <AlertCircle aria-hidden />
            {checkError}
          </div>
        ) : null}
        {runError ? (
          <div className={styles.error} role="alert">
            <AlertCircle aria-hidden />
            {runError}
          </div>
        ) : null}
      </WarmPanel>

      {availability ? (
        <WarmPanel title={`数据可用性 ${startDate} — ${endDate}`}>
          <AvailabilityGrid startDate={startDate} endDate={endDate} availability={availability} />
          <div className={styles.summaryCheck} data-valid={availability.has_minimum_data}>
            {availability.has_minimum_data ? (
              <>
                <CheckCircle2 aria-hidden />
                可执行核算
                {availability.weekly_availability?.some((week) => week.is_partial) ? (
                  <span className={styles.partialBadge}>
                    <AlertTriangle aria-hidden />
                    部分周数据不完整
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <XCircle aria-hidden />
                数据不足，无法执行核算（缺少核心报表数据）
              </>
            )}
          </div>
        </WarmPanel>
      ) : null}

      {runState === 'done' ? (
        <WarmPanel
          title={`核算结果 · 共 ${periods.length} 个周期`}
          actions={
            <WarmButton
              variant="secondary"
              onClick={() => void handleExport()}
              disabled={periods.length === 0}
            >
              <Download aria-hidden />
              导出 Excel
            </WarmButton>
          }
        >
          {periods.length === 0 ? (
            <div className={styles.empty} role="status">
              无核算数据
            </div>
          ) : (
            <div className={styles.periodList}>
              {periods.map((period, idx) => {
                const isExpanded = expandedIndex === idx
                return (
                  <div key={idx} className={styles.period}>
                    <button
                      type="button"
                      className={styles.periodSummary}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? '收起明细' : '展开明细'}
                      onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                    >
                      {isExpanded ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
                      <span className={styles.periodRange}>
                        {period.report_start_date} ~ {period.report_end_date}
                      </span>
                      {period.persisted ? (
                        <span className={styles.persistedBadge}>
                          <CheckCircle2 aria-hidden />
                          已写入PT1
                        </span>
                      ) : null}
                      {period.is_partial && period.completeness ? (
                        <span
                          className={styles.partialBadge}
                          title={`数据不完整：业务报告 ${period.completeness.available_business_days}/${period.completeness.total_days} 天，广告报告 ${period.completeness.available_ad_days}/${period.completeness.total_days} 天${period.completeness.payment_missing ? '，缺少付款数据' : ''}`}
                        >
                          <AlertTriangle aria-hidden />
                          {period.completeness.available_business_days}/
                          {period.completeness.total_days}天
                        </span>
                      ) : null}
                      <span className={styles.periodMetrics}>
                        <span>总销售额: {renderCell(period.summary['总销售额'])}</span>
                        <span>利润: {renderCell(period.summary['利润'])}</span>
                        <span>利润率: {renderCell(period.summary['利润率'], 'percent')}</span>
                        <span>ACOS: {renderCell(period.summary['ACOS'], 'percent')}</span>
                      </span>
                    </button>

                    {isExpanded ? (
                      <div className={styles.detailScroller}>
                        <table className={styles.detailTable}>
                          <thead>
                            <tr>
                              {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                <th key={col.key}>{col.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {period.details.length === 0 ? (
                              <tr>
                                <td colSpan={detailColCount} className={styles.mutedValue}>
                                  无 SKU 明细
                                </td>
                              </tr>
                            ) : (
                              period.details.map((detail, dIdx) => (
                                <tr key={dIdx}>
                                  {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                    <td key={col.key}>{renderCell(detail[col.key], col.fmt)}</td>
                                  ))}
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </WarmPanel>
      ) : null}
    </div>
  )
}
