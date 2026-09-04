'use client'

import { Activity } from 'lucide-react'

import { TermChartCard, ComposedChartCard, buildChartConfig } from '@/components/charts'
import { fmtNumPrecise } from '@/lib/dashboard-format'

export interface V2TrafficRow {
  date: string
  page_views: number
  units_ordered: number
  sessions: number
}

export interface V2TrafficStats {
  totalPageViews: number
  totalSessions: number
  totalUnitsOrdered: number
  /** units_ordered / page_views × 100 */
  conversionRatePct: number
}

/** 汇总流量指标（纯函数，供测试） */
export function computeTrafficStats(rows: V2TrafficRow[]): V2TrafficStats {
  let totalPageViews = 0
  let totalSessions = 0
  let totalUnitsOrdered = 0
  for (const r of rows) {
    totalPageViews += r.page_views ?? 0
    totalSessions += r.sessions ?? 0
    totalUnitsOrdered += r.units_ordered ?? 0
  }
  const conversionRatePct = totalPageViews > 0 ? (totalUnitsOrdered / totalPageViews) * 100 : 0
  return { totalPageViews, totalSessions, totalUnitsOrdered, conversionRatePct }
}

export interface V2TrafficChartProps {
  currentRows: V2TrafficRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(
  ['page_views', 'conversion_rate'],
  { page_views: '浏览量', conversion_rate: '转化率' }
)

/** ISO 日期 → "M/D" */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2TrafficChart({ currentRows, loading }: V2TrafficChartProps) {
  const rows = currentRows.map((r) => {
    const pv = r.page_views ?? 0
    return {
      day: dayLabel(r.date),
      page_views: pv,
      conversion_rate: pv > 0 ? ((r.units_ordered ?? 0) / pv) * 100 : 0,
    }
  })
  const stats = computeTrafficStats(currentRows)
  const hasData = rows.length > 0

  return (
    <TermChartCard
      icon={<Activity className="size-4" />}
      title="流量与转化"
      description="浏览量趋势与转化率（近 7 天）"
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无流量数据"
      className="col-span-2"
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            总浏览量{' '}
            <b className="ml-1 tabular-nums text-term-text">
              {fmtNumPrecise(stats.totalPageViews)}
            </b>
          </span>
          <span className="text-xs text-muted-foreground">
            访客数{' '}
            <b className="ml-1 tabular-nums text-term-text">
              {fmtNumPrecise(stats.totalSessions)}
            </b>
          </span>
          <span className="text-xs text-muted-foreground">
            转化订单{' '}
            <b className="ml-1 tabular-nums text-term-text">
              {fmtNumPrecise(stats.totalUnitsOrdered)}
            </b>
          </span>
          <span className="text-xs text-muted-foreground">
            平均转化率{' '}
            <b className="ml-1 tabular-nums text-term-text">
              {stats.conversionRatePct.toFixed(2)}%
            </b>
          </span>
        </>
      }
    >
      <ComposedChartCard
        data={rows}
        xKey="day"
        config={chartConfig}
        dualAxis
        rightYFormatter={(v) => `${v}%`}
        series={[
          { kind: 'bar', dataKey: 'page_views', name: '浏览量', yAxisId: 'left' },
          {
            kind: 'line',
            dataKey: 'conversion_rate',
            name: '转化率',
            yAxisId: 'right',
          },
        ]}
      />
    </TermChartCard>
  )
}
