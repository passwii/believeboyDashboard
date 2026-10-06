import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

// ── mocks ────────────────────────────────────────────────────────────────────

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', roleType: 'admin' } }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/portfolio-overview',
  useRouter: () => ({ replace: vi.fn(), push: pushMock }),
}))

const pushMock = vi.fn()

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: React.ReactNode) => null,
  useMobileFilterStrip: () => null,
}))

vi.mock('@/components/dashboard/portfolio/portfolio-filters', () => ({
  PortfolioFilters: () => <div data-testid="portfolio-filters" />,
}))

const PROJECTS = [
  {
    project_id: 1,
    project_name: '项目A',
    sales_amount: 10000,
    order_qty: 200,
    ad_spend: 3000,
    conversion_rate: 5.5,
    impressions: 9000,
    clicks: 800,
    cpc: 3.75,
    ad_orders: 60,
    page_views: 5000,
    sessions: 3600,
    available_qty: 1200,
    daily_trend: [],
    sales_contribution: 62.5,
    order_contribution: 66.7,
    ad_spend_contribution: 50,
  },
  {
    project_id: 2,
    project_name: '项目B',
    sales_amount: 6000,
    order_qty: 100,
    ad_spend: 3000,
    conversion_rate: 4.2,
    impressions: 7000,
    clicks: 600,
    cpc: 5.0,
    ad_orders: 30,
    page_views: 4000,
    sessions: 2400,
    available_qty: 800,
    daily_trend: [],
    sales_contribution: 37.5,
    order_contribution: 33.3,
    ad_spend_contribution: 50,
  },
]

vi.mock('@/lib/hooks/use-portfolio-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/use-portfolio-data')>()
  return {
    ...actual,
    usePortfolioData: () => ({
      data: actual.buildPortfolioSummary
        ? null
        : {
            projects: PROJECTS,
            total_sales_amount: 16000,
            total_order_qty: 300,
            total_ad_spend: 6000,
            avg_conversion_rate: 5.56,
            total_impressions: 16000,
            total_clicks: 1400,
            total_sessions: 6000,
          },
      loading: false,
      error: null,
      refresh: vi.fn(),
    }),
  }
})

import PortfolioOverviewClient from './portfolio-overview-client'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PortfolioOverviewClient 终端化渲染契约（BLF-834）', () => {
  it('渲染 KPI 统计磁贴与项目对比表', async () => {
    render(<PortfolioOverviewClient />)
    expect(screen.getByText('总销售额')).toBeInTheDocument()
    // 16000 >= 10000 → 万缩写格式
    expect(screen.getByText('$1.6万')).toBeInTheDocument()
    // 对比表行（默认按销售额降序：项目A在前）
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows[1].textContent).toContain('项目A')
    expect(rows[2].textContent).toContain('项目B')
  })

  it('点击列头切换排序方向', async () => {
    const user = userEvent.setup()
    render(<PortfolioOverviewClient />)
    await screen.findByRole('table')
    // 点击「销售额」表头两次 → asc，项目B（6,000）排前
    await user.click(screen.getByText('销售额'))
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows[1].textContent).toContain('项目B')
  })

  it('点击详情跳转 daily-analysis 并带项目参数', async () => {
    const user = userEvent.setup()
    render(<PortfolioOverviewClient />)
    await screen.findByRole('table')
    const detailButtons = screen.getAllByText('详情')
    await user.click(detailButtons[0])
    expect(pushMock).toHaveBeenCalledWith('/dashboard/operations/daily-analysis?project=1')
  })

  it('Tab 切换到趋势 / 贡献占位不崩溃', async () => {
    const user = userEvent.setup()
    render(<PortfolioOverviewClient />)
    await screen.findByRole('table')
    await user.click(screen.getByText('趋势对比'))
    await user.click(screen.getByText('贡献占比'))
    // 无崩溃即可（recharts 已被 dynamic 拆包，jsdom 下仅验证切换逻辑）
  })
})
