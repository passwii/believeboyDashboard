'use client'

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import styles from '../complaint-center-warm.module.css'

export interface TrendPoint {
  date: string
  needs_reply: number
}

interface ComplaintTrendChartProps {
  data: TrendPoint[]
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function ComplaintTrendChart({ data }: ComplaintTrendChartProps) {
  const chartData = useMemo(
    () => data.map((p) => ({ ...p, label: formatDate(p.date) })),
    [data]
  )

  if (data.length === 0) return null

  return (
    <div className={styles.chart} data-testid="complaint-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--warm-ledger-color-accent)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--warm-ledger-color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--warm-ledger-color-chart-grid)"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{
              fill: 'var(--warm-ledger-color-text-muted)',
              fontSize: 11,
              fontFamily: 'var(--warm-ledger-font-sans)',
            }}
            tickLine={false}
            axisLine={{ stroke: 'var(--warm-ledger-color-hairline)' }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            tick={{
              fill: 'var(--warm-ledger-color-text-muted)',
              fontSize: 11,
              fontFamily: 'var(--warm-ledger-font-sans)',
            }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--warm-ledger-color-panel-strong)',
              border: '1px solid var(--warm-ledger-color-hairline-strong)',
              borderRadius: 10,
              fontFamily: 'var(--warm-ledger-font-sans)',
              fontSize: 12,
              color: 'var(--warm-ledger-color-text)',
            }}
            labelStyle={{ color: 'var(--warm-ledger-color-text-muted)' }}
            formatter={(value: number) => [`${value} 条`, '待回复']}
            cursor={{ stroke: 'var(--warm-ledger-color-hairline)', strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey="needs_reply"
            stroke="var(--warm-ledger-color-accent)"
            strokeWidth={2}
            fill="url(#trendFill)"
            dot={{
              r: 3,
              fill: 'var(--warm-ledger-color-accent)',
              stroke: 'var(--warm-ledger-color-panel)',
              strokeWidth: 1.5,
            }}
            activeDot={{
              r: 4,
              fill: 'var(--warm-ledger-color-accent)',
              stroke: 'var(--warm-ledger-color-panel)',
              strokeWidth: 2,
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
