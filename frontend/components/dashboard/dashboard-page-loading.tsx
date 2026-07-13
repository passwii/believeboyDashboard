import { Skeleton } from '@/components/ui/skeleton'

function MetricTileSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-background/70 p-5 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-14" />
        </div>
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>
      <Skeleton className="mt-2 h-8 w-full rounded" />
    </div>
  )
}

function ChartSkeleton() {
  return (
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
  )
}

function StatusSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <Skeleton className="h-5 w-24" />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  )
}

function AlertWidgetSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <Skeleton className="h-5 w-20" />
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  )
}

function HealthKpisSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <div className="flex items-center justify-between pb-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-6 w-16 rounded-md" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  )
}

function TopProjectsSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <div className="flex items-center justify-between pb-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-7 w-32 rounded-md" />
      </div>
      {/* Phase 5: 与 DashboardTopProjects 保持 10 行 + max-h 滚动条 */}
      <div className="max-h-[420px] space-y-2 overflow-y-auto">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}

function TopCountriesSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <div className="flex items-center justify-between pb-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-6 w-16 rounded-md" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  )
}

function AdSpendChartSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <div className="flex items-center justify-between pb-3">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-52" />
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
  )
}

export function DashboardPageLoading() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-8 w-16" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="grid grid-cols-2 gap-4">
          <MetricTileSkeleton />
          <MetricTileSkeleton />
          <MetricTileSkeleton />
          <MetricTileSkeleton />
        </div>
        <ChartSkeleton />
      </div>

      <StatusSkeleton />

      {/* Row 2: 告警中心 + 健康度 + TOP 项目/店铺(与 page.tsx Row 2 三列布局保持一致) */}
      <div className="grid gap-5 lg:grid-cols-3">
        <AlertWidgetSkeleton />
        <HealthKpisSkeleton />
        <TopProjectsSkeleton />
      </div>

      {/* Row 3: 跨国家 TOP + 销售 vs 广告花费(与 page.tsx Row 3 布局保持一致) */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <TopCountriesSkeleton />
        <AdSpendChartSkeleton />
      </div>
    </div>
  )
}
