import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalLoadingProvider } from '@/components/global-loading-provider'
import { TerminalShell } from './terminal-shell'

const mockNavigation = vi.hoisted(() => ({
  pathname: '/dashboard/profile' as string,
  router: { push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mockNavigation.pathname,
  useRouter: () => mockNavigation.router,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null }),
}))

vi.mock('@/components/motion/PageTransition', () => ({
  PageTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock('@/components/terminal/global-filter-context', () => ({
  TerminalGlobalFilterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  MobileStripMount: () => null,
  TerminalHeaderSlotProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/terminal/terminal-footer', () => ({ TerminalFooter: () => null }))
vi.mock('@/components/terminal/terminal-header', () => ({ TerminalHeader: () => null }))
vi.mock('@/components/terminal/terminal-inspector', () => ({ TerminalInspector: () => null }))
vi.mock('@/components/terminal/theme-mode-picker', () => ({ ThemeModePicker: () => null }))
vi.mock('@/components/terminal/use-live-stream', () => ({ useLiveStream: () => [] }))
vi.mock('@/components/terminal/terminal-subnav', () => ({ TerminalSubnav: () => null }))
vi.mock('@/components/dashboard/search-command', () => ({ SearchCommand: () => null }))
vi.mock('@/components/terminal/terminal-constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/terminal/terminal-constants')>()),
  pushRecent: vi.fn(),
}))
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetTitle: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/terminal/use-terminal-layout', () => ({
  useTerminalLayout: () => ({
    subnavCollapsed: false,
    toggleSubnav: vi.fn(),
    inspectorOpen: false,
    toggleInspector: vi.fn(),
  }),
}))
function renderShell() {
  return render(
    <GlobalLoadingProvider>
      <TerminalShell>
        <button type="button">页面内容</button>
      </TerminalShell>
    </GlobalLoadingProvider>
  )
}

describe('TerminalShell navigation loading', () => {
  beforeEach(() => {
    mockNavigation.pathname = '/dashboard/profile'
    mockNavigation.router.push.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['double-clicking one group', ['运营', '运营']],
    ['quickly switching between groups', ['运营', '项目管理']],
  ])('clears navigation loading after %s and the route changes', (_description, labels) => {
    const view = renderShell()

    labels.forEach((label) => fireEvent.click(screen.getByRole('button', { name: label })))

    expect(screen.getByTestId('dashboard-navigation-loading')).toBeInTheDocument()
    expect(screen.getByRole('main').querySelector('[inert]')).toBeInTheDocument()

    mockNavigation.pathname = '/dashboard/operations/daily-analysis'
    view.rerender(
      <GlobalLoadingProvider>
        <TerminalShell>
          <button type="button">页面内容</button>
        </TerminalShell>
      </GlobalLoadingProvider>
    )

    expect(screen.queryByTestId('dashboard-navigation-loading')).not.toBeInTheDocument()
    expect(screen.getByRole('main').querySelector('[inert]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '页面内容' })).toBeInTheDocument()
  })
})
