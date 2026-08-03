import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useDebounce } from './use-debounce'

describe('useDebounce', () => {
  afterEach(() => vi.useRealTimers())

  it('初始返回原值', () => {
    const { result } = renderHook(() => useDebounce('a', 300))
    expect(result.current).toBe('a')
  })

  it('delay 内不更新，delay 后更新为最新值', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'ab' })
    rerender({ v: 'abc' })
    expect(result.current).toBe('a') // 还没到 delay
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current).toBe('abc') // 取最后一次
  })
})
