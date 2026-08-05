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

vi.mock('@/components/dashboard-v2/v2-revenue-chart', () => ({
  V2RevenueChart: () => <div data-testid="v2-revenue-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-channel-chart', () => ({
  V2ChannelChart: () => <div data-testid="v2-channel-chart" />,
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
]

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ summary_rows: mockRows }),
      })
    )
  )
})

describe('DashboardV2Page', () => {
  it('渲染页面级项目选择器与返回旧版入口', async () => {
    render(<DashboardV2Page />)
    expect(screen.getByText('全部项目')).toBeInTheDocument()
    expect(screen.getByText('返回旧版')).toBeInTheDocument()
  })

  it('渲染 3 个 mock 区块', async () => {
    render(<DashboardV2Page />)
    expect(screen.getByText('Recent invoices')).toBeInTheDocument()
    expect(screen.getByText('Billing health')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('fetch 后渲染真实数据区块（KPI + 两个图表）', async () => {
    render(<DashboardV2Page />)
    expect(await screen.findByText('销售额')).toBeInTheDocument()
    expect(screen.getByTestId('v2-revenue-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-channel-chart')).toBeInTheDocument()
  })

  it('用选中的项目 id 请求 daily-analysis', async () => {
    render(<DashboardV2Page />)
    await screen.findByText('销售额')
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(String(calls[0][0])).toContain('project_ids=1%2C2')
    expect(String(calls[0][0])).toContain('/api/backend/api/v1/daily-analysis/all')
  })
})
