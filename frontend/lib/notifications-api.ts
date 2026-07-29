/**
 * 站内通知 API 客户端。
 * 走代理 /api/backend/api/v1/notifications/*，代理注入 X-User-Id。
 */

const BASE = '/api/backend/api/v1/notifications'

export interface ServerNotification {
  id: number
  user_id: number
  type: string
  title: string
  message: string | null
  data: { alert_event_id?: number; project_id?: number; severity?: string; link?: string } | null
  read: boolean
  read_at: string | null
  created_at: string
}

export interface NotificationListResponse {
  items: ServerNotification[]
  total: number
  page: number
  page_size: number
}

export interface NotificationQuery {
  type?: string
  read?: boolean
  page: number
  page_size: number
}

export function buildNotificationsQuery(q: NotificationQuery): string {
  const sp = new URLSearchParams()
  if (q.type) sp.set('type', q.type)
  if (q.read != null) sp.set('read', String(q.read))
  sp.set('page', String(q.page))
  sp.set('page_size', String(q.page_size))
  return sp.toString()
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Notifications API ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await fetch(`${BASE}/unread-count`)
  const data = await jsonOrThrow<{ count: number }>(res)
  return data.count
}

export async function fetchNotifications(
  params: NotificationQuery
): Promise<NotificationListResponse> {
  const res = await fetch(`${BASE}?${buildNotificationsQuery(params)}`)
  return jsonOrThrow<NotificationListResponse>(res)
}

export async function markNotificationRead(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}/read`, { method: 'POST' })
  if (!res.ok) throw new Error(`mark read ${res.status}`)
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await fetch(`${BASE}/read-all`, { method: 'POST' })
  if (!res.ok) throw new Error(`read-all ${res.status}`)
}

export async function deleteNotification(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete ${res.status}`)
}
