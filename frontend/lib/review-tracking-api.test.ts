import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MISSING_VALUE,
  ReviewTrackingApiError,
  captureStatusLabel,
  describeReviewTrackingError,
  fetchReviews,
  formatAverageRating,
  formatCount,
  formatStarCount,
  hasMorePage,
  idConfidenceLabel,
  mapCrawlRun,
  mapExternalTarget,
  mapRatingSnapshot,
  mapReview,
  mapReviewGroup,
  mapTarget,
  starCountQualityLabel,
  visibilityLabel,
} from './review-tracking-api'

// ======================== fixtures ========================

function snapshotDto(overrides: Record<string, unknown> = {}) {
  return {
    capture_date: '2026-10-18',
    captured_at: '2026-10-18T03:00:00Z',
    average_rating: 4.2,
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
    ...overrides,
  }
}

function reviewDto(overrides: Record<string, unknown> = {}) {
  return {
    review_key: 'R1F90C6R6GV8L6',
    id_confidence: 'original',
    reviewer_id: null,
    reviewer_name: '买家 A',
    rating: 4,
    title: '不错的商品',
    body: '正文',
    review_date: '2026-10-01',
    verified_purchase: true,
    helpful_count: 3,
    first_seen_at: '2026-10-02T00:00:00Z',
    last_seen_at: '2026-10-18T00:00:00Z',
    visibility_status: 'visible',
    ...overrides,
  }
}

// ======================== 映射层 ========================

describe('mapRatingSnapshot：缺失值绝不渲染成 0', () => {
  it('null 指标全部映射为 —', () => {
    const point = mapRatingSnapshot(
      snapshotDto({
        average_rating: null,
        rating_count: null,
        review_count: null,
        star_1_percentage: null,
        star_1_count: null,
        star_count_quality: 'unavailable',
      }) as never
    )

    expect(point.averageRating).toBeNull()
    expect(point.ratingCount).toBeNull()
    expect(point.reviewCount).toBeNull()
    expect(formatAverageRating(point.averageRating)).toBe(MISSING_VALUE)
    expect(formatCount(point.ratingCount)).toBe(MISSING_VALUE)
    expect(formatCount(point.reviewCount)).toBe(MISSING_VALUE)

    const star1 = point.stars.find((s) => s.star === 1)
    expect(star1?.percentage).toBeNull()
    expect(star1?.countText).toBe(MISSING_VALUE)
    expect(star1?.countAvailable).toBe(false)
  })

  it('评分数与评论数分开展示，不互相兜底', () => {
    const point = mapRatingSnapshot(
      snapshotDto({ rating_count: 7, review_count: null }) as never
    )
    expect(formatCount(point.ratingCount)).toBe('7')
    expect(formatCount(point.reviewCount)).toBe(MISSING_VALUE)
  })
})

describe('星数口径三档', () => {
  it('exact 直接展示数量', () => {
    expect(formatStarCount(24, 'exact')).toBe('24')
  })

  it('estimated 加 ≈ 前缀（不冒称精确）', () => {
    expect(formatStarCount(24, 'estimated')).toBe('≈24')
  })

  it('unavailable 只保留百分比，数量不展示', () => {
    expect(formatStarCount(24, 'unavailable')).toBe(MISSING_VALUE)
    expect(formatStarCount(null, 'exact')).toBe(MISSING_VALUE)
  })

  it('星占比保持页面原始值且按 5→1 排序', () => {
    const point = mapRatingSnapshot(snapshotDto() as never)
    expect(point.stars.map((s) => s.star)).toEqual([5, 4, 3, 2, 1])
    expect(point.stars[0].percentage).toBe(60)
  })

  it('口径文案三档 + 未知兜底', () => {
    expect(starCountQualityLabel('exact')).toBe('精确数量')
    expect(starCountQualityLabel('estimated')).toBe('按百分比估算')
    expect(starCountQualityLabel('unavailable')).toBe('数量未取到')
    expect(starCountQualityLabel('mystery')).toBe('mystery')
  })
})

describe('状态文案与未知枚举兜底', () => {
  it('capture_status 三档 + 色档', () => {
    expect(captureStatusLabel('success').label).toBe('成功')
    expect(captureStatusLabel('partial').label).toBe('部分成功')
    expect(captureStatusLabel('partial').tone).toBe('warn')
    expect(captureStatusLabel('failed').tone).toBe('neg')
    expect(captureStatusLabel('weird').label).toBe('weird')
    expect(captureStatusLabel('weird').tone).toBe('muted')
  })

  it('visibility_status 两档 + 兜底', () => {
    expect(visibilityLabel('visible').label).toBe('可见')
    expect(visibilityLabel('suspected_removed').label).toBe('疑似移除')
    expect(visibilityLabel('other').label).toBe('other')
  })

  it('id_confidence 两档 + 兜底', () => {
    expect(idConfidenceLabel('original').label).toBe('来源 ID')
    expect(idConfidenceLabel('derived').label).toBe('推导 ID')
    expect(idConfidenceLabel('unknown-value').label).toBe('unknown-value')
  })

  it('部分成功的快照保留成功文案但标记 warn', () => {
    const point = mapRatingSnapshot(snapshotDto({ capture_status: 'partial' }) as never)
    expect(point.captureStatusLabel).toBe('部分成功')
    expect(point.captureStatusTone).toBe('warn')
    expect(point.captureStatusHint).toContain('缺失项不按 0 计')
  })
})

