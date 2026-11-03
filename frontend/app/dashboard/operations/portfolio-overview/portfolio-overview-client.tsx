'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useSession } from 'next-auth/react'

import {
  PortfolioFilters,
  type PortfolioProjectOption,
} from '@/components/dashboard/portfolio/portfolio-filters'
import {
  COUNTRY_TIMEZONE_MAP,
  formatDateInputValue,
  getTodayInTimezone,
} from '@/components/ui/date-picker'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { usePortfolioData, type ProjectPortfolioKPI } from '@/lib/hooks/use-portfolio-data'
import { ArrowDown, ArrowUp, BarChart3, PieChart, TrendingUp, type LucideIcon } from 'lucide-react'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'

import styles from './portfolio-overview-warm.module.css'

type Tab = 'comparison' | 'trend' | 'contribution'

function getInitialPortfolioDateRange() {
  const end = getTodayInTimezone(COUNTRY_TIMEZONE_MAP.US)
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  return {
    startDate: formatDateInputValue(start),
    endDate: formatDateInputValue(end),
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

// recharts 强依赖 window/document，必须 ssr:false 才能从 portfolio 页面 bundle 拆出 recharts 主体
const LazyPortfolioTrendChart = dynamic(
  () =>
    import('@/components/dashboard/portfolio/portfolio-trend-chart').then(
      (m) => m.PortfolioTrendChart
    ),
  {
    ssr: false,
    loading: () => (
      <div className={styles.chartLoader} role="status" aria-busy="true">
        <span className={styles.visuallyHidden}>正在加载趋势数据</span>
        <div className={styles.chartLoadingSurface} aria-hidden="true" />
      </div>
    ),
  }
)

const LazyPortfolioPieChart = dynamic(
  () =>
    import('@/components/dashboard/portfolio/portfolio-pie-chart').then((m) => m.PortfolioPieChart),
  {
    ssr: false,
    loading: () => (
      <div className={styles.chartLoader} role="status" aria-busy="true">
        <span className={styles.visuallyHidden}>正在加载贡献数据</span>
        <div className={styles.chartLoadingSurface} aria-hidden="true" />
      </div>
    ),
  }
)

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

function formatMoneyShort(value: number, country: string): string {
  const symbol = CURRENCY_SYMBOL[country] ?? '$'
  if (value >= 10000) return `${symbol}${(value / 10000).toFixed(1)}万`
  return `${symbol}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatInt(value: number): string {
  return value.toLocaleString('zh-CN')
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`
}

/** KPI 终端磁贴：mono 数值 + 标签行（与 HeaderKpiTile / TermMetricTile 同规格） */
function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div data-testid="portfolio-kpi-card" className={styles.kpiTile}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue} title={value}>
        {value}
      </span>
    </div>
  )
}

function PortfolioLoadingState() {
  return (
    <div className={styles.initialLoading} role="status" aria-busy="true">
      <span>正在加载组合数据</span>
      <div className={styles.kpiSkeletonGrid} aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <div className={styles.kpiSkeleton} key={index} />
        ))}
      </div>
      <div className={styles.panelSkeleton} aria-hidden="true">
        <div className={styles.tabSkeleton} />
        <div className={styles.chartLoadingSurface} />
      </div>
    </div>
  )
}

