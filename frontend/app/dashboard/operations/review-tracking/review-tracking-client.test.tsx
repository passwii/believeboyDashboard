import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications, stableSession } from '@/test-utils/stable-mocks'

// ── mocks ────────────────────────────────────────────────────────────────────

// session 可切：评论追踪页的写操作（登记外部竞品）仅管理员可见，
// 其余用例一律用运营账号。`stableSession` 按值缓存，同一组入参身份恒定。
const { sessionUser } = vi.hoisted(() => ({
  sessionUser: { current: { id: 'user-1', roleType: 'operator' } as Record<string, unknown> },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: sessionUser.current }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

vi.mock('@/lib/review-tracking-shops', () => ({
  fetchShopOptions: vi.fn().mockResolvedValue([]),
  formatShopOption: (option: { projectName: string; shopName: string | null; shopId: string; country: string }) =>
    `${option.projectName} / ${option.shopName ?? option.shopId} · ${option.country}`,
}))

// 头部插槽：原位渲染，不 portal
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

const {
  fetchTargets,
  fetchRatingSnapshots,
  fetchReviews,
  fetchCrawlRuns,
  fetchExternalTargets,
  createExternalTarget,
} = vi.hoisted(() => ({
  fetchTargets: vi.fn(),
  fetchRatingSnapshots: vi.fn(),
  fetchReviews: vi.fn(),
  fetchCrawlRuns: vi.fn(),
  fetchExternalTargets: vi.fn(),
  createExternalTarget: vi.fn(),
}))

vi.mock('@/lib/review-tracking-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/review-tracking-api')>()
  return {
    ...actual,
    fetchTargets,
    fetchRatingSnapshots,
    fetchReviews,
    fetchCrawlRuns,
    fetchExternalTargets,
    createExternalTarget,
  }
})

import ReviewTrackingClient from './review-tracking-client'
import {
  ReviewTrackingApiError,
  mapRatingSnapshot,
  mapReview,
  mapTarget,
} from '@/lib/review-tracking-api'

const INTERNAL_TARGET = mapTarget({
  id: 1,
  kind: 'internal_group',
  group_id: 3,
  project_id: 1,
  marketplace: 'US',
  asin: 'B0AAAAAAA1',
  display_name: '主力款共享组',
  is_active: true,
} as never)

const EXTERNAL_TARGET = mapTarget({
  id: 2,
  kind: 'external_asin',
  group_id: null,
  project_id: null,
  marketplace: 'US',
  asin: 'B0BBBBBBB2',
  display_name: '竞品 B',
  is_active: true,
} as never)

beforeEach(() => {
  vi.clearAllMocks()
  sessionUser.current = { id: 'user-1', roleType: 'operator' }
  fetchTargets.mockResolvedValue([INTERNAL_TARGET])
  fetchRatingSnapshots.mockResolvedValue([])
  fetchReviews.mockResolvedValue([])
  fetchCrawlRuns.mockResolvedValue([])
  fetchExternalTargets.mockResolvedValue([])
  createExternalTarget.mockResolvedValue(undefined)
})

afterEach(cleanup)

