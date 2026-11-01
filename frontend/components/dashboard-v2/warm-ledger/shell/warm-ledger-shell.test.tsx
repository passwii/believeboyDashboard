import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WarmLedgerShell } from './warm-ledger-shell'
import { WarmLedgerTopbar } from './warm-ledger-topbar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
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

describe('WarmLedgerTopbar', () => {
  it('renders a labeled project select and reports selection changes', () => {
    installMatchMedia(false)
    const onProjectChange = vi.fn()

    render(
      <WarmLedgerShell
        topbar={
          <WarmLedgerTopbar
            projectId="project-2"
            projectOptions={[
              { value: 'all', label: '全部项目' },
              { value: 'project-2', label: '项目二' },
            ]}
            onProjectChange={onProjectChange}
            siteLabel="US"
          />
        }
      >
        Dashboard
      </WarmLedgerShell>
    )

    const select = screen.getByRole('combobox', { name: '项目筛选' })
    expect(select).toHaveValue('project-2')
    expect(screen.getByText('近 7 天')).toBeInTheDocument()
    expect(screen.getByText('US')).toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'all' } })
    expect(onProjectChange).toHaveBeenCalledWith('all')
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
