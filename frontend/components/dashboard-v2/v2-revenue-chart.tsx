'use client'

import type * as React from 'react'
import { TrendingUp } from 'lucide-react'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ComposedChartCard, buildChartConfig } from '@/components/charts'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
import { formatCompactCurrency } from './v2-format'

type RevenueRow = { date: string; sales_amount: number; units_ordered: number }

export interface V2RevenueChartProps {
  currentRows: RevenueRow[]
  comparisonRows?: RevenueRow[]
}

const chartConfig = buildChartConfig(
  ['sales', 'volume'],
  { sales: '销售额', volume: '销量' }
)

function CustomGradientBar(
  props: React.SVGProps<SVGRectElement> & { fill?: string }
): React.ReactElement {
  const { fill, ...rest } = props
  return (
    <rect
      {...rest}
      fill={fill ?? 'var(--color-sales)'}
      style={{
        ...(rest.style as React.CSSProperties | undefined),
      }}
    />
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
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-[hsl(var(--surface-subtle)/0.4)] col-span-2">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
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
        <ComposedChartCard
          data={chartRows}
          xKey="day"
          config={chartConfig}
          dualAxis
          yTickFormatter={formatCompactCurrency}
          series={[
            { kind: 'bar', dataKey: 'sales', name: '销售额', yAxisId: 'left' },
            {
              kind: 'line',
              dataKey: 'volume',
              name: '销量',
              yAxisId: 'right',
            },
          ]}
        />
      </CardContent>
    </V2Card>
  )
}