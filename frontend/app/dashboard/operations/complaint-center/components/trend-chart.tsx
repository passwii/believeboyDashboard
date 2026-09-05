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
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--term-accent)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--term-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--term-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--term-muted)', fontSize: 11, fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--term-border)' }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'var(--term-muted)', fontSize: 11, fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--term-panel)',
              border: '1px solid var(--term-border)',
              borderRadius: 0,
              fontFamily: 'monospace',
              fontSize: 12,
              color: 'var(--term-text)',
            }}
            labelStyle={{ color: 'var(--term-muted)' }}
            formatter={(value: number) => [`${value} 条`, '待回复']}
            cursor={{ stroke: 'var(--term-border)', strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey="needs_reply"
            stroke="var(--term-accent)"
            strokeWidth={2}
            fill="url(#trendFill)"
            dot={{ r: 3, fill: 'var(--term-accent)', stroke: 'var(--term-panel)', strokeWidth: 1.5 }}
            activeDot={{ r: 4, fill: 'var(--term-accent)', stroke: 'var(--term-panel)', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
