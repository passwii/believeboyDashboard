'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type ServerNotification,
} from '@/lib/notifications-api'

const POLL_MS = 30_000
const PAGE_SIZE = 20

interface ServerNotificationsValue {
  unreadCount: number
  items: ServerNotification[]
  loading: boolean
  refresh: () => Promise<void>
  markRead: (id: number) => Promise<void>
  markAllRead: () => Promise<void>
}

const ServerNotificationsContext = createContext<ServerNotificationsValue | null>(null)

/**
 * 服务端站内通知的全局状态（轮询 + 未读数 + 列表）。
 *
 * 背景（BLF-603）：通知入口从正文右上角浮动铃铛迁移到 sidebar 底部 profile 面板后，
 * 通知 UI 只在面板打开时才可见，但未读徽标（user chip 红点 / 面板内徽标）需要
 * 在面板未打开时也是实时的。因此把原先 NotificationBell 内部的轮询状态提升为
 * 全局 Provider，挂载在 dashboard layout（始终挂载 → 始终 30s 轮询），
 * 消费方（SidebarUserPanel / SidebarIconRail / 移动端 Sheet）从 context 读取。
 *
 * 性能要点：
 * - Provider 放在 layout 最外层，一次挂载、一次轮询，不再随面板开合反复启停。
 * - 列表数据（items）仅在打开通知视图时通过 refresh() 拉取，避免全局常驻 20 条数据。
 */
export function ServerNotificationsProvider({ children }: { children: React.ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0)
  const [items, setItems] = useState<ServerNotification[]>([])
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pollCount = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      setUnreadCount(await fetchUnreadCount())
    } catch {
      /* 静默：轮询失败不打扰用户 */
    }
  }, [])

  // 挂载后启动 30s 轮询；卸载清理（layout 级 Provider，实际常驻）
  useEffect(() => {
    void pollCount()
    timerRef.current = setInterval(pollCount, POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [pollCount])

  const refresh = useCallback(async () => {
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

  const markRead = useCallback(
    async (id: number) => {
      // 乐观更新
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
      setUnreadCount((c) => Math.max(0, c - 1))
      try {
        await markNotificationRead(id)
      } catch {
        void pollCount()
      }
    },
    [pollCount]
  )

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadCount(0)
    try {
      await markAllNotificationsRead()
    } catch {
      void pollCount()
    }
  }, [pollCount])

  return (
    <ServerNotificationsContext.Provider
      value={{ unreadCount, items, loading, refresh, markRead, markAllRead }}
    >
      {children}
    </ServerNotificationsContext.Provider>
  )
}

export function useServerNotifications(): ServerNotificationsValue {
  const ctx = useContext(ServerNotificationsContext)
  if (!ctx) {
    throw new Error('useServerNotifications must be used within ServerNotificationsProvider')
  }
  return ctx
}
