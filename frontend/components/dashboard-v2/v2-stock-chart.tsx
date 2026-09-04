'use client'

import { Boxes } from 'lucide-react'

import { AreaChartCard, TermChartCard, buildChartConfig } from '@/components/charts'
import { fmtNumPrecise } from '@/lib/dashboard-format'

export interface V2StockRow {
  date: string
  available_qty: number
}

export interface V2StockTrend {
  /** 图表行：{ day, qty } */
  rows: { day: string; qty: number }[]
  /** 区间末库存快照 */
  current: number
  /** 上一周期末快照 */
  prev: number
  /** 环比 %（prev>0 时计算，否则 0） */
  delta: number
}

/** 由 summary_rows 计算库存趋势（纯函数，供测试） */
export function computeStockTrend(
  currentRows: V2StockRow[],
  comparisonRows: V2StockRow[] = []
): V2StockTrend {
  const rows = currentRows.map((r) => {
    const [, m, d] = r.date.split('-')
    return { day: `${Number(m)}/${Number(d)}`, qty: r.available_qty ?? 0 }
  })
  const current = rows.length > 0 ? rows[rows.length - 1].qty : 0
  const prev =
    comparisonRows.length > 0 ? (comparisonRows[comparisonRows.length - 1].available_qty ?? 0) : 0
  const delta = prev > 0 ? ((current - prev) / prev) * 100 : 0
  return { rows, current, prev, delta }
}

export interface V2StockChartProps {
  currentRows: V2StockRow[]
  comparisonRows?: V2StockRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(['qty'], { qty: '可用库存' })

export function V2StockChart({ currentRows, comparisonRows = [], loading }: V2StockChartProps) {
  const { rows, current, delta } = computeStockTrend(currentRows, comparisonRows)
  const hasData = rows.length > 0

  return (
    <TermChartCard
      icon={<Boxes className="size-4" />}
      title="库存水位"
      description="可用库存每日变化（近 7 天）"
      delta={{ value: delta, variant: 'badge' }}
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无库存数据"
      className="col-span-2"
      actions={
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tabular-nums">{fmtNumPrecise(current)}</span>
          <span className="text-xs text-muted-foreground">件 · 区间末快照</span>
        </div>
      }
    >
      <AreaChartCard
        data={rows}
        xKey="day"
        series={[{ dataKey: 'qty' }]}
        config={chartConfig}
        gradient
      />
    </TermChartCard>
  )
}
