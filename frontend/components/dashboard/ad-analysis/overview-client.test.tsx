import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

import { AdAnalysisOverviewClient } from '@/components/dashboard/ad-analysis/overview-client'
import { requestAdClientRefresh } from '@/components/dashboard/ad-refresh'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

// ── mocks ────────────────────────────────────────────────────────────────────

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard/advertising/ad-analysis/overview',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

let mockSession: unknown = {
  user: { id: 'user-1', roleType: 'admin', name: '张三' },
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

  it('Header 广告刷新信号清缓存后重取活动分析数据', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(OVERVIEW_PAYLOAD))

    render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    requestAdClientRefresh()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toContain('/api/v1/ad-analysis/overview?')
    expect(screen.getByText('20%')).toBeTruthy()
  })

  it('Header 强刷期间保留旧结果，失败时显示错误而不替换画布', async () => {
    let rejectRefresh: ((reason?: unknown) => void) | undefined
    let requestCount = 0
    const refreshResponse = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requestCount += 1
      if (String(input).includes('/api/v1/ad-analysis/overview?')) {
        return requestCount === 1 ? jsonResponse(OVERVIEW_PAYLOAD) : refreshResponse
      }
      return jsonResponse({})
    })

    render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeInTheDocument())

    requestAdClientRefresh()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在刷新'))
    expect(screen.getByText('20%')).toBeInTheDocument()

    rejectRefresh?.(new Error('刷新连接失败'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('刷新连接失败'))
    expect(screen.getByText('20%')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('筛选变化立即隐藏旧总览，失败时不残留旧查询数据', async () => {
    let requestCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/v1/ad-analysis/overview?')) {
        requestCount += 1
        if (requestCount === 1) return jsonResponse(OVERVIEW_PAYLOAD)
        throw new Error('新筛选加载失败')
      }
      return jsonResponse({})
    })

    const view = render(<AdAnalysisOverviewClient />)
    await waitFor(() => expect(screen.getByText('20%')).toBeInTheDocument())

    mockSearchParams = new URLSearchParams('projectId=1&country=DE')
    view.rerender(<AdAnalysisOverviewClient />)

    expect(screen.queryByText('20%')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('新筛选加载失败'))
    expect(screen.queryByText('20%')).not.toBeInTheDocument()
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

  it('Pattern B 双轴画布：KPI 磁贴带 + 上部图表分割区 + 下部明细数据网格（BLF-818）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ...OVERVIEW_PAYLOAD,
        trend_summary: [{ report_date: '2026-08-20', spend: 12.5, clicks: 30, cpc: 0.42, sales_7d: 88 }],
        top_campaigns: [{ campaign_name: 'CAM-A', spend: 33.1, sales_7d: 120, orders_7d: 4, acos: 0.276 }],
      })
    )
    render(<AdAnalysisOverviewClient />)
    // 下部明细数据网格面板存在且 sticky 表头可滚动
    await waitFor(() => expect(screen.getByLabelText('广告明细数据')).toBeTruthy())
    expect(screen.getByText('明细数据 DETAILS')).toBeTruthy()
    // 明细行渲染：活动分组 + 日趋势分组
    await waitFor(() => expect(screen.getByText('CAM-A')).toBeTruthy())
    expect(screen.getAllByText('活动 CAMP').length).toBeGreaterThan(0)
    expect(screen.getAllByText('日趋势 DAILY').length).toBeGreaterThan(0)
  })
})