describe('mapReview / mapCrawlRun', () => {
  it('评论映射保留三态 verified 与 helpful', () => {
    const row = mapReview(reviewDto() as never)
    expect(row.verifiedPurchase).toBe(true)
    expect(row.helpfulCount).toBe(3)
    expect(row.visibility).toBe('visible')
    expect(row.idConfidenceHint).toContain('页面直接提供')
  })

  it('未标记 Verified 与 unknown 区分：null 保持 null', () => {
    const row = mapReview(reviewDto({ verified_purchase: null, helpful_count: null }) as never)
    expect(row.verifiedPurchase).toBeNull()
    expect(row.helpfulCount).toBeNull()
  })

  it('运行记录：false 与 null 不混淆', () => {
    const run = mapCrawlRun({
      id: 9,
      started_at: '2026-10-18T03:00:00Z',
      finished_at: null,
      status: 'partial',
      is_complete_list: false,
      reviews_seen: null,
      ratings_captured: true,
      asin_scraped: 'B0G6C865B6',
      error_message: 'timeout',
    } as never)
    expect(run.isCompleteList).toBe(false)
    expect(run.reviewsSeen).toBeNull()
    expect(run.ratingsCaptured).toBe(true)
    expect(run.statusTone).toBe('warn')
  })
})

describe('mapTarget / mapExternalTarget', () => {
  it('内部目标用项目名，外部目标标「外部竞品」', () => {
    const internal = mapTarget(
      {
        id: 1,
        kind: 'internal_group',
        group_id: 3,
        project_id: 18,
        marketplace: 'US',
        asin: 'B0AAAAAAA1',
        display_name: '主力款共享组',
        is_active: true,
      } as never,
      new Map([[18, '项目A']])
    )
    expect(internal.projectName).toBe('项目A')
    expect(internal.kindLabel).toBe('内部共享组')
    expect(internal.displayName).toBe('主力款共享组')

    const external = mapTarget({
      id: 2,
      kind: 'external_asin',
      group_id: null,
      project_id: null,
      marketplace: 'DE',
      asin: 'B0BBBBBBB2',
      display_name: null,
      is_active: true,
    } as never)
    expect(external.projectName).toBe('外部竞品')
    expect(external.displayName).toBe('B0BBBBBBB2')
  })

  it('外部目标统计活跃关联数（软删的不计）', () => {
    const target = mapExternalTarget({
      id: 5,
      kind: 'external_asin',
      group_id: null,
      project_id: null,
      marketplace: 'US',
      asin: 'B0CCCCCCC3',
      display_name: '竞品 C',
      is_active: true,
      links: [
        { id: 1, target_id: 5, shop_id: 11, is_active: true },
        { id: 2, target_id: 5, shop_id: 12, is_active: false },
      ],
    } as never)
    expect(target.links).toHaveLength(2)
    expect(target.activeLinkCount).toBe(1)
  })
})

describe('mapReviewGroup', () => {
  it('成员数组复制，避免页面就地改动污染缓存', () => {
    const dto = {
      id: 3,
      project_id: 18,
      marketplace: 'US',
      name: '组 A',
      description: null,
      representative_id: 101,
      member_ids: [101, 102],
      is_active: true,
    }
    const group = mapReviewGroup(dto as never)
    expect(group.memberIds).toEqual([101, 102])
    expect(group.memberIds).not.toBe(dto.member_ids)
  })
})

describe('分页判定', () => {
  it('返回行数达到 limit 才算还有下一页', () => {
    expect(hasMorePage(100, 100)).toBe(true)
    expect(hasMorePage(99, 100)).toBe(false)
    expect(hasMorePage(0, 100)).toBe(false)
  })
})

describe('describeReviewTrackingError：权限与存在性分流', () => {
  it('401 / 403 / 404 / 500 各自文案', () => {
    expect(describeReviewTrackingError(new ReviewTrackingApiError(401, 'nope')).title).toBe(
      '登录状态已失效'
    )
    expect(describeReviewTrackingError(new ReviewTrackingApiError(403, 'forbidden')).message).toContain(
      '运营与管理员'
    )
    expect(describeReviewTrackingError(new ReviewTrackingApiError(404, 'missing')).title).toBe(
      '目标不存在或无权访问'
    )
    const server = describeReviewTrackingError(new ReviewTrackingApiError(500, 'boom'))
    expect(server.status).toBe(500)
    expect(server.message).toBe('boom')
  })

  it('非 API 错误回落通用文案', () => {
    const described = describeReviewTrackingError(new Error('Failed to fetch'))
    expect(described.status).toBeNull()
    expect(described.message).toBe('Failed to fetch')
  })
})

// ======================== 传输层 ========================

describe('fetchReviews：查询串与错误类型', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('可见性 / 日期 / 分页参数按后端字段名传参', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [reviewDto()],
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchReviews(7, {
      visibilityStatus: 'suspected_removed',
      reviewDateFrom: '2026-10-01',
      reviewDateTo: '2026-10-31',
      limit: 50,
      offset: 100,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].reviewKey).toBe('R1F90C6R6GV8L6')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/api/backend/api/v1/amazon-review-tracking/targets/7/reviews?')
    expect(url).toContain('visibility_status=suspected_removed')
    expect(url).toContain('review_date_from=2026-10-01')
    expect(url).toContain('review_date_to=2026-10-31')
    expect(url).toContain('limit=50')
    expect(url).toContain('offset=100')
  })

  it('非 2xx 抛带 status 的 ReviewTrackingApiError（403 不静默）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ detail: '需要运营或管理员权限' }),
      })
    )

    await expect(fetchReviews(7)).rejects.toMatchObject({
      name: 'ReviewTrackingApiError',
      status: 403,
      detail: '需要运营或管理员权限',
    })
  })
})
