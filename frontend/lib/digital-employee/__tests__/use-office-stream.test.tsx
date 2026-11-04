import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: MessageEvent) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []

  readonly url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private handlers = new Map<string, Handler>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: Handler) {
    this.handlers.set(type, handler)
  }

  close() {
    this.closed = true
  }

  emit(type: string, data: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

vi.mock('../office-stream-types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../office-stream-types')>()
  return actual
})

import { useOfficeStream } from '../use-office-stream'

const EMPLOYEE = {
  employee_id: 1,
  name: '测试员工',
  persona: { emoji: '📊', color_key: 'amber', tagline: '数据观察员' },
  display_status: 'WORKING',
  busy_level: 'NORMAL',
  queued_count: 0,
  pace: 1,
  current_task: null,
  work_item: { project_name: null, report_label: null },
  virtual_progress: 10,
  step_label: '检查库存',
  today_done: 1,
  success_rate: 1,
  last_heartbeat_at: null,
}

describe('useOfficeStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps snapshot and chatter events on the existing stream contract', () => {
    const { result } = renderHook(() => useOfficeStream())
    const source = FakeEventSource.instances[0]

    expect(source.url).toBe('/api/backend/api/v1/digital-employees/office/stream')
    act(() => {
      source.onopen?.()
      source.emit('snapshot', {
        server_time: '2026-11-04T12:00:00Z',
        employees: [EMPLOYEE],
      })
      source.emit('chatter', {
        employee_id: 1,
        name: '测试员工',
        emoji: '📊',
        event_type: 'task_started',
        text: '开始检查库存',
        timestamp: '2026-11-04T12:00:00Z',
      })
    })

    expect(result.current.connected).toBe(true)
    expect(result.current.employees).toEqual([EMPLOYEE])
    expect(result.current.chatterFeed[0]?.text).toBe('开始检查库存')
  })

  it('keeps exponential reconnect and resolves manual refresh on the next snapshot', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOfficeStream())
    const first = FakeEventSource.instances[0]

    act(() => {
      first.onopen?.()
      first.onerror?.()
    })
    expect(first.closed).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(FakeEventSource.instances).toHaveLength(2)

    const second = FakeEventSource.instances[1]
    act(() => {
      second.onopen?.()
      result.current.refresh()
    })
    expect(result.current.refreshing).toBe(true)
    expect(second.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(3)

    const third = FakeEventSource.instances[2]
    act(() => {
      third.emit('snapshot', {
        server_time: '2026-11-04T12:00:00Z',
        employees: [EMPLOYEE],
      })
    })
    expect(result.current.refreshing).toBe(false)
    expect(result.current.employees).toEqual([EMPLOYEE])
  })

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useOfficeStream())
    const source = FakeEventSource.instances[0]

    unmount()
    expect(source.closed).toBe(true)
  })
})
