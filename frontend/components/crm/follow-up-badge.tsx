'use client'

import { useEffect, useState } from 'react'

/**
 * 待跟进逾期数红点 badge（sidebar「待跟进」子项）。
 *
 * 全局 sidebar 在 CrmClientProvider 之外，故不走 useCrmClient，直接经 Next 代理
 * `/api/backend/v1/crm/follow-ups`（代理按会话注入鉴权头）取当前用户 scope=mine 的
 * overdue_count。60s 轮询；失败静默（不影响 sidebar 渲染）。
 */
const POLL_MS = 60000

export function CrmFollowUpBadge() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/api/backend/v1/crm/follow-ups?scope=mine', {
          headers: { 'Content-Type': 'application/json' },
        })
        if (!res.ok) return
        const data = (await res.json()) as { overdue_count?: number }
        if (!cancelled) setCount(typeof data.overdue_count === 'number' ? data.overdue_count : 0)
      } catch {
        // 静默：badge 失败不阻断 sidebar
      }
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (count <= 0) return null
  return (
    <span
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-term-neg px-1 text-[0.65rem] font-semibold leading-none text-white"
      aria-label={`${count} 条逾期未跟进`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
