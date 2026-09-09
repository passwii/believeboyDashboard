'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import dynamic from 'next/dynamic'

import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { HeaderSlotSelect, HeaderSlotBadge, TERM_HEADER_W_MD } from '@/components/terminal/header-filter-suite'
import {
  MobileFilterStrip,
  MobileFilterWide,
} from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { DailyAnalysisTable } from '@/components/terminal/daily-analysis-table'
import { TermPanel } from '@/components/terminal/term-panel'
import { V2Card } from '@/components/dashboard-v2/v2-card'
import { V2Grid } from '@/components/dashboard-v2/v2-grid'
import { V2Stats } from '@/components/dashboard-v2/v2-stats'
import { V2TopProjects } from '@/components/dashboard-v2/v2-top-projects'
import { V2OrderFlowPanel } from '@/components/dashboard-v2/v2-order-flow-panel'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { formatYMD } from '@/lib/dashboard-format'
import { useNotifications } from '@/components/notifications'
import { Skeleton } from '@/components/ui/skeleton'

// recharts 强依赖 window/document，必须 ssr:false 才能从首屏 bundle 拆出 ~400KB recharts 主体
// 骨架与正式卡（TermChartCard gap-0 + md:col-span-2）同构：BLF-504 修复加载骨架与正式卡不一致
// BLF-978 Stage 3：骨架外壳对齐 TermChartCard（直角 + 1px term 边界 + 零阴影）。
function V2ChartSkeleton({
  titleWidth = 'w-24',
  descWidth = 'w-40',
  chartClass = 'h-60 w-full md:h-80',
}: {
  titleWidth?: string
  descWidth?: string
  chartClass?: string
}) {
  return (
    <div
      className="flex min-w-0 flex-col rounded-none border border-term-border bg-term-panel shadow-none col-span-2"
    >
      <div className="flex flex-col gap-1 p-2">
        <Skeleton className={`h-4 ${titleWidth}`} />
        <Skeleton className={`h-3 ${descWidth}`} />
      </div>
      <div className="px-2 pb-2 pt-1">
        <Skeleton className={chartClass} />
      </div>
    </div>
  )
}

const LazyV2RevenueChart = dynamic(
  () => import('@/components/dashboard-v2/v2-revenue-chart').then((m) => m.V2RevenueChart),
  {
    ssr: false,
    loading: () => <V2ChartSkeleton titleWidth="w-24" descWidth="w-40" chartClass="h-60 w-full md:h-80" />,
  }
)

const LazyV2ChannelChart = dynamic(
  () => import('@/components/dashboard-v2/v2-channel-chart').then((m) => m.V2ChannelChart),
  {
    ssr: false,
    loading: () => <V2ChartSkeleton titleWidth="w-40" descWidth="w-48" chartClass="h-60 w-full md:h-80" />,
  }
)

const LazyV2ProjectChart = dynamic(
  () => import('@/components/dashboard-v2/v2-project-chart').then((m) => m.V2ProjectChart),
  {
    ssr: false,
    loading: () => <V2ChartSkeleton titleWidth="w-40" descWidth="w-48" chartClass="h-52 w-full md:h-64" />,
  }
)

const LazyV2CountryChart = dynamic(
  () => import('@/components/dashboard-v2/v2-country-chart').then((m) => m.V2CountryChart),
  {
    ssr: false,
    loading: () => <V2ChartSkeleton titleWidth="w-40" descWidth="w-48" chartClass="h-52 w-full md:h-64" />,
  }
)

const LazyV2StockChart = dynamic(
  () => import('@/components/dashboard-v2/v2-stock-chart').then((m) => m.V2StockChart),
  {
    ssr: false,
    loading: () => <V2ChartSkeleton titleWidth="w-24" descWidth="w-40" chartClass="h-52 w-full md:h-64" />,
  }
)

