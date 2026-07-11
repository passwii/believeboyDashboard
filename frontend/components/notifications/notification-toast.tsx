'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react'
import { Notification, NotificationType } from '@/lib/notifications'
import { useNotifications } from './notifications-context'
import { cn } from '@/lib/utils'
import { DURATION } from '@/lib/motion/tokens'

const typeConfig: Record<
  NotificationType,
  { icon: typeof CheckCircle2; className: string; iconClassName: string }
> = {
  success: {
    icon: CheckCircle2,
    className:
      'border-emerald-200 bg-emerald-50 dark:border-emerald-900/70 dark:bg-emerald-950/40',
    iconClassName: 'text-emerald-500',
  },
  error: {
    icon: XCircle,
    className:
      'border-rose-200 bg-rose-50 dark:border-rose-900/70 dark:bg-rose-950/40',
    iconClassName: 'text-rose-500',
  },
  warning: {
    icon: AlertTriangle,
    className:
      'border-amber-200 bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/40',
    iconClassName: 'text-amber-500',
  },
  info: {
    icon: Info,
    className:
      'border-blue-200 bg-blue-50 dark:border-blue-900/70 dark:bg-blue-950/40',
    iconClassName: 'text-blue-500',
  },
}

const typeTextClassName: Record<NotificationType, string> = {
  success: 'text-emerald-700 dark:text-emerald-200',
  error: 'text-rose-700 dark:text-rose-200',
  warning: 'text-amber-700 dark:text-amber-200',
  info: 'text-blue-700 dark:text-blue-200',
}

interface ToastItemProps {
  notification: Notification
}

function ToastItem({ notification }: ToastItemProps) {
  const { dismissToast } = useNotifications()
  const config = typeConfig[notification.type]
  const Icon = config.icon

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ duration: DURATION.springPress, ease: 'easeOut' }}
      className={cn(
        'pointer-events-auto flex w-72 items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur-sm',
        config.className
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.iconClassName)} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-semibold leading-snug', typeTextClassName[notification.type])}>
          {notification.title}
        </p>
        {notification.message ? (
          <p
            className={cn(
              'mt-0.5 text-xs leading-relaxed opacity-80',
              typeTextClassName[notification.type]
            )}
          >
            {notification.message}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(notification.id)}
        className={cn(
          'mt-0.5 shrink-0 rounded-md p-0.5 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          typeTextClassName[notification.type]
        )}
        aria-label="关闭通知"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  )
}

export function NotificationToastContainer() {
  const { toasts } = useNotifications()
  return (
    <div
      aria-live="polite"
      aria-label="通知"
      className="pointer-events-none fixed right-4 top-16 z-[100] flex flex-col gap-2"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} notification={toast} />
        ))}
      </AnimatePresence>
    </div>
  )
}