// ── helpers ──────────────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function snapshot(averageRating: number, captureDate = '2026-10-18') {
  return mapRatingSnapshot({
    capture_date: captureDate,
    captured_at: `${captureDate}T03:00:00Z`,
    average_rating: averageRating,
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
}

function review(title: string) {
  return mapReview({
    review_key: `key-${title}`,
    id_confidence: 'exact',
    reviewer_name: '测试评论者',
    rating: 5,
    title,
    body: '正文',
    review_date: '2026-10-17',
    verified_purchase: true,
    helpful_count: 1,
    first_seen_at: '2026-10-17T03:00:00Z',
    last_seen_at: '2026-10-18T03:00:00Z',
    visibility_status: 'visible',
  } as never)
}

describe('评论追踪页：空态', () => {
  it('renders Warm page, target selector, panel, and table scroll containment', async () => {
    render(<ReviewTrackingClient />)

    const page = await screen.findByTestId('review-tracking-page')
    expect(page).toHaveAttribute('data-warm-review-tracking', 'true')
    expect(screen.getByTestId('target-selector')).toBeInTheDocument()
    expect(screen.getByTestId('review-tracking-panel')).toHaveAttribute('data-warm-panel', 'true')

    fireEvent.mouseDown(screen.getByRole('tab', { name: '评论明细' }))
    fireEvent.click(screen.getByRole('tab', { name: '评论明细' }))

    const table = await screen.findByRole('table')
    expect(table.parentElement).toHaveAttribute('data-warm-table-scroll', 'true')
    expect(page.querySelector('[class*="term-"]')).toBeNull()
  })

  it('没有目标时提示等待采集端接入，并列出空态', async () => {
    fetchTargets.mockResolvedValue([])
    render(<ReviewTrackingClient />)

    expect(await screen.findByText(/还没有追踪目标/)).toBeInTheDocument()
    expect(screen.getByText(/等待采集端接入/)).toBeInTheDocument()
  })

  it('有目标但无快照时，趋势区块给出明确空态（不渲染假数据）', async () => {
    render(<ReviewTrackingClient />)

    expect(await screen.findByText('还没有评分快照（等待采集端接入）；采集上线后这里会按天积累历史。')).toBeInTheDocument()
  })

  it('有快照时渲染指标而不是空态', async () => {
    fetchRatingSnapshots.mockResolvedValue([
      mapRatingSnapshot({
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
      } as never),
    ])

    render(<ReviewTrackingClient />)

    expect(await screen.findByTestId('rating-trend-chart')).toBeInTheDocument()
    expect(screen.getByText('4.2')).toBeInTheDocument()
    expect(screen.queryByText(/还没有评分快照/)).not.toBeInTheDocument()
  })
})

describe('评论追踪页：权限与存在性', () => {
  it('403 显示权限说明，不渲染数据区、不重试', async () => {
    fetchTargets.mockRejectedValue(new ReviewTrackingApiError(403, '需要运营或管理员权限'))
    render(<ReviewTrackingClient />)

    expect(await screen.findByText(/没有访问权限/)).toBeInTheDocument()
    expect(screen.getByText(/仅对运营与管理员开放/)).toBeInTheDocument()
    // 没有目标列表 / 图表
    expect(screen.queryByTestId('target-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rating-trend-chart')).not.toBeInTheDocument()
    expect(fetchTargets).toHaveBeenCalledTimes(1)
  })

  it('不可见目标的 404 走通用错误提示，不误判为权限问题', async () => {
    fetchRatingSnapshots.mockRejectedValue(new ReviewTrackingApiError(404, 'review target not found'))
    render(<ReviewTrackingClient />)

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '目标不存在或无权访问' })
      )
    )
    // 目标列表仍在（404 只影响详情），页面不整体降级为权限墙
    expect(screen.getByTestId('target-selector')).toBeInTheDocument()
  })
})

describe('评论追踪页：目标选择', () => {
  it('内部与外部目标分组展示，默认选中第一个并拉取详情', async () => {
    fetchTargets.mockResolvedValue([INTERNAL_TARGET, EXTERNAL_TARGET])
    render(<ReviewTrackingClient />)

    expect(await screen.findByTestId('target-1')).toBeInTheDocument()
    expect(screen.getByTestId('target-2')).toBeInTheDocument()
    expect(screen.getByText('内部共享组 (1)')).toBeInTheDocument()
    expect(screen.getByText('外部竞品 (1)')).toBeInTheDocument()

    await waitFor(() => expect(fetchRatingSnapshots).toHaveBeenCalledWith(1, { limit: 200 }))
    expect(fetchRatingSnapshots).not.toHaveBeenCalledWith(2, { limit: 200 })
  })

  it('切换目标后重新拉取该目标的快照/评论/运行', async () => {
    fetchTargets.mockResolvedValue([INTERNAL_TARGET, EXTERNAL_TARGET])
    render(<ReviewTrackingClient />)

    await screen.findByTestId('target-2')
    await waitFor(() => expect(fetchRatingSnapshots).toHaveBeenCalledWith(1, { limit: 200 }))

    screen.getByTestId('target-2').click()

    await waitFor(() => expect(fetchRatingSnapshots).toHaveBeenCalledWith(2, { limit: 200 }))
    await waitFor(() =>
      expect(fetchReviews).toHaveBeenCalledWith(2, expect.objectContaining({ limit: 50, offset: 0 }))
    )
    await waitFor(() => expect(fetchCrawlRuns).toHaveBeenCalledWith(2, { limit: 20 }))
  })
})

