'use client'

/**
 * 意向客户轮询 hook（设计稿 D5：15s 刷新 /meta，不做 SSE）。
 *
 * - document.hidden 时跳过本轮（暂停）；
 * - 页面重新可见 / 窗口 focus 时立即补拉一次；
 * - 防止上一轮未完成时并发请求。
 */
import { useEffect, useRef } from 'react'

import { INTENT_POLL_INTERVAL_MS } from './types'

export interface UseIntentPollingOptions {
  onPoll: () => void | Promise<void>
  intervalMs?: number
  enabled?: boolean
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

export function useIntentPolling({
  onPoll,
  intervalMs = INTENT_POLL_INTERVAL_MS,
  enabled = true,
}: UseIntentPollingOptions): void {
  const pollRef = useRef(onPoll)
  pollRef.current = onPoll

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    let cancelled = false
    let inFlight = false

    const run = () => {
      if (cancelled || inFlight) return
      if (typeof document !== 'undefined' && document.hidden) return
      inFlight = true
      try {
        const result = pollRef.current()
        if (isThenable(result)) {
          result.then(
            () => {
              inFlight = false
            },
            () => {
              inFlight = false
            }
          )
        } else {
          inFlight = false
        }
      } catch {
        inFlight = false
      }
    }

    const timer = window.setInterval(run, Math.max(1000, intervalMs))

    const onVisibilityChange = () => {
      if (!document.hidden) run()
    }
    const onFocus = () => run()

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, intervalMs])
}
