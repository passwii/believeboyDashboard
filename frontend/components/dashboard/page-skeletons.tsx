import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * BEL-419 统一骨架屏模块（BLF-924 终端化适配）。
 *
 * 约定：
 * - 所有路由级 `loading.tsx` 一律使用本模块导出的组合骨架，禁止再直接复用
 *   按首页布局定制的 `DashboardPageLoading`（它只属于 `app/dashboard/loading.tsx`）。
 * - 本模块全部为纯展示组件（无 state / 无浏览器 API），可在 server component
 *   的 loading.tsx 中直接渲染，保持骨架本身零 JS 开销。
 *
 * 选型指引：
 * - 表格类页面（CRM / reports / finance / operations / system）→ `TablePageLoading`
 * - 分析类页面（advertising / operations / ad-analysis）→ `AnalyticsPageLoading`
 * - 卡片/hub 类页面（ai hub 等）→ `SimplePageLoading`
 *
 * 终端化规范（BLF-924）：
 * - 控件高度：筛选条 h-10、工具条按钮 h-9、分页按钮 h-9
 * - 面板容器：border border-term-border bg-term-panel rounded-none shadow-none
 * - 字号：标题 text-sm font-semibold uppercase tracking-wider text-term-muted
 * - 边框：统一 border-term-border，禁止 border-border/20 等非 term 变体
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
      <div className="space-y-1.5">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-10 w-28 rounded-none" />
        <Skeleton className="h-10 w-24 rounded-none" />
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
        <Skeleton key={index} className="h-10 w-40 rounded-none" />
      ))}
      <Skeleton className="ml-auto h-10 w-24 rounded-none" />
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
          className="space-y-2 rounded-none border border-term-border bg-term-panel p-4"
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
      className={cn('rounded-none border border-term-border bg-term-panel', className)}
    >
      {toolbar ? (
        <div className="flex h-10 items-center justify-between border-b border-term-border px-4">
          <Skeleton className="h-4 w-32" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-44 rounded-none" />
            <Skeleton className="h-9 w-20 rounded-none" />
          </div>
        </div>
      ) : null}
      <div className="space-y-0 p-4">
        <div className="grid grid-cols-6 gap-3 border-b border-term-border pb-3">
          {Array.from({ length: Math.min(columns, 6) }).map((_, index) => (
            <Skeleton key={index} className="h-3.5 w-full max-w-24" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid grid-cols-6 items-center gap-3 border-b border-term-border py-3 last:border-b-0"
          >
            {Array.from({ length: Math.min(columns, 6) }).map((_, cellIndex) => (
              <Skeleton
                key={cellIndex}
                className={cn(
                  'h-3.5',
                  cellIndex === 0 ? 'w-full max-w-32' : 'w-full max-w-20',
                )}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-4 pb-4">
        <Skeleton className="h-3 w-24" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-9 rounded-none" />
          <Skeleton className="h-9 w-9 rounded-none" />
          <Skeleton className="h-9 w-9 rounded-none" />
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
      className={cn('rounded-none border border-term-border bg-term-panel p-5', className)}
    >
      <div className="flex items-center justify-between pb-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-16 rounded-none" />
          <Skeleton className="h-9 w-16 rounded-none" />
        </div>
      </div>
      <Skeleton className={cn('w-full rounded-none', height)} />
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
          className="space-y-3 rounded-none border border-term-border bg-term-panel p-5"
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-6 w-14 rounded-full" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex items-center justify-between pt-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-20 rounded-none" />
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
        className="space-y-4 rounded-none border border-term-border bg-term-panel p-5"
      >
        <div className="flex justify-start">
          <div className="space-y-2 rounded-none border border-term-border p-3">
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <div className="flex justify-end">
          <div className="space-y-2 rounded-none border border-term-border p-3">
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
        <div className="flex justify-start">
          <div className="space-y-2 rounded-none border border-term-border p-3">
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-3 w-52" />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-10 flex-1 rounded-none" />
        <Skeleton className="h-10 w-20 rounded-none" />
      </div>
    </div>
  )
}

/**
 * 表格类页面通用骨架：标题 + 过滤器 + 表格。
 * 用于 CRM / reports / finance / operations / system 等数据表格页。
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

/** CRM 任务页默认看板：筛选工具条 + 三个状态列，避免用表格骨架误导布局。 */
export function CrmTaskBoardPageLoading() {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-label="页面加载中">
      <div className="flex items-center justify-end gap-1.5" data-testid="page-skeleton-task-toolbar">
        <Skeleton className="h-8 w-28 rounded-none" />
        <Skeleton className="h-8 w-32 rounded-none" />
        <Skeleton className="h-8 w-24 rounded-none" />
      </div>
      <div data-testid="page-skeleton-task-columns" className="grid grid-cols-1 gap-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, column) => (
          <section key={column} className="min-w-0 border border-term-border bg-term-panel p-2">
            <div className="mb-2 flex items-center justify-between border-b border-term-border pb-2">
              <Skeleton className="h-4 w-20 rounded-none" />
              <Skeleton className="h-4 w-6 rounded-none" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((__, card) => (
                <div key={card} className="space-y-2 border border-term-border p-2">
                  <Skeleton className="h-4 w-4/5 rounded-none" />
                  <Skeleton className="h-3 w-2/3 rounded-none" />
                  <div className="flex justify-between">
                    <Skeleton className="h-3 w-16 rounded-none" />
                    <Skeleton className="h-3 w-12 rounded-none" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

/** CRM 数据看板：首页 KPI、漏斗、负责人业绩与生命周期区。 */
export function CrmDashboardPageLoading() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="页面加载中">
      <KpiCardsSkeleton count={4} className="gap-1.5" />
      <section className="space-y-3 border border-term-border bg-term-panel p-3" data-testid="page-skeleton-crm-funnel">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-56 rounded-none" />
          <Skeleton className="h-4 w-24 rounded-none" />
        </div>
        <Skeleton className="mx-auto h-44 w-full max-w-3xl rounded-none" />
        <div className="grid gap-1.5 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full rounded-none" />
          ))}
        </div>
      </section>
      <div className="grid gap-2 lg:grid-cols-2">
        <DataTableSkeleton columns={3} rows={4} />
        <section className="space-y-3 border border-term-border bg-term-panel p-3" data-testid="page-skeleton-crm-lifecycle">
          <Skeleton className="h-4 w-36 rounded-none" />
          <Skeleton className="h-32 w-full rounded-none" />
        </section>
      </div>
    </div>
  )
}

/** 适用于超宽运营审计表：真实页面列数超过通用 6 列骨架。 */
export function WideDataTableSkeleton({ columns = 8, rows = 6 }: { columns?: number; rows?: number }) {
  const gridStyle = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
  return (
    <div data-testid="page-skeleton-wide-table" className="overflow-x-auto border border-term-border bg-term-panel">
      <div className="min-w-[960px]">
        <div className="flex h-10 items-center justify-between border-b border-term-border px-3">
          <Skeleton className="h-4 w-32 rounded-none" />
          <Skeleton className="h-8 w-28 rounded-none" />
        </div>
        <div className="space-y-0 p-3">
          <div className="grid gap-3 border-b border-term-border pb-3" style={gridStyle}>
            {Array.from({ length: columns }).map((_, index) => (
              <Skeleton key={index} className="h-3.5 w-full rounded-none" />
            ))}
          </div>
          {Array.from({ length: rows }).map((_, row) => (
            <div key={row} className="grid items-center gap-3 border-b border-term-border py-3 last:border-b-0" style={gridStyle}>
              {Array.from({ length: columns }).map((__, cell) => (
                <Skeleton key={cell} className="h-3.5 w-full rounded-none" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Agent 中心双表页：标题 + 实际多列活动矩阵。 */
export function AgentTablePageLoading({ columns = 8 }: { columns?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中">
      <WideDataTableSkeleton columns={columns} rows={7} />
    </div>
  )
}

/** 库存分类账：全局筛选、KPI、四张趋势/分布面板、Tab 与明细表。 */
export function InventoryLedgerPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-inventory-ledger">
      <div className="flex flex-wrap items-center gap-2" data-testid="page-skeleton-ledger-filters">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-10 w-36 rounded-none" />)}</div>
      <KpiCardsSkeleton count={4} className="gap-2" />
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <section key={index} className="space-y-3 border border-term-border bg-term-panel p-3">
            <Skeleton className="h-4 w-40 rounded-none" />
            <Skeleton className="h-3 w-56 rounded-none" />
            <Skeleton className="h-48 w-full rounded-none" />
          </section>
        ))}
      </div>
      <div className="flex gap-1 border-b border-term-border pb-2" data-testid="page-skeleton-ledger-tabs">
        <Skeleton className="h-9 w-32 rounded-none" />
        <Skeleton className="h-9 w-36 rounded-none" />
        <Skeleton className="h-9 w-28 rounded-none" />
      </div>
      <DataTableSkeleton columns={6} rows={6} />
    </div>
  )
}

/** 项目启动台：桌面项目列表 + 右侧项目详情/流程 Tab。 */
export function ProjectLaunchPageLoading() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-project-launch">
      <div className="flex justify-end"><Skeleton className="h-8 w-32 rounded-none" /></div>
      <div className="md:hidden"><Skeleton className="h-9 w-full rounded-none" /></div>
      <div className="grid min-w-0 gap-2 md:grid-cols-[260px_minmax(0,1fr)]">
        <section className="hidden border border-term-border bg-term-panel p-2 md:block">
          <div className="mb-2 flex justify-between border-b border-term-border pb-2">
            <Skeleton className="h-4 w-20 rounded-none" />
            <Skeleton className="h-4 w-24 rounded-none" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="space-y-2 border-b border-term-border p-2">
                <Skeleton className="h-4 w-3/4 rounded-none" />
                <Skeleton className="h-3 w-full rounded-none" />
              </div>
            ))}
          </div>
        </section>
        <section className="space-y-3 border border-term-border bg-term-panel p-3">
          <Skeleton className="h-4 w-40 rounded-none" />
          <div className="flex gap-1 border-b border-term-border pb-2" data-testid="page-skeleton-project-tabs">
            <Skeleton className="h-8 w-20 rounded-none" />
            <Skeleton className="h-8 w-24 rounded-none" />
            <Skeleton className="h-8 w-24 rounded-none" />
          </div>
          <Skeleton className="h-24 w-full rounded-none" />
          <Skeleton className="h-28 w-full rounded-none" />
        </section>
      </div>
    </div>
  )
}

