import { Skeleton } from '@/components/ui/skeleton'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'

interface DashboardNavigationLoadingProps {
  targetPath: string | null
}

/** V3 Terminal 路由切换时保留外壳，只替换画布内容为轻量骨架。 */
export function DashboardNavigationLoading({ targetPath }: DashboardNavigationLoadingProps) {
  const pageTitle = targetPath ? getDashboardPageTitle(targetPath) : '目标页面'

  return (
    <section
      data-testid="dashboard-navigation-loading"
      aria-busy="true"
      aria-label={`正在加载${pageTitle}`}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-term-border pb-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-term-faint">页面加载中</p>
          <h1 className="truncate text-lg font-semibold text-term-text">{pageTitle}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border border-term-border bg-term-border sm:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-3 bg-term-panel p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(240px,2fr)]" aria-hidden="true">
        <div className="space-y-3 border border-term-border bg-term-panel p-3">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-20" />
          </div>
          <Skeleton className="h-48 w-full sm:h-60" />
        </div>
        <div className="space-y-3 border border-term-border bg-term-panel p-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>

      <div className="space-y-3 border border-term-border bg-term-panel p-3" aria-hidden="true">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-24" />
        </div>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>

      <p className="sr-only" role="status" aria-live="polite">正在打开{pageTitle}</p>
    </section>
  )
}
