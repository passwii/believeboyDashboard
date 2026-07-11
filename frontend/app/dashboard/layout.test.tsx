import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// 关键断言：即便 isNavigationLoading=true（最危险 case），
// layout 也必须始终渲染 children，绝不能整页 swap 成 DashboardPageLoading。
//
// 测试策略：把 isNavigationLoading 强制设为 true 作为默认 mock 状态。
// 新版 layout 已不再消费 useGlobalLoading（line 19 hook 调用已删除），
// 所以 children 必定渲染。

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'authenticated', data: { user: { name: 't' } } }),
  signOut: vi.fn(),
}))

vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({ isNavigationLoading: true, isBlockingLoading: false }),
}))

vi.mock('@/components/dashboard/dashboard-page-loading', () => ({
  DashboardPageLoading: () => <div data-testid="page-loading">loading</div>,
}))

// 把 layout 的客户端副作用（SidebarProvider / SidebarShell / SidebarInset / document.title）打平为最小 stub
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
}))
vi.mock('@/components/dashboard/sidebar-shell', () => ({
  SidebarShell: () => <div data-testid="sidebar-shell" />,
}))

// 动态 import 被测 layout（在 mock 之后）
import DashboardLayout from './layout'

describe('DashboardLayout — 拆整页 loading swap', () => {
  it('isNavigationLoading=true 时 children 必须仍渲染，绝不能整页 swap 成 DashboardPageLoading', () => {
    render(
      <DashboardLayout>
        <div data-testid="child">real child</div>
      </DashboardLayout>,
    )
    // children 必须可见
    expect(screen.getByTestId('child')).toBeInTheDocument()
    // DashboardPageLoading（page-loading）绝不能出现
    expect(screen.queryByTestId('page-loading')).not.toBeInTheDocument()
  })
})