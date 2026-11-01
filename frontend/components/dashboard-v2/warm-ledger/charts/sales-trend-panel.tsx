'use client'

import * as React from 'react'

import { formatCompactCurrency, formatFullCurrency } from '../../v2-format'

export interface SalesTrendRow {
  date: string
  label: string
  current: number
  previous?: number | null
}

export interface SalesTrendPanelProps {
  rows: SalesTrendRow[]
  loading?: boolean
  error?: string | Error | null
  className?: string
}

interface ChartPoint {
  x: number
  y: number
  index: number
}

interface ChartScale {
  divisor: number
  lower: number
  upper: number
  ticks: [number, number, number]
}

const CHART_WIDTH = 700
const CHART_HEIGHT = 176
const CHART_TOP = 12
const CHART_BOTTOM = 164
const CHART_LEFT = 8
const CHART_RIGHT = CHART_WIDTH - CHART_LEFT
const CHART_GRID = [CHART_TOP, (CHART_TOP + CHART_BOTTOM) / 2, CHART_BOTTOM]

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function createScale(rows: SalesTrendRow[]): ChartScale {
  let divisor = 1
  for (const row of rows) {
    if (isFiniteNumber(row.current)) divisor = Math.max(divisor, Math.abs(row.current))
    if (isFiniteNumber(row.previous)) divisor = Math.max(divisor, Math.abs(row.previous))
  }

  let lower = 0
  let upper = 0
  for (const row of rows) {
    if (isFiniteNumber(row.current)) {
      const value = row.current / divisor
      lower = Math.min(lower, value)
      upper = Math.max(upper, value)
    }
    if (isFiniteNumber(row.previous)) {
      const value = row.previous / divisor
      lower = Math.min(lower, value)
      upper = Math.max(upper, value)
    }
  }

  if (lower === upper) upper = lower + 1

  const middle = lower + (upper - lower) / 2
  return {
    divisor,
    lower,
    upper,
    ticks: [upper * divisor, middle * divisor, lower * divisor],
  }
}

function toSegments(
  rows: SalesTrendRow[],
  key: 'current' | 'previous',
  scale: ChartScale
): ChartPoint[][] {
  const segments: ChartPoint[][] = []
  let activeSegment: ChartPoint[] = []

  rows.forEach((row, index) => {
    const value = row[key]
    if (!isFiniteNumber(value)) {
      if (activeSegment.length) segments.push(activeSegment)
      activeSegment = []
      return
    }

    const x = rows.length === 1
      ? CHART_WIDTH / 2
      : CHART_LEFT + (index / (rows.length - 1)) * (CHART_RIGHT - CHART_LEFT)
    const scaledValue = value / scale.divisor
    const ratio = (scale.upper - scaledValue) / (scale.upper - scale.lower)
    const y = CHART_TOP + ratio * (CHART_BOTTOM - CHART_TOP)
    activeSegment.push({ x, y, index })
  })

  if (activeSegment.length) segments.push(activeSegment)
  return segments
}

function coordinate(value: number): string {
  return value.toFixed(2)
}

function linePath(points: ChartPoint[]): string {
  if (!points.length) return ''
  const first = points[0]
  let path = `M ${coordinate(first.x)} ${coordinate(first.y)}`

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const third = (current.x - previous.x) / 3
    path += ` C ${coordinate(previous.x + third)} ${coordinate(previous.y)}`
      + ` ${coordinate(current.x - third)} ${coordinate(current.y)}`
      + ` ${coordinate(current.x)} ${coordinate(current.y)}`
  }

  return path
}

function areaPath(points: ChartPoint[]): string {
  if (points.length < 2) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return `${linePath(points)} L ${coordinate(last.x)} ${CHART_BOTTOM}`
    + ` L ${coordinate(first.x)} ${CHART_BOTTOM} Z`
}

