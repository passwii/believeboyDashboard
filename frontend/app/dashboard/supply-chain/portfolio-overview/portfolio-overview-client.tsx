'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { BarChart3 } from 'lucide-react'
import dynamic from 'next/dynamic'

import { PortfolioFilters } from '@/components/dashboard/portfolio/portfolio-filters'
import { PortfolioKPICards } from '@/components/dashboard/portfolio/portfolio-kpi-cards'
import { PortfolioComparisonTable } from '@/components/dashboard/portfolio/portfolio-comparison-table'
import { FilterToolbar } from '@/components/dashboard/console/filter-toolbar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { usePortfolioData } from '@/lib/hooks/use-portfolio-data'

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
      <div className="dashboard-surface rounded-xl p-4">
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-[320px] w-full rounded-lg" />
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
      <div className="dashboard-surface rounded-xl p-4">
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-[320px] w-full rounded-lg" />
      </div>
    ),
  }
)

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

  return (
    <div className="flex flex-col gap-4">
      <div className="dashboard-toolbar">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[linear-gradient(180deg,#0f527a,#1675ae)] text-white">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">组合分析</h1>
            <p className="text-xs text-muted-foreground">跨项目 KPI 对比、趋势分析和贡献占比</p>
          </div>
        </div>
      </div>
      <FilterToolbar>
        <PortfolioFilters
          projectIds={projectIds}
          onProjectIdsChange={setProjectIds}
          country={country}
          onCountryChange={setCountry}
          startDate={startDate}
          onStartDateChange={setStartDate}
          endDate={endDate}
          onEndDateChange={setEndDate}
          onRefresh={refresh}
          loading={loading}
        />
      </FilterToolbar>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {data && data.projects.length > 0 ? (
        <>
          <PortfolioKPICards data={data} country={country} />
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="comparison">项目对比</TabsTrigger>
              <TabsTrigger value="trend">趋势对比</TabsTrigger>
              <TabsTrigger value="contribution">贡献占比</TabsTrigger>
            </TabsList>
            <TabsContent value="comparison">
              <PortfolioComparisonTable projects={data.projects} country={country} />
            </TabsContent>
            <TabsContent value="trend">
              <LazyPortfolioTrendChart projects={data.projects} country={country} />
            </TabsContent>
            <TabsContent value="contribution">
              <LazyPortfolioPieChart projects={data.projects} country={country} />
            </TabsContent>
          </Tabs>
        </>
      ) : !loading && projectIds.length > 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-muted-foreground">
          <BarChart3 className="mb-3 h-10 w-10 opacity-40" />
          <p>暂无数据，请检查日期范围或项目选择</p>
        </div>
      ) : null}
    </div>
  )
}
