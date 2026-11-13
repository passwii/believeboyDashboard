import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WarmLedgerShell } from './warm-ledger-shell'
import { WarmLedgerTopbar } from './warm-ledger-topbar'
import {
  getWarmLedgerPageTitle,
  getWarmLedgerRouteMeta,
  isWarmLedgerRoute,
  WarmLedgerRouteFrame,
} from './warm-ledger-route-frame'
import { WARM_SIDEBAR_STORAGE_KEY } from './warm-ledger-sidebar'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'
import { SIDEBAR_TOP_GROUPS, filterByRole } from '@/lib/sidebar-config'

const shellThemeCss = readFileSync(
  join(process.cwd(), 'components/dashboard-v2/warm-ledger/shell/theme.css'),
  'utf8'
)

const configuredItems = (groupId: string) => {
  const group = SIDEBAR_TOP_GROUPS.find((candidate) => candidate.id === groupId)
  return group ? filterByRole(group.items) : []
}

function getNavScroller(navigation: HTMLElement) {
  const scroller = navigation.querySelector<HTMLElement>('.warm-ledger__navigation-scroll')
  if (!scroller) throw new Error('navigation scroll region is missing')
  return scroller
}

function scrollerLinks(navigation: HTMLElement) {
  return Array.from(getNavScroller(navigation).querySelectorAll<HTMLAnchorElement>('a'))
}

function visibleScrollerLinks(navigation: HTMLElement) {
  return within(getNavScroller(navigation)).getAllByRole('link')
}

function groupToggle(navigation: HTMLElement, label: string) {
  return within(navigation).getByRole('button', { name: label })
}

async function expandAllGroups(navigation: HTMLElement) {
  for (const group of SIDEBAR_TOP_GROUPS) {
    const toggle = groupToggle(navigation, group.label)
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'))
  }
}

const WARM_CURRENT_ROUTES = [
  ['/dashboard/operations/daily-analysis', '/dashboard/operations/daily-analysis'],
  ['/dashboard/operations/portfolio-overview', '/dashboard/operations/portfolio-overview'],
  ['/dashboard/operations/inventory-analysis', '/dashboard/operations/inventory-analysis'],
  ['/dashboard/operations/inventory-ledger', '/dashboard/operations/inventory-ledger'],
  ['/dashboard/operations/inventory-replenishment', '/dashboard/operations/inventory-replenishment'],
  ['/dashboard/operations/shipping-plan', '/dashboard/operations/shipping-plan'],
  ['/dashboard/operations/shipment-management', '/dashboard/operations/shipment-management'],
  ['/dashboard/operations/sku-info', '/dashboard/operations/sku-info'],
  ['/dashboard/reports/order-info', '/dashboard/reports/order-info'],
  ['/dashboard/reports/product-analysis', '/dashboard/reports/product-analysis'],
  ['/dashboard/reports/monthly-report/display', '/dashboard/reports/monthly-report/display'],
  ['/dashboard/finance/platform-revenue', '/dashboard/finance/platform-revenue'],
  ['/dashboard/finance/exchange-rate', '/dashboard/finance/exchange-rate'],
  ['/dashboard/finance/vat-invoice', '/dashboard/finance/vat-invoice'],
  ['/dashboard/finance/commission-management', '/dashboard/finance/commission-management'],
  ['/dashboard/crm/dashboard', '/dashboard/crm/dashboard'],
  ['/dashboard/crm/follow-ups', '/dashboard/crm/follow-ups'],
  ['/dashboard/crm/customers', '/dashboard/crm/customers'],
  ['/dashboard/crm/sea', '/dashboard/crm/customers'],
  ['/dashboard/crm/proposals', '/dashboard/crm/proposals'],
  ['/dashboard/crm/proposals/42', '/dashboard/crm/proposals'],
  ['/dashboard/crm/intent', '/dashboard/crm/intent'],
  ['/dashboard/crm/leads', '/dashboard/crm/leads'],
  ['/dashboard/crm/tasks', '/dashboard/crm/tasks'],
  ['/dashboard/crm/audit', '/dashboard/crm/audit'],
  ['/dashboard/crm/settings', '/dashboard/crm/settings'],
  ['/dashboard/ai/insights', '/dashboard/ai/insights'],
  ['/dashboard/ai/ad-analysis', '/dashboard/ai/ad-analysis'],
  ['/dashboard/ai/inventory-health', '/dashboard/ai/inventory-health'],
  ['/dashboard/ai/believeboy-models', '/dashboard/ai/believeboy-models'],
  ['/dashboard/ai/customer-service', '/dashboard/ai/customer-service'],
  ['/dashboard/ai/digital-employees', '/dashboard/ai/digital-employees'],
  ['/dashboard/ai/digital-employees/employee-7', '/dashboard/ai/digital-employees'],
  ['/dashboard/ai/digital-employees/office', '/dashboard/ai/digital-employees/office'],
  ['/dashboard/tools/markdown-to-word', '/dashboard/tools/markdown-to-word'],
  ['/dashboard/tools/page-render', '/dashboard/tools/page-render'],
  ['/dashboard/tools/brand-registration-example', '/dashboard/tools/brand-registration-example'],
  ['/dashboard/tools/product-label', '/dashboard/tools/product-label'],
  ['/dashboard/tools/cross-border-compliance', '/dashboard/tools/cross-border-compliance'],
  ['/dashboard/system/account-management', '/dashboard/system/account-management'],
  ['/dashboard/system/agent-management', '/dashboard/system/agent-management'],
  ['/dashboard/system/alerts', '/dashboard/system/alerts'],
  ['/dashboard/system/changelog', '/dashboard/system/changelog'],
  ['/dashboard/system/data-management', '/dashboard/system/data-management'],
  ['/dashboard/system/logs', '/dashboard/system/logs'],
  ['/dashboard/system/operator-management', '/dashboard/system/operator-management'],
  ['/dashboard/system/project-info', '/dashboard/system/project-info'],
] as const

