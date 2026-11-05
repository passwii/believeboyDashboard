'use client'

import { useId, type ReactNode } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import styles from './digital-display-warm.module.css'

export type WarmChartConfig = Record<string, { label: string; color: string }>

export type WarmChartSeries = {
  dataKey: string
  name?: string
}

export type WarmChartTooltipEntry = {
  dataKey?: string
  name?: string
  value?: string | number
  color?: string
}

function formatXTick(value: unknown) {
  if (value == null) return ''
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text
}

export function WarmChartTooltip({
  active,
  label,
  payload,
  formatter,
}: {
  active?: boolean
  label?: unknown
  payload?: WarmChartTooltipEntry[]
  formatter?: (value: number | string, name: string) => ReactNode
}) {
  if (!active || !payload?.length) return null

  return (
    <div
      className={styles.chartTooltip}
      data-testid="digital-display-warm-chart-tooltip"
    >
      {label != null ? <p className={styles.chartTooltipLabel}>{String(label)}</p> : null}
      <div className={styles.chartTooltipRows}>
        {payload.map((item, index) => {
          const name = String(item.name ?? item.dataKey ?? 'value')
          const value = item.value ?? ''
          return (
            <div key={`${name}-${index}`} className={styles.chartTooltipRow}>
              <span>
                <span
                  className={styles.chartTooltipSwatch}
                  style={{ backgroundColor: item.color ?? configFallbackColor }}
                  aria-hidden
                />
                {name}
              </span>
              <strong>{formatter ? formatter(value, name) : value}</strong>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const configFallbackColor = 'var(--warm-ledger-color-text-muted)'

export function WarmTrendChart({
  data,
  xKey,
  series,
  config,
  yTickFormatter,
  tooltipFormatter,
}: {
  data: ReadonlyArray<Record<string, unknown>>
  xKey: string
  series: WarmChartSeries[]
  config: WarmChartConfig
  yTickFormatter?: (value: number) => string
  tooltipFormatter?: (value: number | string, name: string) => ReactNode
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  return (
    <div
      className={styles.chartFrame}
      data-testid="digital-display-warm-chart"
      data-warm-chart="true"
    >
      <div
        className={styles.chartLegend}
        data-testid="digital-display-warm-chart-legend"
        aria-label="图例"
      >
        {series.map((item) => {
          const meta = config[item.dataKey]
          return (
            <span key={item.dataKey} className={styles.chartLegendItem}>
              <span
                className={styles.chartLegendSwatch}
                style={{ backgroundColor: meta?.color ?? configFallbackColor }}
                aria-hidden
              />
              {meta?.label ?? item.name ?? item.dataKey}
            </span>
          )
        })}
      </div>

      <div className={styles.chartCanvas}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            accessibilityLayer
            data={data as Array<Record<string, unknown>>}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              {series.map((item) => (
                <linearGradient
                  key={item.dataKey}
                  id={`${reactId}-${item.dataKey}`}
                  x1="0"
                  x2="0"
                  y1="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={config[item.dataKey]?.color ?? configFallbackColor}
                    stopOpacity={0.28}
                  />
                  <stop
                    offset="100%"
                    stopColor={config[item.dataKey]?.color ?? configFallbackColor}
                    stopOpacity={0}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid
              vertical={false}
              stroke="var(--warm-ledger-color-chart-grid)"
              strokeDasharray="3 3"
            />
            <XAxis
              dataKey={xKey}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={formatXTick}
              tick={{
                fill: 'var(--warm-ledger-color-text-muted)',
                fontFamily: 'var(--warm-ledger-font-mono)',
                fontSize: 11,
              }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={56}
              tickFormatter={(value) =>
                yTickFormatter ? yTickFormatter(Number(value)) : String(value)
              }
              tick={{
                fill: 'var(--warm-ledger-color-text-muted)',
                fontFamily: 'var(--warm-ledger-font-mono)',
                fontSize: 11,
              }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--warm-ledger-color-hairline-strong)', strokeDasharray: '4 4' }}
              content={({ active, label, payload }) => (
                <WarmChartTooltip
                  active={active}
                  label={label}
                  payload={payload as unknown as WarmChartTooltipEntry[]}
                  formatter={tooltipFormatter}
                />
              )}
            />
            {series.map((item) => (
              <Area
                key={item.dataKey}
                type="monotone"
                dataKey={item.dataKey}
                name={item.name ?? config[item.dataKey]?.label ?? item.dataKey}
                stroke={config[item.dataKey]?.color ?? configFallbackColor}
                strokeWidth={2}
                fill={`url(#${reactId}-${item.dataKey})`}
                isAnimationActive
                animationDuration={300}
                animationEasing="ease-out"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