/** 模板管理编辑器：模板目录与多字段/阶段编辑并列，包含附件和内容区。 */
export function WorkflowTemplateEditorPageLoading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-workflow-editor">
      <div className="flex items-center justify-between gap-3 border-b border-term-border pb-2">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28 rounded-none" />
          <Skeleton className="h-3 w-64 rounded-none" />
        </div>
        <div className="flex gap-2"><Skeleton className="h-8 w-24 rounded-none" /><Skeleton className="h-8 w-24 rounded-none" /></div>
      </div>
      <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(220px,0.72fr)_minmax(0,2fr)]">
        <section className="space-y-3 border border-term-border bg-term-panel p-3" data-testid="page-skeleton-template-list">
          <div className="flex justify-between"><Skeleton className="h-4 w-24 rounded-none" /><Skeleton className="h-4 w-8 rounded-none" /></div>
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-12 w-full rounded-none" />)}
        </section>
        <section className="space-y-4 border border-term-border bg-term-panel p-3" data-testid="page-skeleton-template-detail">
          <Skeleton className="h-8 w-full rounded-none" />
          <div className="grid gap-2 md:grid-cols-2"><Skeleton className="h-9 w-full rounded-none" /><Skeleton className="h-9 w-full rounded-none" /><Skeleton className="h-20 w-full rounded-none md:col-span-2" /></div>
          <div className="flex gap-1 border-y border-term-border py-2"><Skeleton className="h-10 w-28 rounded-none" /><Skeleton className="h-10 w-28 rounded-none" /><Skeleton className="h-10 w-28 rounded-none" /></div>
          <div className="grid gap-4 xl:grid-cols-2"><Skeleton className="h-48 w-full rounded-none" /><Skeleton className="h-48 w-full rounded-none" /></div>
        </section>
      </div>
    </div>
  )
}