const WARM_C8_ROUTE_CASES = [
  ['/dashboard/reports/auto-upload', '报表自动化', '报表中心'],
  ['/dashboard/reports/monthly-report/generate', '制作报表', '报表中心'],
  ['/dashboard/reports/monthly-report/reconcile', '报表核对', '报表中心'],
  ['/dashboard/reports/pricing-calculation', '定价核算', '报表中心'],
  ['/dashboard/reports/pricing-calculation/new-product', '新品核算', '报表中心'],
  ['/dashboard/reports/pricing-calculation/shop-calculation', '店铺测算', '报表中心'],
  ['/dashboard/reports/report-reconciliation', '报表核对', '报表中心'],
  ['/dashboard/reports/scheduled-reports', '定时报告', '报表中心'],
  ['/dashboard/reports/scheduled-reports/ledger', '调度记录', '报表中心'],
  ['/dashboard/reports/scheduled-reports/subscriptions', '订阅管理', '报表中心'],
  ['/dashboard/operations/complaint-center', '客户消息', '运营'],
  ['/dashboard/operations/complaint-center/list', '客诉明细', '运营'],
  ['/dashboard/operations/inventory-replenishment', '补货分析', '运营'],
  ['/dashboard/operations/platform-inspection', '平台巡检', '运营'],
  ['/dashboard/operations/project-goals', '项目目标', '运营'],
  ['/dashboard/operations/project-launch', '项目启动台', '运营'],
  ['/dashboard/operations/project-launch/templates', '流程模板管理', '运营'],
  ['/dashboard/operations/research-analysis', '调研分析', '运营'],
  ['/dashboard/operations/return-analysis', '退货分析', '运营'],
  ['/dashboard/operations/review-tracking', '评论追踪', '运营'],
  ['/dashboard/operations/seasonal-replenishment', '季节性补货分析', '运营'],
  ['/dashboard/operations/site-navigation', '站点导航', '运营'],
  ['/dashboard/operations/store-navigation', '店铺导航', '运营'],
  ['/dashboard/operations/weekly-product-analysis', '按周产品分析', '运营'],
  ['/dashboard/agent-center/overview', '数据流总览', '运营'],
  ['/dashboard/agent-center/employees', 'Agent 员工', '运营'],
] as const

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

