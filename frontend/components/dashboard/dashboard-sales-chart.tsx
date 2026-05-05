'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWindowSize } from 'usehooks-ts'
import { DateRange } from 'react-day-picker'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { ArrowDown, ArrowUp, DollarSign, ShoppingBag } from 'lucide-react'
import type { Session } from 'next-auth'

import { RefreshButton } from '@/components/dashboard/console'
import { Badge } from '@/components/ui/badge'
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
} from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { cn } from '@/lib/utils'

type ProjectOption = {
  id: number | null
  name: string
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

type DailyAnalysisAllProjectsResponse = {
  summary_rows: DailyAnalysisRow[]
  detail_rows: unknown[]
  available_dates: Record<string, string[]>
}

const API_BASE = '/api/backend'
const DEFAULT_COUNTRY = 'US'
const US_TIMEZONE = 'America/Los_Angeles'

const CHART_CONFIG = {
  sales_amount: { label: '销售额', color: 'hsl(var(--chart-1))' },
  order_qty: { label: '订单量', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig

// ── Date utilities ──

function getTodayInTimezone(tz: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function addDays(date: Date, amount: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function normalizeDateRange(range?: DateRange) {
  if (!range?.from || !range?.to) return undefined
  const from = new Date(range.from)
  const to = new Date(range.to)
  from.setHours(0, 0, 0, 0)
  to.setHours(0, 0, 0, 0)
  return { from, to }
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

function lastSevenDaysRange(): DateRange {
  const today = getTodayInTimezone(US_TIMEZONE)
  const end = today
  const start = addDays(end, -6)
  return { from: start, to: end }
}

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatAxisMoney(value: number) {
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`
  return `$${value.toFixed(0)}`
}

function getPreviousPeriodRange(range?: DateRange): DateRange | undefined {
  const normalized = normalizeDateRange(range)
  if (!normalized) return undefined
  const dayCount = Math.floor(
    (normalized.to.getTime() - normalized.from.getTime()) / 86400000,
  ) + 1
  return {
    from: addDays(normalized.from, -dayCount),
    to: addDays(normalized.from, -1),
  }
}

// ── Component ──

interface DashboardSalesChartProps {
  session?: Session | null
}

export function DashboardSalesChart({ session }: DashboardSalesChartProps) {
  const { notify } = useNotifications()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const defaultRange = useMemo(() => lastSevenDaysRange(), [])
  const [dateRange] = useState<DateRange | undefined>(defaultRange)
  const [data, setData] = useState<DailyAnalysisRow[]>([])
  const [comparisonData, setComparisonData] = useState<DailyAnalysisRow[]>([])
  const [loading, setLoading] = useState(false)
  const latestRequestRef = useRef(0)

  const { showSkeleton, isRefreshing } = useSmoothRefresh({
    loading,
    hasData: data.length > 0,
  })

  const { width: screenWidth } = useWindowSize()
  const isMobile = screenWidth < 640

  // Load projects
  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(rows.filter((item) => item.id !== null))
      } catch {
        notify({ type: 'error', title: '项目列表加载失败' })
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [notify, session])

  // Load data
  const loadData = useCallback(async () => {
    const effectiveRange = normalizeDateRange(dateRange)
    if (!effectiveRange?.from || !effectiveRange?.to) return
    if (projects.length === 0) return

    const startDate = formatYMD(effectiveRange.from)
    const endDate = formatYMD(effectiveRange.to)
    const ids = projects.map((p) => String(p.id)).join(',')
    const previousRange = getPreviousPeriodRange(effectiveRange)

    const requestId = latestRequestRef.current + 1
    latestRequestRef.current = requestId
    setLoading(true)

    try {
      const search = new URLSearchParams({
        project_ids: ids,
        country: DEFAULT_COUNTRY,
        start_date: startDate,
        end_date: endDate,
      })
      const compareSearch = previousRange
        ? new URLSearchParams({
            project_ids: ids,
            country: DEFAULT_COUNTRY,
            start_date: formatYMD(previousRange.from!),
            end_date: formatYMD(previousRange.to!),
          })
        : null

      const [response, compareResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/daily-analysis/all?${search.toString()}`, {
          cache: 'no-store',
        }),
        compareSearch
          ? fetch(
              `${API_BASE}/api/v1/daily-analysis/all?${compareSearch.toString()}`,
              { cache: 'no-store' },
            )
          : Promise.resolve(null),
      ])

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || '销售数据加载失败')
      }

      const payload = (await response.json()) as DailyAnalysisAllProjectsResponse
      const comparePayload = compareResponse?.ok
        ? ((await compareResponse.json()) as DailyAnalysisAllProjectsResponse)
        : null

      if (requestId !== latestRequestRef.current) return
      setData(payload.summary_rows)
      setComparisonData(comparePayload?.summary_rows ?? [])
    } catch (fetchError) {
      if (requestId !== latestRequestRef.current) return
      notify({
        type: 'error',
        title: '销售数据加载失败',
        message: fetchError instanceof Error ? fetchError.message : '加载失败',
      })
      setData([])
      setComparisonData([])
    } finally {
      if (requestId !== latestRequestRef.current) return
      setLoading(false)
    }
  }, [projects, dateRange, notify])

  useEffect(() => {
    if (projects.length > 0) void loadData()
  }, [projects, loadData])

  // ── Derived data ──

  const totalSales = useMemo(
    () => data.reduce((sum, row) => sum + row.sales_amount, 0),
    [data],
  )
  const totalOrders = useMemo(
    () => data.reduce((sum, row) => sum + row.order_qty, 0),
    [data],
  )
  const prevSales = useMemo(
    () => comparisonData.reduce((sum, row) => sum + row.sales_amount, 0),
    [comparisonData],
  )
  const prevOrders = useMemo(
    () => comparisonData.reduce((sum, row) => sum + row.order_qty, 0),
    [comparisonData],
  )
  const salesChange = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : null
  const ordersChange = prevOrders > 0 ? ((totalOrders - prevOrders) / prevOrders) * 100 : null

  const chartRows = useMemo(() => {
    const normalizedRange = normalizeDateRange(dateRange)
    if (!normalizedRange?.from || !normalizedRange?.to) return []
    const allDates = generateDateRangeStrings(normalizedRange.from, normalizedRange.to)
    const dataMap = new Map(data.map((row) => [row.date, row]))
    const compareByIndex = comparisonData

    return allDates.map((date, index) => {
      const row = dataMap.get(date)
      const compareRow = compareByIndex[index]
      return {
        date,
        sales_amount: row?.sales_amount ?? 0,
        order_qty: row?.order_qty ?? 0,
        compare_sales: compareRow?.sales_amount ?? null,
        compare_orders: compareRow?.order_qty ?? null,
      }
    })
  }, [data, comparisonData, dateRange])

  const hasComparison = comparisonData.length > 0

  return (
    <DataCard>
      <DataCardHeader
        title="销售概览"
        action={
          <RefreshButton
            onClick={() => void loadData()}
            loading={loading || projectsLoading}
            label="刷新"
            variant="outline"
            size="default"
            className="h-8 px-3"
          />
        }
      />
      <DataCardContent className="space-y-4">
        {/* Metric summary */}
        {data.length > 0 && (
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/80 px-3 py-3 min-w-[13rem]">
              <div className="rounded-md bg-primary/10 p-2 text-primary">
                <DollarSign className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    销售额
                  </p>
                  {salesChange !== null && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        'gap-1 text-[10px]',
                        salesChange >= 0
                          ? 'bg-secondary/10 text-secondary'
                          : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {salesChange >= 0 ? (
                        <ArrowUp className="h-2.5 w-2.5" />
                      ) : (
                        <ArrowDown className="h-2.5 w-2.5" />
                      )}
                      {Math.abs(salesChange).toFixed(1)}%
                    </Badge>
                  )}
                </div>
                <p className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
                  ${formatMoney(totalSales)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/80 px-3 py-3 min-w-[13rem]">
              <div className="rounded-md bg-[hsl(var(--chart-2))]/10 p-2 text-[hsl(var(--chart-2))]">
                <ShoppingBag className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    订单量
                  </p>
                  {ordersChange !== null && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        'gap-1 text-[10px]',
                        ordersChange >= 0
                          ? 'bg-secondary/10 text-secondary'
                          : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {ordersChange >= 0 ? (
                        <ArrowUp className="h-2.5 w-2.5" />
                      ) : (
                        <ArrowDown className="h-2.5 w-2.5" />
                      )}
                      {Math.abs(ordersChange).toFixed(1)}%
                    </Badge>
                  )}
                </div>
                <p className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
                  {totalOrders.toLocaleString('zh-CN')}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Chart */}
        {showSkeleton ? (
          <div className="space-y-3">
            <Skeleton className="h-[320px] w-full rounded-lg" />
          </div>
        ) : data.length > 0 ? (
          <div className="rounded-lg bg-[hsl(var(--surface-soft))]/82 p-2 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <div className="inline-flex items-center gap-2 rounded-full bg-background/72 px-3 py-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--chart-1))]" />
                销售额
              </div>
              <div className="inline-flex items-center gap-2 rounded-full bg-background/72 px-3 py-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--chart-2))]" />
                订单量
              </div>
              {hasComparison && (
                <div className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--surface-soft))] px-3 py-1.5 dark:bg-[hsl(var(--surface-strong))]">
                  <span className="w-5 border-t-2 border-dashed border-border/70" />
                  上一周期
                </div>
              )}
            </div>

            <ChartContainer
              config={CHART_CONFIG}
              className="h-[260px] sm:h-[320px] w-full"
            >
              <ComposedChart
                data={chartRows}
                margin={{ top: 10, right: 4, left: 0, bottom: 8 }}
              >
                <CartesianGrid
                  vertical={false}
                  stroke="rgba(148,163,184,0.18)"
                  strokeDasharray="0"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 11, fill: '#71717a' }}
                  tickFormatter={(value) => {
                    const [, month, day] = String(value).split('-')
                    return `${month}/${day}`
                  }}
                />
                <YAxis
                  yAxisId="sales"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={4}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  tickFormatter={(v) => formatAxisMoney(Number(v))}
                  width={36}
                />
                <YAxis
                  yAxisId="orders"
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={4}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  tickFormatter={(v) => Number(v).toLocaleString('zh-CN')}
                  width={32}
                />
                <ChartTooltip
                  cursor={{
                    stroke: 'rgba(15,23,42,0.18)',
                    strokeDasharray: '4 4',
                  }}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(_, payload) => {
                        const date = payload?.[0]?.payload?.date
                        return typeof date === 'string' ? date : ''
                      }}
                      formatter={(value, name) => (
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="font-medium">
                            {name === 'sales_amount' ? '销售额' : name === 'order_qty' ? '订单量' : String(name)}
                          </span>
                          <span className="font-mono font-medium text-foreground">
                            {name === 'sales_amount'
                              ? `$${formatMoney(Number(value))}`
                              : Number(value).toLocaleString('zh-CN')}
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                {/* Comparison bars (behind) */}
                {hasComparison && (
                  <Bar
                    yAxisId="sales"
                    dataKey="compare_sales"
                    name="上一周期销售额"
                    fill="rgba(148,163,184,0.22)"
                    radius={[6, 6, 0, 0]}
                    barSize={isMobile ? 10 : 14}
                    isAnimationActive
                    animationDuration={300}
                  />
                )}
                {/* Current bars */}
                <Bar
                  yAxisId="sales"
                  dataKey="sales_amount"
                  name="sales_amount"
                  fill="var(--color-sales_amount)"
                  radius={[6, 6, 0, 0]}
                  barSize={isMobile ? 10 : 14}
                  isAnimationActive
                  animationDuration={360}
                  animationEasing="ease-out"
                />
                {/* Comparison line */}
                {hasComparison && (
                  <Line
                    yAxisId="orders"
                    type="monotone"
                    dataKey="compare_orders"
                    name="上一周期订单量"
                    stroke="rgba(148,163,184,0.8)"
                    strokeWidth={2}
                    strokeDasharray="6 6"
                    dot={false}
                    isAnimationActive
                    animationDuration={300}
                  />
                )}
                {/* Current line */}
                <Line
                  yAxisId="orders"
                  type="monotone"
                  dataKey="order_qty"
                  name="order_qty"
                  stroke="var(--color-order_qty)"
                  strokeWidth={3}
                  dot={false}
                  isAnimationActive
                  animationDuration={360}
                  animationEasing="ease-out"
                  activeDot={{
                    r: 5,
                    fill: 'var(--color-order_qty)',
                    stroke: '#fff',
                    strokeWidth: 2,
                  }}
                />
              </ComposedChart>
            </ChartContainer>
          </div>
        ) : (
          <div className="flex min-h-[280px] items-center justify-center rounded-lg bg-[hsl(var(--surface-soft))]/82 px-6 text-center">
            <div className="space-y-2">
              <div className="text-base font-semibold text-foreground">
                暂无销售数据
              </div>
              <div className="text-sm text-muted-foreground">
                请前往日报分析页面查看详细数据
              </div>
            </div>
          </div>
        )}
      </DataCardContent>
    </DataCard>
  )
}
