'use client'

import { useMemo } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { BarChart3, DollarSign, Megaphone, RefreshCcw } from 'lucide-react'

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import { cn } from '@/lib/utils'
import {
  fmtMoneyPrecise,
  fmtPct,
  generateDateRangeStrings,
  formatMoney,
  formatAxisMoney,
} from '@/lib/dashboard-format'

import type { DashboardDailyData } from '@/app/dashboard/v1/page'

const CHART_CONFIG = {
  sales_amount: { label: '销售额', color: 'hsl(var(--chart-1))' },
  ad_spend: { label: '广告花费', color: 'hsl(var(--chart-4))' },
  compare_sales: { label: '上一周期销售额', color: 'rgba(148,163,184,0.8)' },
} satisfies ChartConfig

interface DashboardAdSpendChartProps {
  dailyData: DashboardDailyData
  dateRange: { from: Date; to: Date }
  loading?: boolean
  onRefresh?: () => void
}

export function DashboardAdSpendChart({
  dailyData,
  dateRange,
  loading = false,
  onRefresh,
}: DashboardAdSpendChartProps) {
  const { currentRows, comparisonRows } = dailyData

  const totalSales = useMemo(
    () => currentRows.reduce((s, r) => s + (r.sales_amount ?? 0), 0),
    [currentRows]
  )
  const totalAdSpend = useMemo(
    () => currentRows.reduce((s, r) => s + (r.ad_spend ?? 0), 0),
    [currentRows]
  )
  const prevSales = useMemo(
    () => comparisonRows.reduce((s, r) => s + (r.sales_amount ?? 0), 0),
    [comparisonRows]
  )
  const prevAdSpend = useMemo(
    () => comparisonRows.reduce((s, r) => s + (r.ad_spend ?? 0), 0),
    [comparisonRows]
  )

  const salesChange = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : null
  const adSpendChange = prevAdSpend > 0 ? ((totalAdSpend - prevAdSpend) / prevAdSpend) * 100 : null

  /** 投放比 = ad_spend / sales_amount * 100,首页 KPI"广告投放比"同口径 */
  const acos = totalSales > 0 ? (totalAdSpend / totalSales) * 100 : 0
  const acosBadge = useMemo(() => {
    if (acos <= 20) return { label: '优秀', color: 'green' as const }
    if (acos <= 40) return { label: '正常', color: 'yellow' as const }
    return { label: '偏高', color: 'red' as const }
  }, [acos])

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
        ad_spend: row?.ad_spend ?? 0,
        compare_sales: compareRow?.sales_amount ?? null,
      }
    })
  }, [currentRows, comparisonRows, dateRange])

  const hasComparison = comparisonRows.length > 0
  const isMobile = useIsMobile()
  const isEmpty = currentRows.length === 0

  return (
    <DataCard className="h-full">
      <DataCardHeader
        title="销售 vs 广告花费"
        description="按日聚合 · 双 Y 轴对比 · 含上一周期虚线"
        action={
          onRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onRefresh}
              disabled={loading}
              className="h-7 w-7"
              aria-label="刷新数据"
            >
              <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          ) : null
        }
      />
      <DataCardContent className="space-y-4">
        {isEmpty ? (
          <EmptyChartState />
        ) : (
          <>
            {/* 顶部三 KPI:销售额 / 投放比 / 广告花费 */}
            <div className="grid grid-cols-3 gap-3">
              <KpiItem
                icon={<DollarSign className="h-3.5 w-3.5" />}
                label="销售额"
                value={fmtMoneyPrecise(totalSales)}
                change={salesChange}
                accent="chart-1"
              />
              <KpiItem
                icon={<BarChart3 className="h-3.5 w-3.5" />}
                label="投放比"
                value={`${acos.toFixed(1)}%`}
                badge={acosBadge.label}
                badgeColor={acosBadge.color}
                accent="chart-3"
              />
              <KpiItem
                icon={<Megaphone className="h-3.5 w-3.5" />}
                label="广告花费"
                value={fmtMoneyPrecise(totalAdSpend)}
                change={adSpendChange}
                accent="chart-4"
              />
            </div>

            <ChartContainer config={CHART_CONFIG} className="h-[260px] sm:h-[320px] w-full">
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
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(v) => {
                    const [, m, d] = String(v).split('-')
                    return `${m}/${d}`
                  }}
                />
                <YAxis
                  yAxisId="sales"
                  orientation="left"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatAxisMoney(Number(v))}
                  width={isMobile ? 0 : 36}
                  tick={isMobile ? false : { fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis
                  yAxisId="ad_spend"
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatAxisMoney(Number(v))}
                  width={isMobile ? 0 : 36}
                  tick={isMobile ? false : { fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                />
                <ChartTooltip
                  cursor={{ stroke: 'rgba(15,23,42,0.18)', strokeDasharray: '4 4' }}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
                      formatter={(value, name) => {
                        const label =
                          typeof name === 'string'
                            ? ((CHART_CONFIG as Record<string, { label?: string }>)[name]?.label ??
                              name)
                            : String(name)
                        if (
                          name === 'sales_amount' ||
                          name === 'ad_spend' ||
                          name === 'compare_sales'
                        ) {
                          return [`$${formatMoney(Number(value))}`, label]
                        }
                        return [String(value), label]
                      }}
                    />
                  }
                />
                {hasComparison && (
                  <Line
                    yAxisId="sales"
                    type="monotone"
                    dataKey="compare_sales"
                    stroke="rgba(148,163,184,0.8)"
                    strokeWidth={2}
                    strokeDasharray="6 6"
                    dot={false}
                  />
                )}
                <Bar
                  yAxisId="sales"
                  dataKey="sales_amount"
                  fill="var(--color-sales_amount)"
                  radius={[8, 8, 0, 0]}
                  barSize={16}
                />
                <Line
                  yAxisId="ad_spend"
                  type="monotone"
                  dataKey="ad_spend"
                  stroke="var(--color-ad_spend)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 5, fill: 'hsl(var(--chart-4))' }}
                />
              </ComposedChart>
            </ChartContainer>
          </>
        )}
      </DataCardContent>
    </DataCard>
  )
}

