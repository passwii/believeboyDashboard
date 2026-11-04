'use client'

import { useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { StarDistribution } from './star-distribution'
import {
  MISSING_VALUE,
  formatAverageRating,
  formatCount,
  type RatingSnapshotPoint,
} from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'
import styles from '../review-tracking-warm.module.css'

const TONE_CLASS = {
  pos: styles.tonePositive,
  warn: styles.toneAccent,
  neg: styles.toneNegative,
  muted: styles.toneMuted,
} as const

function shortDate(iso: string): string {
  const [, month, day] = iso.split('-')
  return `${Number(month)}/${Number(day)}`
}

interface TooltipPayloadItem {
  payload?: RatingSnapshotPoint
}

function RatingTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
}) {
  const point = active ? payload?.[0]?.payload : undefined
  if (!point) return null

  return (
    <div className={styles.tooltip} data-testid="rating-tooltip">
      <div className={styles.tooltipTop}>
        <span>{point.captureDate}</span>
        <span className={cn(styles.statusText, TONE_CLASS[point.captureStatusTone])}>
          {point.captureStatusLabel}
        </span>
      </div>

      <div className={styles.tooltipGrid}>
        <span>平均分</span>
        <span>{formatAverageRating(point.averageRating)}</span>
        <span>评分数</span>
        <span>{formatCount(point.ratingCount)}</span>
        <span>评论数</span>
        <span>{formatCount(point.reviewCount)}</span>
      </div>

      <StarDistribution stars={point.stars} qualityLabel={point.starCountQualityLabel} />

      {point.captureStatusHint ? <p className={styles.caption}>{point.captureStatusHint}</p> : null}
    </div>
  )
}

export interface RatingTrendPanelProps {
  points: RatingSnapshotPoint[]
  className?: string
}

export function RatingTrendPanel({ points, className }: RatingTrendPanelProps) {
  const chartData = useMemo(
    () =>
      points.map((point) => ({
        ...point,
        label: shortDate(point.captureDate),
        averageRating: point.averageRating,
      })),
    [points]
  )

  const latest = points.length > 0 ? points[points.length - 1] : null

  return (
    <div
      className={cn(styles.rating, className)}
      data-warm-rating-trend="true"
      data-warm-panel="true"
    >
      <div className={styles.metricGrid}>
        <MetricCell
          label="平均分"
          value={formatAverageRating(latest?.averageRating ?? null)}
          note="最近一次"
        />
        <MetricCell
          label="评分数"
          value={formatCount(latest?.ratingCount ?? null)}
          note="页面 global ratings"
        />
        <MetricCell
          label="评论数"
          value={formatCount(latest?.reviewCount ?? null)}
          note="有正文的评论"
        />
        <MetricCell
          label="采集状态"
          value={latest ? latest.captureStatusLabel : MISSING_VALUE}
          note={latest ? latest.captureDate : '暂无快照'}
          tone={latest ? latest.captureStatusTone : 'muted'}
        />
      </div>

      <div className={styles.chart} data-testid="rating-trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
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
              domain={[0, 5]}
              ticks={[0, 1, 2, 3, 4, 5]}
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
              content={<RatingTooltip />}
              cursor={{ stroke: 'var(--warm-ledger-color-hairline)', strokeDasharray: '3 3' }}
            />
            <Line
              type="monotone"
              dataKey="averageRating"
              name="平均分"
              connectNulls={false}
              stroke="var(--warm-ledger-color-accent)"
              strokeWidth={2}
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
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className={styles.chartFootnote}>
        评分数是页面展示的 global ratings 总数，评论数只统计抓到的有正文评论，两者不互相换算。
        标「≈」的星数是按页面百分比与评分数推算，不是页面给出的精确数量。
      </p>
    </div>
  )
}

function MetricCell({
  label,
  value,
  note,
  tone = 'muted',
}: {
  label: string
  value: string
  note: string
  tone?: keyof typeof TONE_CLASS
}) {
  return (
    <div className={cn(styles.metricCell, TONE_CLASS[tone])}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricNote}>{note}</span>
    </div>
  )
}
