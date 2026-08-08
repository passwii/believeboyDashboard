'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useNotifications } from '@/components/notifications'

/**
 * 7 天无跟进提醒（P9-1, BLF-539）：SSE 订阅 GET /crm/follow-ups/reminders/stream，
 * 收到 event: follow_up_reminder → 站内 warning toast；点击跳客户/线索列表。
 *
 * - 连接复用 TaskReminderToast 模式：EventSource + 指数退避重连（1s→30s 封顶）。
 * - 会话去重：sessionStorage 记录本次会话已提醒的 (entity_type, entity_id)
 *   （SSE 重连会重放，用本地标记保证同会话同一实体只弹一次）。
 * - 须置于 NotificationsProvider 之内（CRM layout 内挂载）。
 */
const STREAM_URL = '/api/backend/api/v1/crm/follow-ups/reminders/stream'
const DEDUP_PREFIX = 'crm-follow-up-reminder:'
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

type FollowUpReminderPayload = {
  entity_type: 'customer' | 'lead'
  entity_id: number
  name: string
  days: number
}

const ENTITY_LABEL: Record<FollowUpReminderPayload['entity_type'], string> = {
  customer: '客户',
  lead: '线索',
}

export function FollowUpReminderToast() {
  const { notify } = useNotifications()
  const router = useRouter()
  const retriesRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleReminder = useCallback(
    (payload: FollowUpReminderPayload) => {
      if (typeof window === 'undefined') return
      const flag = `${DEDUP_PREFIX}${payload.entity_type}:${payload.entity_id}`
      if (sessionStorage.getItem(flag)) return
      sessionStorage.setItem(flag, '1')
      const label = ENTITY_LABEL[payload.entity_type] ?? '客户'
      const target = payload.entity_type === 'lead' ? '/dashboard/crm/leads' : '/dashboard/crm/customers'
      notify({
        type: 'warning',
        title: '跟进提醒',
        message: `${label}「${payload.name}」已 ${payload.days} 天无跟进`,
        onClick: () => router.push(target),
      })
    },
    [notify, router]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    let es: EventSource | null = null

    const connect = () => {
      es = new EventSource(STREAM_URL)

      es.addEventListener('follow_up_reminder', (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as FollowUpReminderPayload
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
