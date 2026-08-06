'use client'

import { Bar, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { Activity } from 'lucide-react'

import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { fmtNumPrecise } from '@/lib/dashboard-format'

import { V2Card } from './v2-card'

export interface V2TrafficRow {
  date: string
  page_views: number
  units_ordered: number
  sessions: number
}

export interface V2TrafficStats {
  totalPageViews: number
  totalSessions: number
  totalUnitsOrdered: number
  /** units_ordered / page_views × 100 */
  conversionRatePct: number
}

/** 汇总流量指标（纯函数，供测试） */
export function computeTrafficStats(rows: V2TrafficRow[]): V2TrafficStats {
  let totalPageViews = 0
  let totalSessions = 0
  let totalUnitsOrdered = 0
  for (const r of rows) {
    totalPageViews += r.page_views ?? 0
    totalSessions += r.sessions ?? 0
    totalUnitsOrdered += r.units_ordered ?? 0
  }
  const conversionRatePct = totalPageViews > 0 ? (totalUnitsOrdered / totalPageViews) * 100 : 0
  return { totalPageViews, totalSessions, totalUnitsOrdered, conversionRatePct }
}

export interface V2TrafficChartProps {
  currentRows: V2TrafficRow[]
  loading?: boolean
}

const chartConfig = {
  page_views: {
    label: '浏览量',
    color: '#93c5fd',
  },
  conversion_rate: {
    label: '转化率',
    color: '#2563eb',
  },
} satisfies ChartConfig

/** ISO 日期 → "M/D" */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2TrafficChart({ currentRows, loading }: V2TrafficChartProps) {
  const rows = currentRows.map((r) => {
    const pv = r.page_views ?? 0
    return {
      day: dayLabel(r.date),
      page_views: pv,
      conversion_rate: pv > 0 ? ((r.units_ordered ?? 0) / pv) * 100 : 0,
    }
  })
  const stats = computeTrafficStats(currentRows)

  return (
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-blue-950/30 md:col-span-2">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-300">
            <Activity className="size-4" />
          </span>
          <CardTitle>流量与转化</CardTitle>
        </div>
        <CardDescription>浏览量趋势与转化率（近 7 天）</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length > 0 ? (
          <ChartContainer className="aspect-auto h-52 w-full md:h-64" config={chartConfig}>
            <ComposedChart
              accessibilityLayer
              data={rows}
              margin={{ left: 4, right: 4, top: 4 }}
            >
              <XAxis
                axisLine={false}
                dataKey="day"
                interval={0}
                tickFormatter={(value) => String(value)}
                tickLine={false}
                tickMargin={8}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                width={44}
                yAxisId="left"
              />
              <YAxis
                axisLine={false}
                orientation="right"
                tickFormatter={(value) => `${Number(value)}%`}
                tickLine={false}
                width={44}
                yAxisId="right"
              />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
              <Bar dataKey="page_views" fill="var(--color-page_views)" radius={[2, 2, 0, 0]} yAxisId="left" />
              <Line
                dataKey="conversion_rate"
                dot={false}
                stroke="var(--color-conversion_rate)"
                strokeWidth={2}
                type="monotone"
                yAxisId="right"
              />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
            {loading ? '加载中…' : '暂无流量数据'}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 px-5 py-3">
        <span className="text-xs text-muted-foreground">
          总浏览量 <b className="ml-1 tabular-nums text-blue-700 dark:text-blue-300">{fmtNumPrecise(stats.totalPageViews)}</b>
        </span>
        <span className="text-xs text-muted-foreground">
          访客数 <b className="ml-1 tabular-nums text-blue-700 dark:text-blue-300">{fmtNumPrecise(stats.totalSessions)}</b>
        </span>
        <span className="text-xs text-muted-foreground">
          转化订单 <b className="ml-1 tabular-nums text-blue-700 dark:text-blue-300">{fmtNumPrecise(stats.totalUnitsOrdered)}</b>
        </span>
        <span className="text-xs text-muted-foreground">
          平均转化率{' '}
          <b className="ml-1 tabular-nums text-blue-700 dark:text-blue-300">{stats.conversionRatePct.toFixed(2)}%</b>
        </span>
      </CardFooter>
    </V2Card>
  )
}
