'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Sparkles } from 'lucide-react'

import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { MotionStagger, MotionStaggerItem } from '@/components/motion/MotionStagger'
import { DashboardMetricTiles } from '@/components/dashboard/dashboard-metric-tiles'
import type { MetricTileProps } from '@/components/dashboard/dashboard-metric-tiles'
import { DashboardSurfaceCard } from '@/components/dashboard/dashboard-surface-card'
import { DashboardAlertWidget } from '@/components/dashboard/dashboard-alert-widget'
import { DashboardTopProjects } from '@/components/dashboard/dashboard-top-projects'
import { DashboardTopCountries } from '@/components/dashboard/dashboard-top-countries'
import { DashboardAdSpendChart } from '@/components/dashboard/dashboard-ad-spend-chart'
import { DashboardHealthKpis } from '@/components/dashboard/dashboard-health-kpis'
import { DeferredSection } from '@/components/dashboard/deferred-section'
import { ProjectSelect } from '@/components/dashboard/console/project-select'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { useInViewOnce } from '@/lib/hooks/use-in-view-once'
import { fmtMoney, fmtNum, fmtPct, formatYMD } from '@/lib/dashboard-format'
import { useNotifications } from '@/components/notifications'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'

// recharts 强依赖 window/document，必须 ssr:false 才能从首屏 bundle 拆出 ~400KB recharts 主体
const LazyDashboardSalesChart = dynamic(
  () => import('@/components/dashboard/dashboard-sales-chart').then((m) => m.DashboardSalesChart),
  {
    ssr: false,
    loading: () => (
      <div className="dashboard-surface p-5">
        <div className="flex items-center justify-between pb-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="h-8 w-16" />
        </div>
        <div className="flex gap-3 pb-4">
          <Skeleton className="h-14 w-40" />
          <Skeleton className="h-14 w-40" />
        </div>
        <Skeleton className="h-[280px] w-full rounded-lg" />
      </div>
    ),
  }
)

// Row 3 右侧「销售 vs 广告花费」同样依赖 recharts,也需要 ssr:false
const LazyDashboardAdSpendChart = dynamic(
  () =>
    import('@/components/dashboard/dashboard-ad-spend-chart').then((m) => m.DashboardAdSpendChart),
  {
    ssr: false,
    loading: () => (
      <div className="dashboard-surface p-5">
        <div className="flex items-center justify-between pb-3">
          <div className="space-y-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-7 w-7 rounded-md" />
        </div>
        <div className="grid grid-cols-3 gap-3 pb-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-[260px] sm:h-[320px] w-full rounded-lg" />
      </div>
    ),
  }
)

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

type ProjectBreakdownEntry = {
  project_name: string
  summary_rows: DailyAnalysisRow[]
}

type CountryBreakdownEntry = {
  summary_rows: DailyAnalysisRow[]
  detail_rows?: unknown[]
  currency?: string
  source_currency?: string
}

type DailyAnalysisAllProjectsResponse = {
  summary_rows: DailyAnalysisRow[]
  detail_rows: unknown[]
  available_dates: Record<string, string[]>
  project_breakdown?: Record<number, ProjectBreakdownEntry>
}

