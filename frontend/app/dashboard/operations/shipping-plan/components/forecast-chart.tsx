'use client'

import { useMemo } from 'react'
import type { components } from '@/types/api-generated/api'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'

type DecimalValue = number | string

export type ForecastChartPoint = components['schemas']['ForecastPoint']
export type ShippingPlanForecast = Pick<
  components['schemas']['ShippingPlanForecastResponse'],
  | 'sku'
  | 'as_of_date'
  | 'forecast_start_date'
  | 'forecast_end_date'
  | 'inventory_snapshot_date'
  | 'data_quality'
  | 'daily_points'
  | 'confirmed_180d_sales_upper_bound'
  | 'planned_180d_sales_upper_bound'
>

export type MonthlyForecastPoint = {
  forecast_date: string
  label: string
  demand: number | null
  confirmed_sales: number | null
  planned_sales: number | null
  confirmed_closing_inventory: DecimalValue | null
  planned_closing_inventory: DecimalValue | null
  historical_order_sales: number | null
  confirmed_gap: number | null
  planned_gap: number | null
}

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[2]}/${match[3]}` : value
}

function numeric(value: DecimalValue | null | undefined): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sumKnown(values: Array<DecimalValue | null | undefined>): number | null {
  const numbers = values.map(numeric)
  if (numbers.some((value) => value === null)) return null
  return numbers.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

export function buildMonthlyForecastPoints(points: ForecastChartPoint[]): MonthlyForecastPoint[] {
  const grouped = new Map<string, ForecastChartPoint[]>()
  points.forEach((point) => {
    const month = point.forecast_date.slice(0, 7)
    grouped.set(month, [...(grouped.get(month) ?? []), point])
  })

  const firstDate = points[0]?.forecast_date
  const lastDate = points.at(-1)?.forecast_date
  if (!firstDate || !lastDate) return []

  const cursor = new Date(`${firstDate.slice(0, 7)}-01T00:00:00Z`)
  const lastMonth = Date.UTC(Number(lastDate.slice(0, 4)), Number(lastDate.slice(5, 7)) - 1, 1)
  const monthly: MonthlyForecastPoint[] = []

  while (cursor.getTime() <= lastMonth) {
    const month = cursor.toISOString().slice(0, 7)
    const rows = grouped.get(month) ?? []
    const finalDay = rows.at(-1)
    const monthlyGap = (key: 'confirmed_sales' | 'planned_sales') => {
      const gaps = rows.map((row) => {
        const demand = numeric(row.demand)
        const sales = numeric(row[key])
        return demand === null || sales === null ? null : Math.max(0, demand - sales)
      })
      return gaps.length && gaps.every((gap) => gap !== null)
        ? gaps.reduce<number>((sum, gap) => sum + (gap ?? 0), 0)
        : null
    }
    monthly.push({
      forecast_date: month,
      label: month,
      demand: rows.length ? sumKnown(rows.map((row) => row.demand)) : null,
      confirmed_sales: rows.length ? sumKnown(rows.map((row) => row.confirmed_sales)) : null,
      planned_sales: rows.length ? sumKnown(rows.map((row) => row.planned_sales)) : null,
      confirmed_closing_inventory: finalDay?.confirmed_closing_inventory ?? null,
      planned_closing_inventory: finalDay?.planned_closing_inventory ?? null,
      historical_order_sales: rows.length ? sumKnown(rows.map((row) => row.historical_order_sales)) : null,
      confirmed_gap: monthlyGap('confirmed_sales'),
      planned_gap: monthlyGap('planned_sales'),
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return monthly
}

function formatValue(value: DecimalValue | null | undefined): string {
  const parsed = numeric(value)
  return parsed === null ? '待核实' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(parsed)
}

function qualityReason(reason: string): string {
  const labels: Record<string, string> = {
    inventory_snapshot_missing: '缺少库存快照日期',
    sku_inventory_snapshot_missing: '快照中没有该 SKU 库存',
    sales_baseline_missing: '缺少销量基线',
    completed_inbound_unverified: '已完成货件的入仓信息待核对',
    post_snapshot_inbound_before_forecast_start: '库存快照后已有货件入仓，请更新快照',
    shipment_eta_missing: '部分正式货件缺少 ETA',
    shipment_eta_overdue: '部分正式货件 ETA 早于预测起点',
    plan_eta_overdue: '部分计划到货日期早于预测起点',
  }
  return labels[reason] ?? reason
}

export function calculateInventoryGap(points: ForecastChartPoint[], key: 'confirmed_sales' | 'planned_sales') {
  let quantity = 0
  let firstDate: string | null = null
  for (const point of points) {
    const demand = numeric(point.demand)
    const sales = numeric(point[key])
    if (demand === null || sales === null) return { complete: false, quantity: null, firstDate: null }
    const dailyGap = Math.max(0, demand - sales)
    quantity += dailyGap
    if (dailyGap > 0 && firstDate === null) firstDate = point.forecast_date
  }
  return { complete: points.length > 0, quantity, firstDate }
}

function gapLabel(gap: ReturnType<typeof calculateInventoryGap>): string {
  if (!gap.complete) return '待核实'
  if (gap.quantity === 0) return '180 天内无缺口'
  return `缺 ${formatValue(gap.quantity)} 件 · ${dateLabel(gap.firstDate ?? '')} 起`
}

export function ForecastChart({ forecast }: { forecast: ShippingPlanForecast }) {
  const points = forecast.daily_points
  const data = useMemo(() => buildMonthlyForecastPoints(points), [points])
  const hasHistoricalData = data.some((point) => point.historical_order_sales != null)
  const confirmedGap = useMemo(() => calculateInventoryGap(points, 'confirmed_sales'), [points])
  const plannedGap = useMemo(() => calculateInventoryGap(points, 'planned_sales'), [points])

  return (
    <section className="min-w-0" aria-label={`${forecast.sku} 180 天销量与库存预测`}>
      <div className="mb-3 grid grid-cols-1 border border-term-border sm:grid-cols-2">
        <div className="border-b border-term-border px-3 py-2 sm:border-b-0 sm:border-r">
          <div className="font-mono text-[10px] text-term-muted">确定情景 · 销量上限 {formatValue(forecast.confirmed_180d_sales_upper_bound)}</div>
          <div className={`mt-1 font-mono text-sm tabular-nums ${confirmedGap.complete && confirmedGap.quantity ? 'text-term-neg' : 'text-term-text'}`}>库存缺口：{gapLabel(confirmedGap)}</div>
        </div>
        <div className="px-3 py-2">
          <div className="font-mono text-[10px] text-term-muted">计划情景 · 销量上限 {formatValue(forecast.planned_180d_sales_upper_bound)}</div>
          <div className={`mt-1 font-mono text-sm tabular-nums ${plannedGap.complete && plannedGap.quantity ? 'text-term-neg' : 'text-term-text'}`}>库存缺口：{gapLabel(plannedGap)}</div>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-term-muted">
        <span>预测区间 {dateLabel(forecast.forecast_start_date)}–{dateLabel(forecast.forecast_end_date)}</span>
        <span>库存快照 {forecast.inventory_snapshot_date ?? '未知'}</span>
      </div>
      {forecast.data_quality.length > 0 ? (
        <div role="status" className="mb-3 border border-term-warn/40 px-3 py-2 text-xs leading-5 text-term-warn">
          数据待核实：{forecast.data_quality.map(qualityReason).join('、')}
        </div>
      ) : null}
      <div className="h-[300px] min-w-0 w-full" data-testid="shipping-plan-forecast-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--term-border)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: 'var(--term-border)' }} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} interval="preserveStartEnd" minTickGap={18} />
            <YAxis yAxisId="sales" tickLine={false} axisLine={false} width={44} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} />
            <YAxis yAxisId="inventory" orientation="right" tickLine={false} axisLine={false} width={40} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} />
            <Tooltip
              cursor={{ stroke: 'var(--term-border-strong)', strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as MonthlyForecastPoint | undefined
                if (!active || !point) return null
                const rows = [
                  ['确定情景销量', point.confirmed_sales],
                  ['计划情景销量', point.planned_sales],
                  ...(hasHistoricalData ? [['去年同期销售', point.historical_order_sales] as const] : []),
                  ['确定情景月末库存', point.confirmed_closing_inventory],
                  ['计划情景月末库存', point.planned_closing_inventory],
                ] as const
                return <div className="min-w-48 border border-term-border bg-term-panel p-3 text-xs"><div className="mb-2 border-b border-term-border pb-2 font-mono text-term-text">{point.label}</div>{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-5 py-0.5"><span className="text-term-muted">{label}</span><span className="font-mono tabular-nums text-term-text">{formatValue(value)}</span></div>)}</div>
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} formatter={(value) => <span className="text-term-muted">{value}</span>} />
            <Bar yAxisId="sales" dataKey="confirmed_sales" name="确定情景销量" fill="var(--term-accent)" maxBarSize={20} />
            <Bar yAxisId="sales" dataKey="planned_sales" name="计划情景销量" fill="var(--term-pos)" fillOpacity={0.7} maxBarSize={20} />
            {hasHistoricalData ? <Line yAxisId="sales" type="monotone" dataKey="historical_order_sales" name="去年同期销售" stroke="var(--term-warn)" strokeDasharray="5 3" strokeWidth={1.5} dot={false} connectNulls={false} /> : null}
            <ReferenceLine yAxisId="inventory" y={0} stroke="var(--term-neg)" strokeDasharray="3 3" />
            <Line yAxisId="inventory" type="monotone" dataKey="confirmed_closing_inventory" name="确定情景月末库存" stroke="var(--term-accent)" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line yAxisId="inventory" type="monotone" dataKey="planned_closing_inventory" name="计划情景月末库存" stroke="var(--term-pos)" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line yAxisId="sales" type="monotone" dataKey="confirmed_gap" name="确定情景缺口" stroke="var(--term-neg)" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line yAxisId="sales" type="monotone" dataKey="planned_gap" name="计划情景缺口" stroke="var(--term-warn)" strokeWidth={1.5} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 border-t border-term-border pt-2 text-[11px] leading-5 text-term-muted">按自然月汇总；缺口为当月预测需求未能满足的数量{hasHistoricalData ? '；去年同期销售按相同月份对齐' : ''}。</div>
    </section>
  )
}
