import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WarmLedgerShell } from './warm-ledger-shell'
import { WarmLedgerTopbar } from './warm-ledger-topbar'
import { WarmLedgerRouteFrame } from './warm-ledger-route-frame'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'

const shellMocks = vi.hoisted(() => ({
  pathname: '/dashboard',
  replace: vi.fn(),
  refresh: vi.fn(),
  refreshNotifications: vi.fn(),
  refetchProjects: vi.fn(),
  loadingProjects: false,
  projects: [
    { id: 11, name: '项目一' },
    { id: 12, name: '项目二' },
  ],
}))

vi.mock('next/navigation', () => ({
  usePathname: () => shellMocks.pathname,
  useRouter: () => ({ replace: shellMocks.replace, refresh: shellMocks.refresh }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/lib/hooks/use-managed-projects', () => ({
  useManagedProjects: () => ({
    projects: shellMocks.projects,
    loading: shellMocks.loadingProjects,
    error: null,
    refetch: shellMocks.refetchProjects,
  }),
}))

vi.mock('@/components/notifications', () => ({
  useServerNotifications: () => ({
    unreadCount: 0,
    refresh: shellMocks.refreshNotifications,
  }),
}))

vi.mock('./warm-notification-panel', () => ({
  WarmNotificationPanel: () => null,
}))

vi.mock('@/components/dashboard/search-command', () => ({
  OPEN_SEARCH_EVENT: 'open-search',
  SearchCommand: () => null,
}))

vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

type MediaListener = (event: MediaQueryListEvent) => void

function installMatchMedia(initialMobile: boolean) {
  let matches = initialMobile
  const listeners = new Set<MediaListener>()
  const mediaQuery = {
    media: '(max-width: 820px)',
    get matches() {
      return matches
    },
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: MediaListener) => listeners.delete(listener),
    addListener: (listener: MediaListener) => listeners.add(listener),
    removeListener: (listener: MediaListener) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList

  vi.stubGlobal('matchMedia', () => mediaQuery)
  Object.defineProperty(window, 'matchMedia', {
    value: () => mediaQuery,
    configurable: true,
    writable: true,
  })

  return (nextMobile: boolean) => {
    matches = nextMobile
    act(() => {
      listeners.forEach((listener) =>
        listener({ matches, media: mediaQuery.media } as MediaQueryListEvent)
      )
    })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  shellMocks.pathname = '/dashboard'
  shellMocks.loadingProjects = false
  shellMocks.projects = [
    { id: 11, name: '项目一' },
    { id: 12, name: '项目二' },
  ]
  window.localStorage.clear()
})

describe('WarmLedgerShell', () => {
  it('keeps the dashboard navigation and main content landmarks', () => {
    installMatchMedia(false)

    render(
      <WarmLedgerShell>
        <p>Dashboard content</p>
      </WarmLedgerShell>
    )

    expect(screen.getByRole('navigation', { name: '业务域和快捷入口' })).toHaveAttribute(
      'id',
      'main-navigation'
    )
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    expect(screen.getByText('Dashboard content')).toBeInTheDocument()
  })

  it('renders configured routes, the separate data-flow entry, and real quick links', () => {
    installMatchMedia(false)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const overview = within(navigation).getByRole('link', { name: '运营总览' })
    const dataFlow = within(navigation).getByRole('link', { name: '数据流总览' })
    expect(overview).toHaveAttribute('href', '/dashboard')
    expect(overview).toHaveAttribute('aria-current', 'page')
    expect(dataFlow).toHaveAttribute('href', '/dashboard/agent-center/overview')
    for (const link of within(navigation).getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^\/dashboard(?:\/|$)/)
    }

    const quickLinks = [
      ['销售数据', '/dashboard/operations/daily-analysis'],
      ['订单信息', '/dashboard/reports/order-info'],
      ['库存分析', '/dashboard/operations/inventory-analysis'],
      ['客户消息', '/dashboard/operations/complaint-center'],
    ]
    for (const [label, href] of quickLinks) {
      const link = within(navigation).getByRole('link', { name: label })
      expect(link).toHaveAttribute('href', href)
    }
  })

  it('links each C3 route once, marks its active link, and retains four quick links', () => {
    installMatchMedia(false)

    const c3Routes = [
      '/dashboard/reports/order-info',
      '/dashboard/reports/product-analysis',
      '/dashboard/reports/monthly-report/display',
    ]

    for (const route of c3Routes) {
      shellMocks.pathname = route
      const { container, unmount } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
      const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
      const matchingLinks = within(navigation)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href') === route)

      expect(matchingLinks).toHaveLength(1)
      expect(matchingLinks[0]).toHaveAttribute('aria-current', 'page')
      expect(container.querySelectorAll('.warm-ledger__quick-list a')).toHaveLength(4)
      unmount()
    }
  })

  it('provides accessible names for icon-only sidebar links', () => {
    installMatchMedia(false)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const links = within(navigation).getAllByRole('link')
    expect(links.length).toBeGreaterThan(4)
    for (const link of links) {
      expect(link).toHaveAttribute('aria-label')
    }
  })

  it('traps focus in the mobile drawer and restores focus after Escape', () => {
    installMatchMedia(true)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const openButton = screen.getByRole('button', { name: '打开导航' })
    fireEvent.click(openButton)

    const sidebar = screen.getByRole('complementary', { name: '主导航' })
    const closeButton = within(sidebar).getByRole('button', { name: '关闭导航' })
    expect(closeButton).toHaveFocus()
    expect(sidebar).not.toHaveAttribute('inert')
    expect(document.getElementById('main-content')?.parentElement).toHaveAttribute('inert')

    const links = within(sidebar).getAllByRole('link')
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(links[links.length - 1]).toHaveFocus()
    links[links.length - 1]?.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(closeButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(openButton).toHaveFocus()
    expect(sidebar).toHaveAttribute('inert')
    expect(document.getElementById('main-content')?.parentElement).not.toHaveAttribute('inert')
  })

  it('moves focus to the workspace when the open drawer crosses to desktop', () => {
    const setMobile = installMatchMedia(true)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }))
    const workspace = screen.getByRole('region', { name: 'Dashboard 工作区' })

    setMobile(false)

    expect(workspace).toHaveFocus()
    expect(document.getElementById('main-content')?.parentElement).not.toHaveAttribute('inert')
  })

  it('moves sidebar focus to the menu button when crossing from desktop to mobile', () => {
    const setMobile = installMatchMedia(false)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    screen.getByRole('link', { name: '运营总览' }).focus()
    setMobile(true)

    expect(screen.getByRole('button', { name: '打开导航' })).toHaveFocus()
    expect(document.getElementById('dashboard-sidebar')).toHaveAttribute('inert')
  })
})

