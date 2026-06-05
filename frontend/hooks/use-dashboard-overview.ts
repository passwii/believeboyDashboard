'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useApiQuery } from '@/lib/hooks/use-api-query'
import { useNotifications } from '@/components/notifications'

export interface DashboardOverviewSalesSnapshot {
  today_order_qty: number
  today_sales_amount: number
  prev_order_qty: number
  prev_sales_amount: number
  order_qty_change_pct: number
  sales_change_pct: number
  change_type_order_qty: 'up' | 'down' | 'neutral'
  change_type_sales: 'up' | 'down' | 'neutral'
}

export interface DashboardOverviewTrendItem {
  date: string
  order_qty: number
  sales_amount: number
}

export interface DashboardOverviewInventory {
  sku_count: number
  out_of_stock_count: number
  available_qty: number
}

export interface DashboardOverviewShipments {
  in_transit_count: number
  in_transit_qty: number
}

export interface DashboardOverviewReturns {
  total_returns: number
  total_quantity: number
  return_rate: number
  top_reason: string | null
}

export interface DashboardOverviewAds {
  period_spend: number
  period_sales: number
  period_roas: number
  period_acos: number
  period_ctr: number
  period_impressions: number
  period_clicks: number
  period_orders: number
}

export interface SkuSalesDetailItem {
  sku: string
  product_name: string | null
  quantity: number
  sales_amount: number
}

export interface DashboardOverviewResponse {
  project_ids: number[]
  project_names: string[]
  country: string
  days: number
  server_time: string
  sales: DashboardOverviewSalesSnapshot
  sales_trend: DashboardOverviewTrendItem[]
  inventory: DashboardOverviewInventory
  shipments: DashboardOverviewShipments
  returns: DashboardOverviewReturns
  ads: DashboardOverviewAds
  sku_sales_detail: SkuSalesDetailItem[]
}

interface UseDashboardOverviewOptions {
  country?: string
  days?: number
  referenceDate?: string
  enabled?: boolean
}

interface UseDashboardOverviewReturn {
  data: DashboardOverviewResponse | undefined
  loading: boolean
  error: Error | null
  refresh: () => void
}

type ProjectItem = { id: number; name: string }

/**
 * KPI 总览数据 hook —— 5s 短超时 + 超时自动重试 1 次。
 */
export function useDashboardOverview(
  options: UseDashboardOverviewOptions = {}
): UseDashboardOverviewReturn {
  const { country = 'US', days = 7, referenceDate, enabled = true } = options
  const { notify } = useNotifications()
  const [contextError, setContextError] = useState<Error | null>(null)
  // Keep last good query string so retry uses the same params
  const lastQueryRef = useRef<string>('')

  const loader = useCallback(
    async (signal: AbortSignal): Promise<DashboardOverviewResponse> => {
      const projects = await fetchManagedProjectsCached<ProjectItem[]>()
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const projectIds = projects.map((p) => p.id).join(',')
      const params = new URLSearchParams({ country, days: String(days) })
      if (projectIds) params.set('project_ids', projectIds)
      if (referenceDate) params.set('reference_date', referenceDate)
      lastQueryRef.current = params.toString()

      const res = await fetch(`/api/backend/api/v1/dashboard/overview?${params}`, { signal })
      if (!res.ok) {
        const err = new Error(`API error: ${res.status}`) as Error & { status: number }
        err.status = res.status
        throw err
      }
      return (await res.json()) as DashboardOverviewResponse
    },
    [country, days, referenceDate]
  )

  const { data, loading, error, retry } = useApiQuery<DashboardOverviewResponse>(loader, {
    enabled,
    timeoutMs: 5_000,
    autoRetry: true,
  })

  // Surface terminal errors via the project's notification system.
  useEffect(() => {
    if (!error) return
    setContextError(new Error(error.message))
    if (error.kind === 'timeout') {
      notify({ type: 'warning', title: '加载较慢', message: 'KPI 总览数据加载超时，已自动重试，请稍候' })
    } else if (error.kind === 'network') {
      notify({ type: 'error', title: '网络异常', message: 'KPI 总览数据网络异常，请稍后重试' })
    } else {
      notify({ type: 'error', title: '加载失败', message: 'KPI 总览数据加载失败，请稍后重试' })
    }
  }, [error, notify])

  return {
    data,
    loading,
    error: contextError,
    refresh: retry,
  }
}
