import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import { formatYMD } from '@/lib/dashboard-format'

const mocks = vi.hoisted(() => ({
  useDashboardHomeData: vi.fn(),
  useLiveStream: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  refreshNotifications: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/dashboard',
}))

vi.mock('@/components/terminal/use-live-stream', () => ({
  useLiveStream: (enabled: boolean) => mocks.useLiveStream(enabled),
}))

vi.mock('@/components/notifications', () => ({
  useServerNotifications: () => ({
    unreadCount: 3,
    items: [],
    loading: false,
    refresh: mocks.refreshNotifications,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  }),
}))

vi.mock('./use-dashboard-home-data', () => ({
  useDashboardHomeData: (params: unknown) => mocks.useDashboardHomeData(params),
}))

import DashboardHomePage from './page'

const projects = [
  { id: 1, name: '项目A' },
  { id: 2, name: '项目B' },
]

const baseRow = {
  date: '',
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
}

const projectBreakdown = {
  1: {
    project_name: '项目A',
    summary_rows: [{ ...baseRow, sales_amount: 1200, ad_spend: 100 }],
  },
  2: {
    project_name: '项目B',
    summary_rows: [{ ...baseRow, sales_amount: 800, ad_spend: 200 }],
  },
}

const pendingItem = {
  id: 101,
  project_id: 2,
  project_name: '项目B',
  amazon_order_id: '111-1111111-0000001',
  sku: 'SKU-TEST',
  asin: 'B0TEST0001',
  product_name: '测试商品',
  quantity: 2,
  item_price: 12,
  shipping_price: 2,
  currency: 'USD',
  country: 'US',
  purchase_at_utc: '2026-08-30T02:30:00Z',
  purchase_at_pt: '2026-08-29 19:30:00',
  order_status: 'Pending',
}

const pendingOrders = {
  items: [pendingItem],
  total: 17,
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  loadMore: vi.fn(),
  refresh: mocks.refresh,
}

function createHomeData(dateRange: { from: Date; to: Date }) {
  const previousDate = new Date(dateRange.to)
  previousDate.setDate(previousDate.getDate() - 7)
  return {
    projects,
    projectsLoading: false,
    projectsError: null,
    currentRows: [{ ...baseRow, date: formatYMD(dateRange.to) }],
    comparisonRows: [{ ...baseRow, date: formatYMD(previousDate), sales_amount: 1000 }],
    projectBreakdown,
    compareProjectBreakdown: {
      1: {
        project_name: '项目A',
        summary_rows: [{ ...baseRow, date: formatYMD(previousDate), sales_amount: 1000 }],
      },
      2: {
        project_name: '项目B',
        summary_rows: [{ ...baseRow, date: formatYMD(previousDate), sales_amount: 900 }],
      },
    },
    countryRowsByCode: {
      US: { summary_rows: [{ ...baseRow, sales_amount: 1000 }] },
      CA: { summary_rows: [{ ...baseRow, sales_amount: 250 }] },
    },
    countriesLoading: false,
    dataLoading: false,
    dataError: null,
    pendingOrders,
    refresh: mocks.refresh,
  }
}

function stubMatchMedia() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }))
  )
}

