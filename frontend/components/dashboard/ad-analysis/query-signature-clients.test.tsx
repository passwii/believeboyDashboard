import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { AdAnalysisBudgetClient } from '@/components/dashboard/ad-analysis/budget-client'
import { AdAnalysisPlacementsClient } from '@/components/dashboard/ad-analysis/placements-client'
import { AdAnalysisProductsClient } from '@/components/dashboard/ad-analysis/products-client'
import { AdAnalysisPurchasedProductsClient } from '@/components/dashboard/ad-analysis/purchased-products-client'
import { AdAnalysisSearchTermsClient } from '@/components/dashboard/ad-analysis/search-terms-client'
import { AdAnalysisTargetsClient } from '@/components/dashboard/ad-analysis/targets-client'
import { AdAnalysisTimeTrendClient } from '@/components/dashboard/ad-analysis/time-trend-client'
import { AdAnalysisTrafficQualityClient } from '@/components/dashboard/ad-analysis/traffic-quality-client'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

const mockSession = {
  user: { id: 'user-1', roleType: 'admin', operatorNameZh: '测试用户' },
}
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: 'authenticated' }),
}))

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const common = {
  project_id: 1,
  country: 'US',
  summary_cards: [{ label: '测试指标', value: '10', helper: null }],
  narrative_sections: [],
}

const cases: Array<{
  name: string
  endpoint: string
  marker: string
  Client: ComponentType
  payload: unknown
}> = [
  {
    name: 'budget',
    endpoint: 'budget',
    marker: '旧预算活动',
    Client: AdAnalysisBudgetClient,
    payload: {
      ...common,
      items: [{
        campaign_name: '旧预算活动', status: 'ENABLED', budget: 100, suggested_budget: 120,
        budget_gap: 20, budget_utilization_rate: 0.8, missed_impressions_min: 0,
        missed_impressions_max: 0, missed_clicks_min: 0, missed_clicks_max: 0,
        missed_sales_min: 0, missed_sales_max: 0, spend: 50, sales_7d: 100,
        orders_7d: 5, acos: 0.5, action: '调整', next_step: '观察',
      }],
    },
  },
  {
    name: 'placements',
    endpoint: 'placements',
    marker: '旧广告位',
    Client: AdAnalysisPlacementsClient,
    payload: {
      ...common,
      items: [{
        campaign_name: '活动 A', placement: '旧广告位', impressions: 100, clicks: 10,
        ctr: 0.1, cpc: 1, spend: 10, sales_7d: 20, orders_7d: 2, units_7d: 2,
        cvr_7d: 0.2, acos: 0.5, roas: 2, action: '调整', next_step: '观察',
      }],
    },
  },
  {
    name: 'products',
    endpoint: 'products',
    marker: '旧推广 SKU',
    Client: AdAnalysisProductsClient,
    payload: {
      ...common,
      items: [{
        ad_sku: '旧推广 SKU', ad_asin: 'ASIN-1', campaign_count: 1, primary_campaign: '活动 A',
        impressions: 100, clicks: 10, ctr: 0.1, cpc: 1, spend: 10, sales_7d: 20,
        orders_7d: 2, units_7d: 2, cvr_7d: 0.2, acos: 0.5, grade: 'A',
        cross_sell_asin_count: 1, cross_sell_orders_7d: 1, cross_sell_sales_7d: 5,
        top_purchased_asin: 'ASIN-2', cross_sell_action: '观察', next_action: '继续观察',
      }],
    },
  },
  {
    name: 'purchased-products',
    endpoint: 'purchased-products',
    marker: '旧关联 ASIN',
    Client: AdAnalysisPurchasedProductsClient,
    payload: {
      project_id: 1,
      country: 'US',
      items: [{
        purchased_asin: '旧关联 ASIN', ad_sku: 'SKU-1', campaign_count: 1,
        other_sku_units_7d: 1, other_sku_orders_7d: 1, other_sku_sales_7d: 5, action: '观察',
      }],
    },
  },
  {
    name: 'search-terms',
    endpoint: 'search-terms',
    marker: '旧搜索词',
    Client: AdAnalysisSearchTermsClient,
    payload: {
      ...common,
      items: [{
        search_term: '旧搜索词', match_type: 'EXACT', campaign_count: 1, primary_campaign: '活动 A',
        impressions: 100, clicks: 10, ctr: 0.1, cpc: 1, spend: 10, sales_7d: 20,
        orders_7d: 2, cvr_7d: 0.2, acos: 0.5, impression_share: 0.1,
        impression_rank: 1, action: '观察',
      }],
    },
  },
  {
    name: 'targets',
    endpoint: 'targets',
    marker: '旧投放词',
    Client: AdAnalysisTargetsClient,
    payload: {
      ...common,
      items: [{
        target_text: '旧投放词', match_type: 'EXACT', campaign_count: 1, primary_campaign: '活动 A',
        impressions: 100, clicks: 10, ctr: 0.1, cpc: 1, spend: 10, sales_7d: 20,
        orders_7d: 2, cvr_7d: 0.2, acos: 0.5, top_of_search_impression_share: 0.1,
        action: '观察',
      }],
    },
  },
  {
    name: 'time-trend',
    endpoint: 'time-trend',
    marker: '2026-10-01',
    Client: AdAnalysisTimeTrendClient,
    payload: {
      project_id: 1,
      country: 'US',
      summary: [{ report_date: '2026-10-01', clicks: 10, spend: 20, cpc: 2, running_spend: 20 }],
      comparison: null,
    },
  },
  {
    name: 'traffic-quality',
    endpoint: 'traffic-quality',
    marker: '旧流量活动',
    Client: AdAnalysisTrafficQualityClient,
    payload: {
      ...common,
      items: [{
        campaign_name: '旧流量活动', status: 'ENABLED', total_impressions: 100,
        valid_impressions: 90, invalid_impressions: 10, invalid_impression_rate: 0.1,
        total_clicks: 10, valid_clicks: 9, invalid_clicks: 1, invalid_click_rate: 0.1,
        risk_level: '低风险', next_step: '观察',
      }],
    },
  },
]

describe('广告分析 client 查询签名', () => {
  beforeEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
    mockSearchParams = new URLSearchParams('projectId=1&country=US')
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    clearAdClientCaches()
    window.sessionStorage.clear()
  })

  it.each(cases)('$name 查询变化后失败不残留旧范围数据', async ({ Client, endpoint, marker, payload }) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith(`/api/v1/ad-analysis/${endpoint}`)) {
        if (url.searchParams.get('country') === 'DE') throw new Error('新查询加载失败')
        return jsonResponse(payload)
      }
      return jsonResponse({})
    })

    const view = render(<Client />)
    await waitFor(() => expect(screen.getAllByText(marker).length).toBeGreaterThan(0))

    mockSearchParams = new URLSearchParams('projectId=1&country=DE')
    view.rerender(<Client />)

    expect(screen.queryAllByText(marker)).toHaveLength(0)
    await waitFor(() => expect(screen.getByText(/新查询加载失败/)).toBeInTheDocument())
    expect(screen.queryAllByText(marker)).toHaveLength(0)
  })
})
