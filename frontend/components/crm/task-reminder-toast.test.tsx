import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskReminderToast } from './task-reminder-toast'

const { notify, push } = vi.hoisted(() => {
  return { notify: vi.fn(), push: vi.fn() }
})

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}))

type FakeEventSource = {
  url: string
  instances: FakeEventSource[]
  listeners: Map<string, Array<(e: MessageEvent) => void>>
  close: ReturnType<typeof vi.fn>
  /** 触发已注册的指定事件 */
  emit: (type: string, data: string) => void
}

/** jsdom 未实现 EventSource，注入可手动触发的 fake 类 */
function installFakeEventSource(): { source: typeof EventSource; getInstances: () => FakeEventSource[] } {
  const instances: FakeEventSource[] = []
  class FakeEventSource {
    static instances = instances
    url = ''
    listeners = new Map<string, Array<(e: MessageEvent) => void>>()
    close = vi.fn()
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(url: string | URL) {
      this.url = String(url)
      instances.push(this as unknown as FakeEventSource)
    }

    addEventListener(type: string, cb: (e: MessageEvent) => void) {
      const list = this.listeners.get(type) ?? []
      list.push(cb)
      this.listeners.set(type, list)
    }

    emit(type: string, data: string) {
      const list = this.listeners.get(type) ?? []
      for (const cb of list) cb(new MessageEvent(type, { data }))
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  return {
    source: FakeEventSource as unknown as typeof EventSource,
    getInstances: () => instances,
  }
}

describe('TaskReminderToast', () => {
  let fake: ReturnType<typeof installFakeEventSource>
  let es: FakeEventSource

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    fake = installFakeEventSource()
    render(<TaskReminderToast />)
    es = fake.getInstances()[0]
    expect(es).toBeTruthy()
    es.onopen?.()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('收到 task_reminder 事件 → 调 notify warning，含任务标题与去重标记', () => {
    es.emit('task_reminder', JSON.stringify({ task_id: 7, title: '回访客户A', due_date: null }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        title: '任务即将到期',
        message: '「回访客户A」还剩不到 24 小时',
      })
    )
    // 会话去重标记已写入
    expect(sessionStorage.getItem('crm-task-reminder:7')).toBe('1')
  })

  it('同一任务重复推送（SSE 重连重放）→ 同会话只 notify 一次', () => {
    const payload = { task_id: 3, title: '提交报表', due_date: '2026-08-09T10:00:00+00:00' }
    es.emit('task_reminder', JSON.stringify(payload))
    es.emit('task_reminder', JSON.stringify(payload))
    es.emit('task_reminder', JSON.stringify({ task_id: 4, title: '另一个任务', due_date: null }))

    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls.map((c) => c[0].message)).toEqual([
      '「提交报表」还剩不到 24 小时',
      '「另一个任务」还剩不到 24 小时',
    ])
  })

  it('点击 toast → 跳转 /dashboard/crm/tasks', () => {
    es.emit('task_reminder', JSON.stringify({ task_id: 9, title: '拜访客户', due_date: null }))

    expect(notify).toHaveBeenCalledTimes(1)
    const opts = notify.mock.calls[0][0] as { onClick?: () => void }
    expect(opts.onClick).toBeTypeOf('function')
    opts.onClick?.()
    expect(push).toHaveBeenCalledWith('/dashboard/crm/tasks')
  })

  it('EventSource 连接用正确的流地址', () => {
    expect(fake.source).toBeTruthy()
    expect(es.url).toBe('/api/backend/api/v1/crm/tasks/reminders/stream')
  })

  it('断连（onerror）→ 关闭并按指数退避调度重连', () => {
    vi.useFakeTimers()
    es.onerror?.()
    expect(es.close).toHaveBeenCalled()
    // 第一次重试 1s 后重建连接
    vi.advanceTimersByTime(1000)
    expect(fake.getInstances().length).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
  })
})
