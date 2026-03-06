'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { TrendingDown, TrendingUp, Eye, EyeOff, ShoppingCart } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getClientCache, setClientCache } from '@/lib/client-cache'

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

type WeeklyTrendPoint = {
  week_label: string
  start_date: string
  end_date: string
  sales_amount: number
  units_sold: number
  ad_spend: number
  ad_clicks: number
  organic_traffic: number
}

type WeeklySummaryItem = {
  row: WeeklyDataRow
  summary: Record<string, unknown>
}

type WeeklyViewTab = 'summary' | 'details'
type CountryOption = 'US' | 'DE' | 'UK'

type PT1DetailsResponse = {
  pt1_id: number
  has_next: boolean
  rows: Array<{
    id: number
    source_row_no: number
    sku?: string | null
    asin?: string | null
    raw_row?: Record<string, unknown> | null
  }>
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''
const PROJECTS_CACHE_KEY = 'weekly-analysis:projects'
const PROJECTS_CACHE_TTL_MS = 10 * 60 * 1000
const WEEKLY_DATA_CACHE_TTL_MS = 3 * 60 * 1000
const WEEKLY_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000

function weeklyDataCacheKey(projectId: number, country: CountryOption, startDate: string, endDate: string): string {
  return `weekly-analysis:data:${projectId}:${country}:${startDate || 'none'}:${endDate || 'none'}`
}

function weeklyDetailsCacheKey(pt1Id: number, country: CountryOption): string {
  return `weekly-analysis:details:${pt1Id}:${country}`
}

const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

const SUMMARY_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
    groupClass: 'bg-sky-500/15',
    headClass: 'bg-sky-500/10',
  },
  {
    title: '推广流量',
    columns: ['广告展示量', '广告点击量', '广告点击率', '广告订单量', '广告单占比', '广告转化率', '广告花费', '广告销售额', 'CPC', 'ACOS', 'SP占比'],
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
    columns: ['产品FOB', '成本占比', '销售头程', '头程占比', 'FBA配送费', '配送费占比', '平台佣金', '佣金占比', '总成本', '总成本占比', '利润', '利润率'],
    groupClass: 'bg-amber-500/15',
    headClass: 'bg-amber-500/10',
  },
  {
    title: '财务结算',
    columns: ['实际销售额', '实际销售量', '实际退款额', '实际退款量', '平均售价', '退款率'],
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
    title: '推广流量',
    columns: ['广告展示量', '广告点击量', '广告点击率', '广告订单量', '广告单占比', '广告转化率', '广告花费', '广告销售额', 'CPC', 'ACOS', 'SP占比'],
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
    columns: ['产品FOB', '成本占比', '销售头程', '头程占比', 'FBA配送费', '配送费占比', '平台佣金', '佣金占比', '总成本', '总成本占比', '利润', '利润率'],
    groupClass: 'bg-amber-500/15',
    headClass: 'bg-amber-500/10',
  },
  {
    title: '财务结算',
    columns: ['实际销售额', '实际销售量', '实际退款额', '实际退款量', '平均售价', '退款率'],
    groupClass: 'bg-violet-500/15',
    headClass: 'bg-violet-500/10',
  },
] as const
const DETAIL_BASE_COLUMNS = [...DETAIL_CORE_COLUMNS, ...SUMMARY_COLUMNS]
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

function oneYearAgoDateString(): string {
  const now = new Date()
  now.setFullYear(now.getFullYear() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function authHeaders(): Record<string, string> {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
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
    const payload = JSON.parse(text) as { detail?: string | unknown[] | Record<string, unknown> }
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
  const isNumeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.replace(/,/g, ''))))
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

function buildDetailRow(rawRow: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!rawRow || typeof rawRow !== 'object') return {}
  return { ...rawRow }
}

