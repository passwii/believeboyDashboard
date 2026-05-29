'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
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
  enabled?: boolean
}

interface UseDashboardOverviewReturn {
  data: DashboardOverviewResponse | undefined
  loading: boolean
  error: Error | null
  refresh: () => void
}

type ProjectItem = { id: number; name: string }

export function useDashboardOverview(
  options: UseDashboardOverviewOptions = {}
): UseDashboardOverviewReturn {
  const { country = 'US', days = 7, enabled = true } = options
  const [data, setData] = useState<DashboardOverviewResponse | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const { notify } = useNotifications()
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!enabled) return

    // Cancel any in-flight request from a previous invocation.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)

    try {
      const projects = await fetchManagedProjectsCached<ProjectItem[]>()
      if (controller.signal.aborted) return

      const projectIds = projects.map((p) => p.id).join(',')
      const params = new URLSearchParams({ country, days: String(days) })
      if (projectIds) params.set('project_ids', projectIds)

      const res = await fetch(`/api/backend/api/v1/dashboard/overview?${params}`, {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`API error: ${res.status}`)

      const json: DashboardOverviewResponse = await res.json()
      if (controller.signal.aborted) return
      setData(json)
    } catch (err) {
      if (controller.signal.aborted) return
      const errObj = err instanceof Error ? err : new Error('Unknown error')
      setError(errObj)
      notify({ type: 'error', title: '加载失败', message: 'KPI 总览数据加载失败，请稍后重试' })
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [country, days, enabled, notify])

  useEffect(() => {
    load()
    return () => { abortRef.current?.abort() }
  }, [load])

  return { data, loading, error, refresh: load }
}