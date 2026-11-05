import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { mapRatingSnapshot, type RatingSnapshotPoint } from '@/lib/review-tracking-api'

import { RatingTrendPanel } from './rating-trend-panel'

/**
 * recharts 在 jsdom 下不渲染 SVG 内容，因此这里只断言「指标区文案」与「映射后的
 * 数据契约」（tooltip 明细由 lib 映射层单测覆盖），不对像素做断言。
 */
function point(overrides: Partial<RatingSnapshotPoint> = {}): RatingSnapshotPoint {
  const base = mapRatingSnapshot({
    capture_date: '2026-10-18',
    captured_at: '2026-10-18T03:00:00Z',
    average_rating: 4.25,
    rating_count: 120,
    review_count: 15,
    star_1_percentage: 5,
    star_2_percentage: 5,
    star_3_percentage: 10,
    star_4_percentage: 20,
    star_5_percentage: 60,
    star_1_count: 6,
    star_2_count: 6,
    star_3_count: 12,
    star_4_count: 24,
    star_5_count: 72,
    star_count_quality: 'exact',
    capture_status: 'success',
  } as never)
  return { ...base, ...overrides }
}

afterEach(cleanup)

describe('RatingTrendPanel 指标区', () => {
  it('uses a Warm panel marker without changing snapshot metrics', () => {
    const { container } = render(<RatingTrendPanel points={[point()]} />)

    expect(container.firstElementChild).toHaveAttribute('data-warm-rating-trend', 'true')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(screen.getByText('4.3')).toBeInTheDocument()
  })

  it('展示最近一次快照的平均分 / 评分数 / 评论数 / 采集状态', () => {
    render(<RatingTrendPanel points={[point()]} />)

    expect(screen.getByText('4.3')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('成功')).toBeInTheDocument()
  })

  it('缺失字段渲染为 — 而不是 0（缺采不能落成 0）', () => {
    const missing = mapRatingSnapshot({
      capture_date: '2026-10-18',
      captured_at: '2026-10-18T03:00:00Z',
      average_rating: null,
      rating_count: null,
      review_count: null,
      star_1_percentage: null,
      star_2_percentage: null,
      star_3_percentage: null,
      star_4_percentage: null,
      star_5_percentage: null,
      star_1_count: null,
      star_2_count: null,
      star_3_count: null,
      star_4_count: null,
      star_5_count: null,
      star_count_quality: 'unavailable',
      capture_status: 'failed',
    } as never)

    render(<RatingTrendPanel points={[missing]} />)

    // 平均分 / 评分数 / 评论数 三个指标都是 —
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('部分成功用「部分成功」并保留 warn 语义', () => {
    const partial = point({
      captureStatus: 'partial',
      captureStatusLabel: '部分成功',
      captureStatusTone: 'warn',
    })
    render(<RatingTrendPanel points={[partial]} />)
    expect(screen.getByText('部分成功')).toBeInTheDocument()
  })

  it('口径说明常驻：评分数与评论数不互相换算', () => {
    render(<RatingTrendPanel points={[point()]} />)
    expect(screen.getByText(/两者不互相换算/)).toBeInTheDocument()
  })
})
