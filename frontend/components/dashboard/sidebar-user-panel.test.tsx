import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarUserPanel } from './sidebar-user-panel'
import type { ServerNotification } from '@/lib/notifications-api'

const ctx = vi.hoisted(() => ({
  unreadCount: 0,
  items: [] as ServerNotification[],
  loading: false,
  refresh: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}))

vi.mock('@/components/notifications/server-notifications-context', () => ({
  useServerNotifications: () => ({
    unreadCount: ctx.unreadCount,
    items: ctx.items,
    loading: ctx.loading,
    refresh: ctx.refresh,
    markRead: ctx.markRead,
    markAllRead: ctx.markAllRead,
  }),
}))

// RouteLoadingLink 与测试无关，打平为纯 <a>，避免其依赖 useGlobalLoading / useSidebar
vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({
    href,
    onClick,
    children,
  }: {
    href: string
    onClick?: () => void
    children: React.ReactNode
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

const baseProps = {
  user: { name: '张三', email: 'zhangsan@example.com', roleType: 'admin' as const },
  pinned: false,
  onClose: vi.fn(),
  onPinToggle: vi.fn(),
  onLogout: vi.fn(),
}

describe('SidebarUserPanel — 通知入口与视图切换（BLF-603）', () => {
  beforeEach(() => {
    ctx.unreadCount = 0
    ctx.items = []
    ctx.loading = false
    vi.clearAllMocks()
  })

  it('账户视图渲染通知行（无未读时无徽标）', () => {
    render(<SidebarUserPanel {...baseProps} />)
    const notifRow = screen.getByRole('button', { name: /^通知/ })
    expect(notifRow).toBeInTheDocument()
    expect(notifRow.querySelector('.bg-primary')).toBeNull()
    expect(screen.getByText('个人资料')).toBeInTheDocument()
    expect(screen.getByText('修改密码')).toBeInTheDocument()
    expect(screen.getByText('退出登录')).toBeInTheDocument()
  })

  it('有未读时通知行显示徽标数字，99+ 封顶', () => {
    ctx.unreadCount = 128
    render(<SidebarUserPanel {...baseProps} />)
    expect(screen.getByText('99+')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /通知，128 条未读/ })).toBeInTheDocument()
  })

  it('点击通知行：刷新列表并切换到通知列表视图', () => {
    ctx.unreadCount = 1
    render(<SidebarUserPanel {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /^通知/ }))
    expect(ctx.refresh).toHaveBeenCalled()
    // 列表视图特征：全部已读 + 返回按钮；账户视图元素消失
    expect(screen.getByRole('button', { name: /全部已读/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument()
    expect(screen.queryByText('个人资料')).not.toBeInTheDocument()
    expect(screen.queryByText('修改密码')).not.toBeInTheDocument()
  })

  it('通知列表点击返回回到账户视图', () => {
    render(<SidebarUserPanel {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /^通知/ }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByText('个人资料')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^通知/ })).toBeInTheDocument()
  })

  it('列表内点击通知：跳转 link 并关闭面板（onNavigateClose=onClose）', () => {
    ctx.items = [
      {
        id: 5,
        user_id: 1,
        type: 'alert',
        title: '告警',
        message: null,
        data: { link: '/dashboard/somewhere' },
        read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ]
    render(<SidebarUserPanel {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /^通知/ }))
    fireEvent.click(screen.getByRole('button', { name: /告警/ }))
    expect(push).toHaveBeenCalledWith('/dashboard/somewhere')
    expect(baseProps.onClose).toHaveBeenCalled()
  })
})
