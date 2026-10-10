'use client'

import { useMemo } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { buildShipmentHistoryPoints, type ShipmentHistory, type ShipmentHistoryPoint } from './shipment-history-data'

export { buildShipmentHistoryPoints } from './shipment-history-data'
export type { ShipmentHistory, ShipmentHistoryPoint } from './shipment-history-data'

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

function formatSignedNumber(value: number): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`
}

export function ShipmentHistoryChart({ history }: { history: ShipmentHistory }) {
  const data = useMemo(() => buildShipmentHistoryPoints(history), [history])
  const hasCoveredSales = data.some((point) => point.covered && point.sales_quantity !== null)
  const hasProvisionalSales = data.some((point) => point.provisional_sales_quantity !== null)
  const totals = useMemo(() => {
    const coveredPoints = data.filter((point) => point.covered && point.sales_quantity !== null)
    return {
      covered: coveredPoints.length,
      shipment: coveredPoints.reduce((sum, point) => sum + point.quantity, 0),
      sales: coveredPoints.reduce((sum, point) => sum + (point.sales_quantity ?? 0), 0),
      gap: coveredPoints.reduce((sum, point) => sum + (point.gap ?? 0), 0),
      uncovered: data.length - coveredPoints.length,
      provisional: data.filter((point) => point.provisional_sales_quantity !== null).length,
    }
  }, [data])

  return (
    <DataTableCard data-testid="shipment-history-strip">
      <DataTableCardHeader
        title="历史发运量 / 同月销量对比"
        description="统计在途与已完成货件，按 ETD 月份归档"
      />
      <DataTableCardBody>
        <div
          className="h-52 min-w-0 w-full px-2 pt-2"
          role="img"
          aria-label="按月对比历史发运量与同月销量，包含发运量为零的月份"
          data-testid="shipment-history-chart"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--term-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: 'var(--term-border)' }} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} interval="preserveStartEnd" minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} />
              <Tooltip
                cursor={{ fill: 'var(--term-hover)' }}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as ShipmentHistoryPoint | undefined
                  if (!active || !point) return null
                  const salesCovered = point.covered && point.sales_quantity !== null
                  const provisionalSales = !salesCovered ? point.provisional_sales_quantity : null
                  return (
                    <div className="min-w-40 border border-term-border bg-term-panel p-3 text-xs">
                      <div className="mb-2 border-b border-term-border pb-2 font-mono text-term-text">{point.month}</div>
                      <div className="flex justify-between gap-5"><span className="text-term-muted">发运量</span><span className="font-mono tabular-nums text-term-text">{formatNumber(point.quantity)} 件</span></div>
                      <div className="mt-1 flex justify-between gap-5">
                        <span className="text-term-muted">同月销量</span>
                        <span className="font-mono tabular-nums text-term-text">
                          {salesCovered
                            ? `${formatNumber(point.sales_quantity ?? 0)} 件`
                            : provisionalSales !== null
                              ? `暂计 ${formatNumber(provisionalSales)} 件`
                              : '待核实'}
                        </span>
                      </div>
                      {provisionalSales !== null ? (
                        <div className="mt-1 text-right text-term-warn">
                          非整月{point.provisional_sales_through ? ` · 订单截至 ${point.provisional_sales_through}` : ''}
                          {point.coverage_through ? ` · 报表覆盖至 ${point.coverage_through}` : ''}
                        </div>
                      ) : null}
                      <div className="mt-1 flex justify-between gap-5">
                        <span className="text-term-muted">差值</span>
                        <span className="font-mono tabular-nums text-term-text">
                          {point.gap === null ? '待核实' : `${formatNumber(point.gap)} 件`}
                        </span>
                      </div>
                    </div>
                  )
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: 'var(--term-muted)' }} />
              <Bar dataKey="quantity" name="发运量" fill="var(--term-accent)" maxBarSize={28} />
              {hasCoveredSales ? (
                <Line
                  dataKey="sales_quantity"
                  name="同月销量"
                  stroke="var(--term-pos)"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              ) : null}
              {hasProvisionalSales ? (
                <Line
                  dataKey="provisional_sales_quantity"
                  name="暂计销量（非整月）"
                  stroke="var(--term-warn)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="border-t border-term-border px-4 py-2 text-[11px] text-term-muted">
          <p>
            {totals.covered === 0
              ? `已覆盖 0/${data.length} 个月：发运待核实 · 销量待核实 · 差待核实`
              : `已覆盖 ${totals.covered}/${data.length} 个月：发运 ${formatNumber(totals.shipment)} 件 · 销量 ${formatNumber(totals.sales)} 件 · 差 ${formatSignedNumber(totals.gap)} 件`}
            {totals.uncovered > 0 ? ` · ${totals.uncovered} 个月待核实` : null}
            {totals.provisional > 0 ? ` · ${totals.provisional} 个月有暂计` : null}
          </p>
          <p className="mt-0.5 text-term-warn">缺少 ETD：{history.missing_etd_shipment_count} 件货 · {formatNumber(history.missing_etd_quantity)} 件</p>
        </div>
      </DataTableCardBody>
    </DataTableCard>
  )
}