describe('WarmLedgerRouteFrame', () => {
  it('uses non-clickable reports breadcrumbs and keeps the operations breadcrumb linked', () => {
    installMatchMedia(false)
    const reportRoutes = [
      ['/dashboard/reports/order-info', '订单信息'],
      ['/dashboard/reports/product-analysis', '产品分析'],
      ['/dashboard/reports/monthly-report/display', '财务月报'],
    ] as const

    for (const [pathname, title] of reportRoutes) {
      shellMocks.pathname = pathname
      const { unmount } = render(
        <WarmLedgerRouteFrame pathname={pathname}>
          <p>{title} content</p>
        </WarmLedgerRouteFrame>
      )

      const reportBreadcrumbs = screen.getByRole('navigation', { name: '面包屑' })
      const reportsLabel = within(reportBreadcrumbs).getByText('报表中心')
      expect(reportsLabel.closest('a')).toBeNull()
      expect(within(reportBreadcrumbs).getByText(title)).toHaveAttribute('aria-current', 'page')
      if (pathname !== '/dashboard/reports/order-info') {
        expect(screen.queryByRole('group', { name: '全局筛选' })).not.toBeInTheDocument()
      }
      unmount()
    }

    shellMocks.pathname = '/dashboard/operations/daily-analysis'

    render(
      <WarmLedgerRouteFrame pathname="/dashboard/operations/daily-analysis">
        <p>Daily Analysis content</p>
      </WarmLedgerRouteFrame>
    )

    const operationsBreadcrumbs = screen.getByRole('navigation', { name: '面包屑' })
    expect(within(operationsBreadcrumbs).getByRole('link', { name: '运营' })).toHaveAttribute(
      'href',
      '/dashboard'
    )
  })

  it('synchronizes Order Info project, supported site, and date controls through global filters', async () => {
    installMatchMedia(false)
    shellMocks.pathname = '/dashboard/reports/order-info'
    const user = userEvent.setup()

    const { container } = render(
      <WarmLedgerRouteFrame pathname="/dashboard/reports/order-info">
        <GlobalFilterProbe />
      </WarmLedgerRouteFrame>
    )

    const filters = await screen.findByRole('group', { name: '全局筛选' })
    const probe = screen.getByTestId('global-filter-probe')
    await waitFor(() => {
      expect(probe).toHaveTextContent(
        /^11\|ALL\|\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/
      )
    })
    const projectSelect = within(filters).getByRole('combobox', { name: '项目筛选' })
    const countrySelect = within(filters).getByRole('combobox', { name: '站点筛选' })
    const dateSelect = container.querySelector<HTMLButtonElement>(
      '.warm-ledger__route-date-range'
    )

    expect(projectSelect).toBeInTheDocument()
    expect(countrySelect).toBeInTheDocument()
    expect(dateSelect).toBeInTheDocument()
    expect(projectSelect).toHaveTextContent('项目一')
    expect(countrySelect).toHaveTextContent('全部站点')

    await user.click(projectSelect)
    await user.click(await screen.findByRole('option', { name: '项目二' }))
    await waitFor(() => expect(probe).toHaveTextContent(/^12\|ALL\|/))

    for (const [code, label] of [
      ['ALL', '全部站点'],
      ['US', /\(US\)$/],
      ['DE', /\(DE\)$/],
      ['UK', /\(UK\)$/],
    ] as const) {
      await user.click(countrySelect)
      await user.click(await screen.findByRole('option', { name: label }))
      await waitFor(() => expect(probe).toHaveTextContent(new RegExp(`^12\\|${code}\\|`)))
    }

    await user.click(dateSelect!)
    await user.click(await screen.findByRole('button', { name: '近7天' }))
    await waitFor(() => {
      expect(probe).toHaveTextContent(/^12\|UK\|\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('retains site/date changes made while projects load and seeds only the missing project', async () => {
    installMatchMedia(false)
    shellMocks.pathname = '/dashboard/reports/order-info'
    shellMocks.loadingProjects = true
    shellMocks.projects = []
    const user = userEvent.setup()

    const { container, rerender } = render(
      <WarmLedgerRouteFrame pathname="/dashboard/reports/order-info">
        <GlobalFilterProbe />
      </WarmLedgerRouteFrame>
    )

    const filters = await screen.findByRole('group', { name: '全局筛选' })
    const probe = screen.getByTestId('global-filter-probe')
    const projectSelect = within(filters).getByRole('combobox', { name: '项目筛选' })
    const countrySelect = within(filters).getByRole('combobox', { name: '站点筛选' })
    const dateSelect = container.querySelector<HTMLButtonElement>(
      '.warm-ledger__route-date-range'
    )

    expect(projectSelect).toBeDisabled()
    expect(countrySelect).toBeEnabled()
    expect(dateSelect).toBeEnabled()

    await user.click(countrySelect)
    await user.click(await screen.findByRole('option', { name: /\(DE\)$/ }))
    await user.click(dateSelect!)
    await user.click(await screen.findByRole('button', { name: '昨天' }))

    const [projectBeforeLoad, countryBeforeLoad, dateFromBeforeLoad, dateToBeforeLoad] =
      probe.textContent?.split('|') ?? []
    expect(projectBeforeLoad).toBe('')
    expect(countryBeforeLoad).toBe('DE')
    expect(dateFromBeforeLoad).toBeTruthy()
    expect(dateFromBeforeLoad).toBe(dateToBeforeLoad)

    shellMocks.projects = [{ id: 11, name: '项目一' }]
    shellMocks.loadingProjects = false
    rerender(
      <WarmLedgerRouteFrame pathname="/dashboard/reports/order-info">
        <GlobalFilterProbe />
      </WarmLedgerRouteFrame>
    )

    await waitFor(() => {
      expect(probe).toHaveTextContent(
        `11|DE|${dateFromBeforeLoad}|${dateToBeforeLoad}`
      )
    })
  })
})

function GlobalFilterProbe() {
  const { projectId, country, dateFrom, dateTo } = useTerminalGlobalFilter()
  return (
    <output data-testid="global-filter-probe">
      {`${projectId}|${country}|${dateFrom}|${dateTo}`}
    </output>
  )
}

describe('WarmLedgerTopbar', () => {
  it('renders the selected project and reports option selection changes', async () => {
    installMatchMedia(false)
    const user = userEvent.setup()
    const onProjectChange = vi.fn()
    const projectOptions = [
      { value: 'all', label: '全部项目' },
      { value: 'project-2', label: '项目二' },
    ]

    function ControlledShell() {
      const [projectId, setProjectId] = useState('project-2')

      return (
        <WarmLedgerShell
          topbar={
            <WarmLedgerTopbar
              projectId={projectId}
              projectOptions={projectOptions}
              onProjectChange={(value) => {
                onProjectChange(value)
                setProjectId(value)
              }}
              siteLabel="US"
            />
          }
        >
          Dashboard
        </WarmLedgerShell>
      )
    }

    render(<ControlledShell />)

    const select = screen.getByRole('combobox', { name: '项目筛选' })
    expect(select).toHaveTextContent('项目二')
    expect(screen.getByText('近 7 天')).toBeInTheDocument()
    expect(screen.getByText('US')).toBeInTheDocument()

    await user.click(select)
    await user.click(await screen.findByRole('option', { name: '全部项目' }))

    expect(onProjectChange).toHaveBeenCalledWith('all')
    expect(select).toHaveTextContent('全部项目')
  })

  it('only renders action buttons when their callbacks exist', () => {
    installMatchMedia(false)

    render(
      <WarmLedgerShell
        topbar={
          <WarmLedgerTopbar
            projectId="all"
            projectOptions={[{ value: 'all', label: '全部项目' }]}
            onProjectChange={vi.fn()}
          />
        }
      >
        Dashboard
      </WarmLedgerShell>
    )

    expect(screen.queryByRole('button', { name: '刷新当前页数据' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全局搜索' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '通知' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '用户菜单' })).not.toBeInTheDocument()
  })

  it('connects each visible topbar action to its callback', () => {
    installMatchMedia(false)
    const onRefresh = vi.fn()
    const onSearch = vi.fn()
    const onNotifications = vi.fn()
    const onUserAction = vi.fn()

    render(
      <WarmLedgerShell
        topbar={
          <WarmLedgerTopbar
            projectId="all"
            projectOptions={[{ value: 'all', label: '全部项目' }]}
            onProjectChange={vi.fn()}
            onRefresh={onRefresh}
            onSearch={onSearch}
            onNotifications={onNotifications}
            unreadCount={3}
            onUserAction={onUserAction}
          />
        }
      >
        Dashboard
      </WarmLedgerShell>
    )

    fireEvent.click(screen.getByRole('button', { name: '刷新当前页数据' }))
    fireEvent.click(screen.getByRole('button', { name: '全局搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '通知，3 条未读' }))
    fireEvent.click(screen.getByRole('button', { name: '用户菜单' }))

    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onSearch).toHaveBeenCalledOnce()
    expect(onNotifications).toHaveBeenCalledOnce()
    expect(onUserAction).toHaveBeenCalledOnce()
  })
})
