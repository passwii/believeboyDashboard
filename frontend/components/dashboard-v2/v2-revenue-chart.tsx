'use client'

import { TrendingUp } from 'lucide-react'

import { ChartCard, ComposedChartCard, buildChartConfig } from '@/components/charts'
import { formatCompactCurrency } from './v2-format'

type RevenueRow = { date: string; sales_amount: number; units_ordered: number }

export interface V2RevenueChartProps {
  currentRows: RevenueRow[]
  comparisonRows?: RevenueRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(
  ['sales', 'volume'],
  { sales: '销售额', volume: '销量' }
)

/** ISO 日期 → "M/D" */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2RevenueChart({
  currentRows,
  comparisonRows = [],
  loading = false,
}: V2RevenueChartProps) {
  // 销售额（左轴柱） + 销量（右轴折线）—— 复合图增强数据观察性
  const chartRows = currentRows.map((r) => ({
    day: dayLabel(r.date),
    sales: r.sales_amount,
    volume: r.units_ordered ?? 0,
  }))
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0
  const hasData = chartRows.length > 0

  return (
    <ChartCard
      icon={<TrendingUp className="size-4" />}
      title="销售额"
      description="每日销售额与销量（近 7 天）"
      delta={{ value: delta, variant: 'badge' }}
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无销售数据"
      className="col-span-2"
    >
      <ComposedChartCard
        data={chartRows}
        xKey="day"
        config={chartConfig}
        dualAxis
        yTickFormatter={formatCompactCurrency}
        series={[
          { kind: 'bar', dataKey: 'sales', name: '销售额', yAxisId: 'left' },
          { kind: 'line', dataKey: 'volume', name: '销量', yAxisId: 'right' },
        ]}
      />
    </ChartCard>
  )
}
