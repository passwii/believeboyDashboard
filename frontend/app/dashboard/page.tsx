'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'

import { DashboardSalesChart } from '@/components/dashboard/dashboard-sales-chart'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { FactoryDashboard } from '@/components/dashboard/factory-dashboard'
import { DashboardToolbar, type ViewMode } from '@/components/dashboard/dashboard-toolbar'
import { DashboardMetricTiles } from '@/components/dashboard/dashboard-metric-tiles'
import type { MetricTileProps } from '@/components/dashboard/dashboard-metric-tiles'
import { DashboardSystemStatus } from '@/components/dashboard/dashboard-system-status'
import { useDashboardOverview } from '@/hooks/use-dashboard-overview'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'

type ProjectOption = { id: number | null; name: string }

type DailyAnalysisRow = {
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

type DailyAnalysisAllProjectsResponse = {
  summary_rows: DailyAnalysisRow[]
  detail_rows: unknown[]
  available_dates: Record<string, string[]>
}

const US_TIMEZONE = 'America/Los_Angeles'

function getTodayInTimezone(tz: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function aggregateMetric(rows: DailyAnalysisRow[], key: keyof DailyAnalysisRow & ('order_qty' | 'sales_amount' | 'impressions' | 'clicks' | 'cpc' | 'ad_spend' | 'ad_orders' | 'page_views' | 'units_ordered' | 'sessions' | 'conversion_rate')): number {
  if (!rows.length) return 0
  if (key === 'cpc') {
    const totalClicks = rows.reduce((s, r) => s + r.clicks, 0)
    if (totalClicks <= 0) return 0
    const totalAdSpend = rows.reduce((s, r) => s + r.ad_spend, 0)
    return totalAdSpend / totalClicks
  }
  if (key === 'conversion_rate') {
    const totalPageViews = rows.reduce((s, r) => s + r.page_views, 0)
    const totalUnitsOrdered = rows.reduce((s, r) => s + r.units_ordered, 0)
    if (totalPageViews <= 0) return 0
    return totalUnitsOrdered / totalPageViews
  }
  return rows.reduce((s, r) => s + (r[key] as number), 0)
}

function fmtMoney(v: number) {
  return v >= 10000 ? `$${(v / 1000).toFixed(0)}k` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`
}
function fmtNum(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
}
function fmtPct(v: number) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}

function getDateRange(mode: ViewMode): { from: Date; to: Date } {
  const today = getTodayInTimezone(US_TIMEZONE)
  const yesterday = addDays(today, -1)
  if (mode === 'today') {
    return { from: yesterday, to: yesterday }
  }
  const start = addDays(yesterday, -6)
  return { from: start, to: yesterday }
}

function getDateLabel(mode: ViewMode): string {
  const range = getDateRange(mode)
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  if (mode === 'today') return fmt(range.to)
  return `${fmt(range.from)} — ${fmt(range.to)}`
}

export type DashboardDailyData = {
  currentRows: DailyAnalysisRow[]
  comparisonRows: DailyAnalysisRow[]
}

export default function DashboardPage() {
  const { data: session, status } = useSession()
  const roleType = session?.user?.roleType as string | undefined
  const operatorName = session?.user?.operatorNameZh ?? session?.user?.name ?? undefined
  const { notify } = useNotifications()

  const [viewMode, setViewMode] = useState<ViewMode>('today')
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [currentRows, setCurrentRows] = useState<DailyAnalysisRow[]>([])
  const [comparisonRows, setComparisonRows] = useState<DailyAnalysisRow[]>([])
  const [dataLoading, setDataLoading] = useState(false)
  const latestRequestRef = useRef(0)

  const dateRange = useMemo(() => getDateRange(viewMode), [viewMode])
  const days = viewMode === 'today' ? 1 : 7

  const referenceDate = useMemo(() => formatYMD(dateRange.to), [dateRange])

  const { data: overviewData, loading: overviewLoading, refresh: overviewRefresh } = useDashboardOverview({
    enabled: status === 'authenticated' && roleType !== 'factory',
    days,
    referenceDate,
  })

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(rows.filter((item) => item.id !== null))
      } catch {
        notify({ type: 'error', title: '项目列表加载失败' })
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [notify, session])

  const loadData = useCallback(async () => {
    if (projects.length === 0) return
    const ids = projects.map((p) => String(p.id)).join(',')
    if (!ids) return

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)

    const currentDayCount = Math.floor(
      (dateRange.to.getTime() - dateRange.from.getTime()) / 86400000
    ) + 1
    const prevFrom = addDays(dateRange.from, -currentDayCount)
    const prevTo = addDays(dateRange.from, -1)

    const requestId = ++latestRequestRef.current
    setDataLoading(true)

    try {
      const params = new URLSearchParams({
        project_ids: ids,
        country: 'US',
        start_date: startDate,
        end_date: endDate,
      })
      const compareParams = new URLSearchParams({
        project_ids: ids,
        country: 'US',
        start_date: formatYMD(prevFrom),
        end_date: formatYMD(prevTo),
      })

      const [response, compareResponse] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, { cache: 'no-store' }),
        fetch(`/api/backend/api/v1/daily-analysis/all?${compareParams.toString()}`, { cache: 'no-store' }),
      ])

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || '销售数据加载失败')
      }

      const payload = (await response.json()) as DailyAnalysisAllProjectsResponse
      const comparePayload = compareResponse.ok
        ? ((await compareResponse.json()) as DailyAnalysisAllProjectsResponse)
        : null

      if (requestId !== latestRequestRef.current) return

      setCurrentRows(payload.summary_rows)
      setComparisonRows(comparePayload?.summary_rows ?? [])
    } catch (err) {
      if (requestId !== latestRequestRef.current) return
      notify({
        type: 'error',
        title: '数据加载失败',
        message: err instanceof Error ? err.message : '加载失败',
      })
      setCurrentRows([])
      setComparisonRows([])
    } finally {
      if (requestId !== latestRequestRef.current) return
      setDataLoading(false)
    }
  }, [projects, dateRange, notify])

  useEffect(() => {
    if (projects.length > 0) void loadData()
  }, [projects, loadData])

  const metrics = useMemo(() => {
    if (currentRows.length === 0) return undefined

    const totalSales = aggregateMetric(currentRows, 'sales_amount')
    const totalOrders = aggregateMetric(currentRows, 'order_qty')
    const totalAdSpend = aggregateMetric(currentRows, 'ad_spend')
    const totalAdOrders = aggregateMetric(currentRows, 'ad_orders')
    const roas = totalSales > 0 ? (totalAdSpend / totalSales) * 100 : 0

    const prevSales = comparisonRows.length > 0 ? aggregateMetric(comparisonRows, 'sales_amount') : 0
    const prevOrders = comparisonRows.length > 0 ? aggregateMetric(comparisonRows, 'order_qty') : 0

    const salesChange = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : 0
    const ordersChange = prevOrders > 0 ? ((totalOrders - prevOrders) / prevOrders) * 100 : 0

    const salesTrend = currentRows.map((r) => r.sales_amount)
    const orderTrend = currentRows.map((r) => r.order_qty)

    const roasBadge = roas <= 20 ? '优秀' : roas <= 40 ? '正常' : '偏高'
    const roasBadgeColor = roas <= 20 ? 'green' : roas <= 40 ? 'yellow' : 'red'

    const salesChangeType = salesChange > 0.5 ? 'up' as const : salesChange < -0.5 ? 'down' as const : 'neutral' as const
    const ordersChangeType = ordersChange > 0.5 ? 'up' as const : ordersChange < -0.5 ? 'down' as const : 'neutral' as const

    const dateLabels = currentRows.map((r) => {
      const [, m, d] = r.date.split('-')
      return `${Number(m)}/${Number(d)}`
    })
    const fmtAdMoney = (v: number) => `$${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const fmtAdNum = (v: number) => v.toLocaleString('zh-CN')
    const fmtRoas = (v: number) => `${v.toFixed(1)}%`

    return [
      {
        title: '销售额',
        value: fmtMoney(totalSales),
        change: fmtPct(salesChange),
        changeType: salesChangeType,
        trend: salesTrend,
        labels: dateLabels,
        formatValue: fmtAdMoney,
        icon: (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
        accentColor: 'hsl(var(--chart-1))',
      },
      {
        title: '订单量',
        value: fmtNum(totalOrders),
        change: fmtPct(ordersChange),
        changeType: ordersChangeType,
        trend: orderTrend,
        labels: dateLabels,
        formatValue: fmtAdNum,
        icon: (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
          </svg>
        ),
        accentColor: 'hsl(var(--chart-3))',
      },
      {
        title: '广告投放比',
        value: `${roas.toFixed(1)}%`,
        change: totalAdSpend > 0 ? fmtPct(-roas) : '—',
        changeType: (roas <= 20 ? 'up' : roas >= 40 ? 'down' : 'neutral') as 'up' | 'down' | 'neutral',
        trend: orderTrend,
        labels: dateLabels,
        formatValue: fmtRoas,
        icon: (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        ),
        badge: roasBadge,
        badgeColor: roasBadgeColor,
      },
      {
        title: '广告花费',
        value: fmtMoney(totalAdSpend),
        change: totalAdOrders > 0 ? fmtPct(totalAdOrders) : '—',
        changeType: totalAdSpend > prevSales && prevSales > 0
          ? (totalAdSpend > aggregateMetric(comparisonRows, 'ad_spend') ? 'down' : 'up') as 'up' | 'down'
          : 'neutral' as 'up' | 'down' | 'neutral',
        trend: currentRows.map((r) => r.ad_spend),
        labels: dateLabels,
        formatValue: fmtAdMoney,
        icon: (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        ),
        accentColor: 'hsl(var(--chart-1))',
      },
    ] satisfies MetricTileProps[]
  }, [currentRows, comparisonRows])

  const dateLabel = getDateLabel(viewMode)
  const dailyData: DashboardDailyData = useMemo(() => ({
    currentRows,
    comparisonRows,
  }), [currentRows, comparisonRows])

  const handleRefresh = () => {
    void loadData()
    overviewRefresh()
  }

  const anyLoading = dataLoading || overviewLoading || projectsLoading

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  if (roleType === 'factory') {
    return <FactoryDashboard operatorName={operatorName} />
  }

  return (
    <div className="space-y-5">
      <DashboardToolbar
        mode={viewMode}
        onModeChange={setViewMode}
        onRefresh={handleRefresh}
        refreshing={anyLoading}
        dateLabel={dateLabel}
      />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <DashboardMetricTiles metrics={metrics} loading={anyLoading} />
        <DashboardSalesChart dailyData={dailyData} dateRange={dateRange} projects={projects} loading={dataLoading} onRefresh={handleRefresh} />
      </section>

      <DashboardSystemStatus data={overviewData} loading={overviewLoading} />
    </div>
  )
}