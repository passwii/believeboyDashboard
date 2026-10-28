import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalHeader } from './terminal-header'
import { GLOBAL_FILTER_PILOT_PREFIXES } from './global-filter-context'
import { TERMINAL_HEADER_HEIGHT } from './terminal-constants'
import {
  HeaderSlotMount,
  TerminalHeaderSlotProvider,
  useHeaderRefresh,
  useHeaderSlot,
  usePrimaryFilterSlot,
  useSecondaryHeaderSlot,
} from './terminal-header-slot'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { TrendingUp } from 'lucide-react'

import { stableSession } from '@/test-utils/stable-mocks'

// 会话可切换（BLF-1441 显示名用例）：默认仍是不带 fullName 的旧会话，
// 既有用例的行为与之前完全一致。
let sessionUser: Record<string, unknown> = { name: '测试用户' }
vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: sessionUser }),
}))

const unreadMock = vi.fn()
vi.mock('@/components/notifications/server-notifications-context', () => ({
  useServerNotifications: () => ({ unreadCount: unreadMock() }),
}))

// BLF-881：未注册页兜底刷新走 router.refresh()
const routerRefreshMock = vi.fn()

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
  useRouter: () => ({ refresh: routerRefreshMock }),
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

function HeaderWithPageFilters({ pathname }: { pathname: string }) {
  const actionPortal = useHeaderSlot(<span data-testid="page-action-control">页面操作</span>)
  const primaryPortal = usePrimaryFilterSlot(
    <span data-testid="page-primary-control">项目与日期</span>
  )
  const secondaryPortal = useSecondaryHeaderSlot(
    <span data-testid="page-secondary-control">SKU 筛选</span>
  )

  return (
    <>
      <TerminalHeader
        groups={GROUPS}
        activeGroupId="operations"
        pathname={pathname}
        subnavCollapsed={false}
        onExpandSubnav={vi.fn()}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />
      {actionPortal}
      {primaryPortal}
      {secondaryPortal}
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

function renderHeader(
  pathname: string,
  options: { subnavCollapsed?: boolean; inspectorOpen?: boolean } = {}
) {
  currentPathname = pathname
  // BLF-826 起 TerminalHeader 依赖 TerminalHeaderSlotProvider（刷新按钮/插槽），
  // 测试统一在 Provider 内渲染，与 TerminalShell 真实接线一致。
  return render(
    <TerminalHeaderSlotProvider>
      <TerminalHeader
        groups={GROUPS}
        activeGroupId="operations"
        pathname={pathname}
        subnavCollapsed={options.subnavCollapsed ?? false}
        onExpandSubnav={vi.fn()}
        inspectorOpen={options.inspectorOpen ?? false}
        onToggleInspector={vi.fn()}
      />
    </TerminalHeaderSlotProvider>
  )
}

afterEach(() => {
  cleanup()
  unreadMock.mockReset()
  routerRefreshMock.mockReset()
  filterState = {
    ready: true,
    projectId: '1',
    country: 'US',
    dateFrom: '2026-08-01',
    dateTo: '2026-08-07',
  }
})

describe('TerminalHeader 全局筛选四件套（BLF-819，BLF-874 已移除 KPI 磁贴）', () => {
  it('首层高度引用终端 Header 高度常量', () => {
    const { container } = renderHeader('/dashboard/profile')
    const primaryRow = screen.getByTestId('terminal-header-primary-row') as HTMLElement
    expect(primaryRow.style.height).toBe(`${TERMINAL_HEADER_HEIGHT}px`)
    expect(container.querySelector('header')).not.toHaveStyle({ height: `${TERMINAL_HEADER_HEIGHT}px` })
  })

  it('子导航和 Inspector 控件的可访问名称与按压状态随布局状态同步', () => {
    const { rerender } = render(
      <TerminalHeaderSlotProvider>
        <TerminalHeader
          groups={GROUPS}
          activeGroupId="operations"
          pathname="/dashboard/profile"
          subnavCollapsed={false}
          onExpandSubnav={vi.fn()}
          inspectorOpen={false}
          onToggleInspector={vi.fn()}
        />
      </TerminalHeaderSlotProvider>
    )

    expect(screen.getByRole('button', { name: '侧栏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换 Inspector' })).toHaveAttribute('aria-pressed', 'false')

    rerender(
      <TerminalHeaderSlotProvider>
        <TerminalHeader
          groups={GROUPS}
          activeGroupId="operations"
          pathname="/dashboard/profile"
          subnavCollapsed
          onExpandSubnav={vi.fn()}
          inspectorOpen
          onToggleInspector={vi.fn()}
        />
      </TerminalHeaderSlotProvider>
    )

    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换 Inspector' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('移动导航入口和页面刷新入口可访问且状态可识别', () => {
    renderHeader('/dashboard/profile')
    expect(screen.getByRole('button', { name: '打开导航菜单' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新当前页数据' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '切换 Inspector' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('试点路由（销售数据）：项目与日期默认显示，站点在展开后显示', async () => {
    const user = userEvent.setup()
    renderHeader('/dashboard/operations/daily-analysis')
    const primaryFilterRow = screen.getByTestId('terminal-header-primary-filter-row')
    const primaryFilterSlot = screen.getByTestId('terminal-primary-filter-slot')
    const navigationRow = screen.getByTestId('terminal-header-primary-row')
    const primaryFilters = screen.getByTestId('terminal-header-primary-global-filters')
    expect(primaryFilterRow).toContainElement(primaryFilters)
    expect(primaryFilterSlot).toHaveClass('overflow-x-auto')
    expect(navigationRow).not.toContainElement(primaryFilters)
    expect(primaryFilters).toContainElement(screen.getByTitle('全局项目筛选'))
    expect(primaryFilters.querySelectorAll('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '展开次级筛选' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('terminal-header-secondary-row')).not.toBeInTheDocument()
    expect(screen.queryByTitle('全局站点筛选')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '展开次级筛选' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(screen.getByRole('button', { name: '收起次级筛选' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTitle('全局站点筛选')).toBeInTheDocument()
    expect(screen.queryByText('GMV')).not.toBeInTheDocument()
    expect(screen.queryByText('ORD')).not.toBeInTheDocument()
    expect(screen.queryByText('PND')).not.toBeInTheDocument()
  })

  it('试点路由（订单信息）：站点筛选默认收起', async () => {
    const user = userEvent.setup()
    renderHeader('/dashboard/reports/order-info')
    expect(screen.getByTitle('全局项目筛选')).toBeInTheDocument()
    expect(screen.queryByTitle('全局站点筛选')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '展开次级筛选' }))
    expect(screen.getByTitle('全局站点筛选')).toBeInTheDocument()
  })

  it('常驻筛选与页面操作分行，次级筛选展开后仍在自己的行，路由切换后自动收起', async () => {
    const user = userEvent.setup()
    const pathname = '/dashboard/operations/daily-analysis'
    const { rerender } = render(
      <TerminalHeaderSlotProvider>
        <HeaderWithPageFilters pathname={pathname} />
      </TerminalHeaderSlotProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('terminal-header-primary-filter-row')).toContainElement(
        screen.getByTestId('page-primary-control')
      )
      expect(screen.getByTestId('terminal-header-slot')).toContainElement(
        screen.getByTestId('page-action-control')
      )
    })
    const toggle = await screen.findByRole('button', { name: '展开次级筛选' })
    expect(screen.queryByTestId('page-secondary-control')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(await screen.findByTestId('page-secondary-control')).toBeInTheDocument()
    expect(screen.getByTestId('page-primary-control')).toBeInTheDocument()
    expect(screen.getByTestId('page-action-control')).toBeInTheDocument()

    rerender(
      <TerminalHeaderSlotProvider>
        <HeaderWithPageFilters pathname="/dashboard/profile" />
      </TerminalHeaderSlotProvider>
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '展开次级筛选' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    )
    expect(screen.queryByTestId('page-secondary-control')).not.toBeInTheDocument()
  })

  it('非试点页面：不渲染四件套（头部行为零变化）', () => {
    renderHeader('/dashboard/advertising/ad-analysis/overview')
    expect(screen.queryByTitle('全局项目筛选')).not.toBeInTheDocument()
    expect(screen.queryByTitle('全局站点筛选')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '展开次级筛选' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-header-primary-filter-row')).not.toBeInTheDocument()
    // BLF-874：KPI 磁贴已下线，非试点页亦不再出现
    expect(screen.queryByText('ORD')).not.toBeInTheDocument()
    // 基础控件仍在
    expect(screen.getByTestId('terminal-header-user')).toBeInTheDocument()
  })

  it('全局筛选未水合（ready=false）时不渲染，避免闪默认值', () => {
    filterState = { ...filterState, ready: false }
    renderHeader('/dashboard/operations/daily-analysis')
    expect(screen.queryByTitle('全局项目筛选')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '展开次级筛选' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('terminal-header-primary-filter-row')).not.toBeInTheDocument()
  })
})

describe('TerminalHeader 全局刷新按钮（BLF-826；BLF-881 全页面常驻）', () => {
  it('无页面注册刷新回调时：刷新按钮常驻，点击兜底 router.refresh 且完成后自动恢复', async () => {
    const user = userEvent.setup()
    renderHeader('/dashboard/profile')
    const btn = screen.getByTestId('terminal-header-refresh')
    expect(btn).toBeInTheDocument()
    expect(btn).toBeEnabled()
    expect(btn).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('terminal-header-refresh-status')).toHaveTextContent('')
    // 基础控件仍在
    expect(screen.getByTestId('terminal-header-user')).toBeInTheDocument()

    await user.click(btn)
    expect(routerRefreshMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('terminal-header-refresh-status')).toHaveTextContent(
      '刷新请求已返回；请确认页面内容已更新。'
    )
    // 兜底完成后不卡在 loading（mock refresh 同步返回，transition 即刻结束）
    await waitFor(() => expect(screen.getByTestId('terminal-header-refresh')).toBeEnabled())
  })

  it('页面注册后：优先执行页面回调，不走 router.refresh 兜底', async () => {
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
    expect(routerRefreshMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('terminal-header-refresh-status')).toHaveTextContent(
      '刷新请求已发起。'
    )
  })

  it('loading 时：按钮禁用并转 spinner，不可重复点击', async () => {
    const user = userEvent.setup()
    let finishRefresh: (() => void) | undefined
    const handler = vi.fn(
      () => new Promise<void>((resolve) => {
        finishRefresh = resolve
      })
    )

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

    const btn = await screen.findByTestId('terminal-header-refresh')
    await user.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    expect(btn).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('terminal-header-refresh-status')).toHaveTextContent('正在刷新当前页。')
    expect(handler).toHaveBeenCalledTimes(1)

    await act(async () => finishRefresh?.())
    await waitFor(() => expect(btn).toBeEnabled())
    expect(screen.getByTestId('terminal-header-refresh-status')).toHaveTextContent(
      '刷新请求已返回；请确认页面内容已更新。'
    )
  })
})

describe('TerminalHeader 用户名（BLF-1441：只取 user_accounts.full_name）', () => {
  afterEach(() => {
    sessionUser = { name: '测试用户' }
  })

  it('显示会话里的姓名，不是登录名', () => {
    sessionUser = { name: 'Yawei', fullName: '纪亚伟' }
    renderHeader('/dashboard/profile')

    expect(screen.getByTestId('terminal-header-user')).toHaveAccessibleName('用户菜单：纪亚伟')
    expect(screen.getByText('纪亚伟')).toBeInTheDocument()
    expect(screen.queryByText('Yawei')).not.toBeInTheDocument()
  })

  it('没有姓名时显示「未命名」，不回落登录名', () => {
    sessionUser = { name: 'DamonROCK', fullName: null }
    renderHeader('/dashboard/profile')

    expect(screen.getByTestId('terminal-header-user')).toHaveAccessibleName('用户菜单：未命名')
    expect(screen.queryByText('DamonROCK')).not.toBeInTheDocument()
  })

  it('过渡期旧会话（没有 fullName 键）回落登录名，不闪成「未命名」', () => {
    sessionUser = { name: 'Yawei' }
    renderHeader('/dashboard/profile')

    expect(screen.getByTestId('terminal-header-user')).toHaveAccessibleName('用户菜单：Yawei')
  })
})