/** 项目对比高密度表（TermTable 规范）：等宽数值右对齐、排序点击、跳详情 */
function ComparisonTable({
  projects,
  country,
  onSelectProject,
}: {
  projects: ProjectPortfolioKPI[]
  country: string
  onSelectProject: (projectId: number) => void
}) {
  const [sortKey, setSortKey] = useState<keyof ProjectPortfolioKPI>('sales_amount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const rows = [...projects]
    rows.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return rows
  }, [projects, sortKey, sortDir])

  const toggleSort = (key: keyof ProjectPortfolioKPI) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortHeader = (key: keyof ProjectPortfolioKPI, label: string, numeric = false) => {
    const active = key === sortKey
    const direction = sortDir === 'asc' ? 'ascending' : 'descending'
    const DirectionIcon = sortDir === 'asc' ? ArrowUp : ArrowDown

    return (
      <th
        key={key}
        scope="col"
        aria-sort={active ? direction : undefined}
        className={`${styles.sortHead} ${numeric ? styles.sortHeadNumeric : ''}`}
      >
        <button
          type="button"
          className={`${styles.sortButton} ${numeric ? styles.sortButtonNumeric : ''}`}
          onClick={() => toggleSort(key)}
          aria-label={active ? `按${label}排序，当前${sortDir === 'asc' ? '升序' : '降序'}` : `按${label}排序`}
        >
          <span>{label}</span>
          {active ? <DirectionIcon className={styles.sortDirection} aria-hidden="true" /> : null}
        </button>
      </th>
    )
  }

  const currency = CURRENCY_SYMBOL[country] ?? '$'

  return (
    <div className={styles.tableScroll}>
      <TermTable className={styles.comparisonTable} aria-label="项目对比表">
        <TermTHead>
          <TermRow className="hover:bg-transparent">
            {sortHeader('project_name', '项目')}
            {sortHeader('sales_amount', '销售额', true)}
            {sortHeader('sales_contribution', '占比', true)}
            {sortHeader('order_qty', '订单量', true)}
            {sortHeader('ad_spend', '广告费', true)}
            {sortHeader('cpc', 'CPC', true)}
            {sortHeader('conversion_rate', '转化率', true)}
            {sortHeader('clicks', '点击量', true)}
            {sortHeader('sessions', '访问量', true)}
            <TermHead />
          </TermRow>
        </TermTHead>
        <TermBody>
          {sorted.map((p) => (
            <TermRow key={p.project_id}>
              <TermCell>{p.project_name}</TermCell>
              <TermCell numeric>{formatMoneyShort(p.sales_amount, country)}</TermCell>
              <TermCell numeric tone="muted">{formatPercent(p.sales_contribution)}</TermCell>
              <TermCell numeric>{formatInt(p.order_qty)}</TermCell>
              <TermCell numeric>{formatMoneyShort(p.ad_spend, country)}</TermCell>
              <TermCell numeric tone={p.clicks === 0 ? 'muted' : undefined}>
                {p.clicks === 0 ? '--' : `${currency}${p.cpc.toFixed(2)}`}
              </TermCell>
              <TermCell numeric>{formatPercent(p.conversion_rate)}</TermCell>
              <TermCell numeric>{formatInt(p.clicks)}</TermCell>
              <TermCell numeric>{formatInt(p.sessions)}</TermCell>
              <TermCell>
                <button
                  type="button"
                  className={styles.detailButton}
                  aria-label={`查看${p.project_name}详情`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectProject(p.project_id)
                  }}
                >
                  详情
                </button>
              </TermCell>
            </TermRow>
          ))}
        </TermBody>
      </TermTable>
    </div>
  )
}

