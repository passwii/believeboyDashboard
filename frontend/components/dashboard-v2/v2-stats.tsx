'use client'

import { Delta, DeltaIcon, DeltaValue } from '@/components/ui/delta'
import { Skeleton } from '@/components/ui/skeleton'
import { TermKpiTile } from '@/components/terminal/term-controls'

import { formatCompactCurrency, formatCompactNumber, formatPercent } from './v2-format'

/** 与 app/dashboard/v2/page.tsx 的 DailyAnalysisRow 保持一致的简化类型——只声明本组件用到的字段 */
export type V2StatRow = {
  date: string
  order_qty: number
  sales_amount: number
  ad_spend: number
  page_views: number
  units_ordered: number
}

export type V2Stat = { label: string; value: string; delta: number }

type SumKey = 'order_qty' | 'sales_amount' | 'ad_spend'

function sum(rows: V2StatRow[], key: SumKey): number {
  return rows.reduce((s, r) => s + r[key], 0)
}

/** 与 v1 page.tsx aggregateMetric('conversion_rate') 同口径：units_ordered / page_views，转百分比 */
function conversionRatePct(rows: V2StatRow[]): number {
  const pv = rows.reduce((s, r) => s + r.page_views, 0)
  const uo = rows.reduce((s, r) => s + r.units_ordered, 0)
  return pv > 0 ? (uo / pv) * 100 : 0
}

function pctChange(current: number, previous: number): number {
  return previous > 0 ? ((current - previous) / previous) * 100 : 0
}

export { pctChange }

export function computeStats(currentRows: V2StatRow[], comparisonRows: V2StatRow[]): V2Stat[] {
  const totalSales = sum(currentRows, 'sales_amount')
  const totalOrders = sum(currentRows, 'order_qty')
  const totalAdSpend = sum(currentRows, 'ad_spend')
  const conv = conversionRatePct(currentRows)

  return [
    {
      label: '销售额',
      value: formatCompactCurrency(totalSales),
      delta: pctChange(totalSales, sum(comparisonRows, 'sales_amount')),
    },
    {
      label: '订单量',
      value: formatCompactNumber(totalOrders),
      delta: pctChange(totalOrders, sum(comparisonRows, 'order_qty')),
    },
    {
      label: '广告花费',
      value: formatCompactCurrency(totalAdSpend),
      delta: pctChange(totalAdSpend, sum(comparisonRows, 'ad_spend')),
    },
    {
      label: '转化率',
      value: formatPercent(conv),
      delta: pctChange(conv, conversionRatePct(comparisonRows)),
    },
  ]
}

export interface V2StatsProps {
  currentRows: V2StatRow[]
  comparisonRows?: V2StatRow[]
  loading?: boolean
}

export function V2Stats({ currentRows, comparisonRows = [], loading }: V2StatsProps) {
  const hasData = currentRows.length > 0
  const stats = hasData || !loading ? computeStats(currentRows, comparisonRows) : []

  if (loading && stats.length === 0) {
    return (
      <>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </>
    )
  }

  return (
    <>
      {stats.map((s) => (
        <TermKpiTile
          key={s.label}
          label={s.label}
          value={s.value}
          loading={loading}
          after={
            <Delta value={s.delta} className="shrink-0">
              <DeltaIcon />
              <DeltaValue />
            </Delta>
          }
        />
      ))}
    </>
  )
}
