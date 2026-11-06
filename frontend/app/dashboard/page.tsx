'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import { useServerNotifications } from '@/components/notifications'
import {
  computeStats,
  type V2Stat,
} from '@/components/dashboard-v2/v2-stats'
import {
  computeTopProjects,
  type V2ProjectOption,
  type V2TopProjectSort,
} from '@/components/dashboard-v2/v2-top-projects'
import type { PendingOrderItem } from '@/components/dashboard-v2/use-pending-orders'
import { useLiveStream } from '@/components/terminal/use-live-stream'
import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'
import {
  DiagnosticStrip,
  MetricStrip,
  type DiagnosticItemData,
  type MetricItem,
} from '@/components/dashboard-v2/warm-ledger/metrics'
import { SalesTrendPanel, type SalesTrendRow } from '@/components/dashboard-v2/warm-ledger/charts'
import {
  DailyLedgerTable,
  ProjectRankTable,
  type ProjectRankRow,
  type ProjectRankSortKey,
} from '@/components/dashboard-v2/warm-ledger/tables'
import { OrderFlowCard } from '@/components/dashboard-v2/warm-ledger/orders/order-flow-card'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { WarmLedgerShell } from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-shell'
import { WarmLedgerTopbar } from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-topbar'
import { WarmNotificationPanel } from '@/components/dashboard-v2/warm-ledger/shell/warm-notification-panel'
import { useDashboardHomeData } from './use-dashboard-home-data'
import type {
  DashboardCountryBreakdownEntry,
  DashboardDailyAnalysisRow,
  DashboardHomeDateRange,
} from '@/components/dashboard-v2/warm-ledger/integration/dashboard-home-types'
import { formatYMD } from '@/lib/dashboard-format'
import { formatFullCurrency, formatInteger, formatPercent } from '@/components/dashboard-v2/v2-format'

import styles from './warm-ledger-home.module.css'

const ALL_PROJECTS = 'all'
const US_TIMEZONE = 'America/Los_Angeles'

function getTodayInTimezone(timeZone: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone })
  const [year, month, day] = formatter.format(new Date()).split('-').map(Number)
  return new Date(year!, month! - 1, day!)
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function dateLabel(date: Date): string {
  return formatYMD(date).slice(5).replace('-', '.')
}

function rangeLabel(dateRange: DashboardHomeDateRange): string {
  return `${formatYMD(dateRange.from).slice(5)} → ${formatYMD(dateRange.to).slice(5)}`
}

function sumRows(
  rows: readonly DashboardDailyAnalysisRow[],
  key: keyof Pick<
    DashboardDailyAnalysisRow,
    'sales_amount' | 'order_qty' | 'ad_spend' | 'ad_orders' | 'available_qty' | 'page_views' | 'sessions' | 'units_ordered'
  >
): number {
  return rows.reduce((total, row) => {
    const value = row[key]
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  }, 0)
}

function latestRow(rows: readonly DashboardDailyAnalysisRow[]) {
  return rows.reduce<DashboardDailyAnalysisRow | null>(
    (latest, row) => (!latest || row.date > latest.date ? row : latest),
    null
  )
}

function priorPeriodDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00`)
  shifted.setDate(shifted.getDate() - days)
  return formatYMD(shifted)
}

function buildSalesTrendRows(
  currentRows: readonly DashboardDailyAnalysisRow[],
  comparisonRows: readonly DashboardDailyAnalysisRow[],
  dateRange: DashboardHomeDateRange
): SalesTrendRow[] {
  const dayCount = Math.max(
    1,
    Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
  )
  const currentByDate = new Map(currentRows.map((row) => [row.date, row]))
  const comparisonByDate = new Map(comparisonRows.map((row) => [row.date, row]))
  const rows: SalesTrendRow[] = []

  for (let index = 0; index < dayCount; index += 1) {
    const date = formatYMD(addDays(dateRange.from, index))
    const previous = comparisonByDate.get(priorPeriodDate(date, dayCount))
    rows.push({
      date,
      label: date.slice(5),
      current: currentByDate.get(date)?.sales_amount ?? Number.NaN,
      previous: previous?.sales_amount ?? null,
    })
  }

  return rows
}

function summarizeCountries(
  countryRowsByCode: Record<string, DashboardCountryBreakdownEntry>
) {
  const countries = Object.entries(countryRowsByCode)
    .map(([code, entry]) => ({
      code,
      sales: sumRows(entry.summary_rows ?? [], 'sales_amount'),
    }))
    .filter((country) => country.sales > 0)
    .sort((a, b) => b.sales - a.sales)
  const totalSales = countries.reduce((total, country) => total + country.sales, 0)
  const topCountry = countries[0]

  return topCountry && totalSales > 0
    ? { countries, topCountry, share: (topCountry.sales / totalSales) * 100 }
    : null
}

function toMetricItems(
  stats: V2Stat[],
  currentRows: readonly DashboardDailyAnalysisRow[],
  comparisonRows: readonly DashboardDailyAnalysisRow[],
  pendingTotal: number,
  pendingError: string | null
): MetricItem[] {
  const hasSalesRows = currentRows.length > 0
  const hasComparison = comparisonRows.length > 0
  const sales = stats[0]
  const orders = stats[1]
  const totalSales = sumRows(currentRows, 'sales_amount')
  const totalOrders = sumRows(currentRows, 'order_qty')

  return [
    {
      key: 'sales',
      label: '销售额',
      value: hasSalesRows ? formatFullCurrency(totalSales) : null,
      code: 'USD',
      comparison: hasSalesRows && hasComparison && sales
        ? { delta: sales.delta, label: 'vs 上周' }
        : undefined,
    },
    {
      key: 'orders',
      label: '订单量',
      value: hasSalesRows ? formatInteger(totalOrders) : null,
      comparison: hasSalesRows && hasComparison && orders
        ? { delta: orders.delta, label: 'vs 上周' }
        : undefined,
    },
    {
      key: 'pending',
      label: '待处理订单',
      value: pendingError ? null : formatInteger(pendingTotal),
      tone: 'accent',
      meta: pendingError ? undefined : '近 7 天 PT',
    },
  ]
}

function toDiagnosticItems(
  currentRows: readonly DashboardDailyAnalysisRow[],
  comparisonRows: readonly DashboardDailyAnalysisRow[],
  countryRowsByCode: Record<string, DashboardCountryBreakdownEntry>
): DiagnosticItemData[] {
  const sales = sumRows(currentRows, 'sales_amount')
  const adSpend = sumRows(currentRows, 'ad_spend')
  const adOrders = sumRows(currentRows, 'ad_orders')
  const currentInventory = latestRow(currentRows)?.available_qty ?? null
  const previousInventory = latestRow(comparisonRows)?.available_qty ?? null
  const inventoryChange =
    currentInventory !== null && previousInventory !== null && previousInventory > 0
      ? ((currentInventory - previousInventory) / previousInventory) * 100
      : null
  const pageViews = sumRows(currentRows, 'page_views')
  const sessions = sumRows(currentRows, 'sessions')
  const unitsOrdered = sumRows(currentRows, 'units_ordered')
  const conversion = pageViews > 0 ? (unitsOrdered / pageViews) * 100 : null
  const countrySummary = summarizeCountries(countryRowsByCode)

  return [
    {
      key: 'advertising',
      label: '广告效率',
      value: formatFullCurrency(adSpend),
      meta: `${sales > 0 ? `ACoAS ${formatPercent((adSpend / sales) * 100, 1)}` : 'ACoAS —'} · 广告订单 ${formatInteger(adOrders)}`,
    },
    {
      key: 'inventory',
      label: '库存水位',
      value: currentInventory,
      unit: '件',
      meta: [
        inventoryChange === null
          ? null
          : `${inventoryChange > 0 ? '+' : ''}${formatPercent(inventoryChange, 1)} vs 上周期`,
        currentInventory === null ? null : '区间末快照',
      ].filter(Boolean).join(' · ') || undefined,
    },
    {
      key: 'traffic',
      label: '流量与转化',
      value: conversion === null ? null : formatPercent(conversion, 1),
      meta: `浏览量 ${formatInteger(pageViews)} · 会话 ${formatInteger(sessions)}`,
    },
    {
      key: 'countries',
      label: '跨国家分布',
      value: countrySummary
        ? `${formatPercent(countrySummary.share, 1)} ${countrySummary.topCountry.code}`
        : null,
      meta: countrySummary ? `${countrySummary.countries.length} 个站点` : undefined,
      progress: countrySummary?.share,
    },
  ]
}

export default function DashboardHomePage() {
  const today = useMemo(() => getTodayInTimezone(US_TIMEZONE), [])
  const yesterday = useMemo(() => addDays(today, -1), [today])
  const dateRange = useMemo(
    () => ({ from: addDays(yesterday, -6), to: yesterday }),
    [yesterday]
  )
  const [selectedProjectId, setSelectedProjectId] = useState(ALL_PROJECTS)
  const [projectSort, setProjectSort] = useState<ProjectRankSortKey>('sales')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const router = useRouter()
  const data = useDashboardHomeData({ projectId: selectedProjectId, dateRange })
  const liveEvents = useLiveStream(true)
  const {
    unreadCount,
    refresh: refreshNotifications,
  } = useServerNotifications()
  const {
    projects,
    projectsLoading,
    projectsError,
    refetchProjects,
    currentRows,
    comparisonRows,
    projectBreakdown,
    compareProjectBreakdown,
    countryRowsByCode,
    dataLoading,
    dataError,
    countriesLoading,
    pendingOrders,
    refresh,
  } = data

  const primaryError = dataError
    ? `销售数据加载失败：${dataError}`
    : projectsError
      ? `项目列表加载失败：${projectsError}`
      : null
  const isRefreshing =
    projectsLoading || dataLoading || countriesLoading || pendingOrders.loading
  const stats = useMemo(
    () => computeStats(currentRows, comparisonRows),
    [comparisonRows, currentRows]
  )
  const metricItems = useMemo(
    () => toMetricItems(
      stats,
      currentRows,
      comparisonRows,
      pendingOrders.total,
      pendingOrders.error
    ),
    [comparisonRows, currentRows, pendingOrders.error, pendingOrders.total, stats]
  )
  const metricState = primaryError
    ? 'error'
    : projectsLoading || dataLoading
      ? 'loading'
      : currentRows.length === 0 && pendingOrders.total === 0 && !pendingOrders.error
        ? 'empty'
        : 'ready'
  const trendRows = useMemo(
    () => buildSalesTrendRows(currentRows, comparisonRows, dateRange),
    [comparisonRows, currentRows, dateRange]
  )
  const rankRows = useMemo(() => {
    const projectOptions: V2ProjectOption[] = projects.map(({ id, name }) => ({ id, name }))
    return computeTopProjects(
      projectBreakdown,
      compareProjectBreakdown,
      projectOptions,
      projectSort as V2TopProjectSort
    ).map<ProjectRankRow>((row) => ({
      projectId: row.projectId,
      projectName: row.projectName,
      totalSales: row.totalSales,
      totalAdSpend: row.totalAdSpend,
      change: row.change,
    }))
  }, [compareProjectBreakdown, projectBreakdown, projectSort, projects])
  const diagnosticItems = useMemo(
    () => toDiagnosticItems(currentRows, comparisonRows, countryRowsByCode),
    [comparisonRows, countryRowsByCode, currentRows]
  )
  const diagnosticState = primaryError
    ? 'error'
    : projectsLoading || dataLoading || countriesLoading
      ? 'loading'
      : currentRows.length === 0
        ? 'empty'
        : 'ready'
  const latestDataDate = latestRow(currentRows)?.date
  const selectedProjectName = selectedProjectId === ALL_PROJECTS
    ? '全部项目'
    : projects.find((project) => String(project.id) === selectedProjectId)?.name ?? '全部项目'

  const handleRefresh = useCallback(() => {
    void refresh()
  }, [refresh])
  const handleSearch = useCallback(() => {
    window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
  }, [])
  const handleOpenNotifications = useCallback(() => {
    setNotificationsOpen(true)
    void refreshNotifications()
  }, [refreshNotifications])
  const handleCloseNotifications = useCallback(() => {
    setNotificationsOpen(false)
  }, [])
  const handleOpenUser = useCallback(() => {
    router.push('/dashboard/profile')
  }, [router])
  const handleOpenProject = useCallback((row: ProjectRankRow) => {
    const params = new URLSearchParams({
      project: String(row.projectId),
      country: 'US',
    })
    router.push(`/dashboard/operations/daily-analysis?${params.toString()}`)
  }, [router])
  const handleOpenOrder = useCallback((order: PendingOrderItem) => {
    const params = new URLSearchParams()
    params.set('order_statuses', 'Pending')
    params.set('project_id', String(order.project_id))
    params.set('date_from', formatYMD(dateRange.from))
    params.set('date_to', formatYMD(dateRange.to))
    router.push(`/dashboard/reports/order-info?${params.toString()}`)
  }, [dateRange, router])
  const handleOpenLiveEvent = useCallback((event: LiveStreamItem) => {
    const [projectPart, ...orderParts] = event.id.split(':')
    const titleOrderId = event.title.match(/#([A-Za-z0-9-]+)/)?.[1]
    const orderId =
      orderParts.length > 0
        ? orderParts.join(':')
        : titleOrderId ?? event.id
    const params = new URLSearchParams({
      order_id_keyword: orderId,
      date_from: formatYMD(dateRange.from),
      date_to: formatYMD(dateRange.to),
    })
    if (projectPart && /^\d+$/.test(projectPart)) {
      params.set('project_id', projectPart)
    }
    router.push(`/dashboard/reports/order-info?${params.toString()}`)
  }, [dateRange, router])
  const dateRangeText = rangeLabel(dateRange)
  const projectOptions = useMemo(
    () => [
      { value: ALL_PROJECTS, label: '全部项目' },
      ...projects.map((project) => ({ value: String(project.id), label: project.name })),
    ],
    [projects]
  )

  return (
    <WarmLedgerShell
      topbar={(
        <WarmLedgerTopbar
          showScopeMeta={false}
          projectId={selectedProjectId}
          projectOptions={projectOptions}
          onProjectChange={setSelectedProjectId}
          projectFilterError={projectsError}
          dateRangeLabel={dateRangeText}
          siteLabel="US"
          onRefresh={handleRefresh}
          refreshing={isRefreshing}
          onSearch={handleSearch}
          onNotifications={handleOpenNotifications}
          unreadCount={unreadCount}
          onUserAction={handleOpenUser}
          userLabel="个人资料"
        />
      )}
    >
      <div className={styles.home}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <h1 className={styles.title}>
              <span className={styles.titlePeriod}>{dateLabel(dateRange.from)}—{dateLabel(dateRange.to)}</span>
              <span>本周运营</span>
            </h1>
            <div className={styles.pageMeta}>
              <span>{selectedProjectName}</span>
              <span>US 站</span>
              <span>PT 运营日</span>
            </div>
          </div>
          {latestDataDate ? (
            <p className={styles.freshness}>
              <span aria-hidden="true" />
              <span>数据截至 {latestDataDate} PT</span>
            </p>
          ) : null}
        </header>

        {projectsError ? (
          <div className={styles.errorBanner} role="alert">
            <span>项目列表加载失败：{projectsError}</span>
            <WarmButton onClick={() => void refetchProjects()} variant="secondary">
              重试
            </WarmButton>
          </div>
        ) : null}

        {metricState === 'error' ? (
          <MetricStrip items={metricItems} state="error" errorMessage={primaryError ?? '销售数据加载失败'} />
        ) : metricState === 'loading' ? (
          <MetricStrip items={metricItems} state="loading" skeletonCount={3} />
        ) : (
          <MetricStrip items={metricItems} state={metricState} ariaLabel="本周关键指标" />
        )}

        <div className={styles.primaryGrid}>
          <SalesTrendPanel
            rows={trendRows}
            loading={projectsLoading || dataLoading}
            error={primaryError}
          />
          <OrderFlowCard
            pendingCount={pendingOrders.total}
            countLoading={pendingOrders.loading}
            countError={pendingOrders.error}
            items={pendingOrders.items}
            listLoading={pendingOrders.loading || pendingOrders.loadingMore}
            listError={pendingOrders.error}
            hasMore={pendingOrders.hasMore}
            loadMore={pendingOrders.loadMore}
            liveEvents={liveEvents}
            onOpenOrder={handleOpenOrder}
            onOpenLiveEvent={handleOpenLiveEvent}
          />
        </div>

        <div className={styles.detailGrid}>
          <section className={styles.panel} aria-labelledby="project-rank-title">
            <header className={styles.panelHeader}>
              <h2 id="project-rank-title">项目排行</h2>
            </header>
            <ProjectRankTable
              rows={rankRows}
              sortKey={projectSort}
              onSortChange={setProjectSort}
              onClick={handleOpenProject}
              loading={projectsLoading || dataLoading}
              error={primaryError}
            />
          </section>

          <section className={styles.panel} aria-labelledby="daily-ledger-title">
            <header className={styles.panelHeader}>
              <h2 id="daily-ledger-title">日明细</h2>
            </header>
            <DailyLedgerTable
              rows={currentRows}
              loading={projectsLoading || dataLoading}
              error={primaryError}
            />
          </section>
        </div>

        {diagnosticState === 'error' ? (
          <DiagnosticStrip
            items={diagnosticItems}
            state="error"
            errorMessage={primaryError ?? '经营辅助指标加载失败'}
          />
        ) : diagnosticState === 'loading' ? (
          <DiagnosticStrip items={diagnosticItems} state="loading" skeletonCount={4} />
        ) : (
          <DiagnosticStrip
            items={diagnosticItems}
            state={diagnosticState}
            ariaLabel="经营辅助指标"
          />
        )}
      </div>
      <WarmNotificationPanel
        open={notificationsOpen}
        onClose={handleCloseNotifications}
      />
    </WarmLedgerShell>
  )
}
