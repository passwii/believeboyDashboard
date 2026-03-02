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
}

type WeeklySummaryItem = {
  row: WeeklyDataRow
  summary: Record<string, unknown>
}

type WeeklyViewTab = 'summary' | 'details'

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

const SUMMARY_COLUMN_GROUPS = [
  {
    title: '流量与销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
    groupClass: 'bg-emerald-500/15',
    headClass: 'bg-emerald-500/10',
  },
  {
    title: '广告表现',
    columns: ['广告展示量', '广告点击量', '广告点击率', '广告订单量', '广告单占比', '广告转化率', '广告花费', '广告销售额', 'CPC', 'ACOS', 'SP占比'],
    groupClass: 'bg-sky-500/15',
    headClass: 'bg-sky-500/10',
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
    groupClass: 'bg-indigo-500/15',
    headClass: 'bg-indigo-500/10',
  },
  {
    title: '成本与利润',
    columns: ['产品FOB', '成本占比', '销售头程', '头程占比', 'FBA配送费', '配送费占比', '平台佣金', '佣金占比', '总成本', '总成本占比', '利润', '利润率'],
    groupClass: 'bg-amber-500/15',
    headClass: 'bg-amber-500/10',
  },
  {
    title: '实际销售',
    columns: ['实际销售额', '实际销售量', '实际退款额', '实际退款量', '平均售价', '退款率'],
    groupClass: 'bg-rose-500/15',
    headClass: 'bg-rose-500/10',
  },
] as const

const SUMMARY_COLUMNS = SUMMARY_COLUMN_GROUPS.flatMap((item) => item.columns)
const DETAIL_BASE_COLUMNS = ['日期', 'SKU', 'ASIN', ...SUMMARY_COLUMNS]
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

