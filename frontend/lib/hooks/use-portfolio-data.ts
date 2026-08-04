'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'

import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

const API_BASE = '/api/backend'

export interface ProjectOption {
  id: number
  name: string
}

export interface DailyAnalysisRow {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  ordered_sales_amount: number
  conversion_rate: number
}

export interface ProjectBreakdown {
  project_name: string
  summary_rows: DailyAnalysisRow[]
  detail_rows: DailyAnalysisRow[]
}

export interface DailyAnalysisAllProjectsResponse {
  summary_rows: DailyAnalysisRow[]
  detail_rows: DailyAnalysisRow[]
  available_dates: Record<string, string[]>
  project_breakdown: Record<number, ProjectBreakdown>
}

export interface ProjectPortfolioKPI {
  project_id: number
  project_name: string
  sales_amount: number
  order_qty: number
  ad_spend: number
  conversion_rate: number
  impressions: number
  clicks: number
  cpc: number
  ad_orders: number
  page_views: number
  sessions: number
  available_qty: number
  daily_trend: DailyAnalysisRow[]
  sales_contribution: number
  order_contribution: number
  ad_spend_contribution: number
}

export interface PortfolioSummary {
  projects: ProjectPortfolioKPI[]
  total_sales_amount: number
  total_order_qty: number
  total_ad_spend: number
  avg_conversion_rate: number
  total_impressions: number
  total_clicks: number
  total_sessions: number
}

function sumField(rows: DailyAnalysisRow[], field: keyof DailyAnalysisRow): number {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0)
}

function buildPortfolioSummary(data: DailyAnalysisAllProjectsResponse): PortfolioSummary {
  const projects: ProjectPortfolioKPI[] = []
  let totalSalesAmount = 0
  let totalOrderQty = 0
  let totalAdSpend = 0
  let totalImpressions = 0
  let totalClicks = 0
  let totalSessions = 0

  for (const [projectIdStr, breakdown] of Object.entries(data.project_breakdown)) {
    const projectId = Number(projectIdStr)
    const rows = breakdown.summary_rows
    const salesAmount = sumField(rows, 'sales_amount')
    const orderQty = sumField(rows, 'order_qty')
    const adSpend = sumField(rows, 'ad_spend')
    const impressions = sumField(rows, 'impressions')
    const clicks = sumField(rows, 'clicks')
    const sessions = sumField(rows, 'sessions')

    totalSalesAmount += salesAmount
    totalOrderQty += orderQty
    totalAdSpend += adSpend
    totalImpressions += impressions
    totalClicks += clicks
    totalSessions += sessions

    projects.push({
      project_id: projectId,
      project_name: breakdown.project_name,
      sales_amount: salesAmount,
      order_qty: orderQty,
      ad_spend: adSpend,
      conversion_rate:
        sumField(rows, 'ordered_sales_amount') > 0
          ? (sumField(rows, 'ordered_sales_amount') / (sumField(rows, 'sessions') || 1)) * 100
          : 0,
      impressions,
      clicks,
      cpc: clicks > 0 ? adSpend / clicks : 0,
      ad_orders: sumField(rows, 'ad_orders'),
      page_views: sumField(rows, 'page_views'),
      sessions,
      available_qty: 0,
      daily_trend: rows,
      sales_contribution: 0,
      order_contribution: 0,
      ad_spend_contribution: 0,
    })
  }

  // Compute contribution percentages
  for (const p of projects) {
    p.sales_contribution = totalSalesAmount > 0 ? (p.sales_amount / totalSalesAmount) * 100 : 0
    p.order_contribution = totalOrderQty > 0 ? (p.order_qty / totalOrderQty) * 100 : 0
    p.ad_spend_contribution = totalAdSpend > 0 ? (p.ad_spend / totalAdSpend) * 100 : 0
  }

  return {
    projects,
    total_sales_amount: totalSalesAmount,
    total_order_qty: totalOrderQty,
    total_ad_spend: totalAdSpend,
    avg_conversion_rate: totalSessions > 0 ? (totalOrderQty / totalSessions) * 100 : 0,
    total_impressions: totalImpressions,
    total_clicks: totalClicks,
    total_sessions: totalSessions,
  }
}

interface UsePortfolioDataOptions {
  projectIds: number[]
  country: string
  startDate: string
  endDate: string
}

interface UsePortfolioDataResult {
  data: PortfolioSummary | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function usePortfolioData({
  projectIds,
  country,
  startDate,
  endDate,
}: UsePortfolioDataOptions): UsePortfolioDataResult {
  const { data: session } = useSession()
  const [data, setData] = useState<PortfolioSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (projectIds.length === 0 || !startDate || !endDate) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    let active = true
    setLoading(true)
    setError(null)

    async function load() {
      try {
        const params = new URLSearchParams({
          project_ids: projectIds.join(','),
          country,
          start_date: startDate,
          end_date: endDate,
        })
        // BEL-423：与 daily-analysis 共用 daily-analysis/all 端点的 2min 客户端缓存，
        // 两页来回切换不重复请求。
        const raw = await fetchOpsJsonCached<DailyAnalysisAllProjectsResponse>(
          `${API_BASE}/api/v1/daily-analysis/all?${params.toString()}`,
          { session, fallbackError: '加载失败' }
        )
        if (!active) return
        setData(buildPortfolioSummary(raw))
      } catch (e) {
        if (!active) return
        setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [projectIds.join(','), country, startDate, endDate, nonce, session])

  return { data, loading, error, refresh }
}
