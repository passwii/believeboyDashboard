export type NotificationType = 'success' | 'error' | 'warning' | 'info'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message?: string
  createdAt: number
  read: boolean
  skipHistory?: boolean
  /** 点击 toast 时的回调（如跳转相关页面）；不传则点击无动作 */
  onClick?: () => void
}

export type NotifyOptions = Omit<Notification, 'id' | 'createdAt' | 'read'>

export const NOTIFICATION_HISTORY_KEY = 'believeboy-dashboard:notifications:history'
export const NOTIFICATION_CHANGE_EVENT = 'believeboy-dashboard:notifications:change'

export const CHANGELOG_READ_KEY = 'believeboy-dashboard:changelog:read-id'

export const DEFAULT_NOTIFY_DURATION = 4000 // ms
export const MAX_HISTORY_SIZE = 100
