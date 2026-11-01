import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { stableSession } from '@/test-utils/stable-mocks'

let mockPathname = '/dashboard'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))
vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { name: 't' } }),
  signOut: vi.fn(),
}))

vi.mock('@/components/notifications/server-notifications-context', () => ({
  ServerNotificationsProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="notifications-provider">{children}</div>
  ),
}))
vi.mock('@/components/terminal/terminal-shell', () => ({
  TerminalShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="terminal-shell">{children}</div>
  ),
}))
vi.mock('@/components/dashboard/search-command', () => ({
  SearchCommand: () => <div data-testid="search-command" />,
}))

import DashboardLayout from './layout'

describe('DashboardLayout shell routing', () => {
  beforeEach(() => {
    mockPathname = '/dashboard'
  })

  it('bypasses TerminalShell only for the exact /dashboard route', () => {
    render(
      <DashboardLayout>
        <div data-testid="child">real child</div>
      </DashboardLayout>,
    )

    expect(screen.getByTestId('notifications-provider')).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-shell')).not.toBeInTheDocument()
    expect(screen.getByTestId('search-command')).toBeInTheDocument()
    expect(document.title).toContain('运营总览与关键数据面板')
  })

  it('keeps TerminalShell mounted for every nested Dashboard route', () => {
    mockPathname = '/dashboard/ai/chat'
    render(
      <DashboardLayout>
        <div data-testid="child">real child</div>
      </DashboardLayout>,
    )

    expect(screen.getByTestId('terminal-shell')).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('search-command')).not.toBeInTheDocument()
  })
})
