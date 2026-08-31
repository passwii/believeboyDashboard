import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))

// 生产 useManagedProjects 有 2min client cache，返回稳定引用；mock 用模块级常量避免每次 render 新数组
// 导致 effect/loadData 无限重跑、loading 状态振荡（fetch 永不落定的假象）
const PROJECTS = [
  { id: 1, name: '项目A' },
  { id: 2, name: '项目B' },
]

vi.mock('@/lib/hooks/use-managed-projects', () => ({
  useManagedProjects: () => ({
    projects: PROJECTS,
    loading: false,
    error: null,
  }),
}))

// 生产 useNotifications 的 notify 来自 context（稳定引用）；mock 用模块级常量避免每次 render 新对象
// 导致 loadData/effect 无限重跑、loading 状态振荡
const notify = vi.fn()

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))

// 图表走 next/dynamic + ssr:false，单测里打平为占位（recharts 组件不做单测，项目惯例）
vi.mock('@/components/dashboard-v2/v2-revenue-chart', () => ({
  V2RevenueChart: () => <div data-testid="v2-revenue-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-channel-chart', () => ({
  V2ChannelChart: () => <div data-testid="v2-channel-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-project-chart', () => ({
  V2ProjectChart: () => <div data-testid="v2-project-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-country-chart', () => ({
  V2CountryChart: () => <div data-testid="v2-country-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-stock-chart', () => ({
  V2StockChart: () => <div data-testid="v2-stock-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-traffic-chart', () => ({
  V2TrafficChart: () => <div data-testid="v2-traffic-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-order-flow-panel', () => ({
  V2OrderFlowPanel: () => <div data-testid="v2-order-flow-panel" />,
}))

// 头部刷新/插槽在测试环境下无 Provider；mock 成 no-op 与项目惯例一致
// （参考 finance/platform-revenue / operations/inventory-* 等页面测试）。
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: React.ReactNode) => node,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import DashboardV2Page from './page'

const mockRows = [
  {
    date: '2026-07-31',
    order_qty: 10,
    sales_amount: 1000,
    impressions: 100,
    clicks: 50,
    cpc: 0.5,
    ad_spend: 200,
    ad_orders: 5,
    available_qty: 300,
    page_views: 800,
    units_ordered: 40,
    sessions: 600,
    ordered_sales_amount: 900,
    conversion_rate: 0.05,
  },
  {
    date: '2026-08-01',
    order_qty: 20,
    sales_amount: 2000,
    impressions: 200,
    clicks: 60,
    cpc: 0.6,
    ad_spend: 300,
    ad_orders: 8,
    available_qty: 260,
    page_views: 1000,
    units_ordered: 60,
    sessions: 700,
    ordered_sales_amount: 1800,
    conversion_rate: 0.06,
  },
]

const projectBreakdown = {
  1: { project_name: '项目A', summary_rows: mockRows },
  2: { project_name: '项目B', summary_rows: mockRows },
}

const countryBreakdown = {
  US: { summary_rows: mockRows },
  DE: { summary_rows: mockRows },
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (
        url.includes('/daily-analysis/all-countries') ||
        url.includes('/daily-analysis/all-projects-countries')
      ) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ country_breakdown: countryBreakdown }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ summary_rows: mockRows, project_breakdown: projectBreakdown }),
      })
    })
  )
})

describe('DashboardV2Page', () => {
  it('渲染页面级项目选择器', async () => {
    render(<DashboardV2Page />)
    expect(screen.getByText('全部项目')).toBeInTheDocument()
  })

  it('页内不再渲染独立刷新按钮（BLF-909 收敛到 Top Head 刷新）', async () => {
    render(<DashboardV2Page />)
    // aria-label 唯一，queryBy 找不到即断言无该控件
    expect(screen.queryByLabelText('刷新数据')).not.toBeInTheDocument()
    // 数据区间徽标改为 head 渲染（mock 下内联进页面）
    expect(screen.getByText('数据区间')).toBeInTheDocument()
  })

  it('渲染右侧订单流面板（BLF-926）', async () => {
    render(<DashboardV2Page />)
    expect(await screen.findByTestId('v2-order-flow-panel')).toBeInTheDocument()
  })

  it('渲染真实业务区块（项目排行 标题 + 四个图表占位）', async () => {
    render(<DashboardV2Page />)
    // 非 mock 的真实组件直接渲染标题
    expect(await screen.findByText('项目排行')).toBeInTheDocument()
    // 图表走 dynamic mock，断言 testid（标题由 mock 占位替代）
    expect(screen.getByTestId('v2-project-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-country-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-stock-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-traffic-chart')).toBeInTheDocument()
  })

  it('fetch 后渲染真实数据区块（KPI + 四个图表）', async () => {
    render(<DashboardV2Page />)
    expect(await screen.findByText('销售额')).toBeInTheDocument()
    expect(screen.getByTestId('v2-revenue-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-channel-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-project-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-country-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-stock-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-traffic-chart')).toBeInTheDocument()
  })

  it('用选中的项目 id 请求 daily-analysis', async () => {
    render(<DashboardV2Page />)
    await screen.findByText('项目排行')
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const analysisCall = calls.map((c) => String(c[0])).find((u) => u.includes('/daily-analysis/all?'))
    expect(analysisCall).toBeDefined()
    expect(analysisCall).toContain('project_ids=1%2C2')
    expect(analysisCall).toContain('/api/backend/api/v1/daily-analysis/all')
  })

  // BLF-913：「全部项目」时跨国家图走新聚合端点 /all-projects-countries，project_ids 全选；
  // 单项目时走既有 /all-countries，project_id=具体 id。
  it('跨国家图：全部项目时请求 all-projects-countries（project_ids 全选，不再回退第一个）', async () => {
    render(<DashboardV2Page />)
    await screen.findByText('项目排行')
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const countryCall = calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('all-projects-countries'))
    expect(countryCall).toBeDefined()
    expect(countryCall).toContain('project_ids=1%2C2')
    expect(countryCall).toContain('/api/backend/api/v1/daily-analysis/all-projects-countries')
    // 旧「全部项目时回退第一个项目去 /all-countries」的契约已废止。
    const legacyCall = calls
      .map((c) => String(c[0]))
      .find(
        (u) =>
          u.includes('all-countries') && !u.includes('all-projects-countries')
      )
    expect(legacyCall).toBeUndefined()
  })
})
