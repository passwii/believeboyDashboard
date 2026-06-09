'use client'

import * as React from 'react'

const STORAGE_KEY = 'believeboy-sidebar-pinned-group-v1'
const HOVER_LEAVE_DELAY_MS =150

/**
 * Sidebar两层结构的核心状态机。
 *
 *状态：
 * - hoveredGroupId:鼠标当前悬停的分组（临时）
 * - pinnedGroupId: 用户点击锁定的分组（持久）
 *
 *派生：
 * - activeGroupId = hoveredGroupId ?? pinnedGroupId ?? (pathname命中组)
 *
 *持久化：
 * - pinnedGroupId存到 sessionStorage（关闭标签页重置）
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
 const [mounted, setMounted] = React.useState(false)
 const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

 //挂载后从 sessionStorage恢复 pinned
 React.useEffect(() => {
 try {
 const raw = window.sessionStorage.getItem(STORAGE_KEY)
 if (raw) setPinnedGroupId(raw)
 } catch {
 // ignore
 }
 setMounted(true)
 }, [])

 // pathname变化时，如果当前无 pinned 且无 hover，则自动跟随 pathname
 const pathnameGroupId = findGroupByPathname(pathname)
 React.useEffect(() => {
 if (!mounted) return
 if (pinnedGroupId) return
 if (hoveredGroupId) return
 // pathnameGroupId 仅作 fallback，不显式设置 hovered（保持 null 让 activeGroupId派生使用）
 }, [pathname, pathnameGroupId, mounted, pinnedGroupId, hoveredGroupId])

 //清理 leave timer
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

 const clickToggle = React.useCallback(
 (id: string) => {
 setPinnedGroupId((prev) => {
 const next = prev === id ? null : id
 try {
 if (next) window.sessionStorage.setItem(STORAGE_KEY, next)
 else window.sessionStorage.removeItem(STORAGE_KEY)
 } catch {
 // ignore
 }
 return next
 })
 },
 [],
 )

 const closePanel = React.useCallback(() => {
 setPinnedGroupId(null)
 setHoveredGroupId(null)
 try {
 window.sessionStorage.removeItem(STORAGE_KEY)
 } catch {
 // ignore
 }
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
