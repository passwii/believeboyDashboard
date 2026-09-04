import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { TERMINAL_STORAGE_KEYS } from './terminal-constants'
import { useTerminalLayout } from './use-terminal-layout'

describe('useTerminalLayout', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('默认展开 SubNav、收起 Inspector；⌘B 切换并持久化', () => {
    const { result } = renderHook(() => useTerminalLayout())
    expect(result.current.subnavCollapsed).toBe(false)
    expect(result.current.inspectorOpen).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    })
    expect(result.current.inspectorOpen).toBe(true)
    expect(window.localStorage.getItem(TERMINAL_STORAGE_KEYS.inspectorOpen)).toBe('1')

    // 无修饰键的 b 不触发
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }))
    })
    expect(result.current.inspectorOpen).toBe(true)
  })

  it('折叠状态从 localStorage 恢复；toggleSubnav 写回', () => {
    window.localStorage.setItem(TERMINAL_STORAGE_KEYS.subnavCollapsed, '1')
    const { result } = renderHook(() => useTerminalLayout())
    // 挂载 effect 后恢复为已折叠
    expect(result.current.subnavCollapsed).toBe(true)

    act(() => {
      result.current.toggleSubnav()
    })
    expect(result.current.subnavCollapsed).toBe(false)
    expect(window.localStorage.getItem(TERMINAL_STORAGE_KEYS.subnavCollapsed)).toBe('0')
  })
})