function installMatchMedia(initialMobile: boolean, initialPhone = initialMobile) {
  const matchesByQuery = new Map([
    ['(max-width: 820px)', initialMobile],
    ['(max-width: 430px)', initialPhone],
  ])
  const listenersByQuery = new Map<string, Set<MediaListener>>()
  const mediaQueries = new Map<string, MediaQueryList>()

  const getMediaQuery = (query: string) => {
    const existing = mediaQueries.get(query)
    if (existing) return existing

    const listeners = new Set<MediaListener>()
    listenersByQuery.set(query, listeners)
    const mediaQuery = {
      media: query,
      get matches() {
        return matchesByQuery.get(query) ?? false
      },
      onchange: null,
      addEventListener: (_type: string, listener: MediaListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: MediaListener) => listeners.delete(listener),
      addListener: (listener: MediaListener) => listeners.add(listener),
      removeListener: (listener: MediaListener) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as MediaQueryList
    mediaQueries.set(query, mediaQuery)
    return mediaQuery
  }

  vi.stubGlobal('matchMedia', getMediaQuery)
  Object.defineProperty(window, 'matchMedia', {
    value: getMediaQuery,
    configurable: true,
    writable: true,
  })

  return (nextMobile: boolean, nextPhone = nextMobile) => {
    matchesByQuery.set('(max-width: 820px)', nextMobile)
    matchesByQuery.set('(max-width: 430px)', nextPhone)
    act(() => {
      for (const query of ['(max-width: 820px)', '(max-width: 430px)']) {
        const mediaQuery = getMediaQuery(query)
        listenersByQuery.get(query)?.forEach((listener) =>
          listener({
            matches: matchesByQuery.get(query) ?? false,
            media: mediaQuery.media,
          } as MediaQueryListEvent)
        )
      }
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
  it('fills the desktop viewport inside equal 8px stage insets without window caps', () => {
    const appWindowRule =
      shellThemeCss.match(/\.warm-ledger__app-window\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(shellThemeCss).toContain('--warm-ledger-inset-stage: 8px')
    // 工作窗按父容器内容盒铺满，而不是 100vw：html 的 scrollbar-gutter 会让
    // body 比视口窄，用 100vw 会把右侧边框挤出 body 并被滚动条遮住。
    expect(appWindowRule).toContain('width: 100%')
    expect(appWindowRule).toContain('height: 100%')
    expect(appWindowRule).not.toContain('100vw')
    expect(appWindowRule).not.toContain('960px')
    expect(shellThemeCss).not.toContain('--warm-ledger-layout-window-max-width')
  })

  it('keeps the work window right edge clear of the browser scrollbar', () => {
    // V4 路由取消 html 的 stable gutter 预留，否则文档不滚动时也会白留 10px。
    expect(shellThemeCss).toContain('html:has(.warm-ledger) {')
    expect(shellThemeCss).toContain('scrollbar-gutter: auto')

    const scrollRule =
      shellThemeCss.match(/\.warm-ledger__main-scroll\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(scrollRule).toContain('scrollbar-width: thin')

    const thumbRule =
      shellThemeCss.match(
        /\.warm-ledger__main-scroll::-webkit-scrollbar-thumb\s*\{([^}]*)\}/,
      )?.[1] ?? ''
    // thumb 内缩 3px 并只画 content-box，避免贴住窗口 1px 边框。
    expect(thumbRule).toContain('border: 3px solid transparent')
    expect(thumbRule).toContain('background-clip: content-box')
  })

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

    const { container } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const overview = within(navigation).getByRole('link', { name: '运营总览' })
    const dataFlow = within(navigation).getByRole('link', { name: '数据流总览' })
    expect(overview).toHaveAttribute('href', '/dashboard')
    expect(overview).toHaveAttribute('aria-current', 'page')
    expect(dataFlow).toHaveAttribute('href', '/dashboard/agent-center/overview')
    for (const link of within(navigation).getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^\/dashboard(?:\/|$)/)
    }

    const quickAccess = container.querySelector('.warm-ledger__quick-access')
    expect(quickAccess).not.toBeNull()
    const quickLinks = [
      ['销售数据', '/dashboard/operations/daily-analysis'],
      ['订单信息', '/dashboard/reports/order-info'],
      ['库存分析', '/dashboard/operations/inventory-analysis'],
      ['客户消息', '/dashboard/operations/complaint-center'],
    ]
    for (const [label, href] of quickLinks) {
      const link = within(quickAccess as HTMLElement).getByRole('link', { name: label })
      expect(link).toHaveAttribute('href', href)
    }
  })

  it('links each C3 route once inside the collapsible navigation and retains four quick links', () => {
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
      const matchingLinks = visibleScrollerLinks(navigation).filter(
        (link) => link.getAttribute('href') === route
      )

      expect(matchingLinks).toHaveLength(1)
      expect(matchingLinks[0]).toHaveAttribute('aria-current', 'page')
      expect(container.querySelectorAll('.warm-ledger__quick-list a')).toHaveLength(4)
      unmount()
    }
  })

  it('renders one collapsible group per sidebar config group and expands only the owner of the current route', () => {
    installMatchMedia(false)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    expect(SIDEBAR_TOP_GROUPS.length).toBeGreaterThan(1)
    for (const group of SIDEBAR_TOP_GROUPS) {
      const toggle = groupToggle(navigation, group.label)
      const panelId = toggle.getAttribute('aria-controls')
      expect(panelId, group.id + ' 分组需要 aria-controls').toBeTruthy()
      expect(document.getElementById(panelId!)).toBeInTheDocument()
      expect(toggle).toHaveAttribute(
        'aria-expanded',
        group.id === 'operations' ? 'true' : 'false'
      )
    }

    const visibleHrefs = visibleScrollerLinks(navigation).map((link) =>
      link.getAttribute('href')
    )
    for (const item of configuredItems('operations')) {
      expect(visibleHrefs, 'operations/' + item.title + ' 应可点击').toContain(item.url)
    }
    expect(visibleHrefs).not.toContain('/dashboard/finance/platform-revenue')
  })

  it('toggles a collapsed group from its header button and remembers the state', async () => {
    installMatchMedia(false)

    const { unmount } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
    const readNavigation = () =>
      screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const financeHref = '/dashboard/finance/platform-revenue'
    let navigation = readNavigation()
    const financeToggle = groupToggle(navigation, '财务资金')

    expect(financeToggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      visibleScrollerLinks(navigation).some(
        (link) => link.getAttribute('href') === financeHref
      )
    ).toBe(false)

    fireEvent.click(financeToggle)
    expect(financeToggle).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() =>
      expect(
        visibleScrollerLinks(navigation).some(
          (link) => link.getAttribute('href') === financeHref
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(WARM_SIDEBAR_STORAGE_KEY) ?? '[]')
      ).toContain('finance')
    )

    fireEvent.click(financeToggle)
    expect(financeToggle).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(WARM_SIDEBAR_STORAGE_KEY) ?? '[]')
      ).not.toContain('finance')
    )

    unmount()
    window.localStorage.setItem(WARM_SIDEBAR_STORAGE_KEY, JSON.stringify(['finance']))
    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
    navigation = readNavigation()
    await waitFor(() =>
      expect(groupToggle(navigation, '财务资金')).toHaveAttribute('aria-expanded', 'true')
    )
  })

  it('exposes every sidebar config item once every group is expanded', async () => {
    installMatchMedia(false)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    await expandAllGroups(navigation)

    const hrefs = visibleScrollerLinks(navigation).map((link) => link.getAttribute('href'))
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const group of SIDEBAR_TOP_GROUPS) {
      for (const item of filterByRole(group.items)) {
        expect(hrefs, group.id + '/' + item.title + ' 必须有侧栏入口').toContain(item.url)
      }
    }
  })

  it('shares one left edge across the quick access separator, label, and grid', () => {
    expect(shellThemeCss).toMatch(
      /\.warm-ledger__quick-access \{[^}]*flex-direction: column/s
    )
    expect(shellThemeCss).toMatch(
      /\.warm-ledger__quick-access \{[^}]*gap: var\(--warm-ledger-space-2\)/s
    )
    expect(shellThemeCss).toMatch(
      /\.warm-ledger__quick-access \.warm-ledger__nav-separator \{[^}]*margin: 0/s
    )
    expect(shellThemeCss).toMatch(
      /\.warm-ledger__quick-access \.warm-ledger__nav-label \{[^}]*margin: 0/s
    )
  })

  it('keeps four pinned quick links outside the collapsible groups', () => {
    installMatchMedia(false)

    const { container } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const quickAccess = container.querySelector('.warm-ledger__quick-access')
    expect(quickAccess).not.toBeNull()
    expect(quickAccess!.querySelectorAll('a')).toHaveLength(4)

    const overview = within(navigation).getByRole('link', { name: '运营总览' })
    expect(overview).toHaveAttribute('href', '/dashboard')

    const scrollerHrefs = scrollerLinks(navigation).map((link) => link.getAttribute('href'))
    expect(new Set(scrollerHrefs).size).toBe(scrollerHrefs.length)
  })

  it('keeps a group-level marker when the current route sits in a collapsed group', () => {
    installMatchMedia(false)
    shellMocks.pathname = '/dashboard/finance/platform-revenue'

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const financeToggle = groupToggle(navigation, '财务资金')
    expect(financeToggle).toHaveAttribute('aria-expanded', 'true')
    expect(financeToggle).toHaveAttribute('data-current', 'true')

    fireEvent.click(financeToggle)
    expect(financeToggle).toHaveAttribute('aria-expanded', 'false')
    expect(financeToggle).toHaveAttribute('data-current', 'true')
    expect(groupToggle(navigation, '运营')).not.toHaveAttribute('data-current')
    // 域级琥珀书签只在折叠时显示；展开时由当前条目的书签负责。
    expect(shellThemeCss).toContain(
      "[data-current='true'][aria-expanded='false']"
    )
  })

  it('keeps the group header typography out of the shared button reset', () => {
    expect(shellThemeCss).toContain('.warm-ledger .warm-ledger__nav-group-toggle {')
    expect(shellThemeCss).toMatch(
      /\.warm-ledger \.warm-ledger__nav-group-toggle \{[^}]*font-size: var\(--warm-ledger-font-size-control\)/s
    )
    expect(shellThemeCss).toMatch(
      /\.warm-ledger \.warm-ledger__nav-item \{[^}]*color: var\(--warm-ledger-color-text-soft\)/s
    )
  })

  it('scrolls the current navigation item into view on route change', () => {
    installMatchMedia(false)
    shellMocks.pathname = '/dashboard/tools/cross-border-compliance'

    const original = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView

    try {
      render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
    } finally {
      Element.prototype.scrollIntoView = original
    }

    expect(scrollIntoView).toHaveBeenCalled()
    const target = scrollIntoView.mock.instances[0] as unknown as HTMLElement
    expect(target.getAttribute('aria-current')).toBe('page')
    expect(target.getAttribute('href')).toBe('/dashboard/tools/cross-border-compliance')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('auto-expands the group that owns the next route without collapsing the others', async () => {
    installMatchMedia(false)

    const { rerender } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
    let navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    expect(groupToggle(navigation, 'CRM 客户与合作伙伴')).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    shellMocks.pathname = '/dashboard/crm/leads'
    rerender(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
    navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    await waitFor(() =>
      expect(groupToggle(navigation, 'CRM 客户与合作伙伴')).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    )
    expect(groupToggle(navigation, '运营')).toHaveAttribute('aria-expanded', 'true')
  })

  it('toggles a group from the keyboard', async () => {
    installMatchMedia(false)
    const user = userEvent.setup()

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
    const toggle = groupToggle(navigation, '工具箱')
    toggle.focus()

    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks exactly one configured navigation target current for every Warm route', () => {
    installMatchMedia(false)

    for (const [pathname, navHref] of WARM_CURRENT_ROUTES) {
      shellMocks.pathname = pathname
      const { unmount } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
      const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })
      const scroller = within(getNavScroller(navigation))
      const matchingLinks = scroller
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href') === navHref)
      const currentLinks = scroller
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')

      expect(matchingLinks).toHaveLength(1)
      expect(currentLinks).toHaveLength(1)
      expect(currentLinks[0]).toHaveAttribute('href', navHref)
      unmount()
    }
  }, 30_000)

  it('does not activate a parent item by prefix when a more specific Warm route is current', () => {
    installMatchMedia(false)

    const cases = [
      [
        '/dashboard/ai/digital-employees/office',
        '虚拟办公室',
        '数字员工',
      ],
      [
        '/dashboard/crm/proposals/42',
        '客户方案',
        '数据看板',
      ],
      [
        '/dashboard/crm/sea',
        '客户',
        '客户方案',
      ],
    ] as const

    for (const [pathname, currentLabel, inactiveLabel] of cases) {
      shellMocks.pathname = pathname
      const { unmount } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)
      const navigation = screen.getByRole('navigation', { name: '业务域和快捷入口' })

      expect(within(navigation).getByRole('link', { name: currentLabel })).toHaveAttribute(
        'aria-current',
        'page'
      )
      expect(within(navigation).getByRole('link', { name: inactiveLabel })).not.toHaveAttribute(
        'aria-current'
      )
      unmount()
    }
  })

  it('recognizes every C8 residual route with its exact title and owning section', () => {
    for (const [pathname, title, section] of WARM_C8_ROUTE_CASES) {
      expect(isWarmLedgerRoute(pathname)).toBe(true)
      expect(getWarmLedgerPageTitle(pathname)).toBe(title)
      expect(getWarmLedgerRouteMeta(pathname)).toMatchObject({
        title,
        sectionLabel: section,
      })
    }
  })

  it('renders the five-item phone dock and the operations drawer quick links first', async () => {
    installMatchMedia(true, true)
    const user = userEvent.setup()
    const { container } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const dock = screen.getByRole('navigation', { name: '移动主导航' })
    expect(within(dock).getByRole('link', { name: '总览' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(
      within(dock)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim())
    ).toEqual(['运营', '报表', 'AI', '全部'])

    await user.click(within(dock).getByRole('button', { name: '运营' }))
    const drawer = screen.getByRole('complementary', { name: '运营导航抽屉' })
    expect(dock).toBeInTheDocument()
    expect(drawer).not.toHaveAttribute('inert')

    const quickLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        '.warm-ledger__mobile-quick-links a'
      )
    )
    expect(quickLinks.map((link) => link.textContent?.trim())).toEqual([
      '销售数据',
      '订单信息',
      '库存分析',
      '客户消息',
    ])
    expect(quickLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/dashboard/operations/daily-analysis',
      '/dashboard/reports/order-info',
      '/dashboard/operations/inventory-analysis',
      '/dashboard/operations/complaint-center',
    ])
  })

  it('searches the selected phone drawer and restores focus after route selection or Escape', async () => {
    installMatchMedia(true, true)
    const user = userEvent.setup()
    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const dock = screen.getByRole('navigation', { name: '移动主导航' })
    const operationsButton = within(dock).getByRole('button', { name: '运营' })
    await user.click(operationsButton)

    const search = screen.getByRole('searchbox', { name: '搜索页面' })
    expect(search).toHaveFocus()
    await user.type(search, '评论追踪')
    const reviewLink = screen.getByRole('link', { name: '评论追踪' })
    expect(reviewLink).toHaveAttribute(
      'href',
      '/dashboard/operations/review-tracking'
    )
    expect(screen.queryByRole('link', { name: '销售数据' })).not.toBeInTheDocument()

    await user.click(reviewLink)
    expect(operationsButton).toHaveFocus()
    expect(operationsButton).toHaveAttribute('aria-expanded', 'false')

    const reportsButton = within(dock).getByRole('button', { name: '报表' })
    await user.click(reportsButton)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(reportsButton).toHaveFocus()
    expect(reportsButton).toHaveAttribute('aria-expanded', 'false')
  })

  it('lists every configured navigation group in the phone All drawer and closes on backdrop', async () => {
    installMatchMedia(true, true)
    const user = userEvent.setup()
    const { container } = render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    const dock = screen.getByRole('navigation', { name: '移动主导航' })
    const allButton = within(dock).getByRole('button', { name: '全部' })
    await user.click(allButton)

    const drawer = screen.getByRole('complementary', { name: '全部导航抽屉' })
    const groupButtons = drawer.querySelectorAll('.warm-ledger__nav-group-toggle')
    expect(groupButtons).toHaveLength(SIDEBAR_TOP_GROUPS.length)
    for (const group of SIDEBAR_TOP_GROUPS) {
      expect(within(drawer).getByRole('button', { name: group.label })).toBeInTheDocument()
    }

    const scrim = container.querySelector<HTMLButtonElement>('.warm-ledger__scrim')
    expect(scrim).not.toBeNull()
    await user.click(scrim!)
    expect(allButton).toHaveFocus()
    expect(allButton).toHaveAttribute('aria-expanded', 'false')
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

    const sidebar = screen.getByRole('complementary', { name: '全部导航抽屉' })
    const closeButton = within(sidebar).getByRole('button', { name: '关闭导航' })
    const search = within(sidebar).getByRole('searchbox', { name: '搜索页面' })
    expect(search).toHaveFocus()
    expect(sidebar).not.toHaveAttribute('inert')
    expect(document.getElementById('main-content')?.parentElement).toHaveAttribute('inert')

    const lastGroupToggle = within(sidebar).getByRole('button', { name: '系统管理' })
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(lastGroupToggle).toHaveFocus()
    lastGroupToggle.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(search).toHaveFocus()

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
    const setMobile = installMatchMedia(false, false)

    render(<WarmLedgerShell>Dashboard</WarmLedgerShell>)

    screen.getByRole('link', { name: '运营总览' }).focus()
    setMobile(true, false)

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

  it('uses the owning domain label in breadcrumbs for the expanded Warm groups', () => {
    installMatchMedia(false)
    const cases = [
      ['/dashboard/finance/platform-revenue', '平台回款', '财务资金'],
      ['/dashboard/crm/proposals/42', '客户方案详情', 'CRM 客户与合作伙伴'],
      ['/dashboard/crm/intent', '意向客户', 'CRM 客户与合作伙伴'],
      ['/dashboard/ai/insights', 'AI洞察', 'AI 智能'],
      ['/dashboard/tools/markdown-to-word', 'Markdown 转 Word', '工具箱'],
      ['/dashboard/system/account-management', '系统账号管理', '系统管理'],
    ] as const

    for (const [pathname, title, section] of cases) {
      shellMocks.pathname = pathname
      const { unmount } = render(
        <WarmLedgerRouteFrame pathname={pathname}>
          <p>{title} content</p>
        </WarmLedgerRouteFrame>
      )

      const breadcrumbs = screen.getByRole('navigation', { name: '面包屑' })
      expect(within(breadcrumbs).getByText(section)).toBeInTheDocument()
      expect(within(breadcrumbs).getByText(title)).toHaveAttribute('aria-current', 'page')
      expect(within(breadcrumbs).queryByText('运营')).not.toBeInTheDocument()
      unmount()
    }
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
  it('shows one loading indicator for the page refresh action', () => {
    installMatchMedia(false)
    const onRefresh = vi.fn()
    const renderTopbar = (refreshing: boolean) => (
      <WarmLedgerShell
        topbar={
          <WarmLedgerTopbar
            routeFrame
            onRefresh={onRefresh}
            refreshing={refreshing}
            refreshFeedbackMessage={refreshing ? '正在刷新当前页。' : '刷新完成。'}
            refreshFeedbackStatus={refreshing ? 'loading' : 'success'}
          />
        }
      >
        Dashboard
      </WarmLedgerShell>
    )

    const { rerender } = render(renderTopbar(true))
    const refreshingButton = screen.getByRole('button', { name: '正在刷新当前页数据' })

    expect(refreshingButton).toBeDisabled()
    expect(refreshingButton).toHaveAttribute('aria-busy', 'true')
    expect(refreshingButton.querySelectorAll('.warm-ledger__loading-mark')).toHaveLength(1)
    expect(refreshingButton.querySelector('.warm-ledger__refresh-icon')).not.toBeInTheDocument()

    rerender(renderTopbar(false))
    const idleButton = screen.getByRole('button', { name: '刷新当前页数据' })

    expect(idleButton).toBeEnabled()
    expect(idleButton).not.toHaveAttribute('aria-busy')
    expect(idleButton.querySelectorAll('.warm-ledger__loading-mark')).toHaveLength(0)
    expect(idleButton.querySelector('.warm-ledger__refresh-icon')).toBeInTheDocument()
  })

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
    expect(screen.getAllByText('近 7 天').length).toBeGreaterThan(0)
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

  it('groups all home actions and scope information for the phone layout', () => {
    installMatchMedia(true, true)
    const onRefresh = vi.fn()
    const onSearch = vi.fn()
    const onNotifications = vi.fn()
    const onUserAction = vi.fn()

    const { container } = render(
      <WarmLedgerShell
        topbar={
          <WarmLedgerTopbar
            showScopeMeta={false}
            projectId="all"
            projectOptions={[{ value: 'all', label: '全部项目' }]}
            onProjectChange={vi.fn()}
            dateRangeLabel="11-07 → 11-13"
            siteLabel="US"
            onRefresh={onRefresh}
            onSearch={onSearch}
            onNotifications={onNotifications}
            onUserAction={onUserAction}
            userLabel="个人资料"
          />
        }
      >
        Dashboard
      </WarmLedgerShell>
    )

    const topbar = container.querySelector('.warm-ledger__topbar--home')
    expect(topbar).not.toBeNull()
    expect(within(topbar as HTMLElement).getByRole('combobox', { name: '项目筛选' }))
      .toBeInTheDocument()
    expect(within(topbar as HTMLElement).getByText('11-07 → 11-13'))
      .toBeInTheDocument()
    expect(within(topbar as HTMLElement).getByText('US · PT 运营日'))
      .toBeInTheDocument()

    const actions = within(topbar as HTMLElement).getByRole('group', {
      name: '首页快捷操作',
    })
    expect(within(actions).getByRole('button', { name: '刷新当前页数据' }))
      .toHaveTextContent('刷新')
    expect(within(actions).getByRole('button', { name: '全局搜索' }))
      .toHaveTextContent('搜索')
    expect(within(actions).getByRole('button', { name: '通知' }))
      .toHaveTextContent('通知')
    expect(within(topbar as HTMLElement).getByRole('button', { name: '个人资料' }))
      .toBeInTheDocument()
  })
})
