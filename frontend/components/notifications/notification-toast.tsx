'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react'
import { Notification, NotificationType } from '@/lib/notifications'
import { useNotifications } from './notifications-context'
import { cn } from '@/lib/utils'
import { BLUR, DURATION, EASE, SCALE } from '@/lib/motion/tokens'

/** 上浮行程，对应 transitions.dev `--toast-distance`（16px）——
 * 它不在共享的 `--distance-*` 档位（4/6/8/12/30）里，属 toast 自己的语义变量，故保留字面量。 */
const TOAST_DISTANCE = 16

const typeConfig: Record<
  NotificationType,
  { icon: typeof CheckCircle2; className: string; iconClassName: string }
> = {
  success: {
    icon: CheckCircle2,
    // BLF-893：toast 终端化——零圆角、term 语义色，success 走 term-pos 弱底。
    className: 'border-term-pos/30 bg-term-pos/5',
    iconClassName: 'text-term-pos',
  },
  error: {
    icon: XCircle,
    className: 'border-term-neg/30 bg-term-neg/5',
    iconClassName: 'text-term-neg',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-term-warn/30 bg-term-warn/5',
    iconClassName: 'text-term-warn',
  },
  info: {
    icon: Info,
    // BLF-893：info 走 term-accent 弱底，去掉旧 blue-200/blue-50 旧式双色。
    className: 'border-term-accent/30 bg-term-accent/5',
    iconClassName: 'text-term-accent',
  },
}

const typeTextClassName: Record<NotificationType, string> = {
  success: 'text-term-pos',
  error: 'text-term-neg',
  warning: 'text-term-warn',
  info: 'text-term-text',
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
      /* transitions.dev 22-toast：从下方向上浮 + 淡入 + 交叉模糊 + 微缩；开启走慢钟、
       * 退场走快钟——--toast-open(350ms)=DURATION.medium、--toast-close(250ms)=DURATION.fast、
       * --toast-distance(16px)、--toast-scale(0.97)=SCALE.medium、--toast-blur(2px)=BLUR.small、
       * --toast-ease=EASE.smoothOut。旧实现是 x:40 的横向滑入 + scale 0.95，按 snippet 改为垂直上浮。 */
      initial={{ opacity: 0, y: TOAST_DISTANCE, scale: SCALE.medium, filter: `blur(${BLUR.small}px)` }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{
        opacity: 0,
        y: TOAST_DISTANCE,
        scale: SCALE.medium,
        filter: `blur(${BLUR.small}px)`,
        transition: { duration: DURATION.fast, ease: EASE.smoothOut },
      }}
      transition={{ duration: DURATION.medium, ease: EASE.smoothOut }}
      onClick={() => notification.onClick?.()}
      className={cn(
        // BLF-893：toast 终端化——零圆角、term 令牌、无阴影；保留 backdrop-blur 维持半透明提示感。
        'pointer-events-auto flex w-72 items-start gap-3 rounded-none border bg-term-bg/95 px-4 py-3 backdrop-blur-sm',
        notification.onClick ? 'cursor-pointer' : undefined,
        config.className
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.iconClassName)} />
      <div className="min-w-0 flex-1">
        <p
          className={cn('font-mono text-xs leading-5', typeTextClassName[notification.type])}
        >
          {notification.title}
        </p>
        {notification.message ? (
          <p
            className={cn(
              'mt-0.5 font-mono text-[11px] leading-4 opacity-80',
              typeTextClassName[notification.type]
            )}
          >
            {notification.message}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          dismissToast(notification.id)
        }}
        className={cn(
          'mt-0.5 shrink-0 rounded-none p-0.5 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:border-term-border-strong',
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
  // Portal 到 document.body：与页面过渡的 AnimatePresence 树完全隔离，
  // 后端报错 / 通知出现时绝不打断路由切换动效；也避免被祖先 overflow/transform 裁剪。
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return createPortal(
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
    </div>,
    document.body
  )
}
