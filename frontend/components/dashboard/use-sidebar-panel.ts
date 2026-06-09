'use client'

import * as React from 'react'

const HOVER_LEAVE_DELAY_MS = 150

/**
 * Sidebar 两层结构的核心状态机。
 *
 * 状态：
 * - hoveredGroupId: 鼠标当前悬停的分组（临时）
 * - pinnedGroupId: 用户通过 Pin 按钮显式锁定的分组（不持久化）
 *
 * 派生：
 * - activeGroupId = hoveredGroupId ?? pinnedGroupId ?? (pathname 命中组)
 *
 * 行为要点：
 * - 点击一级 icon 不再做任何事（无 onClick），鼠标 hover 才打开 panel。
 * - Pin 状态仅由 panel 顶部的 Pin 按钮触发，不写入 sessionStorage。
 * - 鼠标离开整个 sidebar region（rail + panel）后关闭 panel（150ms 延迟）。
 */
export interface SidebarPanelState {
  hoveredGroupId: string | null
  pinnedGroupId: string | null
  activeGroupId: string | null
  isOpen: boolean
}

export interface SidebarPanelActions {
  hoverEnter: (id: string) => void
  hoverLeave: () => void
  clickToggle: (id: string) => void
  closePanel: () => void
}

export function useSidebarPanel(
  pathname: string,
  findGroupByPathname: (pathname: string) => string | undefined,
): SidebarPanelState & SidebarPanelActions {
  const [hoveredGroupId, setHoveredGroupId] = React.useState<string | null>(null)
  const [pinnedGroupId, setPinnedGroupId] = React.useState<string | null>(null)
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const pathnameGroupId = findGroupByPathname(pathname)

  // 清理 leave timer
  React.useEffect(() => {
    return () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    }
  }, [])

  const hoverEnter = React.useCallback((id: string) => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
    setHoveredGroupId(id)
  }, [])

  const hoverLeave = React.useCallback(() => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    leaveTimerRef.current = setTimeout(() => {
      setHoveredGroupId(null)
      leaveTimerRef.current = null
    }, HOVER_LEAVE_DELAY_MS)
  }, [])

  // 仅由 panel 顶部 Pin 按钮调用：toggle pinnedGroupId，无任何持久化副作用。
  const clickToggle = React.useCallback((id: string) => {
    setPinnedGroupId((prev) => (prev === id ? null : id))
  }, [])

  const closePanel = React.useCallback(() => {
    setPinnedGroupId(null)
    setHoveredGroupId(null)
  }, [])

  const activeGroupId = hoveredGroupId ?? pinnedGroupId ?? pathnameGroupId ?? null
  const isOpen = activeGroupId !== null

  return {
    hoveredGroupId,
    pinnedGroupId,
    activeGroupId,
    isOpen,
    hoverEnter,
    hoverLeave,
    clickToggle,
    closePanel,
  }
}