interface KpiItemProps {
  icon: React.ReactNode
  label: string
  value: string
  change?: number | null
  badge?: string
  badgeColor?: 'green' | 'yellow' | 'red'
  accent: 'chart-1' | 'chart-3' | 'chart-4'
}

function KpiItem({ icon, label, value, change, badge, badgeColor, accent }: KpiItemProps) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2.5">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
          <span
            className="flex h-4 w-4 items-center justify-center rounded text-white/90"
            style={{ backgroundColor: `hsl(var(--${accent}) / 0.85)` }}
          >
            {icon}
          </span>
          <span>{label}</span>
        </div>
        {badge && (
          <Badge
            variant="outline"
            className={cn(
              'px-1.5 py-0 text-[10px]',
              badgeColor === 'green' &&
                'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              badgeColor === 'yellow' &&
                'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
              badgeColor === 'red' && 'border-destructive/40 bg-destructive/10 text-destructive'
            )}
          >
            {badge}
          </Badge>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="dashboard-display text-[clamp(1.1rem,0.95rem+0.6vw,1.6rem)] leading-none tabular-nums">
          {value}
        </span>
        {change !== undefined && change !== null && Number.isFinite(change) && (
          <span
            className={cn(
              'shrink-0 text-[11px] font-medium tabular-nums',
              change > 0.5 && 'text-emerald-600 dark:text-emerald-400',
              change < -0.5 && 'text-destructive',
              change >= -0.5 && change <= 0.5 && 'text-muted-foreground'
            )}
          >
            {fmtPct(change)}
          </span>
        )}
      </div>
    </div>
  )
}

function EmptyChartState() {
  return (
    <div className="flex h-[260px] sm:h-[320px] flex-col items-center justify-center text-center">
      <div className="mb-2 rounded-xl bg-secondary/10 p-2.5 text-secondary">
        <BarChart3 className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">暂无销售/广告数据</p>
      <p className="mt-1 max-w-[260px] text-xs leading-relaxed text-muted-foreground">
        当前时段没有可展示的销售或广告花费数据。
      </p>
    </div>
  )
}
