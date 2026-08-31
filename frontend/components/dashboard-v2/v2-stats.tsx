'use client'

import {
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
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
  if (loading) {
    return (
      <>
        {Array.from({ length: 4 }).map((_, i) => (
          <V2Card key={i}>
            <CardHeader>
              <Skeleton className="h-3 w-16" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-24" />
            </CardContent>
            <CardFooter>
              <Skeleton className="h-3 w-20" />
            </CardFooter>
          </V2Card>
        ))}
      </>
    )
  }

  const stats = computeStats(currentRows, comparisonRows)

  return (
    <>
      {stats.map((s) => (
        <V2Card className="transition-colors hover:bg-term-raised" key={s.label}>
          <CardHeader className="flex flex-row items-center justify-between px-4 pb-0 pt-3 md:px-4">
            {/* BLF-909 阶段 B：KPI 标签走 mono + uppercase + term-faint，与详情表头一致 */}
            <CardTitle className="font-mono text-[10px] font-medium uppercase tracking-wider text-term-faint">{s.label}</CardTitle>
            <Delta value={s.delta}>
              <DeltaIcon />
              <DeltaValue />
            </Delta>
          </CardHeader>
          <CardContent className="flex flex-row items-center gap-2 px-4 pb-3 md:px-4">
            {/* BLF-809：KPI 数值一律等宽字体（font-mono + tabular-nums） */}
            <p className="font-mono text-xl font-semibold tabular-nums text-term-text">{s.value}</p>
          </CardContent>
        </V2Card>
      ))}
    </>
  )
}
