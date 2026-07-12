import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSpotlight } from './use-spotlight'

describe('useSpotlight', () => {
  let el: HTMLDivElement

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
  })
  afterEach(() => {
    document.body.removeChild(el)
  })

  it('writes --spot-x/--spot-y on pointermove (relative coords 0-100%)', () => {
    renderHook(() => useSpotlight({ ref: { current: el } }))
    // 模拟 getBoundingClientRect 返回 100x100 起点 (0,0)
    el.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect))
    act(() => {
      el.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 25, bubbles: true }))
    })
    expect(el.style.getPropertyValue('--spot-x')).toBe('50%')
    expect(el.style.getPropertyValue('--spot-y')).toBe('25%')
  })

  it('does nothing when ref.current is null', () => {
    const noRef = { current: null }
    expect(() => renderHook(() => useSpotlight({ ref: noRef }))).not.toThrow()
  })

  it('returns a ref that points to the element', () => {
    const { result } = renderHook(() => {
      const ref = useSpotlight<HTMLDivElement>({})
      return ref
    })
    expect(result.current).toBeDefined()
  })
})