import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationToastContainer } from './notification-toast'

const { notify, dismissToast } = vi.hoisted(() => ({
  notify: vi.fn(),
  dismissToast: vi.fn(),
}))

// 直接 mock hook：容器渲染 toasts 并透传 dismiss / onClick
vi.mock('./notifications-context', () => ({
  useNotifications: () => ({
    toasts: [
      {
        id: 't1',
        type: 'warning',
        title: '任务即将到期',
        message: '「回访客户A」还剩不到 24 小时',
        read: false,
        createdAt: 1,
        onClick: () => notify('clicked'),
      },
      {
        id: 't2',
        type: 'info',
        title: '普通通知',
        message: '无点击动作',
        read: false,
        createdAt: 2,
      },
    ],
    notify,
    dismissToast,
  }),
}))

describe('NotificationToastContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('toast 带 onClick 时点击触发回调并显示 cursor-pointer', () => {
    render(<NotificationToastContainer />)
    // 外层 motion.div 带 cursor-pointer + onClick；消息文本在其内部，click 会冒泡触发
    const clickable = screen.getByText('「回访客户A」还剩不到 24 小时').closest('.cursor-pointer')
    expect(clickable).toBeTruthy()
    fireEvent.click(clickable as HTMLElement)
    expect(notify).toHaveBeenCalledWith('clicked')
  })

  it('toast 无 onClick 时点击不报错、不触发回调', () => {
    render(<NotificationToastContainer />)
    const plain = screen.getByText('无点击动作')
    fireEvent.click(plain)
    expect(notify).not.toHaveBeenCalled()
  })

  it('关闭按钮不触发 onClick（stopPropagation）', () => {
    render(<NotificationToastContainer />)
    const closeButtons = screen.getAllByLabelText('关闭通知')
    fireEvent.click(closeButtons[0])
    expect(dismissToast).toHaveBeenCalledWith('t1')
    expect(notify).not.toHaveBeenCalled()
  })
})
