import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalHeader } from './terminal-header'
import { GLOBAL_FILTER_PILOT_PREFIXES } from './global-filter-context'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { TrendingUp } from 'lucide-react'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))

const unreadMock = vi.fn()
vi.mock('@/components/notifications/server-notifications-context', () => ({
  useServerNotifications: () => ({ unreadCount: unreadMock() }),
}))

vi.mock('@/lib/hooks/use-header-kpis', () => ({
  useHeaderKpis: () => ({ kpis: { gmv: 1234, orders: 56, pending: 7 }, loading: false }),
}))

// 全局筛选状态 mock：可控制 ready 与当前路由
let filterState = {
  ready: true,
  projectId: '1',
  country: 'US',
  dateFrom: '2026-08-01',
  dateTo: '2026-08-07',
}
let currentPathname = '/dashboard/operations/daily-analysis'

vi.mock('./global-filter-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./global-filter-context')>()
  return {
    ...actual,
    useTerminalGlobalFilter: () => ({
      ...filterState,
      setProjectId: vi.fn(),
      setCountry: vi.fn(),
      setDateRange: vi.fn(),
    }),
    isGlobalFilterPilotRoute: (p: string) =>
      GLOBAL_FILTER_PILOT_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)),
  }
})

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
}))

vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={href} data-testid={`link-${href}`}>
      {children}
    </a>
  ),
}))

const GROUPS: SidebarTopGroup[] = [
  {
    id: 'operations',
    label: '运营',
    icon: TrendingUp,
    accent: '',
    activeAccent: '',
    items: [{ title: '销售数据', url: '/dashboard/operations/daily-analysis' }],
  },
]

function renderHeader(pathname: string) {
  currentPathname = pathname
  return render(
    <TerminalHeader
      groups={GROUPS}
      activeGroupId="operations"
      pathname={pathname}
      subnavCollapsed={false}
      onExpandSubnav={vi.fn()}
      inspectorOpen={false}
      onToggleInspector={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
  unreadMock.mockReset()
  filterState = {
    ready: true,
    projectId: '1',
    country: 'US',
    dateFrom: '2026-08-01',
    dateTo: '2026-08-07',
  }
})

describe('TerminalHeader 全局筛选四件套（BLF-819）', () => {
  it('试点路由（销售数据）：渲染四件套与 KPI 磁贴', () => {
    renderHeader('/dashboard/operations/daily-analysis')
    expect(screen.getByTitle('全局项目筛选')).toBeInTheDocument()
    expect(screen.getByTitle('全局站点筛选')).toBeInTheDocument()
    expect(screen.getByText('GMV')).toBeInTheDocument()
    expect(screen.getByText('$1,234')).toBeInTheDocument()
    expect(screen.getByText('ORD')).toBeInTheDocument()
    expect(screen.getByText('PND')).toBeInTheDocument()
  })

  it('试点路由（订单信息）：渲染四件套', () => {
    renderHeader('/dashboard/reports/order-info')
    expect(screen.getByTitle('全局项目筛选')).toBeInTheDocument()
    expect(screen.getByTitle('全局站点筛选')).toBeInTheDocument()
  })

  it('非试点页面：不渲染四件套（头部行为零变化）', () => {
    renderHeader('/dashboard/advertising/ad-analysis/overview')
    expect(screen.queryByTitle('全局项目筛选')).not.toBeInTheDocument()
    expect(screen.queryByTitle('全局站点筛选')).not.toBeInTheDocument()
    expect(screen.queryByText('GMV')).not.toBeInTheDocument()
    // 基础控件仍在
    expect(screen.getByTestId('terminal-header-user')).toBeInTheDocument()
  })

  it('全局筛选未水合（ready=false）时不渲染，避免闪默认值', () => {
    filterState = { ...filterState, ready: false }
    renderHeader('/dashboard/operations/daily-analysis')
    expect(screen.queryByTitle('全局项目筛选')).not.toBeInTheDocument()
  })
})
