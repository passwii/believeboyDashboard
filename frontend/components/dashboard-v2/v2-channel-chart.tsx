'use client'

import { BarChart3 } from 'lucide-react'

import { TermChartCard, LineChartCard, buildChartConfig } from '@/components/charts'
import { formatCompactCurrency, formatDate } from './v2-format'

type ChannelRow = { date: string; sales_amount: number; ad_spend: number }

export interface V2ChannelChartProps {
  currentRows: ChannelRow[]
  comparisonRows?: ChannelRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(
  ['sales_amount', 'ad_spend'],
  { sales_amount: '销售额', ad_spend: '广告花费' }
)

export function V2ChannelChart({
  currentRows,
  comparisonRows = [],
  loading = false,
}: V2ChannelChartProps) {
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  const data = currentRows.map((r) => ({
    day: formatDate(r.date, 'day-month'),
    sales_amount: r.sales_amount,
    ad_spend: r.ad_spend,
  }))
  const hasData = data.length > 0

  return (
    <TermChartCard
      icon={<BarChart3 className="size-4" />}
      title="销售额 vs 广告花费"
      description="每日销售额与广告花费对比（近 7 天，双轴）"
      delta={{ value: delta, variant: 'badge' }}
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无销售数据"
      className="col-span-2"
    >
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
    </TermChartCard>
  )
}