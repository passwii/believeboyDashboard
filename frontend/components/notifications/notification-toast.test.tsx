import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * BLF-1361 §5：reduced-motion 下 toast 不做模糊。
 *
 * 全局 `<MotionConfig reducedMotion="user">` 只覆盖 transform / layout，`filter: blur()`
 * 不在它的范围内（实测 reduced-motion 下位移已变 `transform: none`，blur 仍在 2px→0 插值）。
 * 所以 toast 自己读 `useReducedMotion()` 把 blur 钉成 0——这条用例锁住那个分支。
 *
 * 为什么 mock `useReducedMotion` 而不是桩 `matchMedia`：framer-motion 把
 * `prefers-reduced-motion` 的订阅结果缓存在**模块作用域**，`vi.resetModules()` 清不掉，
 * 同一文件里前几个用例先跑过就会把状态带进来（实测过，会假红）。桩 `matchMedia`
 * 测到的是 framer 的缓存行为，不是本仓库的代码；mock hook 才是直测我们自己的分支。
 */
describe('ToastItem reduced-motion 分支', () => {
  afterEach(() => {
    vi.doUnmock('framer-motion')
    vi.resetModules()
  })

  async function renderWithReducedMotion(reduce: boolean) {
    vi.resetModules()
    vi.doMock('framer-motion', async () => {
      const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
      return { ...actual, useReducedMotion: () => reduce }
    })
    const { NotificationToastContainer } = await import('./notification-toast')
    render(<NotificationToastContainer />)
    return screen.getByText('无点击动作').closest('.pointer-events-auto') as HTMLElement
  }

  it('reduce 时初始 filter 为 blur(0px)（不做模糊）', async () => {
    const el = await renderWithReducedMotion(true)
    expect(el.getAttribute('style')).toContain('blur(0px)')
  })

  it('no-preference 时保留 blur(2px) 入场（不削弱正常用户的动效）', async () => {
    const el = await renderWithReducedMotion(false)
    expect(el.getAttribute('style')).toContain('blur(2px)')
  })
})
