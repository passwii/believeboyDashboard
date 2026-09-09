'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'

import { PortfolioFilters } from '@/components/dashboard/portfolio/portfolio-filters'
import { TermPanel } from '@/components/terminal/term-panel'
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
import { BarChart3, PieChart, TrendingUp, type LucideIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'

type Tab = 'comparison' | 'trend' | 'contribution'

// recharts 强依赖 window/document，必须 ssr:false 才能从 portfolio 页面 bundle 拆出 recharts 主体
const LazyPortfolioTrendChart = dynamic(
  () =>
    import('@/components/dashboard/portfolio/portfolio-trend-chart').then(
      (m) => m.PortfolioTrendChart
    ),
  {
    ssr: false,
    loading: () => (
      <div className="border border-term-border bg-term-panel p-2">
        <Skeleton className="h-[320px] w-full rounded-none" />
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
      <div className="border border-term-border bg-term-panel p-2">
        <Skeleton className="h-[320px] w-full rounded-none" />
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
    <div className="flex min-w-0 flex-col gap-0.5 border border-term-border bg-term-panel px-2 py-1.5">
      <span className="truncate font-mono text-xs uppercase tracking-wider text-term-muted">
        {label}
      </span>
      <span className="truncate font-mono text-base leading-6 tabular-nums text-term-text" title={value}>
        {value}
      </span>
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

  const currency = CURRENCY_SYMBOL[country] ?? '$'

  return (
    <div className="max-h-[420px] overflow-auto term-scroll">
      <TermTable>
        <TermTHead>
          <TermRow className="hover:bg-transparent">
            <TermHead onClick={() => toggleSort('project_name')}>项目</TermHead>
            <TermHead numeric onClick={() => toggleSort('sales_amount')}>销售额</TermHead>
            <TermHead numeric onClick={() => toggleSort('sales_contribution')}>占比</TermHead>
            <TermHead numeric onClick={() => toggleSort('order_qty')}>订单量</TermHead>
            <TermHead numeric onClick={() => toggleSort('ad_spend')}>广告费</TermHead>
            <TermHead numeric onClick={() => toggleSort('cpc')}>CPC</TermHead>
            <TermHead numeric onClick={() => toggleSort('conversion_rate')}>转化率</TermHead>
            <TermHead numeric onClick={() => toggleSort('clicks')}>点击量</TermHead>
            <TermHead numeric onClick={() => toggleSort('sessions')}>访问量</TermHead>
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
                  className="text-xs text-term-muted underline-offset-2 transition-colors hover:text-term-text hover:underline"
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
  const [projectIds, setProjectIds] = useState<number[]>([])
  const [country, setCountry] = useState('US')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('comparison')

  const { data, loading, error, refresh } = usePortfolioData({
    projectIds,
    country,
    startDate,
    endDate,
  })

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
      loading={loading}
    />
  )

  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileFilterSummary = `${projectIds.length === 0 ? '全部项目' : `${projectIds.length} 个项目`} · ${country} · ${startDate || '?'}~${endDate || '?'}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={<PortfolioFilters
        projectIds={projectIds}
        onProjectIdsChange={setProjectIds}
        country={country}
        onCountryChange={setCountry}
        startDate={startDate}
        onStartDateChange={setStartDate}
        endDate={endDate}
        onEndDateChange={setEndDate}
        loading={loading}
      />}
    />
  )

  useEffect(() => {
    void session
  }, [session])

  const tabs: Array<{ key: Tab; label: string; icon: LucideIcon }> = [
    { key: 'comparison', label: '项目对比', icon: BarChart3 },
    { key: 'trend', label: '趋势对比', icon: TrendingUp },
    { key: 'contribution', label: '贡献占比', icon: PieChart },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* BLF-826 阶段 C：筛选控件已上移 Top Header 中段插槽；页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}
      {/* 页面级标题已由 TerminalHeader 面包屑承载；不再渲染 PageHeader 胶囊（BLF-824 去重原则） */}

      {error && (
        <div
          role="alert"
          className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          ERR · {error}
        </div>
      )}

      {data && data.projects.length > 0 ? (
        <>
          {/* KPI 统计条：终端磁贴 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
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

          <TermPanel bodyClassName="min-h-0">
            {/* 页内 Tab 切换条（h-10 标题带规格，BLF-887 上档）；BLF-883：前置 icon + 激活态 accent 发光指示条，
                与全局 term Tab 激活语言一致 */}
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-term-border px-2">
              {tabs.map((tab) => {
                const Icon = tab.icon
                const isActive = activeTab === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    aria-selected={isActive}
                    role="tab"
                    className={
                      isActive
                        ? 'relative flex h-8 items-center gap-1.5 border border-term-border bg-term-raised px-2 font-mono text-xs font-semibold text-term-text'
                        : 'flex h-8 items-center gap-1.5 border border-transparent px-2 font-mono text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text'
                    }
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {tab.label}
                    {isActive && (
                      <span className="absolute inset-x-0 bottom-0 h-[2px] bg-term-accent shadow-[0_0_8px_color-mix(in_srgb,var(--term-accent)_60%,transparent),0_0_16px_color-mix(in_srgb,var(--term-accent)_30%,transparent)]" />
                    )}
                  </button>
                )
              })}
            </div>

            {activeTab === 'comparison' && (
              <ComparisonTable
                projects={data.projects}
                country={country}
                onSelectProject={(projectId) =>
                  router.push(`/dashboard/operations/daily-analysis?project=${projectId}`)
                }
              />
            )}
            {activeTab === 'trend' && (
              <LazyPortfolioTrendChart projects={data.projects} country={country} />
            )}
            {activeTab === 'contribution' && (
              <LazyPortfolioPieChart projects={data.projects} country={country} />
            )}
          </TermPanel>
        </>
      ) : !loading && projectIds.length > 0 ? (
        <div className="flex flex-col items-center justify-center border border-dashed border-term-border py-16 font-mono text-xs text-term-faint">
          暂无数据，请检查日期范围或项目选择
        </div>
      ) : null}
    </div>
  )
}
