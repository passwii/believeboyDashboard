import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationListView } from './notification-list-view'
import type { ServerNotification } from '@/lib/notifications-api'

const ctx = vi.hoisted(() => ({
  unreadCount: 0,
  items: [] as ServerNotification[],
  loading: false,
  refresh: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}))

vi.mock('./server-notifications-context', () => ({
  useServerNotifications: () => ({
    unreadCount: ctx.unreadCount,
    items: ctx.items,
    loading: ctx.loading,
    refresh: ctx.refresh,
    markRead: ctx.markRead,
    markAllRead: ctx.markAllRead,
  }),
}))

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

const unread = (over: Partial<ServerNotification>): ServerNotification => ({
  id: 1,
  user_id: 1,
  type: 'alert',
  title: '补货提醒',
  message: 'SKU-001 库存低于安全线',
  data: { link: '/dashboard/inventory/replenishment' },
  read: false,
  read_at: null,
  created_at: new Date().toISOString(),
  ...over,
})

function renderList() {
  const onBack = vi.fn()
  const onNavigateClose = vi.fn()
  render(<NotificationListView onBack={onBack} onNavigateClose={onNavigateClose} />)
  return { onBack, onNavigateClose }
}

describe('NotificationListView — 内嵌通知列表（BLF-603）', () => {
  beforeEach(() => {
    ctx.unreadCount = 0
    ctx.items = []
    ctx.loading = false
    vi.clearAllMocks()
  })

  it('loading 时显示加载中', () => {
    ctx.loading = true
    renderList()
    expect(screen.getByText('加载中…')).toBeInTheDocument()
  })

  it('无通知时显示空态', () => {
    renderList()
    expect(screen.getByText('暂无通知')).toBeInTheDocument()
  })

  it('渲染通知行（标题 / 消息 / 相对时间）', () => {
    ctx.items = [unread({ title: '补货提醒', message: 'SKU-001 库存低于安全线' })]
    renderList()
    expect(screen.getByText('补货提醒')).toBeInTheDocument()
    expect(screen.getByText('SKU-001 库存低于安全线')).toBeInTheDocument()
    // 未读行有主色圆点标识
    expect(screen.getByRole('button', { name: /补货提醒/ })).toBeInTheDocument()
  })

  it('点击未读通知：标记已读 + 跳转 link + 关闭宿主 surface', () => {
    ctx.unreadCount = 2
    ctx.items = [unread({ id: 7 })]
    const { onNavigateClose } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /补货提醒/ }))
    expect(ctx.markRead).toHaveBeenCalledWith(7)
    expect(push).toHaveBeenCalledWith('/dashboard/inventory/replenishment')
    expect(onNavigateClose).toHaveBeenCalled()
  })

  it('点击已读通知：不再调 markRead，但仍跳转并关闭', () => {
    ctx.items = [unread({ read: true })]
    const { onNavigateClose } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /补货提醒/ }))
    expect(ctx.markRead).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/dashboard/inventory/replenishment')
    expect(onNavigateClose).toHaveBeenCalled()
  })

  it('通知无 link 时只关闭宿主 surface，不跳转', () => {
    ctx.items = [unread({ data: null })]
    const { onNavigateClose } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /补货提醒/ }))
    expect(push).not.toHaveBeenCalled()
    expect(onNavigateClose).toHaveBeenCalled()
  })

  it('全部已读：无未读时禁用', () => {
    ctx.unreadCount = 0
    renderList()
    expect(screen.getByRole('button', { name: /全部已读/ })).toBeDisabled()
  })

  it('全部已读：有未读时可点击并调用 markAllRead', () => {
    ctx.unreadCount = 3
    ctx.items = [unread({ id: 1 }), unread({ id: 2 })]
    renderList()
    fireEvent.click(screen.getByRole('button', { name: /全部已读/ }))
    expect(ctx.markAllRead).toHaveBeenCalled()
  })

  it('返回按钮触发 onBack', () => {
    const { onBack } = renderList()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onBack).toHaveBeenCalled()
  })
})
