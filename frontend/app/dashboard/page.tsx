'use client'

import { useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'

import { DashboardSalesChart } from '@/components/dashboard/dashboard-sales-chart'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { FactoryDashboard } from '@/components/dashboard/factory-dashboard'
import { DashboardToolbar, type ViewMode } from '@/components/dashboard/dashboard-toolbar'
import { DashboardMetricTiles } from '@/components/dashboard/dashboard-metric-tiles'
import type { MetricTileProps } from '@/components/dashboard/dashboard-metric-tiles'
import { DashboardSystemStatus } from '@/components/dashboard/dashboard-system-status'
import { useDashboardOverview } from '@/hooks/use-dashboard-overview'
import type { DashboardOverviewResponse } from '@/hooks/use-dashboard-overview'

function buildMetricProps(data: DashboardOverviewResponse, mode: ViewMode) {
  const fmtMoney = (v: number) =>
    v >= 10000 ? `$${(v / 1000).toFixed(0)}k` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`
  const fmtNum = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))
  const fmtPct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

  const salesTrend = data.sales_trend.map((t) => t.sales_amount)
  const orderTrend = data.sales_trend.map((t) => t.order_qty)

  const acos = data.ads.period_acos
  const acosBadge = acos <= 20 ? '优秀' : acos <= 40 ? '正常' : '偏高'
  const acosBadgeColor = acos <= 20 ? 'green' : acos <= 40 ? 'yellow' : 'red'

  return [
    {
      title: '销售额',
      value: fmtMoney(data.sales.today_sales_amount),
      change: fmtPct(data.sales.sales_change_pct),
      changeType: data.sales.change_type_sales as 'up' | 'down' | 'neutral',
      trend: salesTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      accentColor: 'hsl(var(--secondary))',
    },
    {
      title: '订单量',
      value: fmtNum(data.sales.today_order_qty),
      change: fmtPct(data.sales.order_qty_change_pct),
      changeType: data.sales.change_type_order_qty as 'up' | 'down' | 'neutral',
      trend: orderTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
        </svg>
      ),
      accentColor: 'hsl(var(--chart-2))',
    },
    {
      title: '广告成本比',
      value: `${acos.toFixed(1)}%`,
      change: data.ads.period_spend > 0 ? fmtPct(-acos) : '—',
      changeType: (acos <= 20 ? 'up' : acos >= 40 ? 'down' : 'neutral') as 'up' | 'down' | 'neutral',
      trend: orderTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
      badge: acosBadge,
      badgeColor: acosBadgeColor,
    },
    {
      title: '增长指数',
      value: fmtPct(data.sales.sales_change_pct),
      change: fmtPct(data.sales.sales_change_pct),
      changeType: data.sales.change_type_sales as 'up' | 'down' | 'neutral',
      trend: orderTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
      ),
    },
  ] satisfies MetricTileProps[]
}

function getDateLabel(mode: ViewMode): string {
  const today = new Date()
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  if (mode === 'today') return fmt(today)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 6)
  return `${fmt(weekAgo)} — ${fmt(today)}`
}

export default function DashboardPage() {
  const { data: session, status } = useSession()
  const roleType = session?.user?.roleType as string | undefined
  const operatorName = session?.user?.operatorNameZh ?? session?.user?.name ?? undefined

  const [viewMode, setViewMode] = useState<ViewMode>('today')
  const days = viewMode === 'today' ? 1 : 7

  const { data: overviewData, loading: overviewLoading, refresh: overviewRefresh } = useDashboardOverview({
    enabled: status === 'authenticated' && roleType !== 'factory',
    days,
  })

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  if (roleType === 'factory') {
    return <FactoryDashboard operatorName={operatorName} />
  }

  const metrics = overviewData ? buildMetricProps(overviewData, viewMode) : undefined
  const dateLabel = getDateLabel(viewMode)

  return (
    <div className="space-y-5">
      <DashboardToolbar
        mode={viewMode}
        onModeChange={setViewMode}
        onRefresh={() => overviewRefresh()}
        refreshing={overviewLoading}
        dateLabel={dateLabel}
      />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <DashboardMetricTiles metrics={metrics} loading={overviewLoading} />
        <DashboardSalesChart session={session} />
      </section>

      <DashboardSystemStatus data={overviewData} loading={overviewLoading} />
    </div>
  )
}