/** 发货规划首屏：项目范围提示、KPI 与 SKU 预测表，而非通用分析图表。 */
export function ShippingPlanPageLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-shipping-plan">
      <div className="md:hidden"><div className="flex gap-2"><Skeleton className="h-9 w-36 rounded-none" /><Skeleton className="h-9 w-28 rounded-none" /></div></div>
      <div className="flex justify-between border-b border-term-border pb-4">
        <div className="space-y-2"><Skeleton className="h-6 w-32 rounded-none" /><Skeleton className="h-4 w-96 max-w-full rounded-none" /></div>
        <Skeleton className="h-9 w-24 rounded-none" />
      </div>
      <div className="grid grid-cols-2 border border-term-border bg-term-panel md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <div key={index} className="space-y-2 border-r border-term-border p-3"><Skeleton className="h-3 w-24 rounded-none" /><Skeleton className="h-6 w-20 rounded-none" /></div>)}
      </div>
      <WideDataTableSkeleton columns={10} rows={5} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.8fr)]"><Skeleton className="h-64 rounded-none" /><Skeleton className="h-64 rounded-none" /></div>
    </div>
  )
}

/** 补货 cockpit：视图切换、指标区与日历/表格内容。 */
export function InventoryReplenishmentPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-inventory-replenishment">
      <FilterBarSkeleton count={4} />
      <div className="flex gap-1 border-b border-term-border pb-2" data-testid="page-skeleton-replenishment-tabs">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-9 w-28 rounded-none" />)}</div>
      <KpiCardsSkeleton count={4} />
      <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-64 rounded-none" /><Skeleton className="h-64 rounded-none" /></div>
      <DataTableSkeleton columns={8} rows={6} />
    </div>
  )
}

