'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { V2AlertFeed } from '@/components/dashboard-v2/v2-alert-feed'
import { V2Grid } from '@/components/dashboard-v2/v2-grid'
import { V2Stats } from '@/components/dashboard-v2/v2-stats'
import { V2TopProjects } from '@/components/dashboard-v2/v2-top-projects'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { formatYMD } from '@/lib/dashboard-format'
import { useNotifications } from '@/components/notifications'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

// recharts 强依赖 window/document，必须 ssr:false 才能从首屏 bundle 拆出 ~400KB recharts 主体
const LazyV2RevenueChart = dynamic(
  () => import('@/components/dashboard-v2/v2-revenue-chart').then((m) => m.V2RevenueChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-24" />
        <Skeleton className="mb-4 h-3 w-40" />
        <Skeleton className="h-60 w-full md:h-80" />
      </div>
    ),
  }
)

const LazyV2ChannelChart = dynamic(
  () => import('@/components/dashboard-v2/v2-channel-chart').then((m) => m.V2ChannelChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-40" />
        <Skeleton className="mb-4 h-3 w-48" />
        <Skeleton className="h-60 w-full md:h-80" />
      </div>
    ),
  }
)

const LazyV2ProjectChart = dynamic(
  () => import('@/components/dashboard-v2/v2-project-chart').then((m) => m.V2ProjectChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-40" />
        <Skeleton className="mb-4 h-3 w-48" />
        <Skeleton className="h-52 w-full" />
      </div>
    ),
  }
)

const LazyV2CountryChart = dynamic(
  () => import('@/components/dashboard-v2/v2-country-chart').then((m) => m.V2CountryChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-40" />
        <Skeleton className="mb-4 h-3 w-48" />
        <Skeleton className="h-52 w-full" />
      </div>
    ),
  }
)

const LazyV2StockChart = dynamic(
  () => import('@/components/dashboard-v2/v2-stock-chart').then((m) => m.V2StockChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-24" />
        <Skeleton className="mb-4 h-3 w-40" />
        <Skeleton className="h-52 w-full" />
      </div>
    ),
  }
)

const LazyV2TrafficChart = dynamic(
  () => import('@/components/dashboard-v2/v2-traffic-chart').then((m) => m.V2TrafficChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-40" />
        <Skeleton className="mb-4 h-3 w-48" />
        <Skeleton className="h-52 w-full" />
      </div>
    ),
  }
)

// 与 v1 app/dashboard/page.tsx 的 DailyAnalysisRow 保持一致
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
   * 跨国家分布（V2CountryChart 数据源）：/all-countries 只接受单 project_id。
   * 页面选择单项目时用该项目；"全部项目"时回退到第一个项目。随选择变化自动重拉。
   */
  const loadCountriesData = useCallback(async () => {
    if (projects.length === 0) return
    const effectiveProjectId =
      selectedProjectId === ALL_PROJECTS ? String(projects[0]?.id ?? '') : selectedProjectId
    if (!effectiveProjectId) return

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)
    const currentDayCount =
      Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
    const prevFrom = addDays(dateRange.from, -currentDayCount)
    const prevTo = addDays(dateRange.from, -1)

    const requestId = ++latestCountriesRequestRef.current
    setCountriesLoading(true)

    try {
      const params = new URLSearchParams({
        project_id: effectiveProjectId,
        start_date: startDate,
        end_date: endDate,
      })
      const compareParams = new URLSearchParams({
        project_id: effectiveProjectId,
        start_date: formatYMD(prevFrom),
        end_date: formatYMD(prevTo),
      })

      const [res, compareRes] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all-countries?${params.toString()}`, {
          cache: 'no-store',
        }),
        fetch(`/api/backend/api/v1/daily-analysis/all-countries?${compareParams.toString()}`, {
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

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  const anyLoading = dataLoading || projectsLoading
  const hasData = currentRows.length > 0
  /** 跨国家图代表项目名（"全部项目"时取第一个） */
  const representativeProjectName =
    selectedProjectId === ALL_PROJECTS
      ? (projects[0]?.name ?? null)
      : (projects.find((p) => String(p.id) === selectedProjectId)?.name ?? null)

  return (
    <div className="space-y-4">
      {/* 顶部工具栏：页面级项目过滤 + 返回旧版 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue placeholder="选择项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>全部项目</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button asChild size="sm" variant="ghost">
          <Link href="/dashboard">
            <ArrowLeft className="mr-1 h-4 w-4" />
            返回旧版
          </Link>
        </Button>
      </div>

      <V2Grid>
        {hasData || anyLoading ? (
          <>
            <V2Stats currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />
            <LazyV2RevenueChart currentRows={currentRows} comparisonRows={comparisonRows} />
            <LazyV2ChannelChart currentRows={currentRows} comparisonRows={comparisonRows} />
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
          <div className="col-span-full flex flex-col items-center justify-center gap-3 bg-background py-16 text-sm text-muted-foreground">
            <span>暂无销售数据</span>
            <Button onClick={() => void loadData()} size="sm" variant="outline">
              重试
            </Button>
          </div>
        )}
        <V2TopProjects
          projectBreakdown={projectBreakdown}
          compareProjectBreakdown={compareProjectBreakdown}
          projects={projects}
          loading={anyLoading}
        />
        <V2AlertFeed />
      </V2Grid>
    </div>
  )
}
