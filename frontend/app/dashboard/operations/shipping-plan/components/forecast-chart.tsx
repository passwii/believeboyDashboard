'use client'

import { useMemo } from 'react'
import {
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

export type ForecastChartPoint = {
  forecast_date: string
  demand: number | null
  confirmed_sales: number | null
  planned_sales: number | null
  confirmed_closing_inventory: number | null
  planned_closing_inventory: number | null
  historical_order_sales: number | null
  interval_start?: string
  interval_end?: string
}

export type ShippingPlanForecast = {
  sku: string
  as_of_date: string
  forecast_start_date: string
  forecast_end_date: string
  inventory_snapshot_date: string | null
  data_quality: string
  data_quality_reasons: string[]
  daily_points: ForecastChartPoint[]
  confirmed_sales_cap: number | null
  planned_sales_cap: number | null
}

type ChartPoint = ForecastChartPoint & {
  label: string
  rangeLabel: string
  rangeStart: string
  rangeEnd: string
  monthly: boolean
}

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[2]}/${match[3]}` : value
}

function sumKnown(values: Array<number | null>): number | null {
  if (values.some((value) => value === null || !Number.isFinite(value))) return null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function aggregateMonthly(points: ForecastChartPoint[]): ChartPoint[] {
  const grouped = new Map<string, ForecastChartPoint[]>()
  points.forEach((point) => {
    const key = point.forecast_date.slice(0, 7)
    grouped.set(key, [...(grouped.get(key) ?? []), point])
  })
  return [...grouped.entries()].map(([month, rows]) => {
    const first = rows[0]!
    const last = rows[rows.length - 1]!
    return {
      forecast_date: month,
      label: month,
      rangeLabel: `${dateLabel(first.forecast_date)}–${dateLabel(last.forecast_date)}`,
      rangeStart: first.forecast_date,
      rangeEnd: last.forecast_date,
      monthly: true,
      demand: sumKnown(rows.map((row) => row.demand)),
      confirmed_sales: sumKnown(rows.map((row) => row.confirmed_sales)),
      planned_sales: sumKnown(rows.map((row) => row.planned_sales)),
      confirmed_closing_inventory: last.confirmed_closing_inventory,
      planned_closing_inventory: last.planned_closing_inventory,
      historical_order_sales: sumKnown(rows.map((row) => row.historical_order_sales)),
      interval_start: first.forecast_date,
      interval_end: last.forecast_date,
    }
  })
}

function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '缺失'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
}

export function buildForecastChartPoints(points: ForecastChartPoint[]): ChartPoint[] {
  const daily = points.slice(0, 90).map((point) => ({
    ...point,
    label: dateLabel(point.forecast_date),
    rangeLabel: dateLabel(point.forecast_date),
    rangeStart: point.forecast_date,
    rangeEnd: point.forecast_date,
    monthly: false,
  }))
  return [...daily, ...aggregateMonthly(points.slice(90))]
}

export function ForecastChart({ forecast }: { forecast: ShippingPlanForecast }) {
  const data = useMemo(() => buildForecastChartPoints(forecast.daily_points ?? []), [forecast.daily_points])
  const hasHistoricalData = data.some((point) => point.historical_order_sales !== null)
  const hasUnknownDemand = data.some((point) => point.demand === null)
  const confirmedText = formatValue(forecast.confirmed_sales_cap)
  const plannedText = formatValue(forecast.planned_sales_cap)

  return (
    <section className="min-w-0" aria-label={`${forecast.sku} 180 天预测趋势`}>
      <div className="mb-3 grid grid-cols-2 border border-term-border md:grid-cols-4">
        <div className="border-r border-term-border px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">确定情景上限</div><div className="mt-1 font-mono text-base tabular-nums text-term-text">{confirmedText}</div></div>
        <div className="border-r border-term-border px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">计划情景上限</div><div className="mt-1 font-mono text-base tabular-nums text-term-text">{plannedText}</div></div>
        <div className="border-r border-term-border px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">预测区间</div><div className="mt-1 font-mono text-xs tabular-nums text-term-text">{dateLabel(forecast.forecast_start_date)} – {dateLabel(forecast.forecast_end_date)}</div></div>
        <div className="px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">库存快照</div><div className="mt-1 font-mono text-xs tabular-nums text-term-text">{forecast.inventory_snapshot_date ?? '未知'}</div></div>
      </div>
      {forecast.data_quality !== 'ready' ? <div role="status" className="mb-3 border border-term-warn/40 px-3 py-2 text-xs leading-5 text-term-warn">当前 SKU 数据不足以给出完整精确上限。{forecast.data_quality_reasons?.join(' ')}</div> : null}
      <div className="h-[320px] min-w-0 w-full" data-testid="shipping-plan-forecast-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--term-border)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: 'var(--term-border)' }} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} interval="preserveStartEnd" minTickGap={22} />
            <YAxis tickLine={false} axisLine={false} width={46} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} />
            <Tooltip
              cursor={{ stroke: 'var(--term-border-strong)', strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const point = payload[0]?.payload as ChartPoint | undefined
                if (!point) return null
                const rows = [
                  ['需求', point.demand],
                  ['确定情景销量', point.confirmed_sales],
                  ['计划情景销量', point.planned_sales],
                  ['去年同期 orderSales', point.historical_order_sales],
                ] as const
                return <div className="min-w-48 border border-term-border bg-term-panel p-3 text-xs"><div className="mb-2 border-b border-term-border pb-2 font-mono text-term-text">{point.monthly ? `${point.label} · ${point.rangeLabel}` : point.rangeLabel}</div>{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-5 py-0.5"><span className="text-term-muted">{label}</span><span className="font-mono tabular-nums text-term-text">{formatValue(value)}</span></div>)}</div>
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} formatter={(value) => <span className="text-term-muted">{value}</span>} />
            <Line type="monotone" dataKey="demand" name="预测需求" stroke="var(--term-muted)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="confirmed_sales" name="确定情景" stroke="var(--term-accent)" strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="planned_sales" name="计划情景" stroke="var(--term-pos)" strokeWidth={2} dot={false} connectNulls={false} />
            {hasHistoricalData ? <Line type="monotone" dataKey="historical_order_sales" name="去年同期 orderSales" stroke="var(--term-warn)" strokeDasharray="5 3" strokeWidth={1.5} dot={false} connectNulls={false} /> : null}
            {hasUnknownDemand ? <ReferenceLine y={0} stroke="var(--term-warn)" strokeDasharray="2 4" /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-term-border pt-2 text-[11px] text-term-muted"><span>前 90 天逐日 · 后 90 天按自然月聚合，并按预测区间裁剪</span>{!hasHistoricalData ? <span>去年同期报表无完整覆盖，未绘制零值</span> : null}</div>
    </section>
  )
}
