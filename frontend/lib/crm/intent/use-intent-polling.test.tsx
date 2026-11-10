import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useIntentPolling } from './use-intent-polling'

let hidden = false

beforeEach(() => {
  hidden = false
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (document as { hidden?: boolean }).hidden
})

describe('useIntentPolling', () => {
  it('每 15s 轮询一次；hidden 时跳过，恢复可见与 focus 时立即补拉', () => {
    const onPoll = vi.fn()
    renderHook(() => useIntentPolling({ onPoll }))

    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(onPoll).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(onPoll).toHaveBeenCalledTimes(2)

    hidden = true
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(onPoll).toHaveBeenCalledTimes(2)

    hidden = false
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(onPoll).toHaveBeenCalledTimes(3)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(onPoll).toHaveBeenCalledTimes(4)
  })

  it('上一轮未完成时不并发；enabled=false 不启动；卸载后停止', async () => {
    let resolve: () => void = () => {}
    const onPoll = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          resolve = resolvePromise
        })
    )
    const { unmount } = renderHook(() => useIntentPolling({ onPoll }))

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(onPoll).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve()
    })
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(onPoll).toHaveBeenCalledTimes(2)

    unmount()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(onPoll).toHaveBeenCalledTimes(2)

    const disabled = vi.fn()
    renderHook(() => useIntentPolling({ onPoll: disabled, enabled: false }))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(disabled).not.toHaveBeenCalled()
  })
})
