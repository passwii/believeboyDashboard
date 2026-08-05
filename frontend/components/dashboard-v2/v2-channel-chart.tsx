'use client'

import { useId } from 'react'
import { CartesianGrid, Line, LineChart, XAxis } from 'recharts'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
import { formatDate } from './v2-format'

type ChannelRow = { date: string; sales_amount: number; ad_spend: number }

export interface V2ChannelChartProps {
  currentRows: ChannelRow[]
  comparisonRows?: ChannelRow[]
}

const chartConfig = {
  sales: {
    label: '销售额',
    color: 'var(--chart-1)',
  },
  ad_spend: {
    label: '广告花费',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig

export function V2ChannelChart({ currentRows, comparisonRows = [] }: V2ChannelChartProps) {
  const chartUid = useId().replace(/:/g, '')
  const idLineGlow = `v2-channel-line-glow-${chartUid}`

  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  return (
    <V2Card className="gap-0 transition-colors hover:bg-muted/50 md:col-span-2">
      <CardHeader>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>销售额 vs 广告花费</CardTitle>
            <Delta value={delta} variant="badge">
              <DeltaIcon variant="trend" />
              <DeltaValue />
            </Delta>
          </div>
          <CardDescription>每日销售额与广告花费对比（近 7 天）</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer className="aspect-auto h-60 w-full p-0 md:h-80" config={chartConfig}>
          <LineChart
            accessibilityLayer
            data={currentRows}
            margin={{ left: 12, right: 12, top: 8 }}
          >
            <CartesianGrid className="stroke-border" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="date"
              interval={0}
              tickFormatter={(value) => formatDate(String(value), 'day-month')}
              tickLine={false}
              tickMargin={8}
            />
            <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
            <defs>
              <filter height="140%" id={idLineGlow} width="140%" x="-20%" y="-20%">
                <feGaussianBlur result="blur" stdDeviation="10" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <Line
              dataKey="sales_amount"
              dot={false}
              filter={`url(#${idLineGlow})`}
              stroke="var(--color-sales)"
              strokeWidth={2}
              type="step"
            />
            <Line
              dataKey="ad_spend"
              dot={false}
              filter={`url(#${idLineGlow})`}
              stroke="var(--color-ad_spend)"
              strokeWidth={2}
              type="step"
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </V2Card>
  )
}