type DailyAnalysisAllCountriesResponse = {
  summary_rows: DailyAnalysisRow[]
  detail_rows: unknown[]
  available_dates: Record<string, string[]>
  country_breakdown?: Record<string, CountryBreakdownEntry>
  currency?: string
  currency_note?: string | null
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

function aggregateMetric(
  rows: DailyAnalysisRow[],
  key: keyof DailyAnalysisRow &
    (
      | 'order_qty'
      | 'sales_amount'
      | 'impressions'
      | 'clicks'
      | 'cpc'
      | 'ad_spend'
      | 'ad_orders'
      | 'page_views'
      | 'units_ordered'
      | 'sessions'
      | 'conversion_rate'
    )
): number {
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

/** 解析后端 /all-countries 返回的 country_breakdown,过滤非法 entry */
function parseCountryBreakdown(
  countryBreakdown: Record<string, CountryBreakdownEntry> | undefined
): Record<string, DailyAnalysisRow[]> {
  const result: Record<string, DailyAnalysisRow[]> = {}
  if (!countryBreakdown) return result
  for (const [code, entry] of Object.entries(countryBreakdown)) {
    if (entry && Array.isArray(entry.summary_rows) && entry.summary_rows.length > 0) {
      result[code] = entry.summary_rows
    }
  }
  return result
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

  const today = useMemo(() => getTodayInTimezone(US_TIMEZONE), [])
  const yesterday = useMemo(() => addDays(today, -1), [today])
  const dateRange = useMemo(
    () => ({
      from: addDays(yesterday, -6),
      to: yesterday,
    }),
    [yesterday]
  )

  // 项目列表由 useManagedProjects hook 统一管理(单一 fetch + 2min client cache),
  // 子组件 <ProjectSelect> 也通过 props 复用同一份数据,避免重复请求
  const { projects, loading: projectsLoading, error: projectsError } = useManagedProjects()
  const [currentRows, setCurrentRows] = useState<DailyAnalysisRow[]>([])
  const [comparisonRows, setComparisonRows] = useState<DailyAnalysisRow[]>([])
  const [projectBreakdown, setProjectBreakdown] = useState<Record<number, ProjectBreakdownEntry>>(
    {}
  )
  const [compareProjectBreakdown, setCompareProjectBreakdown] = useState<
    Record<number, ProjectBreakdownEntry>
  >({})
  const [countryRowsByCode, setCountryRowsByCode] = useState<Record<string, DailyAnalysisRow[]>>({})
  const [countryCompareRowsByCode, setCountryCompareRowsByCode] = useState<
    Record<string, DailyAnalysisRow[]>
  >({})
  const [countryCurrencyNote, setCountryCurrencyNote] = useState<string | null>(null)
  /** 跨国家卡片的"代表项目"(用户可手动切换);null 表示跟随默认 projectIds[0] */
  const [representativeProjectId, setRepresentativeProjectId] = useState<number | null>(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [countriesLoading, setCountriesLoading] = useState(false)
  const latestRequestRef = useRef(0)
  const latestCountriesRequestRef = useRef(0)

  // hook 返回的项目 id 必为 number;保留 ?. 防御性兜底(后端 schema 升级时)
  const projectIds = useMemo(
    () => projects.map((p) => p.id).filter((id): id is number => typeof id === 'number'),
    [projects]
  )

  // 代表项目初始化 + 失效回退:
  //   - 首次进入时(state=null)自动选第一个项目
  //   - 选中的代表项目被移除(用户改了权限/项目下架)时,重置到第一个
  useEffect(() => {
    if (projectIds.length === 0) return
    if (representativeProjectId === null) {
      setRepresentativeProjectId(projectIds[0])
      return
    }
    if (!projectIds.includes(representativeProjectId)) {
      setRepresentativeProjectId(projectIds[0])
    }
  }, [projectIds, representativeProjectId])

  useEffect(() => {
    if (projectsError) {
      notify({ type: 'error', title: '项目列表加载失败' })
    }
  }, [projectsError, notify])

  const loadData = useCallback(async () => {
    if (projects.length === 0) return
    const ids = projects.map((p) => String(p.id)).join(',')
    if (!ids) return

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)

    const currentDayCount =
      Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
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

      // BEL-419 首页数据懒加载：mount 只拉首屏必需的 2 个核心请求（当期 + 对比期）；
      // Row 3 的跨国家 all-countries 2 个请求推迟到滚动接近 Row 3 时再发（见 loadCountriesData）。
      const [response, compareResponse] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, { cache: 'no-store' }),
        fetch(`/api/backend/api/v1/daily-analysis/all?${compareParams.toString()}`, {
          cache: 'no-store',
        }),
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
      setProjectBreakdown(payload.project_breakdown ?? {})
      setCompareProjectBreakdown(comparePayload?.project_breakdown ?? {})
    } catch (err) {
      if (requestId !== latestRequestRef.current) return
      notify({
        type: 'error',
        title: '数据加载失败',
        message: err instanceof Error ? err.message : '加载失败',
      })
      setCurrentRows([])
      setComparisonRows([])
      setProjectBreakdown({})
      setCompareProjectBreakdown({})
    } finally {
      if (requestId !== latestRequestRef.current) return
      setDataLoading(false)
    }
  }, [projects, dateRange, notify])

  /**
   * BEL-419 首页数据懒加载：Row 3 跨国家分布专用取数。
   * - 首次触发：滚动接近 Row 3（row3InView）时；
   * - 后续触发：日期固定为近 7 天，仅"代表项目"切换时重拉（deps 含 representativeProjectId，
   *   顺带修复旧实现中切换代表项目不重拉的 stale-closure 问题）。
   * - 失败静默降级为空（与旧实现一致，不阻断首屏 KPI）。
   */
  const loadCountriesData = useCallback(async () => {
    if (projects.length === 0) return

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)
    const currentDayCount =
      Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
    const prevFrom = addDays(dateRange.from, -currentDayCount)
    const prevTo = addDays(dateRange.from, -1)

    const projectIds = projects.map((p) => p.id).filter((id): id is number => typeof id === 'number')
    // /all-countries 只接受单 project_id，首页是多项目合并 —— 用户可在 Row 3 切换"代表项目"，
    // 未指定时 fallback 到 projectIds[0]
    const effectiveRepresentativeProjectId = representativeProjectId ?? projectIds[0]
    if (effectiveRepresentativeProjectId === undefined) return

    const requestId = ++latestCountriesRequestRef.current
    setCountriesLoading(true)

    try {
      const countriesParams = new URLSearchParams({
        project_id: String(effectiveRepresentativeProjectId),
        start_date: startDate,
        end_date: endDate,
      })
      const countriesCompareParams = new URLSearchParams({
        project_id: String(effectiveRepresentativeProjectId),
        start_date: formatYMD(prevFrom),
        end_date: formatYMD(prevTo),
      })

      const [countriesRes, countriesCompareRes] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all-countries?${countriesParams.toString()}`, {
          cache: 'no-store',
        }),
        fetch(
          `/api/backend/api/v1/daily-analysis/all-countries?${countriesCompareParams.toString()}`,
          { cache: 'no-store' }
        ),
      ])

      let nextCountryRowsByCode: Record<string, DailyAnalysisRow[]> = {}
      let nextCountryCompareRowsByCode: Record<string, DailyAnalysisRow[]> = {}
      let nextCurrencyNote: string | null = null
      if (countriesRes.ok) {
        try {
          const countriesPayload = (await countriesRes.json()) as DailyAnalysisAllCountriesResponse
          nextCountryRowsByCode = parseCountryBreakdown(countriesPayload.country_breakdown)
          nextCurrencyNote = countriesPayload.currency_note ?? null
        } catch {
          nextCountryRowsByCode = {}
        }
      }
      if (countriesCompareRes.ok) {
        try {
          const compareCountriesPayload =
            (await countriesCompareRes.json()) as DailyAnalysisAllCountriesResponse
          nextCountryCompareRowsByCode = parseCountryBreakdown(
            compareCountriesPayload.country_breakdown
          )
        } catch {
          nextCountryCompareRowsByCode = {}
        }
      }

      if (requestId !== latestCountriesRequestRef.current) return
      setCountryRowsByCode(nextCountryRowsByCode)
      setCountryCompareRowsByCode(nextCountryCompareRowsByCode)
      setCountryCurrencyNote(nextCurrencyNote)
    } finally {
      if (requestId !== latestCountriesRequestRef.current) return
      setCountriesLoading(false)
    }
  }, [projects, dateRange, representativeProjectId])

  useEffect(() => {
    if (projects.length > 0) void loadData()
  }, [projects, loadData])

  // BEL-419：滚动接近 Row 3 后才发起跨国家请求；首次触发后，切换代表项目会经 deps 自动重拉。
  const { ref: row3Ref, inView: row3InView } = useInViewOnce<HTMLElement>({ rootMargin: '480px' })
  useEffect(() => {
    if (!row3InView) return
    void loadCountriesData()
  }, [row3InView, loadCountriesData])

  const metrics = useMemo(() => {
    if (currentRows.length === 0) return undefined

    const totalSales = aggregateMetric(currentRows, 'sales_amount')
    const totalOrders = aggregateMetric(currentRows, 'order_qty')
    const totalAdSpend = aggregateMetric(currentRows, 'ad_spend')
    const totalAdOrders = aggregateMetric(currentRows, 'ad_orders')
    const roas = totalSales > 0 ? (totalAdSpend / totalSales) * 100 : 0

    const prevSales =
      comparisonRows.length > 0 ? aggregateMetric(comparisonRows, 'sales_amount') : 0
    const prevOrders = comparisonRows.length > 0 ? aggregateMetric(comparisonRows, 'order_qty') : 0

    const salesChange = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : 0
    const ordersChange = prevOrders > 0 ? ((totalOrders - prevOrders) / prevOrders) * 100 : 0

    const salesTrend = currentRows.map((r) => r.sales_amount)
    const orderTrend = currentRows.map((r) => r.order_qty)

    const roasBadge = roas <= 20 ? '优秀' : roas <= 40 ? '正常' : '偏高'
    const roasBadgeColor = roas <= 20 ? 'green' : roas <= 40 ? 'yellow' : 'red'

    const salesChangeType =
      salesChange > 0.5
        ? ('up' as const)
        : salesChange < -0.5
          ? ('down' as const)
          : ('neutral' as const)
    const ordersChangeType =
      ordersChange > 0.5
        ? ('up' as const)
        : ordersChange < -0.5
          ? ('down' as const)
          : ('neutral' as const)

    const dateLabels = currentRows.map((r) => {
      const [, m, d] = r.date.split('-')
      return `${Number(m)}/${Number(d)}`
    })
    const fmtAdMoney = (v: number) =>
      `$${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
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
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
            />
          </svg>
        ),
        accentColor: 'hsl(var(--chart-3))',
      },
      {
        title: '广告投放比',
        value: `${roas.toFixed(1)}%`,
        change: totalAdSpend > 0 ? fmtPct(-roas) : '—',
        changeType: (roas <= 20 ? 'up' : roas >= 40 ? 'down' : 'neutral') as
          | 'up'
          | 'down'
          | 'neutral',
        trend: orderTrend,
        labels: dateLabels,
        formatValue: fmtRoas,
        icon: (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        ),
        badge: roasBadge,
        badgeColor: roasBadgeColor,
      },
      {
        title: '广告花费',
        value: fmtMoney(totalAdSpend),
        change: totalAdOrders > 0 ? fmtPct(totalAdOrders) : '—',
        changeType:
          totalAdSpend > prevSales && prevSales > 0
            ? ((totalAdSpend > aggregateMetric(comparisonRows, 'ad_spend') ? 'down' : 'up') as
                | 'up'
                | 'down')
            : ('neutral' as 'up' | 'down' | 'neutral'),
        trend: currentRows.map((r) => r.ad_spend),
        labels: dateLabels,
        formatValue: fmtAdMoney,
        icon: (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
            />
          </svg>
        ),
        accentColor: 'hsl(var(--chart-1))',
      },
    ] satisfies MetricTileProps[]
  }, [currentRows, comparisonRows])

  const dailyData: DashboardDailyData = useMemo(
    () => ({
      currentRows,
      comparisonRows,
    }),
    [currentRows, comparisonRows]
  )

  /**
   * 库存健康度快照 —— 同步给 DashboardAlertWidget 卡片底部使用。
   * current: 区间最后一天的 available_qty 快照(每日是当时累计);
   * trend: 7 日序列;labels: 形如 "M/D",与 dashboard-metric-tiles 同口径。
   */
  const stockSnapshot = useMemo(() => {
    if (currentRows.length === 0) return undefined
    const trend = currentRows.map((r) => r.available_qty ?? 0)
    const labels = currentRows.map((r) => {
      const [, m, d] = r.date.split('-')
      return `${Number(m)}/${Number(d)}`
    })
    return {
      current: trend[trend.length - 1] ?? 0,
      trend,
      labels,
    }
  }, [currentRows])

  const handleRefresh = () => {
    void loadData()
    // 跨国家数据仅在已触发过懒加载（Row 3 已入视口）时随刷新重拉
    if (row3InView) void loadCountriesData()
  }

  const anyLoading = dataLoading || projectsLoading

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  return (
    <div className="space-y-5">
      {/* v2 实验入口——临时，实验结束后移除 */}
      <div className="flex justify-end">
        <Button asChild size="sm" variant="ghost">
          <Link href="/dashboard/v2">
            试试新版
            <Sparkles className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </div>
      {/*
       * iPad portrait (768–1023px) intentionally stays single-column:
       * the 2:3 split would compress tiles to ~200px each. Side-by-side
       * kicks in at lg (1024px) so iPad Pro landscape + small laptop
       * get the full dashboard feel. Stacked on phone so the chart
       * gets the full width.
       */}
      <section className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Stagger 容器用 display:contents,不破坏 grid 布局;子节点仍为 section 的直接 grid item */}
        <MotionStagger className="contents">
          <MotionStaggerItem>
            <DashboardSurfaceCard className="p-5">
              <DashboardMetricTiles metrics={metrics} loading={anyLoading} />
            </DashboardSurfaceCard>
          </MotionStaggerItem>
          <MotionStaggerItem>
            <LazyDashboardSalesChart
              dailyData={dailyData}
              dateRange={dateRange}
              projects={projects}
              loading={dataLoading}
              onRefresh={handleRefresh}
            />
          </MotionStaggerItem>
        </MotionStagger>
      </section>
      {/*
       * Row 2 — 高度填充 + 信息密度补充
       *   - 左 2fr：DashboardAlertWidget（自管 fetch，与 KPI 时段无关）
       *   - 右 3fr：DashboardTopProjects（Top 5 项目/店铺，Tab 切换 销售额/广告花费）
       * iPad portrait 同样保持单列堆叠（与 Row 1 同一断点逻辑）。
       *
       * 注意：三个子组件根节点已通过 DataCard / DataTableCard 自带 dashboard-surface，
       * 因此不再用 <DashboardSurfaceCard> 包裹（避免 dashboard-surface 嵌套）；仅用
       * MotionStagger 做错峰入场。
       */}
      <section className="grid gap-5 lg:grid-cols-3">
        {/* Stagger 容器用 display:contents,不破坏 grid 布局;子节点仍为 section 的直接 grid item */}
        <MotionStagger className="contents">
          <MotionStaggerItem>
            {/* BEL-419：告警组件自管 fetch，用 DeferredSection 推迟到滚动接近时再挂载取数 */}
            <DeferredSection
              data-testid="home-alert-deferred"
              fallbackHeight="h-[240px]"
              className="h-full"
            >
              <DashboardAlertWidget stockSnapshot={stockSnapshot} stockLoading={dataLoading} />
            </DeferredSection>
          </MotionStaggerItem>
          <MotionStaggerItem>
            <DashboardHealthKpis
              currentRows={currentRows}
              comparisonRows={comparisonRows}
              loading={dataLoading}
            />
          </MotionStaggerItem>
          <MotionStaggerItem>
            <DashboardTopProjects
              projectBreakdown={projectBreakdown}
              compareProjectBreakdown={compareProjectBreakdown}
              projects={projects}
              loading={dataLoading || projectsLoading}
            />
          </MotionStaggerItem>
        </MotionStagger>
      </section>

      {/*
       * Row 3 — 销售/广告全景
       *   - 左 2fr：跨国家 TOP（取 representativeProjectId 为代表项目调 /all-countries,静默降级)
       *   - 右 3fr：销售 vs 广告花费 双轴对比图（复用 page.tsx 同一份 currentRows/comparisonRows）
       *
       * 子组件根节点已通过 DataTableCard / DataCard 自带 dashboard-surface,
       * 与 row 2 一致,不再包 <DashboardSurfaceCard>,仅加 MotionStagger。
       *
       * BEL-419：row3Ref 挂载 useInViewOnce —— 滚动接近本节才触发 all-countries 取数。
       */}
      <section ref={row3Ref} className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Stagger 容器用 display:contents,不破坏 grid 布局 */}
        <MotionStagger className="contents">
          <MotionStaggerItem>
            <DashboardTopCountries
              countryRowsByCode={countryRowsByCode}
              countryCompareRowsByCode={countryCompareRowsByCode}
              currencyNote={countryCurrencyNote}
              representativeProjectName={
                representativeProjectId
                  ? (projects.find((p) => p.id === representativeProjectId)?.name ?? null)
                  : null
              }
              projectSelector={
                <ProjectSelect
                  value={representativeProjectId ? String(representativeProjectId) : ''}
                  onChange={(v) => setRepresentativeProjectId(Number(v))}
                  placeholder="选择代表项目"
                  triggerClassName="h-8 text-xs min-w-[140px]"
                  projects={projects}
                  loading={projectsLoading}
                  error={projectsError}
                />
              }
              loading={row3InView ? countriesLoading : anyLoading}
            />
          </MotionStaggerItem>
          <MotionStaggerItem>
            <LazyDashboardAdSpendChart
              dailyData={dailyData}
              dateRange={dateRange}
              loading={dataLoading}
              onRefresh={handleRefresh}
            />
          </MotionStaggerItem>
        </MotionStagger>
      </section>
    </div>
  )
}
