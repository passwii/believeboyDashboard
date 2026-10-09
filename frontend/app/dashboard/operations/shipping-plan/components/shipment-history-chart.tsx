'use client'

import { useMemo } from 'react'
import { buildShipmentHistoryPoints, type ShipmentHistory, type ShipmentHistoryPoint } from './shipment-history-data'

export { buildShipmentHistoryPoints } from './shipment-history-data'
export type { ShipmentHistory, ShipmentHistoryPoint } from './shipment-history-data'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

export function ShipmentHistoryChart({ history }: { history: ShipmentHistory }) {
  const data = useMemo(() => buildShipmentHistoryPoints(history), [history])

  return (
    <DataTableCard data-testid="shipment-history-strip">
      <DataTableCardHeader title="历史发运量" />
      <DataTableCardBody>
        <div className="h-52 min-w-0 w-full px-2 pt-2" role="img" aria-label="按月统计的历史发运量柱状图，包含发运量为零的月份" data-testid="shipment-history-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--term-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: 'var(--term-border)' }} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} interval="preserveStartEnd" minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: 'var(--term-muted)', fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} />
              <Tooltip
                cursor={{ fill: 'var(--term-hover)' }}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as ShipmentHistoryPoint | undefined
                  if (!active || !point) return null
                  return (
                    <div className="min-w-36 border border-term-border bg-term-panel p-3 text-xs">
                      <div className="mb-2 border-b border-term-border pb-2 font-mono text-term-text">{point.month}</div>
                      <div className="flex justify-between gap-5"><span className="text-term-muted">发运量</span><span className="font-mono tabular-nums text-term-text">{formatNumber(point.quantity)} 件</span></div>
                      <div className="mt-1 flex justify-between gap-5"><span className="text-term-muted">货件数</span><span className="font-mono tabular-nums text-term-text">{formatNumber(point.shipment_count)} 件</span></div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="quantity" name="发运量" fill="var(--term-accent)" maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-term-border px-4 py-2 text-[11px] text-term-muted">
          <span>统计在途与已完成货件，按 ETD 月份归档</span>
          <span className="text-term-warn">缺少 ETD：{history.missing_etd_shipment_count} 件货 · {formatNumber(history.missing_etd_quantity)} 件</span>
        </div>
      </DataTableCardBody>
    </DataTableCard>
  )
}
