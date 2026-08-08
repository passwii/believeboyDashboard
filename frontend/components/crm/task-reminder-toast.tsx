'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useNotifications } from '@/components/notifications'

/**
 * 任务到期提醒（BLF-513, P7-4）：SSE 订阅 GET /crm/tasks/reminders/stream，
 * 收到 event: task_reminder → 站内 warning toast；点击 toast 跳 /dashboard/crm/tasks。
 *
 * - 连接复用 useOfficeStream 模式：EventSource + 指数退避重连（1s→30s 封顶）。
 * - 会话去重：sessionStorage 记录本次会话已提醒的 task_id（SSE 重连会重放，
 *   用本地标记保证同会话同一任务只弹一次，仿 FollowUpToast 的 TOAST_FLAG 模式）。
 * - 须置于 NotificationsProvider 之内（CRM layout 内挂载）。
 */
const STREAM_URL = '/api/backend/api/v1/crm/tasks/reminders/stream'
const DEDUP_PREFIX = 'crm-task-reminder:'
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

type TaskReminderPayload = {
  task_id: number
  title: string
  due_date: string | null
}

export function TaskReminderToast() {
  const { notify } = useNotifications()
  const router = useRouter()
  const retriesRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleReminder = useCallback(
    (payload: TaskReminderPayload) => {
      if (typeof window === 'undefined') return
      const flag = `${DEDUP_PREFIX}${payload.task_id}`
      if (sessionStorage.getItem(flag)) return
      sessionStorage.setItem(flag, '1')
      notify({
        type: 'warning',
        title: '任务即将到期',
        message: `「${payload.title}」还剩不到 24 小时`,
        onClick: () => router.push('/dashboard/crm/tasks'),
      })
    },
    [notify, router]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    let es: EventSource | null = null

    const connect = () => {
      es = new EventSource(STREAM_URL)

      es.addEventListener('task_reminder', (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as TaskReminderPayload
          handleReminder(payload)
        } catch {
          // 静默：解析失败不打扰用户
        }
      })

      es.onopen = () => {
        retriesRef.current = 0 // 连接成功，重置退避
      }

      es.onerror = () => {
        es?.close()
        // 指数退避重连
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** retriesRef.current, BACKOFF_MAX_MS)
        retriesRef.current += 1
        timerRef.current = setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      es?.close()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [handleReminder])

  return null
}
