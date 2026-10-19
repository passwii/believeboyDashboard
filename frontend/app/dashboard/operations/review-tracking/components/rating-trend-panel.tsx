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

/**
 * 评分趋势（阶段 C，BLF-1377）。
 *
 * 数据口径（设计稿 §8.3 / §8.5）：
 *  - 每个 `capture_date` 一条快照（同日重试是更新，不在图上出现双点）；
 *  - `capture_status=failed` 的日期没有可比数据，`average_rating` 走 `null`，
 *    recharts 自然断点（`connectNulls={false}`），不画成 0；
 *  - hover 显示当天：平均分、评分数（global ratings）、评论数（有正文）、
 *    1–5 星占比与数量口径、采集状态。
 */

const TONE_CLASS = {
  pos: 'text-term-pos',
  warn: 'text-term-warn',
  neg: 'text-term-neg',
  muted: 'text-term-muted',
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
    <div
      className="min-w-[220px] space-y-2 border border-term-border bg-term-panel p-3 font-mono text-[11px] text-term-text"
      data-testid="rating-tooltip"
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-term-muted">{point.captureDate}</span>
        <span className={cn('font-semibold', TONE_CLASS[point.captureStatusTone])}>
          {point.captureStatusLabel}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
        <span className="text-term-muted">平均分</span>
        <span className="text-right">{formatAverageRating(point.averageRating)}</span>
        <span className="text-term-muted">评分数</span>
        <span className="text-right">{formatCount(point.ratingCount)}</span>
        <span className="text-term-muted">评论数</span>
        <span className="text-right">{formatCount(point.reviewCount)}</span>
      </div>

      <StarDistribution stars={point.stars} qualityLabel={point.starCountQualityLabel} />

      {point.captureStatusHint ? (
        <p className="text-term-muted">{point.captureStatusHint}</p>
      ) : null}
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
        // `null` 保持 null，让折线断开——缺采不能落成 0
        averageRating: point.averageRating,
      })),
    [points]
  )

  const latest = points.length > 0 ? points[points.length - 1] : null

  return (
    <div className={cn('space-y-4', className)}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCell label="平均分" value={formatAverageRating(latest?.averageRating ?? null)} note="最近一次" />
        <MetricCell label="评分数" value={formatCount(latest?.ratingCount ?? null)} note="页面 global ratings" />
        <MetricCell label="评论数" value={formatCount(latest?.reviewCount ?? null)} note="有正文的评论" />
        <MetricCell
          label="采集状态"
          value={latest ? latest.captureStatusLabel : MISSING_VALUE}
          note={latest ? latest.captureDate : '暂无快照'}
          tone={latest ? latest.captureStatusTone : 'muted'}
        />
      </div>

      <div className="h-[260px] w-full" data-testid="rating-trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
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
              domain={[0, 5]}
              ticks={[0, 1, 2, 3, 4, 5]}
              tick={{ fill: 'var(--term-muted)', fontSize: 11, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={false}
              width={32}
            />
            <Tooltip
              content={<RatingTooltip />}
              cursor={{ stroke: 'var(--term-border)', strokeDasharray: '3 3' }}
            />
            <Line
              type="monotone"
              dataKey="averageRating"
              name="平均分"
              connectNulls={false}
              stroke="var(--term-accent)"
              strokeWidth={2}
              dot={{ r: 3, fill: 'var(--term-accent)', stroke: 'var(--term-panel)', strokeWidth: 1.5 }}
              activeDot={{ r: 4, fill: 'var(--term-accent)', stroke: 'var(--term-panel)', strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="font-mono text-[11px] text-term-muted">
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
    <div className="border border-term-border bg-term-panel px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-term-muted">{label}</div>
      <div className={cn('font-mono text-lg font-semibold tabular-nums', TONE_CLASS[tone])}>{value}</div>
      <div className="font-mono text-[10px] text-term-faint">{note}</div>
    </div>
  )
}
