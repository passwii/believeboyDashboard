'use client'

import { useMemo } from 'react'
import type { components } from '@/types/api-generated/api'
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

type ChartPoint = Omit<ForecastChartPoint, 'demand' | 'confirmed_sales' | 'planned_sales' | 'historical_order_sales'> & {
  demand: DecimalValue | null
  confirmed_sales: DecimalValue | null
  planned_sales: DecimalValue | null
  historical_order_sales: number | null
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

function sumKnown(values: Array<DecimalValue | null | undefined>): number | null {
  const numericValues = values.map((value) => value == null ? null : Number(value))
  if (numericValues.some((value) => value === null || !Number.isFinite(value))) return null
  return numericValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
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
      historical_order_sales: sumKnown(rows.map((row) => row.historical_order_sales ?? null)),
    }
  })
}

function formatValue(value: DecimalValue | null | undefined): string {
  const numeric = value === null || value === undefined ? null : Number(value)
  if (numeric === null || !Number.isFinite(numeric)) return '缺失'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(numeric)
}

function qualityReason(reason: string): string {
  const labels: Record<string, string> = {
    inventory_snapshot_missing: '缺少库存快照日期。',
    sku_inventory_snapshot_missing: '快照中没有该 SKU 的可售数量。',
    sales_baseline_missing: '缺少可用的销量基线。',
    completed_inbound_unverified: '已完成货件缺少可核对的实际入仓日期或库存快照。',
    post_snapshot_inbound_before_forecast_start: '库存快照后、预测开始前已有货件入仓；请更新快照。',
    shipment_eta_missing: '部分正式货件没有可用 ETA。',
    shipment_eta_overdue: '部分正式货件 ETA 已早于预测开始日期。',
    plan_eta_overdue: '部分预期计划日期已早于预测开始日期。',
  }
  return labels[reason] ?? reason
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
  return [...daily, ...aggregateMonthly(points.slice(90))] as ChartPoint[]
}

export function ForecastChart({ forecast }: { forecast: ShippingPlanForecast }) {
  const data = useMemo(() => buildForecastChartPoints(forecast.daily_points ?? []), [forecast.daily_points])
  const hasHistoricalData = data.some((point) => point.historical_order_sales != null)
  const hasUnknownDemand = data.some((point) => point.demand === null)
  const confirmedText = formatValue(forecast.confirmed_180d_sales_upper_bound)
  const plannedText = formatValue(forecast.planned_180d_sales_upper_bound)

  return (
    <section className="min-w-0" aria-label={`${forecast.sku} 180 天预测趋势`}>
      <div className="mb-3 grid grid-cols-2 border border-term-border md:grid-cols-4">
        <div className="border-r border-term-border px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">确定情景上限</div><div className="mt-1 font-mono text-base tabular-nums text-term-text">{confirmedText}</div></div>
        <div className="border-r border-term-border px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">计划情景上限</div><div className="mt-1 font-mono text-base tabular-nums text-term-text">{plannedText}</div></div>
        <div className="border-r border-term-border px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">预测区间</div><div className="mt-1 font-mono text-xs tabular-nums text-term-text">{dateLabel(forecast.forecast_start_date)} – {dateLabel(forecast.forecast_end_date)}</div></div>
        <div className="px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-wide text-term-muted">库存快照</div><div className="mt-1 font-mono text-xs tabular-nums text-term-text">{forecast.inventory_snapshot_date ?? '未知'}</div></div>
      </div>
      {forecast.data_quality.length > 0 ? <div role="status" className="mb-3 border border-term-warn/40 px-3 py-2 text-xs leading-5 text-term-warn">当前 SKU 数据不足以给出完整精确上限。{forecast.data_quality.map((reason) => qualityReason(reason)).join(' ')}</div> : null}
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
