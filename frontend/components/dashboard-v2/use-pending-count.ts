'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import { buildBackendClientHeaders } from '@/lib/backend-auth'

/**
 * BLF-928：Dashboard 订单流面板的实时 pending 计数。
 *
 * - 复用 `GET /api/v1/order-info/overview`（与 usePendingOrders 同端点，只取 `total`）：
 *   请求带 order_statuses=Pending + 项目 + 日期窗口限定（BEL-422 护栏，绝不裸拉全时段）。
 * - 30s 轮询，仅 `document.visibilityState === 'visible'` 时真正发请求；回前台立即刷新
 *   （与 useLiveStream 相同的可见性策略，后台标签页零请求）。
 * - `refresh()` 供「展开/收起时立即刷新」与操作闭环后同步计数。
 * - 静默失败：失败/超时保留上次计数（面板徽标保持稳定观感，不闪错误）。
 *
 * 本 hook 与 `usePendingOrders` 分置：面板收起时只跑轻量计数轮询（page_size=1），
 * 展开时才加载完整列表，避免收起状态下拉 20 行/页的列表。
 */

/** 轮询间隔（ms）：30s 平衡实时性与后端压力 */
const PENDING_COUNT_POLL_MS = 30_000
/** 单次请求超时（ms）：超短，避免挂起占用 */
const PENDING_COUNT_TIMEOUT_MS = 8_000

interface PendingCountResponse {
  total?: number
}

export interface UsePendingCountParams {
  /** 关闭时挂起轮询（面板收起时由展开态列表的 total 承担计数，避免双请求） */
  enabled: boolean
  /** 项目 id 列表（空 = 不发请求，BEL-422 护栏） */
  projectIds: number[]
  /** PT 日期窗口（YYYY-MM-DD）；缺任一端不发请求 */
  dateFrom: string
  dateTo: string
}

export interface UsePendingCountResult {
  /** 服务端口径的 pending 订单数 */
  count: number
  loading: boolean
  /** 立即拉一次（展开/收起切换、操作闭环后同步计数） */
  refresh: () => void
}

export function usePendingCount({
  enabled,
  projectIds,
  dateFrom,
  dateTo,
}: UsePendingCountParams): UsePendingCountResult {
  const { data: session } = useSession()
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  // refreshKey 变化 → 立即重拉（不依赖 30s 轮询周期）
  const [refreshKey, setRefreshKey] = useState(0)

  const projectIdsKey = projectIds.join(',')
  const ready = enabled && projectIds.length > 0 && !!dateFrom && !!dateTo

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  useEffect(() => {
    if (!ready) {
      setCount(0)
      setLoading(false)
      return
    }

    let cancelled = false
    const ctrl = new AbortController()

    async function load() {
      if (cancelled) return
      setLoading(true)
      const timeoutId = setTimeout(() => ctrl.abort(), PENDING_COUNT_TIMEOUT_MS)
      try {
        const params = new URLSearchParams()
        projectIds.forEach((id) => params.append('project_ids', String(id)))
        params.set('order_statuses', 'Pending')
        params.set('date_from', dateFrom)
        params.set('date_to', dateTo)
        params.set('page', '1')
        params.set('page_size', '1')
        const res = await fetch(`/api/backend/api/v1/order-info/overview?${params.toString()}`, {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
          signal: ctrl.signal,
        })
        if (!res.ok) return // 静默失败：保留上次计数
        const data = (await res.json()) as PendingCountResponse
        if (cancelled) return
        setCount(typeof data.total === 'number' ? data.total : 0)
      } catch {
        // 网络错误 / abort：静默保留旧计数
      } finally {
        clearTimeout(timeoutId)
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, PENDING_COUNT_POLL_MS)

    // 回前台立即刷新一次
    function onVisible() {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      ctrl.abort()
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectIds 用序列化 key，refreshKey 驱动立即刷新
  }, [ready, projectIdsKey, dateFrom, dateTo, session, refreshKey])

  return { count, loading, refresh }
}
