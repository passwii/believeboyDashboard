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
import styles from '../shipping-plan-warm.module.css'

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
    <section className={styles.forecastChart} aria-label={`${forecast.sku} 180 天销量与库存预测`}>
      <div className={styles.forecastScenarioGrid}>
        <div className={styles.forecastScenario}>
          <div className={styles.scenarioLabel}>确定情景 · 销量上限 {formatValue(forecast.confirmed_180d_sales_upper_bound)}</div>
          <div className={`${styles.scenarioGap} ${confirmedGap.complete && confirmedGap.quantity ? styles.scenarioGapActive : ''}`}>库存缺口：{gapLabel(confirmedGap)}</div>
        </div>
        <div className={styles.forecastScenario}>
          <div className={styles.scenarioLabel}>计划情景 · 销量上限 {formatValue(forecast.planned_180d_sales_upper_bound)}</div>
          <div className={`${styles.scenarioGap} ${plannedGap.complete && plannedGap.quantity ? styles.scenarioGapActive : ''}`}>库存缺口：{gapLabel(plannedGap)}</div>
        </div>
      </div>
      <div className={styles.forecastPeriod}>
        <span>预测区间 {dateLabel(forecast.forecast_start_date)}–{dateLabel(forecast.forecast_end_date)}</span>
        <span>库存快照 {forecast.inventory_snapshot_date ?? '未知'}</span>
      </div>
      {forecast.data_quality.length > 0 ? (
        <div role="status" className={styles.forecastQuality}>
          数据待核实：{forecast.data_quality.map(qualityReason).join('、')}
        </div>
      ) : null}
      <div className={styles.forecastPlot} data-testid="shipping-plan-forecast-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--warm-ledger-color-chart-grid)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: 'var(--warm-ledger-color-hairline)' }} tick={{ fill: 'var(--warm-ledger-color-text-muted)', fontSize: 11, fontFamily: 'var(--warm-ledger-font-mono)' }} interval="preserveStartEnd" minTickGap={18} />
            <YAxis yAxisId="sales" tickLine={false} axisLine={false} width={44} tick={{ fill: 'var(--warm-ledger-color-text-muted)', fontSize: 11, fontFamily: 'var(--warm-ledger-font-mono)' }} />
            <YAxis yAxisId="inventory" orientation="right" tickLine={false} axisLine={false} width={40} tick={{ fill: 'var(--warm-ledger-color-text-muted)', fontSize: 11, fontFamily: 'var(--warm-ledger-font-mono)' }} />
            <Tooltip
              cursor={{ stroke: 'var(--warm-ledger-color-hairline-strong)', strokeDasharray: '3 3' }}
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
                return <div className={styles.chartTooltip}><div className={styles.tooltipTitle}>{point.label}</div>{rows.map(([label, value]) => <div key={label} className={styles.tooltipRow}><span>{label}</span><strong>{formatValue(value)}</strong></div>)}</div>
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} formatter={(value) => <span className={styles.chartLegend}>{value}</span>} />
            <Bar yAxisId="sales" dataKey="confirmed_sales" name="确定情景销量" fill="var(--warm-ledger-color-accent)" maxBarSize={20} />
            <Bar yAxisId="sales" dataKey="planned_sales" name="计划情景销量" fill="var(--warm-ledger-color-text-soft)" fillOpacity={0.72} maxBarSize={20} />
            {hasHistoricalData ? <Line yAxisId="sales" type="monotone" dataKey="historical_order_sales" name="去年同期销售" stroke="var(--warm-ledger-color-text-muted)" strokeDasharray="5 3" strokeWidth={1.5} dot={false} connectNulls={false} /> : null}
            <ReferenceLine yAxisId="inventory" y={0} stroke="var(--warm-ledger-color-chart-grid)" strokeDasharray="3 3" />
            <Line yAxisId="inventory" type="monotone" dataKey="confirmed_closing_inventory" name="确定情景月末库存" stroke="var(--warm-ledger-color-accent)" strokeWidth={2} dot={false} connectNulls={false} />
            <Line yAxisId="inventory" type="monotone" dataKey="planned_closing_inventory" name="计划情景月末库存" stroke="var(--warm-ledger-color-text-soft)" strokeDasharray="5 3" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line yAxisId="sales" type="monotone" dataKey="confirmed_gap" name="确定情景缺口" stroke="var(--warm-ledger-color-negative)" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line yAxisId="sales" type="monotone" dataKey="planned_gap" name="计划情景缺口" stroke="var(--warm-ledger-color-negative)" strokeDasharray="5 3" strokeWidth={1.5} dot={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className={styles.chartFootnote}>按自然月汇总；缺口为当月预测需求未能满足的数量{hasHistoricalData ? '；去年同期销售按相同月份对齐' : ''}</div>
    </section>
  )
}