describe('评论追踪页：切目标防串台（B4）', () => {
  it('A 未回就切到 B，A 后到时仍渲染 B 的快照', async () => {
    fetchTargets.mockResolvedValue([INTERNAL_TARGET, EXTERNAL_TARGET])
    const slowA = deferred<ReturnType<typeof snapshot>[]>()
    fetchRatingSnapshots.mockImplementation((targetId: number) =>
      targetId === 1 ? slowA.promise : Promise.resolve([snapshot(3.1)])
    )

    render(<ReviewTrackingClient />)
    await screen.findByTestId('target-2')
    await waitFor(() => expect(fetchRatingSnapshots).toHaveBeenCalledWith(1, { limit: 200 }))

    // 切到 B：B 先回，图表先渲染 B 的数据
    screen.getByTestId('target-2').click()
    expect(await screen.findByText('3.1')).toBeInTheDocument()

    // A 的响应此刻才回来：必须被丢弃，不能把 B 的图表盖成 A 的 4.2
    await act(async () => {
      slowA.resolve([snapshot(4.2)])
    })

    await waitFor(() => expect(screen.getByText('3.1')).toBeInTheDocument())
    expect(screen.queryByText('4.2')).not.toBeInTheDocument()
  })

  it('A 未回就切到 B，A 后到时仍渲染 B 的评论（含翻页/可见性令牌）', async () => {
    fetchTargets.mockResolvedValue([INTERNAL_TARGET, EXTERNAL_TARGET])
    const slowA = deferred<ReturnType<typeof review>[]>()
    fetchReviews.mockImplementation((targetId: number) =>
      targetId === 1 ? slowA.promise : Promise.resolve([review('B 的评论标题')])
    )

    render(<ReviewTrackingClient />)
    await screen.findByTestId('target-2')
    fireEvent.mouseDown(screen.getByRole('tab', { name: '评论明细' }))
    fireEvent.click(screen.getByRole('tab', { name: '评论明细' }))

    screen.getByTestId('target-2').click()
    expect(await screen.findByText('B 的评论标题')).toBeInTheDocument()

    await act(async () => {
      slowA.resolve([review('A 的评论标题')])
    })

    await waitFor(() => expect(screen.getByText('B 的评论标题')).toBeInTheDocument())
    expect(screen.queryByText('A 的评论标题')).not.toBeInTheDocument()
  })
})

describe('评论追踪页：外部竞品登记（B5）', () => {
  it('登记成功后同时刷新外部列表与左侧目标列表', async () => {
    sessionUser.current = { id: 'user-1', roleType: 'admin', isAdmin: true }
    render(<ReviewTrackingClient />)

    await screen.findByTestId('target-1')
    expect(fetchTargets).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(screen.getByRole('tab', { name: '外部竞品' }))
    fireEvent.click(screen.getByRole('tab', { name: '外部竞品' }))

    const asinInput = await screen.findByLabelText('ASIN')
    fireEvent.change(asinInput, { target: { value: 'B0DDDDDDD4' } })

    const submit = screen.getByRole('button', { name: /登记/ })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    // 左侧目标列表重新拉取（否则「仅启用」下刚登记的竞品选不到）
    await waitFor(() => expect(fetchTargets).toHaveBeenCalledTimes(2))
    expect(createExternalTarget).toHaveBeenCalledWith(
      expect.objectContaining({ marketplace: 'US', asin: 'B0DDDDDDD4' })
    )
    await waitFor(() => expect(fetchExternalTargets).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: '外部竞品已登记' })))
  })
})
