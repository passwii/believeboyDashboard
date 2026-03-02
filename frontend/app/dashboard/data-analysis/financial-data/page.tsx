'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { TrendingUp, TrendingDown, Wallet, ArrowUpRight, ArrowDownRight, Eye, EyeOff } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { resolveOperationCommissionUsd } from '@/lib/commission'

type ProjectOption = {
  id: number | null
  name: string
  commission_basis?: string | null
  commission_rate?: number | null
}

type FinancialSeriesRow = {
  report_month: string
  income_sales: number
  income_refund: number
  income_adjustment: number
  income_other: number
  expense_selling_fee: number
  expense_fba_fee: number
  expense_inventory_fee: number
  expense_service_fee: number
  expense_advertising: number
  expense_other_fees: number
  income_total: number
  expense_total: number
  amazon_pay_back: number
  credit_card_deduction_usd: number
  has_source_report: boolean
}

type ExchangeRateListResponse = {
  data?: Array<{
    year_month: string
    rate: number
  }>
  pagination?: {
    totalPages: number
  }
}

type FinancialTrendPoint = {
  report_month: string
  income_total: number
  expense_total: number
  amazon_pay_back: number
  net_amount: number
  has_source_report: boolean
}

type FinancialSeriesResponse = {
  project_id: number
  project_name: string
  start_month: string
  end_month: string
  rows: FinancialSeriesRow[]
  trend: {
    income_total_sum: number
    expense_total_sum: number
    amazon_pay_back_sum: number
    net_amount_sum: number
    points: FinancialTrendPoint[]
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

function oneYearAgoMonthString(): string {
  const now = new Date()
  now.setFullYear(now.getFullYear() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

const chartConfig = {
  income_sales: {
    label: '销售额',
    color: 'hsl(var(--chart-2))',
  },
  income_refund: {
    label: '退款',
    color: 'hsl(var(--destructive))',
  },
} satisfies ChartConfig

function authHeaders(): Record<string, string> {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
}

function currentMonthString() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
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

function formatMonth(month: string): string {
  const [year, mon] = month.split('-')
  const monInt = Number(mon)
  if (!year || Number.isNaN(monInt)) return month
  return `${year}年${monInt}月`
}

function formatCurrency(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `¥${text}`
}

function toPositiveRatio(numerator: number, denominator: number): number {
  const base = Math.abs(denominator)
  if (base === 0) return 0
  return Math.abs(numerator) / base
}

function toSignedRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return numerator / denominator
}

function formatRatio(value: number): string {
  return `${(Math.abs(value) * 100).toFixed(1)}%`
}

function formatSignedRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-'
  return value.toFixed(4)
}

const MONTH_STICKY_WIDTH = 128

// 简化的数字格式化，用于大数值显示
function formatCompactCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`
  }
  return formatCurrency(value)
}

interface StatCardProps {
  title: string
  value: string
  rawValue: number
  icon: React.ReactNode
  color: 'emerald' | 'rose' | 'sky' | 'amber'
  trend?: number
  trendLabel?: string
}

function StatCard({ title, value, rawValue, icon, color, trend, trendLabel }: StatCardProps) {
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
        <CardTitle className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </CardTitle>
        <div className={`rounded-lg ${colors.bg} p-2 ${colors.icon}`}>
          {icon}
        </div>
      </CardHeader>
      <CardContent className="relative z-10 pt-0">
        <div className={`text-2xl font-semibold tracking-tight md:text-[1.7rem] ${colors.text}`}>
          {value}
        </div>
        {trend !== undefined && (
          <p className="mt-2 text-xs text-muted-foreground">
            <span className={`inline-flex items-center ${trend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {trend >= 0 ? <ArrowUpRight className="mr-1 h-3 w-3" /> : <ArrowDownRight className="mr-1 h-3 w-3" />}
              {Math.abs(trend).toFixed(1)}%
            </span>
            <span className="ml-1">{trendLabel || '较上期'}</span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function FinancialDataPage() {
  const { data: session, status: sessionStatus } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectId, setProjectId] = useState('')
  const [startMonth, setStartMonth] = useState(oneYearAgoMonthString())
  const [endMonth, setEndMonth] = useState(lastMonthString())

  const [data, setData] = useState<FinancialSeriesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exchangeRateByMonth, setExchangeRateByMonth] = useState<Record<string, number>>({})

  // 图表线条可见性状态
  const [visibleLines, setVisibleLines] = useState({
    income_sales: true,
    income_refund: true,
  })

  const latestRequestIdRef = useRef(0)

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectLoadError(null)
    try {
      const headers: Record<string, string> = {
        ...authHeaders(),
      }
      if (isAdmin) {
        headers['X-Is-Admin'] = 'true'
      }
      const operatorName = session?.user?.operatorNameZh?.trim()
      if (operatorName) {
        headers['X-Operator'] = encodeURIComponent(operatorName)
      }

      const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
        cache: 'no-store',
        headers,
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
  }, [projectId, isAdmin, session?.user?.operatorNameZh])

  const loadExchangeRates = useCallback(async (months: string[]) => {
    const uniqueMonths = Array.from(new Set(months.filter(Boolean)))
    if (uniqueMonths.length === 0) {
      setExchangeRateByMonth({})
      return
    }

    let page = 1
    let totalPages = 1
    const fetchedMap: Record<string, number> = {}

    while (page <= totalPages) {
      const response = await fetch(`/api/exchange-rates?currency=USD&page=${page}&pageSize=200`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as ExchangeRateListResponse
      const rows = Array.isArray(payload.data) ? payload.data : []
      rows.forEach((row) => {
        if (row.year_month) {
          fetchedMap[row.year_month] = Number(row.rate) || 0
        }
      })
      totalPages = Number(payload.pagination?.totalPages || 1)
      page += 1
    }

    const monthMap: Record<string, number> = {}
    uniqueMonths.forEach((month) => {
      monthMap[month] = fetchedMap[month] ?? 0
    })
    setExchangeRateByMonth(monthMap)
    setError(null)
  }, [])

  const loadFinancialSeries = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId) {
      setError('请先选择店铺')
      setData(null)
      return
    }

    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId

    setLoading(true)
    setError(null)

    try {
      const search = new URLSearchParams({
        project_id: String(parsedProjectId),
        fill_missing: 'true',
      })
      if (startMonth) search.set('start_month', startMonth)
      if (endMonth) search.set('end_month', endMonth)

      const response = await fetch(`${API_BASE}/api/v1/monthly-reports/financial-series?${search.toString()}`, {
        cache: 'no-store',
        headers: authHeaders(),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      const payload = (await response.json()) as FinancialSeriesResponse
      if (latestRequestIdRef.current !== requestId) return
      setData(payload)
    } catch (loadError) {
      if (latestRequestIdRef.current !== requestId) return
      setData(null)
      setError(loadError instanceof Error ? loadError.message : '财务数据加载失败')
    } finally {
      if (latestRequestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [projectId, startMonth, endMonth])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    void loadProjects()
  }, [loadProjects, sessionStatus])

  useEffect(() => {
    if (!projectId || projectsLoading) return
    void loadFinancialSeries()
  }, [projectId, projectsLoading, loadFinancialSeries])

  useEffect(() => {
    const months = (data?.rows ?? []).map((row) => row.report_month)
    if (months.length === 0) {
      setExchangeRateByMonth({})
      return
    }
    void loadExchangeRates(months).catch((loadError) => {
      setExchangeRateByMonth({})
      setError(loadError instanceof Error ? loadError.message : '汇率数据加载失败')
    })
  }, [data, loadExchangeRates])

  const trendPoints = useMemo(() => {
    if (!data) return []
    return data.rows.map((row) => ({
      report_month: row.report_month,
      month_label: formatMonth(row.report_month),
      income_sales: row.income_sales,
      // 退款统一按正值展示金额规模，避免与销售额方向相反影响可读性
      income_refund: Math.abs(row.income_refund),
      has_source_report: row.has_source_report,
    }))
  }, [data])

  // 计算趋势（最后一个有数据的月份与上一个的比较）
  const trends = useMemo(() => {
    if (!data || data.trend.points.length < 2) return { income: 0, expense: 0, amazon: 0 }
    const points = data.trend.points
    const validPoints = points.filter(p => p.has_source_report)
    if (validPoints.length < 2) return { income: 0, expense: 0, amazon: 0 }
    
    const last = validPoints[validPoints.length - 1]
    const prev = validPoints[validPoints.length - 2]
    
    return {
      income: prev.income_total !== 0 ? ((last.income_total - prev.income_total) / Math.abs(prev.income_total)) * 100 : 0,
      expense: prev.expense_total !== 0 ? ((last.expense_total - prev.expense_total) / Math.abs(prev.expense_total)) * 100 : 0,
      amazon: prev.amazon_pay_back !== 0 ? ((last.amazon_pay_back - prev.amazon_pay_back) / Math.abs(prev.amazon_pay_back)) * 100 : 0,
    }
  }, [data])

  const selectedProject = useMemo(
    () => projects.find((project) => String(project.id) === projectId) ?? null,
    [projects, projectId]
  )
  const commissionRate = selectedProject?.commission_rate ?? 0
  const commissionBasis = selectedProject?.commission_basis ?? null
  const disableCommission = !commissionBasis

  const totals = useMemo(() => {
    const rows = data?.rows ?? []
    return rows.reduce(
      (acc, row) => {
        const exchangeRate = exchangeRateByMonth[row.report_month] ?? 0
        const creditCardUsd = row.credit_card_deduction_usd
        const evaluationFeeRmb = 0
        const prepaymentOtherRmb = 0
        const operationCommission = resolveOperationCommissionUsd({
          commissionBasis,
          configuredCommissionRate: commissionRate,
          incomeTotalUsd: row.income_total,
          amazonPaybackUsd: row.amazon_pay_back,
        })
        const operationCommissionRmb = operationCommission.commissionUsd * exchangeRate
        const payableTotalRmb = evaluationFeeRmb + prepaymentOtherRmb + operationCommissionRmb

        return {
          income_sales: acc.income_sales + row.income_sales,
          income_refund: acc.income_refund + row.income_refund,
          income_adjustment: acc.income_adjustment + row.income_adjustment,
          income_other: acc.income_other + row.income_other,
          expense_selling_fee: acc.expense_selling_fee + row.expense_selling_fee,
          expense_fba_fee: acc.expense_fba_fee + row.expense_fba_fee,
          expense_inventory_fee: acc.expense_inventory_fee + row.expense_inventory_fee,
          expense_service_fee: acc.expense_service_fee + row.expense_service_fee,
          expense_advertising: acc.expense_advertising + row.expense_advertising,
          expense_other_fees: acc.expense_other_fees + row.expense_other_fees,
          income_total: acc.income_total + row.income_total,
          expense_total: acc.expense_total + row.expense_total,
          amazon_pay_back: acc.amazon_pay_back + row.amazon_pay_back,
          credit_card_deduction_usd: acc.credit_card_deduction_usd + creditCardUsd,
          evaluation_fee_rmb: acc.evaluation_fee_rmb + evaluationFeeRmb,
          prepayment_other_rmb: acc.prepayment_other_rmb + prepaymentOtherRmb,
          operation_commission_rmb: acc.operation_commission_rmb + operationCommissionRmb,
          payable_total_rmb: acc.payable_total_rmb + payableTotalRmb,
          exchange_rate_sum: acc.exchange_rate_sum + (exchangeRate > 0 ? exchangeRate : 0),
          exchange_rate_count: acc.exchange_rate_count + (exchangeRate > 0 ? 1 : 0),
        }
      },
      {
        income_sales: 0,
        income_refund: 0,
        income_adjustment: 0,
        income_other: 0,
        expense_selling_fee: 0,
        expense_fba_fee: 0,
        expense_inventory_fee: 0,
        expense_service_fee: 0,
        expense_advertising: 0,
        expense_other_fees: 0,
        income_total: 0,
        expense_total: 0,
        amazon_pay_back: 0,
        credit_card_deduction_usd: 0,
        evaluation_fee_rmb: 0,
        prepayment_other_rmb: 0,
        operation_commission_rmb: 0,
        payable_total_rmb: 0,
        exchange_rate_sum: 0,
        exchange_rate_count: 0,
      }
    )
  }, [data, exchangeRateByMonth, commissionRate, commissionBasis])

  return (
    <div className="min-w-0 w-full space-y-6 overflow-x-hidden">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge variant="outline" className="w-fit rounded-md border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                数据分析
              </Badge>
              <p className="text-sm text-muted-foreground">按店铺查看月度财务收入/支出数据，缺失月份自动补零展示。</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] space-y-1.5">
                <label className="text-xs text-muted-foreground">店铺</label>
                <Select value={projectId} onValueChange={setProjectId} disabled={projectsLoading}>
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
                <label htmlFor="financial_start_month" className="text-xs text-muted-foreground">开始月份</label>
                <Input id="financial_start_month" type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} className="h-9 w-[170px]" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="financial_end_month" className="text-xs text-muted-foreground">结束月份</label>
                <Input id="financial_end_month" type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} className="h-9 w-[170px]" />
              </div>
              <Button type="button" variant="outline" className="h-9" onClick={() => void loadFinancialSeries()} disabled={loading || !projectId}>
                {loading ? '刷新中...' : '刷新数据'}
              </Button>
            </div>
          </div>

          {projectLoadError ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{projectLoadError}</div> : null}
          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

          {/* 优化后的统计卡片 */}
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard
              title="收入合计"
              value={data ? formatCurrency(data.trend.income_total_sum) : '$0.00'}
              rawValue={data?.trend.income_total_sum ?? 0}
              icon={<TrendingUp className="h-5 w-5" />}
              color="emerald"
              trend={trends.income}
              trendLabel="较上月"
            />
            <StatCard
              title="支出合计"
              value={data ? formatCurrency(data.trend.expense_total_sum) : '$0.00'}
              rawValue={data?.trend.expense_total_sum ?? 0}
              icon={<TrendingDown className="h-5 w-5" />}
              color="rose"
              trend={trends.expense}
              trendLabel="较上月"
            />
            <StatCard
              title="亚马逊返款"
              value={data ? formatCurrency(data.trend.amazon_pay_back_sum) : '$0.00'}
              rawValue={data?.trend.amazon_pay_back_sum ?? 0}
              icon={<Wallet className="h-5 w-5" />}
              color="sky"
              trend={trends.amazon}
              trendLabel="较上月"
            />
          </div>

          {/* 优化后的图表 - 使用 AreaChart 和渐变 */}
          <Card className="dashboard-surface animate-enter">
            <CardHeader className="relative z-10 flex flex-col gap-4 space-y-0 border-b border-border/70 py-5 sm:flex-row sm:items-center">
              <div className="grid flex-1 gap-1 text-center sm:text-left">
                <CardTitle className="text-lg">月度趋势</CardTitle>
                <CardDescription className="text-sm text-muted-foreground">
                  销售额、退款
                </CardDescription>
              </div>
              {/* 可点击的图例按钮 */}
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={() => setVisibleLines(prev => ({ ...prev, income_sales: !prev.income_sales }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.income_sales
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.income_sales ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--chart-2))' }} />
                  销售额
                </button>
                <button
                  type="button"
                  onClick={() => setVisibleLines(prev => ({ ...prev, income_refund: !prev.income_refund }))}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                    visibleLines.income_refund
                      ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                      : 'border-muted bg-muted/30 text-muted-foreground line-through'
                  }`}
                >
                  {visibleLines.income_refund ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'hsl(var(--destructive))' }} />
                  退款
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
                      <linearGradient id="fillRefund" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.7} />
                        <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                    <XAxis 
                      dataKey="month_label" 
                      tickLine={false} 
                      axisLine={false} 
                      tickMargin={12}
                      minTickGap={32}
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                    />
                    <YAxis 
                      tickFormatter={(v) => formatCompactCurrency(Number(v))} 
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
                            // 将英文 dataKey 映射为中文
                            const nameMap: Record<string, string> = {
                              income_sales: '销售额',
                              income_refund: '退款',
                            }
                            const displayName = nameMap[String(name)] || String(name)
                            return (
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">{displayName}</span>
                                <span className="font-medium">{formatCurrency(Number(value))}</span>
                              </div>
                            )
                          }}
                          indicator="dot"
                        />
                      }
                    />
                    {visibleLines.income_refund && (
                      <Area
                        type="monotone"
                        dataKey="income_refund"
                        stroke="hsl(var(--destructive))"
                        fill="url(#fillRefund)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    )}
                    {visibleLines.income_sales && (
                      <Area
                        type="monotone"
                        dataKey="income_sales"
                        stroke="hsl(var(--chart-2))"
                        fill="url(#fillSales)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    )}
                  </AreaChart>
                </ChartContainer>
              ) : (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  暂无趋势数据
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="dashboard-surface animate-enter">
            <CardHeader className="relative z-10 pb-2">
              <CardTitle className="text-base">月度财务明细</CardTitle>
              <CardDescription className="text-sm text-muted-foreground">
                {data ? `${data.project_name} · ${formatMonth(data.start_month)} 至 ${formatMonth(data.end_month)}` : '按月展示收入/支出结构与返款'}
              </CardDescription>
            </CardHeader>
            <CardContent className="relative z-10 min-w-0">
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : data && data.rows.length > 0 ? (
                <div className="w-full max-w-full overflow-x-auto rounded-md border">
                <Table className={`w-max ${isAdmin ? 'min-w-[2200px]' : 'min-w-[1800px]'} table-fixed text-xs`}>
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead
                          rowSpan={2}
                          className="sticky z-40 border-r border-border bg-muted px-2 py-2 text-center"
                          style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                        >
                          年/月度
                        </TableHead>
                        <TableHead
                          colSpan={4}
                          className="border-r bg-emerald-100 px-2 py-2 text-center text-foreground dark:bg-emerald-900"
                        >
                          平台-收入 Income
                        </TableHead>
                        <TableHead colSpan={6} className="border-r bg-amber-500/15 px-2 py-2 text-center text-foreground">平台-支出 Expense</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">收入合计</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">支出合计</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">亚马逊回款</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">信用卡扣款</TableHead>
                        {isAdmin ? (
                          <>
                            <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">测评费用RMB</TableHead>
                            <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">垫付其他RMB</TableHead>
                            <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">运营佣金RMB</TableHead>
                            <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">应付总计RMB</TableHead>
                            <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">汇率</TableHead>
                          </>
                        ) : null}
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">平台占比</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">配送占比</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">仓储占比</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">服务占比</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">广告占比</TableHead>
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">退款率</TableHead>
                        <TableHead rowSpan={2} className="px-2 py-2 text-center">回款率</TableHead>
                      </TableRow>
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900">
                          销售额
                        </TableHead>
                        <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900">
                          退款
                        </TableHead>
                        <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900">
                          赔偿
                        </TableHead>
                        <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900">
                          其他收入
                        </TableHead>
                        <TableHead className="border-r bg-amber-500/10 px-2 py-1.5 text-center">平台费</TableHead>
                        <TableHead className="border-r bg-amber-500/10 px-2 py-1.5 text-center">配送费</TableHead>
                        <TableHead className="border-r bg-amber-500/10 px-2 py-1.5 text-center">仓储费</TableHead>
                        <TableHead className="border-r bg-amber-500/10 px-2 py-1.5 text-center">服务费</TableHead>
                        <TableHead className="border-r bg-amber-500/10 px-2 py-1.5 text-center">广告费</TableHead>
                        <TableHead className="border-r bg-amber-500/10 px-2 py-1.5 text-center">其他费用</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.rows.map((row) => {
                        const exchangeRate = exchangeRateByMonth[row.report_month] ?? 0
                        const creditCardUsd = row.credit_card_deduction_usd
                        const evaluationFeeRmb = 0
                        const prepaymentOtherRmb = 0
                        const operationCommission = resolveOperationCommissionUsd({
                          commissionBasis,
                          configuredCommissionRate: commissionRate,
                          incomeTotalUsd: row.income_total,
                          amazonPaybackUsd: row.amazon_pay_back,
                        })
                        const operationCommissionRmb = operationCommission.commissionUsd * exchangeRate
                        const payableTotalRmb = evaluationFeeRmb + prepaymentOtherRmb + operationCommissionRmb
                        const rowBg = !row.has_source_report ? 'bg-muted' : 'bg-background'
                        const platformRatio = toPositiveRatio(row.expense_selling_fee, row.income_total)
                        const deliveryRatio = toPositiveRatio(row.expense_fba_fee, row.income_total)
                        const storageRatio = toPositiveRatio(row.expense_inventory_fee, row.income_total)
                        const serviceRatio = toPositiveRatio(row.expense_service_fee, row.income_total)
                        const adRatio = toPositiveRatio(row.expense_advertising, row.income_total)
                        const refundRatio = toPositiveRatio(row.income_refund, row.income_sales)
                        const paybackRatio = toSignedRatio(row.amazon_pay_back, row.income_total)

                        return (
                        <TableRow key={row.report_month} className={!row.has_source_report ? 'bg-muted/20' : undefined}>
                          <TableCell
                            className={`sticky z-20 border-r border-border px-2 py-1.5 font-medium ${rowBg}`}
                            style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="whitespace-nowrap">{formatMonth(row.report_month)}</span>
                              {!row.has_source_report ? (
                                <Badge
                                  variant="outline"
                                  className="h-4 whitespace-nowrap rounded-sm border-amber-500/30 bg-amber-500/10 px-1 text-[9px] leading-none text-amber-700 dark:text-amber-300"
                                >
                                  无
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_sales)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_refund)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_adjustment)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_other)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(row.expense_selling_fee)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(row.expense_fba_fee)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(row.expense_inventory_fee)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(row.expense_service_fee)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(row.expense_advertising)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(row.expense_other_fees)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">{formatCurrency(row.income_total)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">{formatCurrency(row.expense_total)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">{formatCurrency(row.amazon_pay_back)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatCurrency(creditCardUsd)}</TableCell>
                          {isAdmin ? (
                            <>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRmb(evaluationFeeRmb)}</TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRmb(prepaymentOtherRmb)}</TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{disableCommission ? '-' : formatRmb(operationCommissionRmb)}</TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">{disableCommission ? '-' : formatRmb(payableTotalRmb)}</TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRate(exchangeRate)}</TableCell>
                            </>
                          ) : null}
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRatio(platformRatio)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRatio(deliveryRatio)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRatio(storageRatio)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRatio(serviceRatio)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRatio(adRatio)}</TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">{formatRatio(refundRatio)}</TableCell>
                          <TableCell className="px-2 py-1.5 text-right tabular-nums">{formatSignedRatio(paybackRatio)}</TableCell>
                        </TableRow>
                      )})}
                    </TableBody>
                    <TableFooter>
                      <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                        <TableCell
                          className="sticky z-20 border-r border-border bg-muted/40 px-2 py-2"
                          style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                        >
                          合计
                        </TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                          {formatCurrency(totals.income_sales)}
                        </TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                          {formatCurrency(totals.income_refund)}
                        </TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                          {formatCurrency(totals.income_adjustment)}
                        </TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                          {formatCurrency(totals.income_other)}
                        </TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_selling_fee)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_fba_fee)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_inventory_fee)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_service_fee)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_advertising)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_other_fees)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.income_total)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.expense_total)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.amazon_pay_back)}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatCurrency(totals.credit_card_deduction_usd)}</TableCell>
                        {isAdmin ? (
                          <>
                            <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRmb(totals.evaluation_fee_rmb)}</TableCell>
                            <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRmb(totals.prepayment_other_rmb)}</TableCell>
                            <TableCell className="border-r px-2 py-2 text-right tabular-nums">{disableCommission ? '-' : formatRmb(totals.operation_commission_rmb)}</TableCell>
                            <TableCell className="border-r px-2 py-2 text-right tabular-nums">{disableCommission ? '-' : formatRmb(totals.payable_total_rmb)}</TableCell>
                            <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRate(totals.exchange_rate_count > 0 ? totals.exchange_rate_sum / totals.exchange_rate_count : 0)}</TableCell>
                          </>
                        ) : null}
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRatio(toPositiveRatio(totals.expense_selling_fee, totals.income_total))}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRatio(toPositiveRatio(totals.expense_fba_fee, totals.income_total))}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRatio(toPositiveRatio(totals.expense_inventory_fee, totals.income_total))}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRatio(toPositiveRatio(totals.expense_service_fee, totals.income_total))}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRatio(toPositiveRatio(totals.expense_advertising, totals.income_total))}</TableCell>
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">{formatRatio(toPositiveRatio(totals.income_refund, totals.income_sales))}</TableCell>
                        <TableCell className="px-2 py-2 text-right tabular-nums">{formatSignedRatio(toSignedRatio(totals.amazon_pay_back, totals.income_total))}</TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  当前筛选条件暂无财务数据
                </div>
              )}
            </CardContent>
          </Card>

        </CardContent>
      </Card>
    </div>
  )
}
