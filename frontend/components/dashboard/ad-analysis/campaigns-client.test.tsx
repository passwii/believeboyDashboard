import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { AdAnalysisCampaignsClient } from '@/components/dashboard/ad-analysis/campaigns-client'
import { requestAdClientRefresh } from '@/components/dashboard/ad-refresh'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard/advertising/ad-analysis/campaigns',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

let mockSession: unknown = {
  user: { id: 'user-1', roleType: 'admin', name: '测试用户' },
}
let mockStatus = 'authenticated'
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockStatus }),
}))

const CAMPAIGNS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  summary_cards: [{ label: 'Spend', value: '旧结果 $25.00', helper: null }],
  narrative_sections: [],
  items: [
    {
      campaign_name: '保留的活动',
      status: 'ENABLED',
      targeting_type: 'MANUAL',
      bidding_strategy: 'DYNAMIC',
      budget: 100,
      impressions: 1000,
      clicks: 50,
      ctr: 0.05,
      cpc: 0.5,
      spend: 25,
      sales_7d: 100,
      orders_7d: 5,
      acos: 0.25,
      roas: 4,
      grade: 'A',
      budget_gap: 0,
      budget_utilization_rate: 0.5,
      missed_sales_max: 0,
      cross_sell_orders_7d: 0,
      cross_sell_sales_7d: 0,
      cross_sell_action: '保持',
      next_action: '继续观察',
    },
  ],
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AdAnalysisCampaignsClient Header refresh', () => {
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

  it('查询条件变化立即隐藏旧活动，失败时不把旧结果留在新范围', async () => {
    let requestCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/ad-analysis/campaigns?')) {
        requestCount += 1
        if (requestCount === 1) return jsonResponse(CAMPAIGNS_PAYLOAD)
        throw new Error('新查询加载失败')
      }
      return jsonResponse({})
    })

    const view = render(<AdAnalysisCampaignsClient />)
    await waitFor(() => expect(screen.getByText('旧结果 $25.00')).toBeInTheDocument())
    const page = document.querySelector('[data-warm-ad-analysis-page="campaigns"]')
    expect(page).not.toBeNull()
    await waitFor(() => {
      expect(page?.querySelector('[data-warm-table-scroll="true"]')).not.toBeNull()
    })
    for (const element of page?.querySelectorAll('*') ?? []) {
      const className = element.getAttribute('class') ?? ''
      expect(className).not.toContain('term-')
      expect(className).not.toContain('rounded-none')
      expect(className).not.toMatch(/(?:^|\s)font-mono(?=\s|$)/)
    }

    mockSearchParams = new URLSearchParams('projectId=1&country=DE')
    view.rerender(<AdAnalysisCampaignsClient />)

    expect(screen.queryByText('旧结果 $25.00')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/新查询加载失败/)).toBeInTheDocument())
    expect(screen.queryByText('旧结果 $25.00')).not.toBeInTheDocument()
  })

  it('强刷期间保留已加载结果，失败时显示错误而不替换页面', async () => {
    let rejectRefresh: ((reason?: unknown) => void) | undefined
    let requestCount = 0
    const refreshResponse = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      requestCount += 1
      if (String(input).includes('/api/v1/ad-analysis/campaigns?')) {
        return requestCount === 1 ? jsonResponse(CAMPAIGNS_PAYLOAD) : refreshResponse
      }
      return jsonResponse({})
    })

    render(<AdAnalysisCampaignsClient />)
    await waitFor(() => expect(screen.getByText('旧结果 $25.00')).toBeInTheDocument())

    requestAdClientRefresh()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在刷新'))
    expect(screen.getByText('旧结果 $25.00')).toBeInTheDocument()

    rejectRefresh?.(new Error('刷新连接失败'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('刷新连接失败'))
    expect(screen.getByText('旧结果 $25.00')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