function formatDetailCell(column: string, value: unknown): string {
  if (!hasValue(value)) return '-'
  if (column === '日期' || column === 'SKU') return String(value)
  return formatSummaryCell(column, value)
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

interface StatCardProps {
  title: string
  value: string
  icon: React.ReactNode
  color: 'emerald' | 'rose' | 'sky' | 'amber'
  trend?: number
  trendLabel?: string
}

function StatCard({ title, value, icon, color, trend, trendLabel }: StatCardProps) {
  const colorClasses = {
    emerald: {
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
      text: 'text-emerald-600 dark:text-emerald-400',
      gradient: 'from-emerald-500/5',
      icon: 'text-emerald-600',
    },
    rose: {
      bg: 'bg-rose-500/10',
      border: 'border-rose-500/20',
      text: 'text-rose-600 dark:text-rose-400',
      gradient: 'from-rose-500/5',
      icon: 'text-rose-600',
    },
    sky: {
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/20',
      text: 'text-sky-600 dark:text-sky-400',
      gradient: 'from-sky-500/5',
      icon: 'text-sky-600',
    },
    amber: {
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
      text: 'text-amber-600 dark:text-amber-400',
      gradient: 'from-amber-500/5',
      icon: 'text-amber-600',
    },
  }

  const colors = colorClasses[color]

  return (
    <Card className={`dashboard-surface hover-lift animate-enter border ${colors.border} relative overflow-hidden`}>
      <div className={`absolute inset-0 bg-gradient-to-br ${colors.gradient} via-transparent to-transparent opacity-60`} />
      <CardHeader className="relative z-10 flex flex-row items-start justify-between space-y-0 pb-3">
        <CardTitle className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</CardTitle>
        <div className={`rounded-lg ${colors.bg} p-2 ${colors.icon}`}>{icon}</div>
      </CardHeader>
      <CardContent className="relative z-10 pt-0">
        <div className={`text-2xl font-semibold tracking-tight md:text-[1.7rem] ${colors.text}`}>{value}</div>
        {trend !== undefined ? (
          <p className="mt-2 text-xs text-muted-foreground">
            <span className={`inline-flex items-center ${trend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {trend >= 0 ? <TrendingUp className="mr-1 h-3 w-3" /> : <TrendingDown className="mr-1 h-3 w-3" />}
              {Math.abs(trend).toFixed(1)}%
            </span>
            <span className="ml-1">{trendLabel || '较上期'}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default function WeeklyProductAnalysisPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectId, setProjectId] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(oneYearAgoDateString())
  const [endDate, setEndDate] = useState(lastSundayDateString())

  const [data, setData] = useState<WeeklyDataRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<WeeklyViewTab>('summary')
  const [selectedWeekId, setSelectedWeekId] = useState('')
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<Array<Record<string, unknown>>>([])

  const [visibleLines, setVisibleLines] = useState({
    sales_amount: true,
    units_sold: true,
    ad_spend: true,
    ad_clicks: true,
    organic_traffic: true,
  })

  const latestRequestIdRef = useRef(0)
  const summaryWeekHeadRef = useRef<HTMLTableCellElement | null>(null)
  const [summaryWeekColumnWidth, setSummaryWeekColumnWidth] = useState(SUMMARY_WEEK_COLUMN_FALLBACK_WIDTH)

  const loadProjects = useCallback(async () => {
    const cached = getClientCache<ProjectOption[]>(PROJECTS_CACHE_KEY, PROJECTS_CACHE_TTL_MS)
    const hasCachedProjects = Array.isArray(cached) && cached.length > 0
    if (hasCachedProjects) {
      setProjects(cached)
      if (!projectId) {
        setProjectId(String(cached[0].id))
      }
      setProjectsLoading(false)
    } else {
      setProjectsLoading(true)
    }
    setProjectLoadError(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects`, {
        cache: 'no-store',
        headers: authHeaders(),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as ProjectOption[]
      setProjects(payload)
      setClientCache(PROJECTS_CACHE_KEY, payload)
      if (payload.length > 0 && !projectId) {
        setProjectId(String(payload[0].id))
      }
    } catch (loadError) {
      if (!hasCachedProjects) {
        setProjectLoadError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
      }
    } finally {
      setProjectsLoading(false)
    }
  }, [projectId])

  const loadWeeklyData = useCallback(async (options?: { force?: boolean }) => {
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

      const response = await fetch(`${API_BASE}/api/v1/product-analysis/weekly?${search.toString()}`, {
        cache: 'no-store',
        headers: authHeaders(),
      })
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
  }, [projectId, country, startDate, endDate])

  const loadWeeklyDetails = useCallback(async (options?: { force?: boolean }) => {
    const pt1Id = Number(selectedWeekId)
    if (!pt1Id) {
      setDetailRows([])
      setDetailsError(null)
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

    setDetailsLoading(!hasCachedRows)
    setDetailsError(null)
    try {
      const merged: Array<Record<string, unknown>> = []
      let page = 1
      let hasNext = true

      while (hasNext) {
        const search = new URLSearchParams({
          page: String(page),
          page_size: '1000',
          country,
        })
        const response = await fetch(`${API_BASE}/api/v1/product-analysis/pt1/${pt1Id}/details?${search.toString()}`, {
          cache: 'no-store',
          headers: authHeaders(),
        })
        if (!response.ok) {
          throw new Error(parseErrorBody(await response.text(), response.status))
        }

        const payload = (await response.json()) as PT1DetailsResponse
        merged.push(...payload.rows.map((row) => buildDetailRow(row.raw_row)))
        hasNext = payload.has_next
        page += 1
      }

      setDetailRows(merged)
      setClientCache(cacheKey, merged, { persist: false })
    } catch (loadError) {
      if (!hasCachedRows) {
        setDetailRows([])
        setDetailsError(loadError instanceof Error ? loadError.message : 'SKU明细 加载失败')
      }
    } finally {
      setDetailsLoading(false)
    }
  }, [selectedWeekId, country])

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
      const dateOrder = String(a.report_start_date).localeCompare(String(b.report_start_date))
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
    const groups = DETAIL_COLUMN_GROUPS
      .map((group) => ({
        ...group,
        columns: group.columns.filter((column) => detailColumnSet.has(column)),
      }))
      .filter((group) => group.columns.length > 0)

    const groupedColumns = new Set<string>(groups.flatMap((group) => group.columns))
    const coreColumnSet = new Set<string>(DETAIL_CORE_COLUMNS)
    const extras = detailColumns.filter((column) => !coreColumnSet.has(column) && !groupedColumns.has(column))
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

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge variant="outline" className="w-fit rounded-md border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                数据分析
              </Badge>
              <p className="text-sm text-muted-foreground">默认展示每周汇总，表头与产品分析汇总口径一致。</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] space-y-1.5">
                <label className="text-xs text-muted-foreground">店铺</label>
                <Select value={projectId} onValueChange={setProjectId} disabled={projectsLoading || projects.length === 0}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder={projectsLoading ? '店铺加载中...' : '请选择店铺'} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={String(project.id)}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[170px] space-y-1.5">
                <label className="text-xs text-muted-foreground">国家站点</label>
                <Select value={country} onValueChange={(value) => setCountry(value as CountryOption)}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="请选择国家站点" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="weekly_start_date" className="text-xs text-muted-foreground">开始日期</label>
                <Input id="weekly_start_date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 w-[170px]" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="weekly_end_date" className="text-xs text-muted-foreground">结束日期</label>
                <Input id="weekly_end_date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-9 w-[170px]" />
              </div>
              <Button type="button" variant="outline" className="h-9" onClick={() => void loadWeeklyData({ force: true })} disabled={loading || !projectId}>
                {loading ? '刷新中...' : '刷新数据'}
              </Button>
            </div>
          </div>

          {projectLoadError ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{projectLoadError}</div> : null}
          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              title="销售额合计"
              value={formatCurrency(totals.sales_amount)}
              icon={<TrendingUp className="h-5 w-5" />}
              color="emerald"
              trend={trends.sales}
              trendLabel="较上周"
            />
            <StatCard
              title="销量合计"
              value={totals.units_sold.toLocaleString()}
              icon={<ShoppingCart className="h-5 w-5" />}
              color="sky"
              trend={trends.units}
              trendLabel="较上周"
            />
            <StatCard
              title="广告花费合计"
              value={formatCurrency(totals.ad_spend)}
              icon={<TrendingDown className="h-5 w-5" />}
              color="rose"
              trend={trends.ad}
              trendLabel="较上周"
            />
          </div>

          <Card className="dashboard-surface animate-enter">
            <CardHeader className="relative z-10 flex flex-col gap-4 space-y-0 border-b border-border/70 py-5 sm:flex-row sm:items-center">
              <div className="grid flex-1 gap-1 text-center sm:text-left">
                <CardTitle className="text-lg">周度趋势</CardTitle>
                <CardDescription className="text-sm text-muted-foreground">销售额、销量、广告花费、广告点击量、自然流量</CardDescription>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={() => setVisibleLines((prev) => ({ ...prev, sales_amount: !prev.sales_amount }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.sales_amount
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.sales_amount ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--chart-2))' }} />
                  销售额
                </button>
                <button
                  type="button"
                  onClick={() => setVisibleLines((prev) => ({ ...prev, units_sold: !prev.units_sold }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.units_sold
                      ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.units_sold ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--primary))' }} />
                  销量
                </button>
                <button
                  type="button"
                  onClick={() => setVisibleLines((prev) => ({ ...prev, ad_spend: !prev.ad_spend }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.ad_spend
                      ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.ad_spend ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--destructive))' }} />
                  广告花费
                </button>
                <button
                  type="button"
                  onClick={() => setVisibleLines((prev) => ({ ...prev, ad_clicks: !prev.ad_clicks }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.ad_clicks
                      ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.ad_clicks ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--chart-4))' }} />
                  广告点击量
                </button>
                <button
                  type="button"
                  onClick={() => setVisibleLines((prev) => ({ ...prev, organic_traffic: !prev.organic_traffic }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.organic_traffic
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.organic_traffic ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--chart-5))' }} />
                  自然流量
                </button>
              </div>
            </CardHeader>
            <CardContent className="relative z-10 px-2 pt-4 sm:px-6 sm:pt-6">
              {showSummarySkeleton ? (
                <Skeleton className="h-[320px] w-full" />
              ) : trendPoints.length > 0 ? (
                <ChartContainer config={chartConfig} className="aspect-auto h-[320px] w-full">
                  <AreaChart accessibilityLayer data={trendPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-sales_amount)" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="var(--color-sales_amount)" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillUnits" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-units_sold)" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="var(--color-units_sold)" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillAd" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-ad_spend)" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="var(--color-ad_spend)" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillAdClicks" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-ad_clicks)" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="var(--color-ad_clicks)" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillOrganicTraffic" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-organic_traffic)" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="var(--color-organic_traffic)" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                    <XAxis
                      dataKey="week_label"
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
                      cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '4 4' }}
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
                            const displayName = nameMap[String(name)] || String(name)
                            const metricKey = String(name)
                            const isCurrencyMetric = metricKey === 'sales_amount' || metricKey === 'ad_spend'
                            return (
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">{displayName}</span>
                                <span className="font-medium">{isCurrencyMetric ? formatCurrency(Number(value)) : Number(value).toLocaleString()}</span>
                              </div>
                            )
                          }}
                          indicator="dot"
                        />
                      }
                    />
                    {visibleLines.sales_amount ? (
                      <Area
                        type="monotone"
                        dataKey="sales_amount"
                        stroke="var(--color-sales_amount)"
                        fill="url(#fillSales)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ) : null}
                    {visibleLines.units_sold ? (
                      <Area
                        type="monotone"
                        dataKey="units_sold"
                        stroke="var(--color-units_sold)"
                        fill="url(#fillUnits)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ) : null}
                    {visibleLines.ad_spend ? (
                      <Area
                        type="monotone"
                        dataKey="ad_spend"
                        stroke="var(--color-ad_spend)"
                        fill="url(#fillAd)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ) : null}
                    {visibleLines.ad_clicks ? (
                      <Area
                        type="monotone"
                        dataKey="ad_clicks"
                        stroke="var(--color-ad_clicks)"
                        fill="url(#fillAdClicks)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ) : null}
                    {visibleLines.organic_traffic ? (
                      <Area
                        type="monotone"
                        dataKey="organic_traffic"
                        stroke="var(--color-organic_traffic)"
                        fill="url(#fillOrganicTraffic)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    ) : null}
                  </AreaChart>
                </ChartContainer>
              ) : (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">暂无趋势数据</div>
              )}
            </CardContent>
          </Card>

          <Card className="dashboard-surface animate-enter">
            <CardHeader className="relative z-10 border-b border-border/70 pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">每周分析明细</CardTitle>
                  <CardDescription className="text-sm text-muted-foreground">
                    默认显示周汇总；可切换到 SKU明细 查看每周的行级结果。
                  </CardDescription>
                </div>
                <div className="inline-flex rounded-md border bg-muted/20 p-1">
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
              {activeTab === 'details' ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="min-w-[280px] space-y-1.5">
                    <label className="text-xs text-muted-foreground">选择周次</label>
                    <Select value={selectedWeekId} onValueChange={setSelectedWeekId} disabled={summaryRows.length === 0}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="请选择周次" />
                      </SelectTrigger>
                      <SelectContent>
                        {summaryRows.map((item, index) => (
                          <SelectItem key={item.row.id} value={String(item.row.id)}>
                            第{index + 1}周 · {formatDateRange(item.row.report_start_date, item.row.report_end_date)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9"
                    onClick={() => void loadWeeklyDetails({ force: true })}
                    disabled={!selectedWeekId || detailsLoading}
                  >
                    {detailsLoading ? '加载中...' : '刷新 SKU明细'}
                  </Button>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="relative z-10 pt-4">
              {activeTab === 'summary' ? (
                showSummarySkeleton ? (
                  <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : summaryRows.length > 0 ? (
                  <div className="w-full overflow-x-auto rounded-md border">
                    <Table className="min-w-[4200px] table-auto text-xs">
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
                            <TableHead key={group.title} colSpan={group.columns.length} className={`border-r px-2 py-2 text-center text-foreground ${group.groupClass}`}>
                              {group.title}
                            </TableHead>
                          ))}
                        </TableRow>
                        <TableRow className="bg-muted/20 hover:bg-muted/20">
                          {SUMMARY_COLUMN_GROUPS.map((group) =>
                            group.columns.map((column) => (
                              <TableHead key={column} className={`border-r px-2 py-1.5 text-center whitespace-nowrap ${group.headClass}`}>
                                {column}
                              </TableHead>
                            ))
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {summaryRows.map((item, index) => {
                          const row = item.row
                          const rowBg = row.is_current ? 'bg-background' : 'bg-muted/20'
                          return (
                            <TableRow key={row.id} className={!row.is_current ? 'bg-muted/15' : undefined}>
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
                                {formatDateRange(row.report_start_date, row.report_end_date)}
                              </TableCell>
                              {SUMMARY_COLUMNS.map((column) => (
                                <TableCell key={`${row.id}-${column}`} className="border-r px-2 py-1.5 text-right tabular-nums">
                                  {formatSummaryCell(column, item.summary[column])}
                                </TableCell>
                              ))}
                            </TableRow>
                          )
                        })}
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
                            <TableCell key={`summary-total-${column}`} className="border-r px-2 py-2 text-right tabular-nums">
                              {formatSummaryCell(column, summaryTotals[column])}
                            </TableCell>
                          ))}
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">当前筛选条件暂无产品分析周汇总数据</div>
                )
              ) : showDetailsSkeleton ? (
                <div className="space-y-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : detailsError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{detailsError}</div>
              ) : detailRows.length > 0 ? (
                <div className="relative w-full overflow-x-auto rounded-md border">
                  <Table className="min-w-[3600px] table-auto text-xs">
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead
                          rowSpan={2}
                          className="sticky z-40 border-r border-border bg-muted px-3 py-2 text-center whitespace-nowrap"
                          style={{ left: DETAIL_STICKY_LEFT[0], minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0] }}
                        >
                          日期
                        </TableHead>
                        <TableHead
                          rowSpan={2}
                          className="sticky z-40 border-r border-border bg-muted px-3 py-2 text-center whitespace-nowrap"
                          style={{ left: DETAIL_STICKY_LEFT[1], minWidth: DETAIL_STICKY_COLUMN_WIDTHS[1] }}
                        >
                          SKU
                        </TableHead>
                        {detailGroupMeta.groups.map((group) => (
                          <TableHead key={group.title} colSpan={group.columns.length} className={`border-r px-2 py-2 text-center text-foreground ${group.groupClass}`}>
                            {group.title}
                          </TableHead>
                        ))}
                        {detailGroupMeta.extras.map((column) => (
                          <TableHead key={`detail-extra-top-${column}`} rowSpan={2} className="border-r px-2 py-2 text-center whitespace-nowrap bg-muted/20">
                            {column}
                          </TableHead>
                        ))}
                      </TableRow>
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        {detailGroupMeta.groups.map((group) =>
                          group.columns.map((column) => (
                            <TableHead key={column} className={`border-r px-2 py-1.5 text-center whitespace-nowrap ${detailGroupMeta.headClassByColumn[column] || ''}`}>
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
                              className={`border-r px-2 py-1.5 tabular-nums whitespace-nowrap ${
                                column === '日期' || column === 'SKU'
                                  ? 'sticky z-20 border-border bg-background text-left'
                                  : 'text-right'
                              }`}
                              style={
                                column === '日期'
                                  ? { left: DETAIL_STICKY_LEFT[0], minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0] }
                                  : column === 'SKU'
                                    ? { left: DETAIL_STICKY_LEFT[1], minWidth: DETAIL_STICKY_COLUMN_WIDTHS[1] }
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
                      <TableRow className="bg-muted font-semibold hover:bg-muted">
                        {detailColumns.map((column) => {
                          if (column === '日期') {
                            return (
                              <TableCell
                                key="detail-total-date"
                                className="sticky z-30 border-r border-border bg-muted px-2 py-2 text-left"
                                style={{ left: DETAIL_STICKY_LEFT[0], minWidth: DETAIL_STICKY_COLUMN_WIDTHS[0] }}
                              >
                                合计
                              </TableCell>
                            )
                          }
                          if (column === 'SKU') {
                            return (
                              <TableCell
                                key="detail-total-sku"
                                className="sticky z-30 border-r border-border bg-muted px-2 py-2 text-left"
                                style={{ left: DETAIL_STICKY_LEFT[1], minWidth: DETAIL_STICKY_COLUMN_WIDTHS[1] }}
                              >
                                {detailRows.length} 行
                              </TableCell>
                            )
                          }
                          if (SUMMARY_COLUMN_SET.has(column)) {
                            return (
                              <TableCell key={`detail-total-${column}`} className="border-r px-2 py-2 text-right tabular-nums">
                                {formatDetailCell(column, detailTotals[column])}
                              </TableCell>
                            )
                          }
                          const extraTotal = detailExtraTotals[column]
                          return (
                            <TableCell key={`detail-total-${column}`} className="border-r px-2 py-2 text-right tabular-nums">
                              {extraTotal === null ? '-' : formatDetailCell(column, extraTotal)}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">当前周次暂无 SKU明细 数据</div>
              )}
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  )
}
