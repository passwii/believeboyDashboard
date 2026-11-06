import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'
import type { DashboardStats, LifecycleBoard } from '@/lib/crm/types'

const { client } = vi.hoisted(() => ({
  client: {
    getDashboardStats: vi.fn(),
    getLifecycleBoard: vi.fn(),
  },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', roleType: 'admin' } }),
}))
vi.mock('@/components/notifications', () => ({ useNotifications: () => stableNotifications() }))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => client }))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))
vi.mock('@/components/ui/funnel-chart', () => ({
  FunnelChart: ({ className }: { className?: string }) => (
    <div data-testid="lead-funnel-chart" className={className} />
  ),
}))
vi.mock('@/components/crm/lifecycle-board', () => ({
  LifecycleBoardSection: () => <div data-testid="lifecycle-board" />,
}))
vi.mock('@/components/crm/funnel-stage-drawer', () => ({ FunnelStageDrawer: () => null }))

import CrmDashboardPage from './page'

const STATS: DashboardStats = {
  leadFunnel: { new: 12, contacting: 8, qualified: 5, converted: 2, discarded: 1 },
  newThisMonth: { newCustomers: 3, newLeads: 4, convertedCount: 2 },
  followActivity: { followCount7d: 9 },
  perOwner: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CRM Dashboard SkeletonReveal 接入', () => {
  it('统计尚在请求时隐藏真实内容，完成后在 Warm 页面内揭示内容', async () => {
    const stats = deferred<DashboardStats>()
    const lifecycle = deferred<LifecycleBoard>()
    client.getDashboardStats.mockReturnValue(stats.promise)
    client.getLifecycleBoard.mockReturnValue(lifecycle.promise)

    render(<CrmDashboardPage />)

    const kpis = screen.getByTestId('crm-dashboard-kpis')
    const funnel = screen.getByTestId('crm-dashboard-funnel')
    expect(kpis).toHaveAttribute('data-state', 'loading')
    expect(funnel).toHaveAttribute('data-state', 'loading')
    expect(kpis).toHaveAttribute('aria-busy', 'true')
    expect(kpis.querySelector('.ui-skel-content')).toHaveAttribute('aria-hidden', 'true')
    expect(kpis.querySelector('.ui-skel-content')).toHaveAttribute('inert')
    expect(funnel.querySelector('.ui-skel-content')).toHaveAttribute('aria-hidden', 'true')
    expect(funnel.querySelector('.ui-skel-content')).toHaveAttribute('inert')
    expect(screen.queryByTestId('lead-funnel-chart')).not.toBeInTheDocument()
    expect(screen.queryByText(/整体转化率/)).not.toBeInTheDocument()

    await act(async () => {
      stats.resolve(STATS)
      lifecycle.resolve({} as LifecycleBoard)
      await Promise.all([stats.promise, lifecycle.promise])
    })

    expect(await screen.findByText('本月新增客户')).toBeVisible()
    expect(screen.getByTestId('crm-dashboard-kpis')).toHaveAttribute('data-state', 'revealed')
    expect(screen.getByTestId('crm-dashboard-funnel')).toHaveAttribute('data-state', 'revealed')
    expect(kpis.querySelector('.ui-skel-content')).not.toHaveAttribute('aria-hidden')
    expect(kpis.querySelector('.ui-skel-content')).not.toHaveAttribute('inert')
    expect(screen.getByRole('region', { name: /线索漏斗/ })).toBeVisible()
    expect(within(screen.getByTestId('crm-dashboard-funnel')).getByTestId('lead-funnel-chart')).toBeInTheDocument()
  })

  it('页面主体使用 Warm CRM 框架与可键盘滚动表格，不混用 Terminal class', async () => {
    client.getDashboardStats.mockResolvedValue({
      ...STATS,
      perOwner: [
        {
          ownerId: 'owner-1',
          ownerName: '张三',
          customerCount: 8,
          convertedThisMonth: 2,
        },
      ],
    })
    client.getLifecycleBoard.mockResolvedValue({} as LifecycleBoard)

    const { container } = render(<CrmDashboardPage />)

    expect(await screen.findByText('张三')).toBeVisible()
    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '每销售业绩' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '每销售业绩表格' })).toHaveAttribute('tabindex', '0')
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
  })

  it('成功返回空数据时揭示漏斗空态', async () => {
    client.getDashboardStats.mockResolvedValue({
      ...STATS,
      leadFunnel: {},
      perOwner: [],
    })
    client.getLifecycleBoard.mockResolvedValue({} as LifecycleBoard)

    render(<CrmDashboardPage />)

    expect(await screen.findByText('暂无漏斗数据')).toBeVisible()
    expect(screen.getByTestId('crm-dashboard-kpis')).toHaveAttribute('data-state', 'revealed')
    expect(screen.getByTestId('crm-dashboard-funnel')).toHaveAttribute('data-state', 'revealed')
    expect(screen.getByTestId('crm-dashboard-funnel')).not.toHaveAttribute('aria-busy')
    expect(screen.getByText('暂无业绩数据')).toBeVisible()
    expect(screen.getByText('本月新增客户')).toBeVisible()
  })

  it('请求失败时显示错误并隐藏尚无真实数据的区域', async () => {
    client.getDashboardStats.mockRejectedValue(new Error('看板暂不可用'))
    client.getLifecycleBoard.mockRejectedValue(new Error('看板暂不可用'))

    render(<CrmDashboardPage />)

    expect(await screen.findByText('看板暂不可用')).toBeVisible()
    expect(screen.queryByTestId('crm-dashboard-kpis')).not.toBeInTheDocument()
    expect(screen.queryByTestId('crm-dashboard-funnel')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无漏斗数据')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无业绩数据')).not.toBeInTheDocument()
    expect(screen.queryByText('本月新增客户')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  })
})
