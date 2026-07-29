'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type ServerNotification,
} from '@/lib/notifications-api'

const POLL_MS = 30_000
const PAGE_SIZE = 20

export function useServerNotifications() {
  const [unreadCount, setUnreadCount] = useState(0)
  const [items, setItems] = useState<ServerNotification[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pollCount = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      setUnreadCount(await fetchUnreadCount())
    } catch {
      /* 静默：轮询失败不打扰用户 */
    }
  }, [])

  // 挂载后启动 30s 轮询；卸载清理
  useEffect(() => {
    void pollCount()
    timerRef.current = setInterval(pollCount, POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [pollCount])

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchNotifications({ page: 1, page_size: PAGE_SIZE })
      setItems(res.items)
    } catch {
      /* 静默 */
    } finally {
      setLoading(false)
    }
  }, [])

  // 面板打开时立即拉一次列表
  useEffect(() => {
    if (open) void loadList()
  }, [open, loadList])

  const markRead = useCallback(async (id: number) => {
    // 乐观更新
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    setUnreadCount((c) => Math.max(0, c - 1))
    try {
      await markNotificationRead(id)
    } catch {
      void pollCount()
    }
  }, [pollCount])

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadCount(0)
    try {
      await markAllNotificationsRead()
    } catch {
      void pollCount()
    }
  }, [pollCount])

  return { unreadCount, items, loading, open, setOpen, refresh: loadList, markRead, markAllRead }
}
