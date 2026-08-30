'use client'

import { BarChart3 } from 'lucide-react'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { LineChartCard, buildChartConfig } from '@/components/charts'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
import { formatCompactCurrency, formatDate } from './v2-format'

type ChannelRow = { date: string; sales_amount: number; ad_spend: number }

export interface V2ChannelChartProps {
  currentRows: ChannelRow[]
  comparisonRows?: ChannelRow[]
}

const chartConfig = buildChartConfig(
  ['sales_amount', 'ad_spend'],
  { sales_amount: '销售额', ad_spend: '广告花费' }
)

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
        <LineChartCard
          data={data}
          xKey="day"
          config={chartConfig}
          dualAxis
          yTickFormatter={formatCompactCurrency}
          rightYFormatter={formatCompactCurrency}
          series={[
            { dataKey: 'sales_amount', name: '销售额', yAxisId: 'left' },
            {
              dataKey: 'ad_spend',
              name: '广告花费',
              yAxisId: 'right',
              lineProps: { strokeDasharray: '6 4', strokeWidth: 2 },
            },
          ]}
        />
      </CardContent>
    </V2Card>
  )
}