/** 巡检工作区：活动 Tab、周期筛选、状态面板与填写/历史区。 */
export function PlatformInspectionPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-platform-inspection">
      <div className="flex items-center justify-between"><div className="flex gap-1">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-9 w-28 rounded-none" />)}</div><Skeleton className="h-9 w-36 rounded-none" /></div>
      <div className="grid gap-3 lg:grid-cols-2"><section className="space-y-3 border border-term-border p-3"><Skeleton className="h-5 w-40 rounded-none" /><div className="grid grid-cols-2 gap-1.5">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-16 rounded-none" />)}</div><Skeleton className="h-28 rounded-none" /></section><DataTableSkeleton columns={9} rows={5} /></div>
    </div>
  )
}

/** 项目目标页：筛选、指标、图表和进度 Tab。 */
export function ProjectGoalsPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-project-goals">
      <FilterBarSkeleton count={3} />
      <KpiCardsSkeleton count={4} />
      <ChartPanelSkeleton height="h-[192px]" />
      <div className="flex gap-1 border-b border-term-border pb-2"><Skeleton className="h-9 w-24 rounded-none" /><Skeleton className="h-9 w-24 rounded-none" /></div>
      <DataTableSkeleton columns={6} rows={5} />
    </div>
  )
}

/** 客诉列表：筛选和七列工作表；不呈现 KPI/图表。 */
export function ComplaintListPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-complaint-list">
      <FilterBarSkeleton count={4} />
      <WideDataTableSkeleton columns={7} rows={8} />
    </div>
  )
}

/** 船期管理：四个工作 Tab 与批次表格。 */
export function ShipmentManagementPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-shipment-management">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-1">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-9 w-24 rounded-none" />)}</div><div className="flex gap-2">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-9 w-24 rounded-none" />)}</div></div>
      <WideDataTableSkeleton columns={10} rows={8} />
    </div>
  )
}

/** SKU 资料页：六个工作 Tab、搜索工具栏、宽数据表。 */
export function SkuInfoPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-sku-info">
      <div className="flex flex-wrap gap-1 border-b border-term-border pb-2" data-testid="page-skeleton-sku-tabs">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-9 w-24 rounded-none" />)}</div>
      <div className="flex flex-wrap items-center gap-2">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-9 w-36 rounded-none" />)}</div>
      <WideDataTableSkeleton columns={9} rows={7} />
    </div>
  )
}

/** 月报生成：左侧文件识别/上传 + 右侧任务进度，而不是表格页。 */
export function MonthlyReportGeneratePageLoading() {
  return (
    <div className="grid w-full gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-monthly-report-generate">
      <div className="space-y-4"><section className="space-y-4 border border-term-border bg-term-panel p-4"><Skeleton className="h-5 w-28 rounded-none" /><div className="grid grid-cols-2 gap-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-14 rounded-none" />)}</div></section><section className="space-y-4 border border-term-border bg-term-panel p-4"><Skeleton className="h-5 w-40 rounded-none" /><div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]"><Skeleton className="min-h-[190px] w-full rounded-none" /><div className="space-y-3">{Array.from({ length: 2 }).map((_, index) => <Skeleton key={index} className="h-28 w-full rounded-none" />)}</div></div></section></div>
      <section className="space-y-4 border border-term-border bg-term-panel p-4"><Skeleton className="h-5 w-24 rounded-none" /><Skeleton className="h-20 w-full rounded-none" /><div className="space-y-3">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-4 w-full rounded-none" />)}</div><Skeleton className="h-10 w-full rounded-none" /></section>
    </div>
  )
}

/** 静态/动态站点导航：三项概览、分组标题及可点开的链接卡片网格。 */
export function OperationsNavigationPageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-operations-navigation">
      <section className="space-y-3 border border-term-border bg-term-panel p-3">
        <Skeleton className="h-4 w-32 rounded-none" />
        <Skeleton className="h-3 w-3/4 rounded-none" />
        <div className="grid max-w-sm grid-cols-3 gap-2">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-14 rounded-none" />)}</div>
      </section>
      {[0, 1].map((group) => (
        <section key={group} className="space-y-2">
          <div className="flex justify-between"><Skeleton className="h-4 w-48 rounded-none" /><Skeleton className="h-3 w-8 rounded-none" /></div>
          <div className="grid grid-cols-2 gap-px bg-term-border p-px md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6" data-testid={group === 0 ? 'page-skeleton-navigation-platforms' : undefined}>
            {Array.from({ length: group === 0 ? 6 : 3 }).map((_, index) => (
              <div key={index} className="flex min-h-[132px] flex-col gap-3 bg-term-panel p-3">
                <div className="flex justify-between"><Skeleton className="h-4 w-24 rounded-none" /><Skeleton className="h-7 w-7 rounded-none" /></div>
                <Skeleton className="h-3 w-2/3 rounded-none" />
                <Skeleton className="mt-auto h-5 w-full rounded-none" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
