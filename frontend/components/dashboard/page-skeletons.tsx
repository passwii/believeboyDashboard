import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * BEL-419 统一骨架屏模块。
 *
 * 约定：
 * - 所有路由级 `loading.tsx` 一律使用本模块导出的组合骨架，禁止再直接复用
 *   按首页布局定制的 `DashboardPageLoading`（它只属于 `app/dashboard/loading.tsx`）。
 * - 本模块全部为纯展示组件（无 state / 无浏览器 API），可在 server component
 *   的 loading.tsx 中直接渲染，保持骨架本身零 JS 开销。
 *
 * 选型指引：
 * - 表格类页面（CRM / reports / finance / supply-chain / system）→ `TablePageLoading`
 * - 分析类页面（advertising / operations / ad-analysis）→ `AnalyticsPageLoading`
 * - 卡片/hub 类页面（ai hub 等）→ `SimplePageLoading`
 */

interface PageHeaderSkeletonProps {
  className?: string
}

export function PageHeaderSkeleton({ className }: PageHeaderSkeletonProps) {
  return (
    <div
      data-testid="page-skeleton-header"
      className={cn('flex items-center justify-between', className)}
    >
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-3 w-72" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-28 rounded-md" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
    </div>
  )
}

interface FilterBarSkeletonProps {
  /** 过滤器控件数量，默认 3 */
  count?: number
  className?: string
}

export function FilterBarSkeleton({ count = 3, className }: FilterBarSkeletonProps) {
  return (
    <div
      data-testid="page-skeleton-filters"
      className={cn('flex flex-wrap items-center gap-3', className)}
    >
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className="h-9 w-40 rounded-md" />
      ))}
      <Skeleton className="ml-auto h-9 w-24 rounded-md" />
    </div>
  )
}

interface KpiCardsSkeletonProps {
  /** KPI 卡片数量，默认 4 */
  count?: number
  className?: string
}

export function KpiCardsSkeleton({ count = 4, className }: KpiCardsSkeletonProps) {
  return (
    <div
      data-testid="page-skeleton-kpis"
      className={cn('grid grid-cols-2 gap-4 xl:grid-cols-4', className)}
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="space-y-2 rounded-xl border border-border/50 bg-background/70 p-4"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

interface DataTableSkeletonProps {
  /** 列数，默认 6 */
  columns?: number
  /** 行数，默认 8 */
  rows?: number
  /** 是否渲染表格工具条（标题 + 操作按钮），默认 true */
  toolbar?: boolean
  className?: string
}

export function DataTableSkeleton({
  columns = 6,
  rows = 8,
  toolbar = true,
  className,
}: DataTableSkeletonProps) {
  return (
    <div
      data-testid="page-skeleton-table"
      className={cn('rounded-xl border border-border/50 bg-background/70', className)}
    >
      {toolbar ? (
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-44 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
      ) : null}
      <div className="space-y-0 p-4">
        <div className="grid grid-cols-6 gap-3 border-b border-border/40 pb-3">
          {Array.from({ length: Math.min(columns, 6) }).map((_, index) => (
            <Skeleton key={index} className="h-3 w-full max-w-24" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid grid-cols-6 items-center gap-3 border-b border-border/20 py-3 last:border-b-0"
          >
            {Array.from({ length: Math.min(columns, 6) }).map((_, cellIndex) => (
              <Skeleton
                key={cellIndex}
                className={cn('h-4', cellIndex === 0 ? 'w-full max-w-32' : 'w-full max-w-20')}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-4 pb-4">
        <Skeleton className="h-3 w-24" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </div>
  )
}

interface ChartPanelSkeletonProps {
  /** 图表区域高度，默认 280px */
  height?: string
  className?: string
}

export function ChartPanelSkeleton({ height = 'h-[280px]', className }: ChartPanelSkeletonProps) {
  return (
    <div
      data-testid="page-skeleton-chart"
      className={cn('rounded-xl border border-border/50 bg-background/70 p-5', className)}
    >
      <div className="flex items-center justify-between pb-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
        </div>
      </div>
      <Skeleton className={cn('w-full rounded-lg', height)} />
    </div>
  )
}

interface CardListSkeletonProps {
  /** 卡片数量，默认 6 */
  count?: number
  className?: string
}

export function CardListSkeleton({ count = 6, className }: CardListSkeletonProps) {
  return (
    <div
      data-testid="page-skeleton-cards"
      className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', className)}
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="space-y-3 rounded-xl border border-border/50 bg-background/70 p-5"
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-6 w-14 rounded-full" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex items-center justify-between pt-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 对话类页面骨架：标题 + 消息气泡 + 输入框。
 * 用于 AI chat 等会话页。
 */
export function ChatPageLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="页面加载中">
      <PageHeaderSkeleton />
      <div
        data-testid="page-skeleton-chat"
        className="space-y-4 rounded-xl border border-border/50 bg-background/70 p-5"
      >
        <div className="flex justify-start">
          <div className="space-y-2 rounded-lg border border-border/40 p-3">
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <div className="flex justify-end">
          <div className="space-y-2 rounded-lg border border-border/40 p-3">
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
        <div className="flex justify-start">
          <div className="space-y-2 rounded-lg border border-border/40 p-3">
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-3 w-52" />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-10 flex-1 rounded-md" />
        <Skeleton className="h-10 w-20 rounded-md" />
      </div>
    </div>
  )
}

/**
 * 表格类页面通用骨架：标题 + 过滤器 + 表格。
 * 用于 CRM / reports / finance / supply-chain / system 等数据表格页。
 */
export function TablePageLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="页面加载中">
      <PageHeaderSkeleton />
      <FilterBarSkeleton />
      <DataTableSkeleton />
    </div>
  )
}

/**
 * 分析类内容区骨架：KPI 行 + 图表 + 表格（不含页头）。
 * 用于页头/过滤器已在布局层常驻渲染的场景（如 ad-analysis 布局内 Suspense fallback）。
 */
export function AnalyticsContentLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="页面加载中">
      <KpiCardsSkeleton />
      <ChartPanelSkeleton />
      <DataTableSkeleton columns={6} rows={6} />
    </div>
  )
}

/**
 * 分析类页面骨架：标题 + 过滤器 + KPI 行 + 图表 + 表格。
 * 用于 advertising / operations / ad-analysis 等分析页。
 */
export function AnalyticsPageLoading() {
  return (
    <div className="space-y-5">
      <PageHeaderSkeleton />
      <FilterBarSkeleton count={4} />
      <AnalyticsContentLoading />
    </div>
  )
}

/**
 * 卡片/hub 类页面骨架：标题 + 卡片网格。
 * 用于 AI hub 等入口型页面。
 */
export function SimplePageLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="页面加载中">
      <PageHeaderSkeleton />
      <CardListSkeleton />
    </div>
  )
}
