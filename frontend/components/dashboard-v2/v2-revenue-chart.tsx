'use client'

import type * as React from 'react'
import { TrendingUp } from 'lucide-react'
import { Bar, BarChart, Line, XAxis, YAxis } from 'recharts'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
import { formatCompactCurrency } from './v2-format'

type RevenueRow = { date: string; sales_amount: number; units_ordered: number }

export interface V2RevenueChartProps {
  currentRows: RevenueRow[]
  comparisonRows?: RevenueRow[]
}

const chartConfig = {
  sales: {
    label: '销售额',
    color: '#2563eb',
  },
  volume: {
    label: '销量',
    color: '#60a5fa',
  },
} satisfies ChartConfig

function CustomGradientBar(
  props: React.SVGProps<SVGRectElement> & {
    index?: number
    dataKey?: string | number
  }
) {
  const { fill, x = 0, y = 0, width = 0, height = 0, dataKey = 'sales', index = 0 } = props
  const gid = `v2-gradient-bar-${String(dataKey)}-${index}`

  return (
    <>
      <rect fill={`url(#${gid})`} height={height} stroke="none" width={width} x={x} y={y} />
      <rect fill={fill} height={2} stroke="none" width={width} x={x} y={y} />
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity={0.5} />
          <stop offset="100%" stopColor={fill} stopOpacity={0} />
        </linearGradient>
      </defs>
    </>
  )
}

/** ISO 日期 → "M/D"（与 v1 page.tsx dateLabels 同口径） */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2RevenueChart({ currentRows, comparisonRows = [] }: V2RevenueChartProps) {
  // 销售额（左轴柱） + 销量（右轴折线）—— 复合图增强数据观察性
  const chartRows = currentRows.map((r) => ({
    day: dayLabel(r.date),
    sales: r.sales_amount,
    volume: r.units_ordered ?? 0,
  }))
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  return (
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-blue-950/30 md:col-span-2">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-300">
            <TrendingUp className="size-4" />
          </span>
          <CardTitle>销售额</CardTitle>
          <Delta value={delta} variant="badge">
            <DeltaIcon variant="trend" />
            <DeltaValue />
          </Delta>
        </div>
        <CardDescription>每日销售额与销量（近 7 天）</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer className="aspect-auto h-60 w-full md:h-80" config={chartConfig}>
          <BarChart
            accessibilityLayer
            data={chartRows}
            margin={{ left: 4, right: 4, top: 8 }}
          >
            <XAxis
              axisLine={false}
              dataKey="day"
              interval={0}
              tickFormatter={(value) => String(value)}
              tickLine={false}
              tickMargin={10}
            />
            {/* 销售额 / 销量量级差异大，分左右双轴 */}
            <YAxis
              axisLine={false}
              tickFormatter={(value) => formatCompactCurrency(Number(value))}
              tickLine={false}
              width={52}
              yAxisId="left"
            />
            <YAxis
              axisLine={false}
              orientation="right"
              tickLine={false}
              width={44}
              yAxisId="right"
            />
            <ChartTooltip
              content={<ChartTooltipContent hideLabel />}
              cursor={{ stroke: 'var(--border)', strokeDasharray: '4 4' }}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar
              dataKey="sales"
              fill="var(--color-sales)"
              shape={<CustomGradientBar />}
              yAxisId="left"
            />
            <Line
              activeDot={{ r: 4 }}
              dataKey="volume"
              dot={false}
              stroke="var(--color-volume)"
              strokeWidth={2.5}
              type="monotone"
              yAxisId="right"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </V2Card>
  )
}
