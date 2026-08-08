import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FollowUpReminderToast } from './follow-up-reminder-toast'

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

describe('FollowUpReminderToast', () => {
  let fake: ReturnType<typeof installFakeEventSource>
  let es: FakeEventSource

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    fake = installFakeEventSource()
    render(<FollowUpReminderToast />)
    es = fake.getInstances()[0]
    expect(es).toBeTruthy()
    es.onopen?.()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('收到 follow_up_reminder 事件 → 调 notify warning，含实体名/天数与去重标记', () => {
    es.emit(
      'follow_up_reminder',
      JSON.stringify({ entity_type: 'customer', entity_id: 7, name: '旺旺集团', days: 10 })
    )

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        title: '跟进提醒',
        message: '客户「旺旺集团」已 10 天无跟进',
      })
    )
    // 会话去重标记已写入
    expect(sessionStorage.getItem('crm-follow-up-reminder:customer:7')).toBe('1')
  })

  it('线索事件文案用「线索」标签', () => {
    es.emit(
      'follow_up_reminder',
      JSON.stringify({ entity_type: 'lead', entity_id: 2, name: '李经理', days: 8 })
    )

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].message).toBe('线索「李经理」已 8 天无跟进')
  })

  it('同一实体重复推送（SSE 重连重放）→ 同会话只 notify 一次；不同实体各弹一次', () => {
    const payload = { entity_type: 'customer', entity_id: 3, name: '提交报表', days: 9 }
    es.emit('follow_up_reminder', JSON.stringify(payload))
    es.emit('follow_up_reminder', JSON.stringify(payload))
    es.emit(
      'follow_up_reminder',
      JSON.stringify({ entity_type: 'lead', entity_id: 4, name: '另一个线索', days: 7 })
    )

    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls.map((c) => c[0].message)).toEqual([
      '客户「提交报表」已 9 天无跟进',
      '线索「另一个线索」已 7 天无跟进',
    ])
  })

  it('点击客户 toast → 跳转 /dashboard/crm/customers', () => {
    es.emit(
      'follow_up_reminder',
      JSON.stringify({ entity_type: 'customer', entity_id: 9, name: '拜访客户', days: 12 })
    )

    expect(notify).toHaveBeenCalledTimes(1)
    const opts = notify.mock.calls[0][0] as { onClick?: () => void }
    expect(opts.onClick).toBeTypeOf('function')
    opts.onClick?.()
    expect(push).toHaveBeenCalledWith('/dashboard/crm/customers')
  })

  it('点击线索 toast → 跳转 /dashboard/crm/leads', () => {
    es.emit(
      'follow_up_reminder',
      JSON.stringify({ entity_type: 'lead', entity_id: 5, name: '新线索', days: 9 })
    )

    const opts = notify.mock.calls[0][0] as { onClick?: () => void }
    opts.onClick?.()
    expect(push).toHaveBeenCalledWith('/dashboard/crm/leads')
  })

  it('EventSource 连接用正确的流地址', () => {
    expect(fake.source).toBeTruthy()
    expect(es.url).toBe('/api/backend/api/v1/crm/follow-ups/reminders/stream')
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
