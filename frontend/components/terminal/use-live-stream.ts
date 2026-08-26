'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'

import { buildBackendClientHeaders } from '@/lib/backend-auth'
import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'

/**
 * BLF-839：今日出单流轮询（Inspector Live Stream 数据源）。
 *
 * - 端点 `GET /api/v1/order-info/live-stream`（Damon，PR #427）：口径与订单信息页一致，
 *   仅已计入销售行、排除 Cancelled、各站点本地「今天」窗口、is_current 报表版本；
 * - 30s 轮询（页面不可见时暂停，回前台立即拉一次）；
 * - 静默失败：失败/超时保留上次数据（或空），不打扰终端外壳的稳定观感；
 * - 仅 Inspector 打开时才发起轮询——关着面板不烧请求。
 */

/** 轮询间隔（ms）：30s 平衡实时性与后端压力 */
const LIVE_STREAM_POLL_MS = 30_000
/** 单次请求超时（ms）：超短，避免挂起占用 */
const LIVE_STREAM_TIMEOUT_MS = 8_000

interface LiveStreamApiResponse {
  items?: Array<{
    id: string
    title: string
    time_label?: string
    occurred_at?: string
  }>
}

/** UTC ISO → 中文相对时间文案（分钟/小时内/天级降级到绝对日期） */
function formatOccurredAt(occurredAt: string | undefined, fallback: string): string {
  if (!occurredAt) return fallback
  const then = new Date(occurredAt).getTime()
  if (Number.isNaN(then)) return fallback
  const diffMs = Date.now() - then
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const d = new Date(occurredAt)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

export function useLiveStream(enabled: boolean): LiveStreamItem[] {
  const { data: session } = useSession()
  const [items, setItems] = React.useState<LiveStreamItem[]>([])

  React.useEffect(() => {
    if (!enabled || !session) return

    let cancelled = false

    async function load() {
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), LIVE_STREAM_TIMEOUT_MS)
      try {
        const res = await fetch('/api/backend/api/v1/order-info/live-stream?limit=10', {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
          signal: ctrl.signal,
        })
        if (!res.ok) return // 静默失败：保留上次数据
        const data = (await res.json()) as LiveStreamApiResponse
        if (cancelled) return
        const rows = Array.isArray(data.items) ? data.items : []
        setItems(
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            timeLabel: formatOccurredAt(row.occurred_at, row.time_label ?? ''),
          }))
        )
      } catch {
        // 网络错误 / abort：静默保留旧数据
      } finally {
        clearTimeout(timeoutId)
      }
    }

    void load()
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, LIVE_STREAM_POLL_MS)

    // 回前台立即刷新一次
    function onVisible() {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, session])

  return items
}
