'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCheck, X } from 'lucide-react'

import { useServerNotifications } from '@/components/notifications'
import type { ServerNotification } from '@/lib/notifications-api'
import { WarmButton, WarmIconButton } from '../controls'

export interface WarmNotificationPanelProps {
  open: boolean
  onClose: () => void
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function WarmNotificationPanel({ open, onClose }: WarmNotificationPanelProps) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { unreadCount, items, loading, markRead, markAllRead } = useServerNotifications()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
  }, [open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', handleCancel)
    return () => dialog.removeEventListener('cancel', handleCancel)
  }, [onClose])

  const handleOpenNotification = (notification: ServerNotification) => {
    if (!notification.read) void markRead(notification.id)
    const link = notification.data?.link
    if (!link) return
    onClose()
    router.push(link)
  }

  return (
    <dialog
      ref={dialogRef}
      className="warm-ledger__notification-dialog"
      aria-labelledby="warm-ledger-notification-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <header className="warm-ledger__notification-header">
        <div className="min-w-0">
          <h2 id="warm-ledger-notification-title" className="warm-ledger__notification-title">
            通知
          </h2>
          <p className="warm-ledger__notification-meta">
            {unreadCount > 0 ? `${unreadCount} 条未读` : '暂无未读'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <WarmButton
            variant="quiet"
            disabled={unreadCount === 0}
            onClick={() => void markAllRead()}
          >
            <CheckCheck aria-hidden="true" className="h-4 w-4" />
            全部已读
          </WarmButton>
          <WarmIconButton aria-label="关闭通知" onClick={onClose}>
            <X aria-hidden="true" />
          </WarmIconButton>
        </div>
      </header>

      <div className="warm-ledger__notification-list">
        {loading ? (
          <p className="warm-ledger__notification-state" role="status">
            正在读取通知
          </p>
        ) : items.length === 0 ? (
          <p className="warm-ledger__notification-state">暂无通知</p>
        ) : (
          <ul aria-label="通知列表">
            {items.map((notification) => (
              <li key={notification.id}>
                <WarmButton
                  variant="quiet"
                  className="warm-ledger__notification-item"
                  data-unread={notification.read ? undefined : 'true'}
                  onClick={() => handleOpenNotification(notification)}
                >
                  <span
                    className="warm-ledger__notification-unread"
                    aria-hidden={notification.read || undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="warm-ledger__notification-item-title">
                      {notification.title}
                    </span>
                    {notification.message ? (
                      <span className="warm-ledger__notification-item-message">
                        {notification.message}
                      </span>
                    ) : null}
                    <span className="warm-ledger__notification-item-time">
                      {timeAgo(notification.created_at)}
                    </span>
                  </span>
                </WarmButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
