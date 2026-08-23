'use client'

import { useCallback, useEffect, useState } from 'react'

import { TERMINAL_STORAGE_KEYS } from '@/components/terminal/terminal-constants'

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // 写入失败静默降级：仅影响下次进入时的记忆
  }
}

export interface UseTerminalLayoutResult {
  subnavCollapsed: boolean
  toggleSubnav: () => void
  inspectorOpen: boolean
  toggleInspector: () => void
}

/**
 * Terminal 外壳布局状态（BLF-809）：
 * - SubNav 折叠 / Inspector 开关，均持久化到 localStorage；
 * - Cmd/Ctrl+B 切换右侧 Inspector（规范指定快捷键）。
 */
export function useTerminalLayout(): UseTerminalLayoutResult {
  const [subnavCollapsed, setSubnavCollapsed] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  useEffect(() => {
    setSubnavCollapsed(readFlag(TERMINAL_STORAGE_KEYS.subnavCollapsed, false))
    setInspectorOpen(readFlag(TERMINAL_STORAGE_KEYS.inspectorOpen, false))
  }, [])

  const toggleSubnav = useCallback(() => {
    setSubnavCollapsed((prev) => {
      const next = !prev
      writeFlag(TERMINAL_STORAGE_KEYS.subnavCollapsed, next)
      return next
    })
  }, [])

  const toggleInspector = useCallback(() => {
    setInspectorOpen((prev) => {
      const next = !prev
      writeFlag(TERMINAL_STORAGE_KEYS.inspectorOpen, next)
      return next
    })
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'b' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setInspectorOpen((prev) => {
          const next = !prev
          writeFlag(TERMINAL_STORAGE_KEYS.inspectorOpen, next)
          return next
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return { subnavCollapsed, toggleSubnav, inspectorOpen, toggleInspector }
}
