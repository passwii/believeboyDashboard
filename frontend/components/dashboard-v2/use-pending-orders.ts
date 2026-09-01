'use client'

import { useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'

import { buildBackendClientHeaders } from '@/lib/backend-auth'

/**
 * BLF-927：Dashboard 订单流面板的订单级 pending 列表数据源。
 *
 * - 端点 `GET /api/v1/order-info/overview?order_statuses=Pending&...`（复用 BLF-157 单请求模式，
 *   列表+统计合一；本 stage 零后端改动）。
 * - BEL-422 护栏：请求必须带项目（autoselect）+ 日期窗口限定，绝不全项目全时间段裸拉 ——
 *   `projectIds` / `dateFrom` / `dateTo` 任一为空时 hook 不发请求。
 * - 仅 `enabled`（面板展开）时请求；收起/入参变化即 abort 在飞请求（参考 order-info 页
 *   `fetchAbortRef` 模式），杜绝并发堆积。
 * - 分页："加载更多"模式 —— hook 维护 page，新页数据 append（去重按 id），reset 时机 =
 *   enabled/projectIds/dateFrom/dateTo 变化。
 * - BLF-928：展开态 30s 可见感知轮询（仅 page=1 时刷新首页，不打断用户翻页）；
 *   失败/超时静默保留上次列表。
 */

/** 订单级 pending 行（overview items 的子集字段） */
export interface PendingOrderItem {
  id: number
  amazon_order_id: string
  sku: string | null
  asin: string | null
  product_name: string | null
  quantity: number
  item_price: number
  shipping_price: number
  currency: string | null
  country: string
  purchase_at_utc: string
  purchase_at_pt: string
  order_status: string
}

interface PendingOrdersResponse {
  items?: PendingOrderItem[]
  total?: number
}

/** 面板一页条数：320px 宽高密度表，20 行/页平衡首屏与滚动 */
export const PENDING_ORDERS_PAGE_SIZE = 20

/** 展开态轮询间隔（ms）：30s 与 live-stream / pending-count 同节奏 */
export const PENDING_ORDERS_POLL_MS = 30_000

export interface UsePendingOrdersParams {
  /** 仅展开时轮询/请求 */
  enabled: boolean
  /** 项目 id 列表（空 = 全项目；护栏要求非空才发请求） */
  projectIds: number[]
  /** PT 日期窗口（YYYY-MM-DD）；缺任一端不发请求 */
  dateFrom: string
  dateTo: string
}

export interface UsePendingOrdersResult {
  items: PendingOrderItem[]
  /** 服务端口径的总条数（含未加载页） */
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  /** BLF-928：立即刷新首页（展开/收起时用） */
  refresh: () => void
}

export function usePendingOrders({
  enabled,
  projectIds,
  dateFrom,
  dateTo,
}: UsePendingOrdersParams): UsePendingOrdersResult {
  const { data: session } = useSession()
  const [items, setItems] = useState<PendingOrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAbortRef = useRef<AbortController | null>(null)

  // 入参序列化：任一变化即回到第 1 页重新拉
  const projectIdsKey = projectIds.join(',')
  const ready = enabled && projectIds.length > 0 && !!dateFrom && !!dateTo

  // BLF-928：30s 轮询时静默刷新首页（不闪 loading），用 ref 桥接（避免进 effect 依赖）
  const silentRefreshRef = useRef(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!ready) {
      // 面板收起 / 护栏未满足：abort 在飞请求并清空列表
      fetchAbortRef.current?.abort()
      fetchAbortRef.current = null
      setItems([])
      setTotal(0)
      setPage(1)
      setLoading(false)
      setLoadingMore(false)
      setError(null)
      return
    }

    // enabled 之外的入参变化 → 回到第 1 页（loadMore 触发的 page 变化除外）
    setPage(1)
  }, [ready, projectIdsKey, dateFrom, dateTo])

  useEffect(() => {
    if (!ready) return

    // 发新请求前 abort 上一次在飞请求（order-info 页 fetchAbortRef 模式）
    fetchAbortRef.current?.abort()
    const ctrl = new AbortController()
    fetchAbortRef.current = ctrl

    const isFirstPage = page === 1
    const isSilent = silentRefreshRef.current
    silentRefreshRef.current = false
    if (isFirstPage && !isSilent) setLoading(true)
    else if (!isFirstPage) setLoadingMore(true)
    if (isFirstPage) setError(null)

    async function load() {
      try {
        const params = new URLSearchParams()
        projectIds.forEach((id) => params.append('project_ids', String(id)))
        params.append('order_statuses', 'Pending')
        params.set('date_from', dateFrom)
        params.set('date_to', dateTo)
        params.set('page', String(page))
        params.set('page_size', String(PENDING_ORDERS_PAGE_SIZE))
        params.set('sort_by', 'purchase_at_pt')
        params.set('sort_dir', 'desc')
        const res = await fetch(
          `/api/backend/api/v1/order-info/overview?${params.toString()}`,
          {
            cache: 'no-store',
            headers: buildBackendClientHeaders(session),
            signal: ctrl.signal,
          }
        )
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(txt || `待处理订单加载失败 (${res.status})`)
        }
        const data = (await res.json()) as PendingOrdersResponse
        if (ctrl.signal.aborted) return
        const rows = Array.isArray(data.items) ? data.items : []
        const serverTotal = typeof data.total === 'number' ? data.total : 0
        setItems((prev) => {
          if (page === 1) return rows
          // append 模式按 id 去重（服务端分页位移保护）
          const seen = new Set(prev.map((it) => it.id))
          return [...prev, ...rows.filter((it) => !seen.has(it.id))]
        })
        setTotal(serverTotal)
      } catch (e) {
        if (ctrl.signal.aborted) return
        setError(e instanceof Error ? e.message : '待处理订单加载失败')
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    }

    void load()

    return () => {
      ctrl.abort()
    }
    // session 变化会触发重拉（带上 X-Operator 头）；ready false→true 首拉；refreshKey 驱动 30s 轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectIds 用序列化 key，page 由 loadMore/reset 驱动
  }, [ready, page, projectIdsKey, dateFrom, dateTo, session, refreshKey])

  // BLF-928：展开态 30s 可见感知轮询（仅 page=1 时刷新首页，不打断用户翻页）
  const pageRef = useRef(page)
  pageRef.current = page
  useEffect(() => {
    if (!ready) return
    const poll = () => {
      if (pageRef.current === 1 && document.visibilityState === 'visible') {
        silentRefreshRef.current = true
        setRefreshKey((k) => k + 1)
      }
    }
    const intervalId = setInterval(poll, PENDING_ORDERS_POLL_MS)
    function onVisible() {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ready])

  // 卸载时 abort
  useEffect(() => {
    return () => {
      fetchAbortRef.current?.abort()
    }
  }, [])

  const hasMore = items.length < total

  const loadMore = () => {
    setPage((p) => p + 1)
  }

  const refresh = () => {
    setPage(1)
    silentRefreshRef.current = true
    setRefreshKey((k) => k + 1)
  }

  return { items, total, loading, loadingMore, error, hasMore, loadMore, refresh }
}
