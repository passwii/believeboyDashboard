import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

import { AdAnalysisOverviewClient } from '@/components/dashboard/ad-analysis/overview-client'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

// ── mocks ────────────────────────────────────────────────────────────────────

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard/advertising/ad-analysis/overview',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

let mockSession: unknown = {
  user: { id: 'user-1', roleType: 'admin', operatorNameZh: '张三' },
}
let mockStatus = 'authenticated'
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockStatus }),
}))

const OVERVIEW_PAYLOAD = {
  project_id: 1,
  country: 'US',
  metrics: [{ label: 'ACOS', value: 0.2, display_value: '20%', helper: null }],
  issue_cards: [],
  narrative_sections: [],
  comparison: null,
  top_campaigns: [],
  top_products: [],
  top_waste_terms: [],
  trend_summary: [],
  top_cross_sell_products: [],
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AdAnalysisOverviewClient mount 请求行为（BEL-421）', () => {
  beforeEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
    mockSearchParams = new URLSearchParams('projectId=1&country=US')
    mockStatus = 'authenticated'
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    clearAdClientCaches()
    window.sessionStorage.clear()
  })

  it('mount 只发 1 个 overview 数据请求（projects 请求属于共享筛选区，不在本页）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(OVERVIEW_PAYLOAD))

    render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/ad-analysis/overview?')
  })

  it('2min 内重复 mount（tab 切回 / 下钻返回）不再发请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(OVERVIEW_PAYLOAD))

    const first = render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeTruthy())
    first.unmount()

    render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('筛选变化（新参数）会重新取数一次', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(OVERVIEW_PAYLOAD))

    const first = render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeTruthy())
    first.unmount()

    mockSearchParams = new URLSearchParams('projectId=1&country=DE')
    render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(fetchMock.mock.calls[1][0]).toContain('country=DE')
  })

  it('session 未就绪时不取数（避免 unknown 用户域写入缓存）', async () => {
    mockStatus = 'loading'
    mockSession = null
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(OVERVIEW_PAYLOAD))

    render(<AdAnalysisOverviewClient />)
    // 等一个微任务窗口，确认没有发出请求
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('下方非首屏区块经 DeferredSection 懒挂载（无 IntersectionObserver 时降级直出）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(OVERVIEW_PAYLOAD))
    render(<AdAnalysisOverviewClient />)
    // jsdom 无 IntersectionObserver → useInViewOnce 降级为可见，区块仍会渲染
    await waitFor(() => expect(screen.getByTestId('overview-deferred-analysis')).toBeTruthy())
    expect(screen.getByTestId('overview-deferred-products')).toBeTruthy()
    expect(screen.getByTestId('overview-deferred-trend')).toBeTruthy()
  })
})
