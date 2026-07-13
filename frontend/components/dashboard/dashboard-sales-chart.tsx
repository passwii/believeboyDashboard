'use client'

import { useMemo } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { DateRange } from 'react-day-picker'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { ArrowDown, ArrowUp, DollarSign, ShoppingBag } from 'lucide-react'

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
import { RefreshButton } from '@/components/dashboard/console'
import { cn } from '@/lib/utils'
import {
  formatYMD,
  generateDateRangeStrings,
  formatMoney,
  formatAxisMoney,
} from '@/lib/dashboard-format'

import type { DashboardDailyData } from '@/app/dashboard/page'

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

type ProjectOption = { id: number | null; name: string }

const CHART_CONFIG = {
  sales_amount: { label: '销售额', color: 'hsl(var(--chart-1))' },
  order_qty: { label: '订单量', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig

interface DashboardSalesChartProps {
  dailyData: DashboardDailyData
  dateRange: { from: Date; to: Date }
  projects: ProjectOption[]
  loading?: boolean
  onRefresh?: () => void
}

export function DashboardSalesChart({ dailyData, dateRange, projects, loading = false, onRefresh }: DashboardSalesChartProps) {
  const { currentRows, comparisonRows } = dailyData

  const totalSales = useMemo(
    () => currentRows.reduce((sum, row) => sum + row.sales_amount, 0),
    [currentRows],
  )
  const totalOrders = useMemo(
    () => currentRows.reduce((sum, row) => sum + row.order_qty, 0),
    [currentRows],
  )
  const prevSales = useMemo(
    () => comparisonRows.reduce((sum, row) => sum + row.sales_amount, 0),
    [comparisonRows],
  )
  const prevOrders = useMemo(
    () => comparisonRows.reduce((sum, row) => sum + row.order_qty, 0),
    [comparisonRows],
  )
  const salesChange = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : null
  const ordersChange = prevOrders > 0 ? ((totalOrders - prevOrders) / prevOrders) * 100 : null

  const chartRows = useMemo(() => {
    const allDates = generateDateRangeStrings(dateRange.from, dateRange.to)
    const dataMap = new Map(currentRows.map((row) => [row.date, row]))
    const compareByIndex = comparisonRows

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
  }, [currentRows, comparisonRows, dateRange])

  const hasComparison = comparisonRows.length > 0
  const isMobile = useIsMobile()

  return (
    <DataCard>
      <DataCardHeader
        title="销售概览"
        action={
          onRefresh ? (
            <RefreshButton
              onClick={onRefresh}
              loading={loading}
              label="刷新"
              variant="outline"
              size="default"
              className="h-8 px-3"
            />
          ) : undefined
        }
      />
      <DataCardContent className="space-y-4">
        {currentRows.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-[hsl(var(--surface-soft))]/60 px-2.5 py-2 min-w-0">
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
            <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-[hsl(var(--surface-soft))]/60 px-2.5 py-2 min-w-[13rem]">
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

        {currentRows.length > 0 ? (
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
                margin={{ top: 10, right: 4, left: isMobile ? -8 : 0, bottom: 8 }}
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
                  tick={isMobile ? false : { fontSize: 10, fill: '#71717a' }}
                  tickFormatter={(v) => formatAxisMoney(Number(v))}
                  width={isMobile ? 0 : 36}
                />
                <YAxis
                  yAxisId="orders"
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={4}
                  tick={isMobile ? false : { fontSize: 10, fill: '#71717a' }}
                  tickFormatter={(v) => Number(v).toLocaleString('zh-CN')}
                  width={isMobile ? 0 : 32}
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
                {hasComparison && (
                  <Bar
                    yAxisId="sales"
                    dataKey="compare_sales"
                    name="上一周期销售额"
                    fill="rgba(148,163,184,0.22)"
                    radius={[8, 8, 0, 0]}
                    barSize={16}
                    isAnimationActive
                    animationDuration={300}
                  />
                )}
                <Bar
                  yAxisId="sales"
 dataKey="sales_amount"
 name="sales_amount"
                    fill="var(--color-sales_amount)"
                    radius={[8, 8, 0, 0]}
                    barSize={16}
                  isAnimationActive
                  animationDuration={360}
                  animationEasing="ease-out"
                />
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
                请前往每日销售分析页面查看详细数据
              </div>
            </div>
          </div>
        )}
      </DataCardContent>
    </DataCard>
  )
}