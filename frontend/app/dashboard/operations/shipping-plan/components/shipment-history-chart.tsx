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
import { buildShipmentHistoryPoints, type ShipmentHistory, type ShipmentHistoryPoint } from './shipment-history-data'
import styles from '../shipping-plan-warm.module.css'

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
    <section className={`${styles.panel} ${styles.historyPanel}`} data-testid="shipment-history-strip" aria-labelledby="shipment-history-title">
      <header className={styles.panelHeader}>
        <div>
          <h2 id="shipment-history-title" className={styles.sectionTitle}>历史发运量与同月销量</h2>
          <p className={styles.historyBasis}>
            <span>按 ETD 月份归档</span>
            <span>{history.date_basis}</span>
          </p>
        </div>
      </header>
      <div className={styles.historyPlotWrap}>
        <div
          className={styles.historyPlot}
          role="img"
          aria-label="按月对比历史发运量与同月销量，包含发运量为零的月份"
          data-testid="shipment-history-chart"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--warm-ledger-color-chart-grid)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: 'var(--warm-ledger-color-hairline)' }} tick={{ fill: 'var(--warm-ledger-color-text-muted)', fontSize: 11, fontFamily: 'var(--warm-ledger-font-mono)' }} interval="preserveStartEnd" minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: 'var(--warm-ledger-color-text-muted)', fontSize: 11, fontFamily: 'var(--warm-ledger-font-mono)' }} />
              <Tooltip
                cursor={{ fill: 'var(--warm-ledger-color-raised)' }}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as ShipmentHistoryPoint | undefined
                  if (!active || !point) return null
                  const salesCovered = point.covered && point.sales_quantity !== null
                  const provisionalSales = !salesCovered ? point.provisional_sales_quantity : null
                  return (
                    <div className={styles.chartTooltip}>
                      <div className={styles.tooltipTitle}>{point.month}</div>
                      <div className={styles.tooltipRow}><span>发运量</span><strong>{formatNumber(point.quantity)} 件</strong></div>
                      <div className={styles.tooltipRow}>
                        <span>同月销量</span>
                        <strong>
                          {salesCovered
                            ? `${formatNumber(point.sales_quantity ?? 0)} 件`
                            : provisionalSales !== null
                              ? `暂计 ${formatNumber(provisionalSales)} 件`
                              : '待核实'}
                        </strong>
                      </div>
                      {provisionalSales !== null ? (
                        <div className={styles.provisionalNote}>
                          非整月{point.provisional_sales_through ? ` · 订单截至 ${point.provisional_sales_through}` : ''}
                          {point.coverage_through ? ` · 报表覆盖至 ${point.coverage_through}` : ''}
                        </div>
                      ) : null}
                      <div className={styles.tooltipRow}>
                        <span>差值</span>
                        <strong>
                          {point.gap === null ? '待核实' : `${formatNumber(point.gap)} 件`}
                        </strong>
                      </div>
                    </div>
                  )
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} formatter={(value) => <span className={styles.chartLegend}>{value}</span>} />
              <Bar dataKey="quantity" name="发运量" fill="var(--warm-ledger-color-accent)" maxBarSize={28} />
              {hasCoveredSales ? (
                <Line
                  dataKey="sales_quantity"
                  name="同月销量"
                  stroke="var(--warm-ledger-color-text-soft)"
                  strokeWidth={2}
                  dot={{ r: 2, fill: 'var(--warm-ledger-color-text-soft)' }}
                  activeDot={{ r: 4, fill: 'var(--warm-ledger-color-text)' }}
                  connectNulls={false}
                />
              ) : null}
              {hasProvisionalSales ? (
                <Line
                  dataKey="provisional_sales_quantity"
                  name="暂计销量（非整月）"
                  stroke="var(--warm-ledger-color-text-muted)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={{ r: 2, fill: 'var(--warm-ledger-color-text-muted)' }}
                  activeDot={{ r: 4, fill: 'var(--warm-ledger-color-text)' }}
                  connectNulls={false}
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className={styles.historySummary}>
        <p>
          {totals.covered === 0
            ? `已覆盖 0/${data.length} 个月：发运待核实 · 销量待核实 · 差待核实`
            : `已覆盖 ${totals.covered}/${data.length} 个月：发运 ${formatNumber(totals.shipment)} 件 · 销量 ${formatNumber(totals.sales)} 件 · 差 ${formatSignedNumber(totals.gap)} 件`}
          {totals.uncovered > 0 ? ` · ${totals.uncovered} 个月待核实` : null}
          {totals.provisional > 0 ? ` · ${totals.provisional} 个月有暂计` : null}
        </p>
        <p className={styles.missingEtd}>缺少 ETD：{history.missing_etd_shipment_count} 件货 · {formatNumber(history.missing_etd_quantity)} 件</p>
      </div>
    </section>
  )
}