const LazyV2TrafficChart = dynamic(
  () => import('@/components/dashboard-v2/v2-traffic-chart').then((m) => m.V2TrafficChart),
  {
    ssr: false,
    loading: () => <V2ChartSkeleton titleWidth="w-40" descWidth="w-48" chartClass="h-52 w-full md:h-64" />,
  }
)

// 与 v1 app/dashboard/page.tsx 的 DailyAnalysisRow 保持一致
type DailyAnalysisRow = {
  date: string
  order_qty: number
  pending_order_qty: number
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

type DailyAnalysisResponse = {
  summary_rows: DailyAnalysisRow[]
  project_breakdown?: Record<number, ProjectBreakdownEntry>
}

type ProjectBreakdownEntry = {
  project_name: string
  summary_rows: DailyAnalysisRow[]
}

type CountryBreakdownEntry = {
  summary_rows: DailyAnalysisRow[]
}

type DailyAnalysisAllCountriesResponse = {
  summary_rows: DailyAnalysisRow[]
  country_breakdown?: Record<string, CountryBreakdownEntry>
  currency_note?: string | null
}

// BLF-913：全部项目 × 全部国家站点聚合（USD 基准）。
// 该端点 country_breakdown 的每项与 /all-countries 的 CountryBreakdownEntry 同构。
type DailyAnalysisAllProjectsCountriesResponse = {
  summary_rows: DailyAnalysisRow[]
  country_breakdown?: Record<string, CountryBreakdownEntry>
  currency_note?: string | null
}

const US_TIMEZONE = 'America/Los_Angeles'

/** 页面级项目过滤选项：'all' = 全部项目（= v1 行为） */
const ALL_PROJECTS = 'all'

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

export default function DashboardV2Page() {
  const { status } = useSession()
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

  const { projects, loading: projectsLoading, error: projectsError } = useManagedProjects()
  const [selectedProjectId, setSelectedProjectId] = useState<string>(ALL_PROJECTS)
  const [currentRows, setCurrentRows] = useState<DailyAnalysisRow[]>([])
  const [comparisonRows, setComparisonRows] = useState<DailyAnalysisRow[]>([])
  const [dataLoading, setDataLoading] = useState(false)
  const latestRequestRef = useRef(0)
  // 项目分解（Top 排行/项目对比图）与跨国家分布（国家图）—— 均来自 daily-analysis 系列端点
  const [projectBreakdown, setProjectBreakdown] = useState<Record<number, ProjectBreakdownEntry>>(
    {}
  )
  const [compareProjectBreakdown, setCompareProjectBreakdown] = useState<
    Record<number, ProjectBreakdownEntry>
  >({})
  const [countryRowsByCode, setCountryRowsByCode] = useState<Record<string, CountryBreakdownEntry>>(
    {}
  )
  const [countryCompareRowsByCode, setCountryCompareRowsByCode] = useState<
    Record<string, CountryBreakdownEntry>
  >({})
  const [countriesLoading, setCountriesLoading] = useState(false)
  const latestCountriesRequestRef = useRef(0)

  useEffect(() => {
    if (projectsError) {
      notify({ type: 'error', title: '项目列表加载失败' })
    }
  }, [projectsError, notify])

  const loadData = useCallback(async () => {
    if (projects.length === 0) return
    const ids =
      selectedProjectId === ALL_PROJECTS
        ? projects.map((p) => String(p.id)).join(',')
        : selectedProjectId
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

      const [response, compareResponse] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, {
          cache: 'no-store',
        }),
        fetch(`/api/backend/api/v1/daily-analysis/all?${compareParams.toString()}`, {
          cache: 'no-store',
        }),
      ])

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || '销售数据加载失败')
      }

      const payload = (await response.json()) as DailyAnalysisResponse
      const comparePayload = compareResponse.ok
        ? ((await compareResponse.json()) as DailyAnalysisResponse)
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
  }, [projects, selectedProjectId, dateRange, notify])

  useEffect(() => {
    if (projects.length > 0) void loadData()
  }, [projects, loadData])

  /**
   * 跨国家分布（V2CountryChart 数据源）。
   * BLF-913：单项目走 /all-countries；"全部项目"走 /all-projects-countries（USD 基准，
   * 跨项目合并后的 country_breakdown），不再回退到第一个项目。随选择变化自动重拉。
   */
  const loadCountriesData = useCallback(async () => {
    if (projects.length === 0) return
    if (!selectedProjectId) return

    const isAll = selectedProjectId === ALL_PROJECTS
    const idsParam = isAll
      ? projects.map((p) => String(p.id)).join(',')
      : selectedProjectId
    if (!idsParam) return

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)
    const currentDayCount =
      Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
    const prevFrom = addDays(dateRange.from, -currentDayCount)
    const prevTo = addDays(dateRange.from, -1)

    const requestId = ++latestCountriesRequestRef.current
    setCountriesLoading(true)

    const paramKey = isAll ? 'project_ids' : 'project_id'
    const endpoint = isAll
      ? '/api/backend/api/v1/daily-analysis/all-projects-countries'
      : '/api/backend/api/v1/daily-analysis/all-countries'

    try {
      const params = new URLSearchParams({
        [paramKey]: idsParam,
        start_date: startDate,
        end_date: endDate,
      })
      const compareParams = new URLSearchParams({
        [paramKey]: idsParam,
        start_date: formatYMD(prevFrom),
        end_date: formatYMD(prevTo),
      })

      const [res, compareRes] = await Promise.all([
        fetch(`${endpoint}?${params.toString()}`, {
          cache: 'no-store',
        }),
        fetch(`${endpoint}?${compareParams.toString()}`, {
          cache: 'no-store',
        }),
      ])

      let nextRows: Record<string, CountryBreakdownEntry> = {}
      let nextCompareRows: Record<string, CountryBreakdownEntry> = {}
      if (res.ok) {
        const payload = (await res.json()) as DailyAnalysisAllCountriesResponse
        nextRows = payload.country_breakdown ?? {}
      }
      if (compareRes.ok) {
        const payload = (await compareRes.json()) as DailyAnalysisAllCountriesResponse
        nextCompareRows = payload.country_breakdown ?? {}
      }

      if (requestId !== latestCountriesRequestRef.current) return
      setCountryRowsByCode(nextRows)
      setCountryCompareRowsByCode(nextCompareRows)
    } catch {
      // 跨国家数据静默降级为空（不阻断主数据）
    } finally {
      if (requestId !== latestCountriesRequestRef.current) return
      setCountriesLoading(false)
    }
  }, [projects, selectedProjectId, dateRange])

  useEffect(() => {
    if (projects.length > 0) void loadCountriesData()
  }, [projects, loadCountriesData])

  // —— BLF-826 阶段 B/C：head 插槽 + 全局刷新 ——
  // 刷新语义：当前项目 + 日期区间条件下，重新拉取主数据 + 跨国家分布。
  // handler 用 ref 桥接，projectId 变化后仍能跑最新闭包。
  const refreshRef = useRef<() => void>(loadData)
  refreshRef.current = () => {
    void loadData()
    void loadCountriesData()
  }
  useHeaderRefresh(() => refreshRef.current(), { loading: dataLoading || projectsLoading })

  // 项目选择（桌面 / 移动端共用同一受控状态，联动一致）
  const projectSelect = (
    <HeaderSlotSelect
      value={selectedProjectId}
      options={[
        { value: ALL_PROJECTS, label: '全部项目' },
        ...projects.map((p) => ({ value: String(p.id), label: p.name })),
      ]}
      onChange={setSelectedProjectId}
      widthClass={TERM_HEADER_W_MD}
      placeholder="选择项目"
    />
  )

  // 数据区间徽标：固定 7 天窗口，标注口径，非筛选控件
  const dateRangeBadge = (className = '') => (
    <HeaderSlotBadge className={className} title="数据区间">
      <span className="font-mono text-xs uppercase tracking-wider text-term-faint">数据区间</span>
      <span className="truncate font-mono text-xs tabular-nums text-term-text">
        {formatYMD(dateRange.from)} → {formatYMD(dateRange.to)}
      </span>
    </HeaderSlotBadge>
  )

  // 筛选控件 + 数据区间徽标 portal 进 Top Header 中段插槽（桌面端）；
  // 刷新走 head 全局按钮（BLF-826 / BLF-881），页面不再渲染独立刷新控件。
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={<>{projectSelect}{dateRangeBadge()}</>} />
  )

  // BLF-930 · 移动端：筛选控件下迁为正文顶部可折叠筛选条。
  // 摘要 = 当前项目名 · 日期范围；展开态 grid-cols-2：项目 Select 占 1/2，
  // 数据区间徽标（宽）用 MobileFilterWide 占整行。
  const mobileFilterSummary = `${selectedProjectId === ALL_PROJECTS ? '全部项目' : (projects.find((p) => String(p.id) === selectedProjectId)?.name ?? '')} · ${formatYMD(dateRange.from)} → ${formatYMD(dateRange.to)}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          {projectSelect}
          <MobileFilterWide>{dateRangeBadge('w-full')}</MobileFilterWide>
        </>
      }
    />
  )

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  const anyLoading = dataLoading || projectsLoading
  const hasData = currentRows.length > 0
  /**
   * 跨国家图代表项目名：单项目时显该名；"全部项目"时为 null（图表描述退化为"各站点销售额分布"，
   * 避免与 BLF-913 的"全部项目 × 全部国家"真实数据混用某单一项目名）。
   */
  const representativeProjectName =
    selectedProjectId === ALL_PROJECTS
      ? null
      : (projects.find((p) => String(p.id) === selectedProjectId)?.name ?? null)

  return (
    <div className="flex flex-col gap-2">
      {/* BLF-826 阶段 C：项目过滤 + 数据区间徽标已上移 Top Header 中段插槽；页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-930：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}

      {/* BLF-926：主区（flex-1）+ 右侧订单流面板（lg 显示，默认折叠窄条 / 展开 320px） */}
      <div className="flex items-stretch gap-px">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <V2Grid>
            {hasData || anyLoading ? (
              <>
                <V2Stats currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />
                <LazyV2RevenueChart currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />
                <LazyV2ChannelChart currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />
                <LazyV2ProjectChart
                  projectBreakdown={projectBreakdown}
                  projects={projects}
                  loading={anyLoading}
                />
                <LazyV2CountryChart
                  countryRowsByCode={countryRowsByCode}
                  representativeProjectName={representativeProjectName}
                  loading={countriesLoading}
                />
                <LazyV2StockChart currentRows={currentRows} comparisonRows={comparisonRows} loading={dataLoading} />
                <LazyV2TrafficChart currentRows={currentRows} loading={dataLoading} />
              </>
            ) : (
              <V2Card className="col-span-full gap-0">
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                  <span>暂无销售数据</span>
                  <button
                    type="button"
                    onClick={() => void loadData()}
                    className="border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    重试
                  </button>
                </div>
              </V2Card>
            )}
            <V2TopProjects
              projectBreakdown={projectBreakdown}
              compareProjectBreakdown={compareProjectBreakdown}
              projects={projects}
              loading={anyLoading}
            />
          </V2Grid>

          {/* Pattern A 高密度明细表：近 14 天销售数据（日环比着色 + 等宽数字） */}
          <TermPanel title="近 14 天明细" bodyClassName="overflow-hidden">
            <DailyAnalysisTable rows={currentRows} loading={dataLoading && currentRows.length === 0} />
          </TermPanel>
        </div>

        <V2OrderFlowPanel
          currentRows={currentRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
          loading={anyLoading}
          dateFrom={formatYMD(dateRange.from)}
          dateTo={formatYMD(dateRange.to)}
        />
      </div>
      {/* BLF-999：移动端订单流底栏为 fixed 贴底，正文让出一栏高度防遮挡（lg+ 无底栏不占位） */}
      <div className="h-11 lg:hidden" aria-hidden="true" />
    </div>
  )
}