const STICKY_COLUMN_WIDTHS = [92, 220] as const
const STICKY_LEFT = [0, STICKY_COLUMN_WIDTHS[0]] as const

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
  const daysToSubtract = now.getDay() + 7
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
  if (column === '日期' || column === 'SKU' || column === 'ASIN') return String(value)
  return formatSummaryCell(column, value)
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
  })

  const latestRequestIdRef = useRef(0)

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
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
      if (payload.length > 0 && !projectId) {
        setProjectId(String(payload[0].id))
      }
    } catch (loadError) {
      setProjectLoadError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
    } finally {
      setProjectsLoading(false)
    }
  }, [projectId])

  const loadWeeklyData = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId) {
      setError('请先选择店铺')
      setData([])
      return
    }

    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId

    setLoading(true)
    setError(null)

    try {
      const search = new URLSearchParams({
        project_id: String(parsedProjectId),
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
    } catch (loadError) {
      if (latestRequestIdRef.current !== requestId) return
      setData([])
      setError(loadError instanceof Error ? loadError.message : '产品分析数据加载失败')
    } finally {
      if (latestRequestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [projectId, startDate, endDate])

  const loadWeeklyDetails = useCallback(async () => {
    const pt1Id = Number(selectedWeekId)
    if (!pt1Id) {
      setDetailRows([])
      setDetailsError(null)
      return
    }

    setDetailsLoading(true)
    setDetailsError(null)
    try {
      const merged: Array<Record<string, unknown>> = []
      let page = 1
      let hasNext = true

      while (hasNext) {
        const search = new URLSearchParams({
          page: String(page),
          page_size: '1000',
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
    } catch (loadError) {
      setDetailRows([])
      setDetailsError(loadError instanceof Error ? loadError.message : 'SKU Details 加载失败')
    } finally {
      setDetailsLoading(false)
    }
  }, [selectedWeekId])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (!projectId || projectsLoading) return
    void loadWeeklyData()
  }, [projectId, projectsLoading, loadWeeklyData])

  const trendPoints = useMemo(() => {
    if (!data || data.length === 0) return []
    return data.map((row) => {
      return {
        week_label: formatWeekLabel(row.report_start_date, row.report_end_date),
        start_date: row.report_start_date,
        end_date: row.report_end_date,
        sales_amount: Number(row.total_sales || 0),
        units_sold: Number(row.total_units || 0),
        ad_spend: Number(row.total_ad_spend || 0),
      }
    })
  }, [data])

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
    if (!data || data.length < 2) return { sales: 0, units: 0, ad: 0 }
    const last = data[data.length - 1]
    const prev = data[data.length - 2]
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
  }, [data])

  const summaryRows = useMemo<WeeklySummaryItem[]>(() => {
    return data.map((row) => ({ row, summary: buildSummaryForRow(row) }))
  }, [data])

  const summaryTotals = useMemo(() => {
    return buildSummaryTotals(summaryRows.map((item) => item.summary))
  }, [summaryRows])

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
        if (!DETAIL_BASE_COLUMNS.includes(key)) {
          extra.add(key)
        }
      })
    })
    return [...DETAIL_BASE_COLUMNS, ...Array.from(extra)]
  }, [detailRows])

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
              <div className="space-y-1.5">
                <label htmlFor="weekly_start_date" className="text-xs text-muted-foreground">开始日期</label>
                <Input id="weekly_start_date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 w-[170px]" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="weekly_end_date" className="text-xs text-muted-foreground">结束日期</label>
                <Input id="weekly_end_date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-9 w-[170px]" />
              </div>
              <Button type="button" variant="outline" className="h-9" onClick={() => void loadWeeklyData()} disabled={loading || !projectId}>
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
                <CardDescription className="text-sm text-muted-foreground">销售额、销量、广告花费</CardDescription>
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
              </div>
            </CardHeader>
            <CardContent className="relative z-10 px-2 pt-4 sm:px-6 sm:pt-6">
              {loading ? (
                <Skeleton className="h-[320px] w-full" />
              ) : trendPoints.length > 0 ? (
                <ChartContainer config={chartConfig} className="aspect-auto h-[320px] w-full">
                  <AreaChart data={trendPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillUnits" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                      </linearGradient>
                      <linearGradient id="fillAd" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0.05} />
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
                      tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
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
                            }
                            const displayName = nameMap[String(name)] || String(name)
                            return (
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">{displayName}</span>
                                <span className="font-medium">{String(name) === 'units_sold' ? Number(value).toLocaleString() : formatCurrency(Number(value))}</span>
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
                        stroke="hsl(var(--chart-2))"
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
                        stroke="hsl(var(--primary))"
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
                        stroke="hsl(var(--destructive))"
                        fill="url(#fillAd)"
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
                    默认显示周汇总；可切换到 SKU Details 查看每周的行级结果。
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
                    SKU Details
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
                            第{summaryRows.length - index}周 · {formatDateRange(item.row.report_start_date, item.row.report_end_date)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9"
                    onClick={() => void loadWeeklyDetails()}
                    disabled={!selectedWeekId || detailsLoading}
                  >
                    {detailsLoading ? '加载中...' : '刷新 SKU Details'}
                  </Button>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="relative z-10 pt-4">
              {activeTab === 'summary' ? (
                loading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : summaryRows.length > 0 ? (
                  <div className="w-full overflow-x-auto rounded-md border">
                    <Table className="min-w-[4200px] table-fixed text-xs">
                      <TableHeader>
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableHead
                            rowSpan={2}
                            className="sticky z-40 border-r border-border bg-muted px-2 py-2 text-center"
                            style={{ left: STICKY_LEFT[0], minWidth: STICKY_COLUMN_WIDTHS[0] }}
                          >
                            周次
                          </TableHead>
                          <TableHead
                            rowSpan={2}
                            className="sticky z-40 border-r border-border bg-muted px-2 py-2 text-center"
                            style={{ left: STICKY_LEFT[1], minWidth: STICKY_COLUMN_WIDTHS[1] }}
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
                                className={`sticky z-20 border-r border-border px-2 py-1.5 text-center font-medium ${rowBg}`}
                                style={{ left: STICKY_LEFT[0], minWidth: STICKY_COLUMN_WIDTHS[0] }}
                              >
                                第{summaryRows.length - index}周
                              </TableCell>
                              <TableCell
                                className={`sticky z-20 border-r border-border px-2 py-1.5 text-center ${rowBg}`}
                                style={{ left: STICKY_LEFT[1], minWidth: STICKY_COLUMN_WIDTHS[1] }}
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
                        <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                          <TableCell
                            className="sticky z-20 border-r border-border bg-muted/40 px-2 py-2 text-center"
                            style={{ left: STICKY_LEFT[0], minWidth: STICKY_COLUMN_WIDTHS[0] }}
                          >
                            合计
                          </TableCell>
                          <TableCell
                            className="sticky z-20 border-r border-border bg-muted/40 px-2 py-2 text-center"
                            style={{ left: STICKY_LEFT[1], minWidth: STICKY_COLUMN_WIDTHS[1] }}
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
              ) : detailsLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : detailsError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{detailsError}</div>
              ) : detailRows.length > 0 ? (
                <div className="w-full overflow-x-auto rounded-md border">
                  <Table className="min-w-[4200px] table-fixed text-xs">
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        {detailColumns.map((column) => (
                          <TableHead key={column} className="border-r px-2 py-2 text-center whitespace-nowrap">
                            {column}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailRows.map((row, idx) => (
                        <TableRow key={`detail-${idx}`}>
                          {detailColumns.map((column) => (
                            <TableCell
                              key={`detail-${idx}-${column}`}
                              className={`border-r px-2 py-1.5 tabular-nums ${column === '日期' || column === 'SKU' || column === 'ASIN' ? 'text-left' : 'text-right'}`}
                            >
                              {formatDetailCell(column, row[column])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">当前周次暂无 SKU Details 数据</div>
              )}
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  )
}
