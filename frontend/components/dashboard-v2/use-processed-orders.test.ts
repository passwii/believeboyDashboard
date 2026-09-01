import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProcessedOrders } from './use-processed-orders'

// ---- tests ------------------------------------------------------------------

const WINDOW = '1,2|2026-08-25|2026-08-31'
const OTHER_WINDOW = '3|2026-09-01|2026-09-07'

describe('useProcessedOrders（BLF-928 已处理集合）', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })

  it('初始为空集合', () => {
    const { result } = renderHook(() => useProcessedOrders(WINDOW))
    expect(result.current.processedIds.size).toBe(0)
  })

  it('markProcessed 追加 id，且持久化到 localStorage', () => {
    const { result } = renderHook(() => useProcessedOrders(WINDOW))
    act(() => result.current.markProcessed([101, 102]))
    expect(result.current.processedIds.has(101)).toBe(true)
    expect(result.current.processedIds.has(102)).toBe(true)
    expect(result.current.processedIds.has(103)).toBe(false)
    expect(window.localStorage.setItem).toHaveBeenCalled()
  })

  it('markProcessed 幂等：重复 id 不膨胀', () => {
    const { result } = renderHook(() => useProcessedOrders(WINDOW))
    act(() => result.current.markProcessed([101, 101, 102]))
    expect(result.current.processedIds.size).toBe(2)
  })

  it('窗口变化时切换到该窗口的已处理集合（互不污染）', () => {
    const { result, rerender } = renderHook(({ w }: { w: string }) => useProcessedOrders(w), {
      initialProps: { w: WINDOW },
    })
    act(() => result.current.markProcessed([101]))
    expect(result.current.processedIds.has(101)).toBe(true)

    rerender({ w: OTHER_WINDOW })
    expect(result.current.processedIds.size).toBe(0)
  })

  it('从 localStorage 水合该窗口的历史已处理 id', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => JSON.stringify({ [WINDOW]: [101, 102], [OTHER_WINDOW]: [999] })),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    const { result } = renderHook(() => useProcessedOrders(WINDOW))
    expect(result.current.processedIds.has(101)).toBe(true)
    expect(result.current.processedIds.has(102)).toBe(true)
    expect(result.current.processedIds.has(999)).toBe(false)
  })

  it('localStorage 数据损坏时静默降级为空集合', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '{broken json'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    const { result } = renderHook(() => useProcessedOrders(WINDOW))
    expect(result.current.processedIds.size).toBe(0)
  })
})
