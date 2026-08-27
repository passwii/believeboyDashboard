import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalHeader } from './terminal-header'
import { GLOBAL_FILTER_PILOT_PREFIXES } from './global-filter-context'
import {
  HeaderSlotMount,
  TerminalHeaderSlotProvider,
  useHeaderRefresh,
} from './terminal-header-slot'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { TrendingUp } from 'lucide-react'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))

const unreadMock = vi.fn()
vi.mock('@/components/notifications/server-notifications-context', () => ({
  useServerNotifications: () => ({ unreadCount: unreadMock() }),
}))

// BLF-874：KPI 磁贴已下线，TerminalHeader 不再调用 useHeaderKpis，但保留空 mock 避免遗留依赖误触发

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

/** 带 HeaderSlotMount 的 header 包装（BLF-826 真实接线形态） */
function TerminalHeaderWithMount({ pathname }: { pathname: string }) {
  return (
    <>
      <HeaderSlotMount className="flex items-center" />
      <TerminalHeader
        groups={GROUPS}
        activeGroupId="operations"
        pathname={pathname}
        subnavCollapsed={false}
        onExpandSubnav={vi.fn()}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />
    </>
  )
}

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
  // BLF-826 起 TerminalHeader 依赖 TerminalHeaderSlotProvider（刷新按钮/插槽），
  // 测试统一在 Provider 内渲染，与 TerminalShell 真实接线一致。
  return render(
    <TerminalHeaderSlotProvider>
      <TerminalHeader
        groups={GROUPS}
        activeGroupId="operations"
        pathname={pathname}
        subnavCollapsed={false}
        onExpandSubnav={vi.fn()}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />
    </TerminalHeaderSlotProvider>
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

describe('TerminalHeader 全局筛选四件套（BLF-819，BLF-874 已移除 KPI 磁贴）', () => {
  it('试点路由（销售数据）：渲染筛选四件套且不含 KPI 磁贴', () => {
    renderHeader('/dashboard/operations/daily-analysis')
    expect(screen.getByTitle('全局项目筛选')).toBeInTheDocument()
    expect(screen.getByTitle('全局站点筛选')).toBeInTheDocument()
    expect(screen.queryByText('GMV')).not.toBeInTheDocument()
    expect(screen.queryByText('ORD')).not.toBeInTheDocument()
    expect(screen.queryByText('PND')).not.toBeInTheDocument()
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
    // BLF-874：KPI 磁贴已下线，非试点页亦不再出现
    expect(screen.queryByText('ORD')).not.toBeInTheDocument()
    // 基础控件仍在
    expect(screen.getByTestId('terminal-header-user')).toBeInTheDocument()
  })

  it('全局筛选未水合（ready=false）时不渲染，避免闪默认值', () => {
    filterState = { ...filterState, ready: false }
    renderHeader('/dashboard/operations/daily-analysis')
    expect(screen.queryByTitle('全局项目筛选')).not.toBeInTheDocument()
  })
})

describe('TerminalHeader 全局刷新按钮（BLF-826）', () => {
  it('无页面注册刷新回调时：不显示刷新按钮（静态页零变化）', () => {
    renderHeader('/dashboard/profile', { withSlotProvider: true })
    expect(screen.queryByTestId('terminal-header-refresh')).not.toBeInTheDocument()
    // 基础控件仍在
    expect(screen.getByTestId('terminal-header-user')).toBeInTheDocument()
  })

  it('页面注册后：显示刷新按钮；点击触发页面回调', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()

    function SlotPage() {
      useHeaderRefresh(handler)
      return null
    }

    render(
      <TerminalHeaderSlotProvider>
        <TerminalHeaderWithMount pathname="/dashboard/profile" />
        <SlotPage />
      </TerminalHeaderSlotProvider>
    )

    await waitFor(() => expect(screen.getByTestId('terminal-header-refresh')).toBeInTheDocument())
    await user.click(screen.getByTestId('terminal-header-refresh'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('loading 时：按钮禁用并转 spinner，不可重复点击', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()

    function SlotPage() {
      useHeaderRefresh(handler, { loading: true })
      return null
    }

    render(
      <TerminalHeaderSlotProvider>
        <TerminalHeaderWithMount pathname="/dashboard/profile" />
        <SlotPage />
      </TerminalHeaderSlotProvider>
    )

    const btn = await screen.findByTestId('terminal-header-refresh')
    await waitFor(() => expect(btn).toBeDisabled())
    await user.click(btn)
    expect(handler).not.toHaveBeenCalled()
  })
})
