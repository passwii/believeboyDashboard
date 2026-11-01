import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const projects = [
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]
  const pendingRefresh = vi.fn()
  const pendingOrders = {
    items: [],
    total: 9,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    loadMore: vi.fn(),
    refresh: pendingRefresh,
  }

  return {
    projects,
    pendingRefresh,
    pendingOrders,
    refetchProjects: vi.fn(),
    useManagedProjects: vi.fn(),
    usePendingOrders: vi.fn(),
  }
})

vi.mock('@/lib/hooks/use-managed-projects', () => ({
  useManagedProjects: () => mocks.useManagedProjects(),
}))

vi.mock('@/components/dashboard-v2/use-pending-orders', () => ({
  usePendingOrders: (params: unknown) => mocks.usePendingOrders(params),
}))

import { useDashboardHomeData } from './use-dashboard-home-data'

const dateRange = {
  from: new Date(2026, 7, 25),
  to: new Date(2026, 7, 31),
}

const currentRows = [
  {
    date: '2026-08-31',
    order_qty: 12,
    pending_order_qty: 3,
    sales_amount: 1200,
    impressions: 200,
    clicks: 20,
    cpc: 0.5,
    ad_spend: 100,
    ad_orders: 4,
    available_qty: 40,
    page_views: 300,
    units_ordered: 12,
    sessions: 180,
    ordered_sales_amount: 1100,
    conversion_rate: 0.04,
  },
]

const comparisonRows = [
  {
    ...currentRows[0],
    date: '2026-08-24',
    order_qty: 10,
    sales_amount: 1000,
  },
]

const projectBreakdown = {
  1: { project_name: '项目A', summary_rows: currentRows },
}

const countryBreakdown = {
  US: { summary_rows: currentRows },
  CA: { summary_rows: [{ ...currentRows[0], sales_amount: 300 }] },
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function jsonForUrl(url: string) {
  if (url.includes('/all-projects-countries') || url.includes('/all-countries')) {
    return response({ country_breakdown: countryBreakdown })
  }

  const params = new URL(url, 'http://localhost').searchParams
  const isComparison = params.get('start_date') === '2026-08-18'
  return response({
    summary_rows: isComparison ? comparisonRows : currentRows,
    project_breakdown: isComparison ? {} : projectBreakdown,
  })
}

function installSuccessfulFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(jsonForUrl(String(input))))
  )
}

describe('useDashboardHomeData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useManagedProjects.mockReturnValue({
      projects: mocks.projects,
      loading: false,
      error: null,
      refetch: mocks.refetchProjects,
    })
    mocks.usePendingOrders.mockReturnValue(mocks.pendingOrders)
    installSuccessfulFetch()
  })

  it('loads current and comparison rows plus all-project country data for the selected PT week', async () => {
    const { result } = renderHook(() =>
      useDashboardHomeData({ projectId: 'all', dateRange })
    )

    await waitFor(() => expect(result.current.currentRows).toHaveLength(1))

    expect(result.current.currentRows[0].sales_amount).toBe(1200)
    expect(result.current.comparisonRows[0].sales_amount).toBe(1000)
    expect(result.current.projectBreakdown).toEqual(projectBreakdown)
    expect(result.current.countryRowsByCode).toEqual(countryBreakdown)
    expect(mocks.usePendingOrders).toHaveBeenLastCalledWith({
      enabled: true,
      projectIds: [1, 2],
      dateFrom: '2026-08-25',
      dateTo: '2026-08-31',
    })

    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) =>
      String(input)
    )
    expect(urls).toHaveLength(4)
    expect(urls.some((url) => url.includes('project_ids=1%2C2'))).toBe(true)
    expect(urls.some((url) => url.includes('all-projects-countries'))).toBe(true)
    expect(urls.every((url) => url.includes('start_date=2026-08-'))).toBe(true)
  })

  it('uses one selected project for daily, country, and pending requests', async () => {
    const { result } = renderHook(() =>
      useDashboardHomeData({ projectId: '2', dateRange })
    )

    await waitFor(() => expect(result.current.currentRows).toHaveLength(1))

    expect(mocks.usePendingOrders).toHaveBeenLastCalledWith({
      enabled: true,
      projectIds: [2],
      dateFrom: '2026-08-25',
      dateTo: '2026-08-31',
    })
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) =>
      String(input)
    )
    expect(urls.some((url) => url.includes('project_ids=2'))).toBe(true)
    expect(urls.some((url) => url.includes('all-countries?project_id=2'))).toBe(true)
    expect(urls.every((url) => !url.includes('all-projects-countries'))).toBe(true)
  })

  it('keeps the latest project response when an earlier request resolves afterward', async () => {
    const staleResolvers: Array<(value: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        const params = new URL(url, 'http://localhost').searchParams
        if (
          url.includes('/daily-analysis/all?') &&
          params.get('project_ids') === '1'
        ) {
          return new Promise<Response>((resolve) => staleResolvers.push(resolve))
        }
        const rows = params.get('project_ids') === '2'
          ? [{ ...currentRows[0], sales_amount: 2200 }]
          : currentRows
        if (url.includes('/all-projects-countries') || url.includes('/all-countries')) {
          return Promise.resolve(response({ country_breakdown: countryBreakdown }))
        }
        return Promise.resolve(response({ summary_rows: rows, project_breakdown: {} }))
      })
    )

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useDashboardHomeData({ projectId, dateRange }),
      { initialProps: { projectId: '1' } }
    )

    await waitFor(() => expect(staleResolvers).toHaveLength(2))
    rerender({ projectId: '2' })
    await waitFor(() => expect(result.current.currentRows[0]?.sales_amount).toBe(2200))

    await act(async () => {
      staleResolvers.forEach((resolve) =>
        resolve(response({ summary_rows: [{ ...currentRows[0], sales_amount: 1100 }] }))
      )
    })

    expect(result.current.currentRows[0].sales_amount).toBe(2200)
  })

  it('returns the main data error and refreshes daily, country, and pending data together', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/daily-analysis/all?') && url.includes('start_date=2026-08-25')) {
          return Promise.resolve(response({ detail: 'report unavailable' }, false))
        }
        return Promise.resolve(jsonForUrl(url))
      })
    )

    const { result } = renderHook(() =>
      useDashboardHomeData({ projectId: 'all', dateRange })
    )

    await waitFor(() => expect(result.current.dataError).toContain('report unavailable'))
    expect(result.current.currentRows).toEqual([])

    vi.clearAllMocks()
    await act(async () => {
      await result.current.refresh()
    })

    expect(mocks.pendingRefresh).toHaveBeenCalledOnce()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4)
  })
})