describe('DashboardHomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubMatchMedia()
    mocks.useDashboardHomeData.mockImplementation(
      ({ dateRange }: { dateRange: { from: Date; to: Date } }) => createHomeData(dateRange)
    )
    mocks.useLiveStream.mockReturnValue([
      { id: '1:111-1111111-0000001', title: '项目A · $12.00', timeLabel: '19:30' },
    ])
  })

  it('renders the three Warm Ledger metrics and reuses Pending total in OrderFlow', () => {
    render(<DashboardHomePage />)

    const metrics = screen.getByRole('region', { name: '本周关键指标' })
    expect(within(metrics).getByText('销售额')).toBeInTheDocument()
    expect(within(metrics).getByText('订单量')).toBeInTheDocument()
    expect(within(metrics).getByText('待处理订单')).toBeInTheDocument()
    expect(within(metrics).getByLabelText('$1,200.00')).toBeInTheDocument()
    expect(within(metrics).getByLabelText('12')).toBeInTheDocument()
    expect(within(metrics).getByLabelText('17')).toBeInTheDocument()
    expect(within(metrics).getByText('近 7 天 PT')).toBeInTheDocument()
    expect(screen.queryByText('PND')).not.toBeInTheDocument()
    expect(screen.queryByText(/与订单流同源/)).not.toBeInTheDocument()
    expect(screen.queryByText('数据区间')).not.toBeInTheDocument()
    expect(screen.queryByText('当前区间 · 7 天')).not.toBeInTheDocument()

    const orderFlow = screen.getByRole('region', { name: '订单流' })
    expect(within(orderFlow).getByText('17')).toBeInTheDocument()
    expect(within(orderFlow).getByText('项目A · $12.00')).toBeInTheDocument()
    expect(mocks.useLiveStream).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('待处理（日快照）')).toBeInTheDocument()
    expect(screen.queryByTestId('v2-revenue-chart')).not.toBeInTheDocument()
    expect(screen.queryByText('近 14 天明细')).not.toBeInTheDocument()
  })

  it('aligns comparison sales on the same seven current-date chart rows', () => {
    render(<DashboardHomePage />)

    const chart = screen.getByRole('img', { name: '销售趋势图' })
    expect(chart.querySelectorAll('[data-point="current"]')).toHaveLength(1)
    expect(chart.querySelectorAll('[data-point="previous"]')).toHaveLength(1)
  })

  it('keeps project sort controlled and updates the rank order', () => {
    render(<DashboardHomePage />)
    const table = screen.getByRole('table', { name: '项目排行' })
    const initialRows = within(table).getAllByRole('row')
    expect(within(initialRows[1]).getByText('项目A')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '广告花费' }))

    const sortedRows = within(table).getAllByRole('row')
    expect(within(sortedRows[1]).getByText('项目B')).toBeInTheDocument()
    expect(mocks.useDashboardHomeData).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'all' })
    )
  })

  it('updates the project scope and refreshes all dashboard sources from the topbar', async () => {
    const user = userEvent.setup()
    render(<DashboardHomePage />)
    await user.click(screen.getByRole('combobox', { name: '项目筛选' }))
    await user.click(screen.getByRole('option', { name: '项目B' }))

    expect(mocks.useDashboardHomeData).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: '2' })
    )
    await user.click(screen.getByRole('button', { name: '刷新当前页数据' }))
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('wires search, notification, and profile actions in the Warm topbar', () => {
    const onSearch = vi.fn()
    window.addEventListener(OPEN_SEARCH_EVENT, onSearch)
    render(<DashboardHomePage />)

    fireEvent.click(screen.getByRole('button', { name: '全局搜索' }))

    expect(onSearch).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '通知，3 条未读' }))
    expect(mocks.refreshNotifications).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '个人资料' }))
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/profile')
    window.removeEventListener(OPEN_SEARCH_EVENT, onSearch)
  })

  it('opens project drill-down and live event order links with supported filters', () => {
    render(<DashboardHomePage />)
    const hookParams = mocks.useDashboardHomeData.mock.calls[0][0] as {
      dateRange: { from: Date; to: Date }
    }

    fireEvent.click(screen.getByRole('button', { name: '打开项目 项目A' }))
    expect(mocks.push).toHaveBeenCalledWith(
      '/dashboard/operations/daily-analysis?project=1&country=US'
    )

    fireEvent.click(screen.getByRole('button', { name: '打开订单 项目A · $12.00' }))
    const from = formatYMD(hookParams.dateRange.from)
    const to = formatYMD(hookParams.dateRange.to)
    expect(mocks.push).toHaveBeenCalledWith(
      `/dashboard/reports/order-info?order_id_keyword=111-1111111-0000001&date_from=${from}&date_to=${to}&project_id=1`
    )
  })

  it('falls back to the order number in live event titles when the event id is opaque', () => {
    mocks.useLiveStream.mockReturnValueOnce([
      { id: 'live-1', title: '订单 #114-0000000-0000001 · $88.00', timeLabel: '刚刚' },
    ])
    render(<DashboardHomePage />)

    fireEvent.click(
      screen.getByRole('button', { name: '打开订单 订单 #114-0000000-0000001 · $88.00' })
    )

    expect(mocks.push).toHaveBeenCalledWith(
      expect.stringContaining('order_id_keyword=114-0000000-0000001')
    )
  })

  it('opens the order info page with Pending, project, and PT date filters', () => {
    render(<DashboardHomePage />)
    const hookParams = mocks.useDashboardHomeData.mock.calls[0][0] as {
      dateRange: { from: Date; to: Date }
    }
    const orderButton = screen.getByRole('button', { name: /111-1111111-0000001/ })
    fireEvent.click(orderButton)

    const from = formatYMD(hookParams.dateRange.from)
    const to = formatYMD(hookParams.dateRange.to)
    expect(mocks.push).toHaveBeenCalledWith(
      `/dashboard/reports/order-info?order_statuses=Pending&project_id=2&date_from=${from}&date_to=${to}`
    )
  })

  it('shows component loading, empty, and error states from the data contract', () => {
    const initial = createHomeData({ from: new Date(2026, 7, 25), to: new Date(2026, 7, 31) })

    mocks.useDashboardHomeData.mockReturnValueOnce({
      ...initial,
      dataLoading: true,
      pendingOrders: { ...pendingOrders, loading: true },
    })
    const first = render(<DashboardHomePage />)
    expect(screen.getByText('正在读取关键指标')).toBeInTheDocument()
    expect(screen.getByText('正在加载销售趋势')).toBeInTheDocument()
    first.unmount()

    mocks.useDashboardHomeData.mockReturnValueOnce({
      ...initial,
      currentRows: [],
      comparisonRows: [],
      projectBreakdown: {},
      pendingOrders: { ...pendingOrders, items: [], total: 0 },
    })
    const second = render(<DashboardHomePage />)
    expect(screen.getByText('暂无销售数据')).toBeInTheDocument()
    expect(screen.getByText('暂无日明细')).toBeInTheDocument()
    second.unmount()

    mocks.useDashboardHomeData.mockReturnValueOnce({
      ...initial,
      dataError: 'report unavailable',
    })
    render(<DashboardHomePage />)
    expect(
      screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('report unavailable'))
    ).toBe(true)
  })
})