function chartSummary(rows: SalesTrendRow[]): string {
  const days = rows.map((row) => {
    const current = isFiniteNumber(row.current) ? formatFullCurrency(row.current) : '无数据'
    const previous = isFiniteNumber(row.previous) ? formatFullCurrency(row.previous) : '无数据'
    return `${row.label}（${row.date}）：本周${current}；上周${previous}`
  })

  return `近 7 天 PT 运营日。${days.join('。')}`
}

function latestCurrentRow(rows: SalesTrendRow[]): SalesTrendRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (isFiniteNumber(rows[index].current)) return rows[index]
  }
  return undefined
}

function LegendItem({ previous = false, label }: { previous?: boolean; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-[11px] leading-4 text-[var(--warm-ledger-color-text-soft)]">
      <span
        aria-hidden="true"
        className={previous
          ? 'h-0 w-4 shrink-0 border-t border-dashed border-[var(--warm-ledger-color-text-muted)]'
          : 'h-[2px] w-4 shrink-0 bg-[var(--warm-ledger-color-accent)]'}
      />
      <span>{label}</span>
    </span>
  )
}

function ChartState({
  kind,
  message,
}: {
  kind: 'loading' | 'empty' | 'error'
  message: string
}) {
  if (kind === 'loading') {
    return (
      <div className="min-w-0" role="status" aria-busy="true">
        <p className="text-[12px] leading-5 text-[var(--warm-ledger-color-text-soft)]">
          {message}
        </p>
        <div aria-hidden="true" className="mt-3 flex h-44 flex-col justify-between">
          {CHART_GRID.map((y) => (
            <span
              key={y}
              className="h-px w-full bg-[var(--warm-ledger-color-chart-grid)]"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex min-h-44 min-w-0 items-center text-[12px] leading-5 text-[var(--warm-ledger-color-text-soft)]"
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {message}
    </div>
  )
}

export function SalesTrendPanel({
  rows,
  loading = false,
  error,
  className,
}: SalesTrendPanelProps) {
  const id = React.useId()
  const titleId = `${id}-title`
  const summaryId = `${id}-summary`
  const latest = latestCurrentRow(rows)
  const latestIndex = latest ? rows.lastIndexOf(latest) : -1
  const scale = createScale(rows)
  const currentSegments = toSegments(rows, 'current', scale)
  const previousSegments = toSegments(rows, 'previous', scale)
  const hasCurrentData = currentSegments.some((segment) => segment.length > 0)
  const errorMessage = error instanceof Error
    ? error.message
    : typeof error === 'string' && error.trim()
      ? error
      : '销售趋势加载失败'
  const summary = chartSummary(rows)

  let state: React.ReactNode
  if (error) {
    state = <ChartState kind="error" message={errorMessage} />
  } else if (loading) {
    state = <ChartState kind="loading" message="正在加载销售趋势" />
  } else if (!hasCurrentData) {
    state = <ChartState kind="empty" message="暂无销售数据" />
  } else {
    state = (
      <div className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] gap-2">
        <div
          aria-hidden="true"
          className="flex h-44 min-w-0 flex-col justify-between font-[var(--warm-ledger-font-mono)] text-[11px] leading-4 tabular-nums text-[var(--warm-ledger-color-text-muted)]"
        >
          {scale.ticks.map((tick, index) => (
            <span key={`${index}-${tick}`} className="min-w-0 break-all">
              {formatCompactCurrency(tick, { maximumFractionDigits: 1 })}
            </span>
          ))}
        </div>

        <div className="min-w-0">
          <svg
            aria-describedby={summaryId}
            aria-labelledby={`${id}-chart-title`}
            className="block h-44 min-w-0 w-full overflow-visible outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--warm-ledger-color-accent-strong)]"
            role="img"
            tabIndex={0}
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
          >
            <title id={`${id}-chart-title`}>销售趋势图</title>
            <desc>本周使用琥珀色实线，上周使用灰色虚线。可访问图片描述以阅读逐日数值。</desc>
            <g aria-hidden="true">
              {CHART_GRID.map((y) => (
                <line
                  key={y}
                  x1={CHART_LEFT}
                  x2={CHART_RIGHT}
                  y1={y}
                  y2={y}
                  stroke="var(--warm-ledger-color-chart-grid)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              {currentSegments.map((segment, index) => {
                const d = areaPath(segment)
                return d ? (
                  <path
                    key={`current-area-${index}`}
                    d={d}
                    fill="var(--warm-ledger-color-accent-area)"
                    data-series="current-area"
                  />
                ) : null
              })}

              {previousSegments.map((segment, index) => (
                <path
                  key={`previous-${index}`}
                  d={linePath(segment)}
                  fill="none"
                  stroke="var(--warm-ledger-color-text-muted)"
                  strokeDasharray="5 5"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                  data-series="previous"
                />
              ))}

              {currentSegments.map((segment, index) => (
                <path
                  key={`current-${index}`}
                  d={linePath(segment)}
                  fill="none"
                  stroke="var(--warm-ledger-color-accent)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                  data-series="current"
                />
              ))}

              {previousSegments.flatMap((segment, segmentIndex) =>
                segment.map((point, pointIndex) => (
                  <circle
                    key={`previous-point-${segmentIndex}-${pointIndex}`}
                    cx={coordinate(point.x)}
                    cy={coordinate(point.y)}
                    r="2.5"
                    fill="var(--warm-ledger-color-panel)"
                    stroke="var(--warm-ledger-color-text-muted)"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    data-point="previous"
                  />
                ))
              )}

              {currentSegments.flatMap((segment, segmentIndex) =>
                segment.map((point, pointIndex) => (
                  <circle
                    key={`current-point-${segmentIndex}-${pointIndex}`}
                    cx={coordinate(point.x)}
                    cy={coordinate(point.y)}
                    r={point.index === latestIndex ? '4' : '2.5'}
                    fill={point.index === latestIndex
                      ? 'var(--warm-ledger-color-accent)'
                      : 'var(--warm-ledger-color-panel)'}
                    stroke="var(--warm-ledger-color-accent)"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    data-point="current"
                  />
                ))
              )}
            </g>
          </svg>

          <div className="flex min-w-0" aria-hidden="true">
            {rows.map((row) => (
              <span
                key={`${row.date}-${row.label}`}
                className="min-w-0 flex-1 break-words text-center text-[11px] leading-4 text-[var(--warm-ledger-color-text-muted)] [overflow-wrap:anywhere]"
              >
                {row.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <section
      aria-labelledby={titleId}
      className={`box-border min-w-0 max-w-full rounded-[var(--warm-ledger-radius-panel)] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] p-5 font-[var(--warm-ledger-font-sans)] text-[var(--warm-ledger-color-text)] max-[460px]:p-3 ${className ?? ''}`}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2
          id={titleId}
          className="min-w-0 text-[16px] font-medium leading-6 text-[var(--warm-ledger-color-text)]"
        >
          销售趋势
        </h2>
        <p className="min-w-0 break-words text-[11px] leading-5 text-[var(--warm-ledger-color-text-soft)]">
          近 7 天 · PT 运营日
        </p>
      </header>

      {!error && !loading && hasCurrentData && (
        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div
            role="group"
            aria-label="图例"
            className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
          >
            <LegendItem label="本周" />
            <LegendItem previous label="上周" />
          </div>
          {latest && (
            <p
              className="min-w-0 break-words text-[11px] leading-5 text-[var(--warm-ledger-color-text-soft)] [overflow-wrap:anywhere]"
              title={`${latest.date} · 本周 ${formatFullCurrency(latest.current)}`}
            >
              最新 ·{' '}
              <span className="font-[var(--warm-ledger-font-mono)]">{latest.label}</span>
              {' '}· 本周{' '}
              <span className="font-[var(--warm-ledger-font-mono)]">
                {formatCompactCurrency(latest.current, { maximumFractionDigits: 1 })}
              </span>
            </p>
          )}
        </div>
      )}

      <div className="mt-4 min-w-0">
        {state}
      </div>

      {!error && !loading && hasCurrentData && (
        <p id={summaryId} className="sr-only">
          {summary}
        </p>
      )}
    </section>
  )
}
