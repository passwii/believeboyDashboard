'use client'

import { BarChart3 } from 'lucide-react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

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
import { formatCompactCurrency, formatDate } from './v2-format'

type ChannelRow = { date: string; sales_amount: number; ad_spend: number }

export interface V2ChannelChartProps {
  currentRows: ChannelRow[]
  comparisonRows?: ChannelRow[]
}

const chartConfig = {
  sales_amount: {
    label: '销售额',
    color: '#2563eb',
  },
  ad_spend: {
    label: '广告花费',
    color: '#60a5fa',
  },
} satisfies ChartConfig

export function V2ChannelChart({ currentRows, comparisonRows = [] }: V2ChannelChartProps) {
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  const data = currentRows.map((r) => ({
    day: formatDate(r.date, 'day-month'),
    sales_amount: r.sales_amount,
    ad_spend: r.ad_spend,
  }))

  return (
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-[hsl(var(--surface-subtle)/0.4)] col-span-2">
      <CardHeader>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
              <BarChart3 className="size-4" />
            </span>
            <CardTitle>销售额 vs 广告花费</CardTitle>
            <Delta value={delta} variant="badge">
              <DeltaIcon variant="trend" />
              <DeltaValue />
            </Delta>
          </div>
          <CardDescription>每日销售额与广告花费对比（近 7 天，双轴）</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer className="aspect-auto h-60 w-full p-0 md:h-80" config={chartConfig}>
          <LineChart
            accessibilityLayer
            data={data}
            margin={{ left: 4, right: 4, top: 8 }}
          >
            <CartesianGrid className="stroke-blue-100 dark:stroke-[hsl(var(--border)/0.6)]" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="day"
              interval={0}
              tickFormatter={(value) => String(value)}
              tickLine={false}
              tickMargin={8}
            />
            {/* 销售额 / 广告花费量级差异大，分左右双轴 */}
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
              tickFormatter={(value) => formatCompactCurrency(Number(value))}
              tickLine={false}
              width={52}
              yAxisId="right"
            />
            <ChartTooltip
              content={<ChartTooltipContent />}
              cursor={{ stroke: 'var(--border)', strokeDasharray: '4 4' }}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              activeDot={{ r: 4 }}
              dataKey="sales_amount"
              dot={false}
              strokeWidth={2.5}
              type="monotone"
              yAxisId="left"
            />
            <Line
              activeDot={{ r: 4 }}
              dataKey="ad_spend"
              dot={false}
              strokeDasharray="6 4"
              strokeWidth={2}
              type="monotone"
              yAxisId="right"
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </V2Card>
  )
}