export default function PortfolioOverviewClient() {
  const router = useRouter()
  const { data: session } = useSession()
  const { setFiltersForNavigation } = useTerminalGlobalFilter()
  const [projectIds, setProjectIds] = useState<number[]>([])
  const [country, setCountry] = useState('US')
  const [dateRange, setDateRange] = useState(getInitialPortfolioDateRange)
  const { startDate, endDate } = dateRange
  const [activeTab, setActiveTab] = useState<Tab>('comparison')
  const [projects, setProjects] = useState<PortfolioProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [retryingProjects, setRetryingProjects] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectLoadAttempt, setProjectLoadAttempt] = useState(0)
  const forceProjectFetchRef = useRef(false)

  useEffect(() => {
    let active = true
    const forceFetch = forceProjectFetchRef.current
    forceProjectFetchRef.current = false
    setLoadingProjects(true)
    setProjectError(null)

    void (async () => {
      try {
        const data = await fetchManagedProjectsCached<PortfolioProjectOption[]>(
          session,
          undefined,
          forceFetch ? { force: true } : undefined
        )
        if (!active) return
        setProjects(data)
      } catch (error) {
        if (active) setProjectError(getErrorMessage(error))
      } finally {
        if (active) {
          setLoadingProjects(false)
          setRetryingProjects(false)
        }
      }
    })()

    return () => {
      active = false
    }
  }, [projectLoadAttempt, session])

  function retryProjects() {
    forceProjectFetchRef.current = true
    setRetryingProjects(true)
    setLoadingProjects(true)
    setProjectError(null)
    setProjectLoadAttempt((attempt) => attempt + 1)
  }

  function setStartDate(startDate: string) {
    setDateRange((current) => ({ ...current, startDate }))
  }

  function setEndDate(endDate: string) {
    setDateRange((current) => ({ ...current, endDate }))
  }

  const { data, loading, error, refresh } = usePortfolioData({
    projectIds,
    country,
    startDate,
    endDate,
  })

  const missingProjectSelection = projectIds.length === 0
  const missingDateRange = !startDate || !endDate
  const filterPrompt =
    missingProjectSelection && missingDateRange
      ? '请先选择项目并设置完整日期范围，再查看组合数据。'
      : missingProjectSelection
        ? '请先选择至少一个项目，再查看组合数据。'
        : missingDateRange
          ? '请设置完整日期范围，再查看组合数据。'
          : null

  // —— BLF-826 阶段 B/C：head 插槽 + 全局刷新 ——
  // 刷新语义与原 RefreshButton 一致。
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const { setLoading: setHeaderRefreshLoading } = useHeaderRefresh(() => refreshRef.current(), {
    loading,
  })

  const filterControls = (
    <PortfolioFilters
      projectIds={projectIds}
      onProjectIdsChange={setProjectIds}
      country={country}
      onCountryChange={setCountry}
      startDate={startDate}
      onStartDateChange={setStartDate}
      endDate={endDate}
      onEndDateChange={setEndDate}
      projects={projects}
      loadingProjects={loadingProjects}
      retryingProjects={retryingProjects}
      projectError={projectError}
      onRetryProjects={retryProjects}
    />
  )

  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const projectSummary = projectIds.length === 0 ? '未选项目' : `${projectIds.length} 个项目`
  const mobileFilterSummary = `${projectSummary} · ${country} · ${startDate || '未设置'}~${endDate || '未设置'}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <div className="col-span-2 min-w-0">
          <PortfolioFilters
            projectIds={projectIds}
            onProjectIdsChange={setProjectIds}
            country={country}
            onCountryChange={setCountry}
            startDate={startDate}
            onStartDateChange={setStartDate}
            endDate={endDate}
            onEndDateChange={setEndDate}
            projects={projects}
            loadingProjects={loadingProjects}
            retryingProjects={retryingProjects}
            projectError={projectError}
            onRetryProjects={retryProjects}
          />
        </div>
      }
    />
  )

  const tabs: Array<{ key: Tab; label: string; icon: LucideIcon }> = [
    { key: 'comparison', label: '项目对比', icon: BarChart3 },
    { key: 'trend', label: '趋势对比', icon: TrendingUp },
    { key: 'contribution', label: '贡献占比', icon: PieChart },
  ]

  return (
    <div className={styles.page} aria-busy={loading}>
      {/* BLF-826 阶段 C：筛选控件已上移 Top Header 中段插槽；页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}
      {/* 页面级标题已由 TerminalHeader 面包屑承载；不再渲染 PageHeader 胶囊（BLF-824 去重原则） */}

      {loading && data && data.projects.length > 0 && (
        <div className={styles.refreshStatus} role="status">
          正在更新组合数据
        </div>
      )}

      {error && (
        <div role="alert" className={styles.errorState}>
          <span>组合数据加载失败：{error}</span>
          <button type="button" className={styles.retryButton} onClick={refresh}>
            重试
          </button>
        </div>
      )}

      {loading && (!data || data.projects.length === 0) && <PortfolioLoadingState />}

      {!loading && !error && !data && filterPrompt && (
        <div className={styles.emptyState} role="status">
          {filterPrompt}
        </div>
      )}

      {data && data.projects.length > 0 ? (
        <>
          {/* KPI 统计条：终端磁贴 */}
          <div className={styles.kpiGrid} data-testid="portfolio-kpi-cards">
            <KpiTile
              label="总销售额"
              value={formatMoneyShort(data.total_sales_amount, country)}
            />
            <KpiTile label="总订单量" value={formatInt(data.total_order_qty)} />
            <KpiTile label="总广告费" value={formatMoneyShort(data.total_ad_spend, country)} />
            <KpiTile
              label="平均转化率"
              value={formatPercent(data.avg_conversion_rate)}
            />
            <KpiTile label="项目数量" value={String(data.projects.length)} />
          </div>

          <section className={styles.analyticsPanel}>
            <div className={styles.tabBar} role="tablist" aria-label="组合数据视图">
              {tabs.map((tab) => {
                const Icon = tab.icon
                const isActive = activeTab === tab.key
                return (
                  <button
                    key={tab.key}
                    id={`portfolio-tab-${tab.key}`}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    onKeyDown={(event) => {
                      const currentIndex = tabs.findIndex(({ key }) => key === tab.key)
                      let nextIndex = currentIndex

                      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
                      else if (event.key === 'ArrowLeft') {
                        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
                      } else if (event.key === 'Home') nextIndex = 0
                      else if (event.key === 'End') nextIndex = tabs.length - 1
                      else return

                      event.preventDefault()
                      const nextTab = tabs[nextIndex]
                      setActiveTab(nextTab.key)
                      document.getElementById(`portfolio-tab-${nextTab.key}`)?.focus()
                    }}
                    aria-selected={isActive}
                    role="tab"
                    aria-controls="portfolio-tabpanel"
                    tabIndex={isActive ? 0 : -1}
                    className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {tab.label}
                  </button>
                )
              })}
            </div>

            <div
              className={styles.panelContent}
              id="portfolio-tabpanel"
              role="tabpanel"
              aria-labelledby={`portfolio-tab-${activeTab}`}
              tabIndex={0}
            >
              {activeTab === 'comparison' && (
                <ComparisonTable
                  projects={data.projects}
                  country={country}
                  onSelectProject={(projectId) => {
                    if (!startDate || !endDate) return

                    const value = String(projectId)
                    setFiltersForNavigation({
                      projectId: value,
                      country,
                      dateFrom: startDate,
                      dateTo: endDate,
                    })
                    const params = new URLSearchParams({
                      project: value,
                      country,
                      gProject: value,
                      gCountry: country,
                      gDateFrom: startDate,
                      gDateTo: endDate,
                    })
                    router.push(
                      `/dashboard/operations/daily-analysis?${params.toString()}`
                    )
                  }}
                />
              )}
              {activeTab === 'trend' && (
                <div className={styles.chartRegion} role="group" aria-label="多项目趋势对比">
                  <span className={styles.visuallyHidden}>
                    按日期比较以下项目的趋势：
                    {data.projects.map((project) => project.project_name).join('、')}。
                    图表可切换销售额、订单量、广告费和转化率。
                  </span>
                  <LazyPortfolioTrendChart projects={data.projects} country={country} />
                </div>
              )}
              {activeTab === 'contribution' && (
                <div className={styles.chartRegion}>
                  <LazyPortfolioPieChart projects={data.projects} country={country} />
                </div>
              )}
            </div>
          </section>
        </>
      ) : !loading && !error && data ? (
        <div className={styles.emptyState}>
          暂无数据，请检查日期范围或项目选择
        </div>
      ) : null}
    </div>
  )
}
