import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// 关键断言：即便 isNavigationLoading=true（最危险 case），
// layout 也必须始终渲染 children，绝不能整页 swap 成 DashboardPageLoading。
//
// 测试策略：把 isNavigationLoading 强制设为 true 作为默认 mock 状态。
// 新版 layout 已不再消费 useGlobalLoading（line 19 hook 调用已删除），
// 所以 children 必定渲染。

let mockPathname = '/dashboard'
const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
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
  beforeEach(() => {
    mockPathname = '/dashboard'
  })

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

  it('renders children without throwing when pathname is full-bleed (/dashboard/ai/chat)', () => {
    // 端到端验证：layout + PageTransition dispatcher 一起在 ai-chat 路由下不抛错
    // 因为路由判断在 PageTransition 内部（用 usePathname），layout 只负责 render children
    // 此 test 守护的是：dispatcher 改造后，外部 layout 调用栈不破坏
    mockPathname = '/dashboard/ai/chat'
    expect(() =>
      render(
        <DashboardLayout>
          <div data-testid="child">real child</div>
        </DashboardLayout>,
      ),
    ).not.toThrow()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })
})