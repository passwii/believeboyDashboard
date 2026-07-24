'use client'

import { useEffect, useRef } from 'react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'

/**
 * 进入 CRM 时检查当前用户名下逾期未跟进数，>0 则站内 toast 提醒一次。
 * sessionStorage 标记防同一会话重复弹（逾期按日期判定，一天内不变，每会话查一次即可）。
 * 须置于 CrmClientProvider 与 NotificationsProvider 之内。
 */
const TOAST_FLAG = 'crm-overdue-toasted'

export function FollowUpToast() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const checked = useRef(false)

  useEffect(() => {
    if (checked.current) return
    checked.current = true
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem(TOAST_FLAG)) return
    client
      .listFollowUps('mine')
      .then((groups) => {
        if (groups.overdueCount > 0) {
          notify({
            type: 'warning',
            title: `${groups.overdueCount} 条逾期未跟进`,
            message: '前往「待跟进」查看今天该跟谁',
          })
        }
      })
      .catch(() => {
        // 静默：提醒失败不打扰用户
      })
      .finally(() => {
        sessionStorage.setItem(TOAST_FLAG, '1')
      })
  }, [client, notify])

  return null
}
