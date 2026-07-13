'use client'

import { useMemo, useState } from 'react'
import { Store } from 'lucide-react'

import { DataTableCard, DataTableCardHeader } from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { fmtMoneyPrecise, fmtNumPrecise, renderChangeIndicator } from '@/lib/dashboard-format'

// 与 app/dashboard/page.tsx 中的类型保持一致 —— 这里是简化版,
// 只声明本组件实际使用的字段。
export interface TopProjectSummaryRow {
  date: string
  order_qty: number
  sales_amount: number
  ad_spend: number
  ad_orders: number
}

export interface ProjectBreakdownEntry {
  project_name: string
  summary_rows: TopProjectSummaryRow[]
}

export interface ProjectOption {
  id: number | null
  name: string
}

type SortKey = 'sales' | 'ad_spend'

interface DashboardTopProjectsProps {
  /** 后端 /daily-analysis/all 返回的 project_breakdown: { [projectId]: { project_name, summary_rows } } */
  projectBreakdown: Record<number, ProjectBreakdownEntry>
  /** 上一周期的 project_breakdown（同一接口,start_date=prev_from,end_date=prev_to） */
  compareProjectBreakdown?: Record<number, ProjectBreakdownEntry>
  /** 来自 fetchManagedProjectsCached 的项目列表,用于补全名字/顺序 */
  projects: ProjectOption[]
  loading?: boolean
}

interface AggregatedRow {
  projectId: number
  projectName: string
  totalSales: number
  totalAdSpend: number
  totalOrders: number
}

// Phase 5 提到 Top 10:对多项目用户更有意义(原 Top 5 会让中段项目被裁掉),
// 表格区加 max-h + overflow-y-auto,避免 1080p 屏撑出整页 + 与 Row 1/2 高度失衡
const MAX_ROWS = 10
const TABLE_MAX_HEIGHT = 'max-h-[420px]'

function aggregate(
  projectBreakdown: Record<number, ProjectBreakdownEntry>,
  projects: ProjectOption[]
): AggregatedRow[] {
  const rows: AggregatedRow[] = []
  for (const project of projects) {
    if (project.id === null) continue
    const entry = projectBreakdown[project.id]
    if (!entry || !Array.isArray(entry.summary_rows) || entry.summary_rows.length === 0) continue
    let totalSales = 0
    let totalAdSpend = 0
    let totalOrders = 0
    for (const r of entry.summary_rows) {
      totalSales += r.sales_amount ?? 0
      totalAdSpend += r.ad_spend ?? 0
      totalOrders += r.order_qty ?? 0
    }
    rows.push({
      projectId: project.id,
      projectName: entry.project_name || project.name,
      totalSales,
      totalAdSpend,
      totalOrders,
    })
  }
  return rows
}

function getSortValue(row: AggregatedRow, key: SortKey): number {
  return key === 'sales' ? row.totalSales : row.totalAdSpend
}

function getMainLabel(key: SortKey): string {
  return key === 'sales' ? '销售额' : '广告花费'
}

export function DashboardTopProjects({
  projectBreakdown,
  compareProjectBreakdown,
  projects,
  loading = false,
}: DashboardTopProjectsProps) {
  const [sortKey, setSortKey] = useState<SortKey>('sales')

  const aggregated = useMemo(
    () => aggregate(projectBreakdown, projects),
    [projectBreakdown, projects]
  )

  const totalSales = useMemo(() => aggregated.reduce((s, r) => s + r.totalSales, 0), [aggregated])
  const totalAdSpend = useMemo(
    () => aggregated.reduce((s, r) => s + r.totalAdSpend, 0),
    [aggregated]
  )

  const topRows = useMemo(() => {
    const total = sortKey === 'sales' ? totalSales : totalAdSpend
    const sorted = [...aggregated].sort(
      (a, b) => getSortValue(b, sortKey) - getSortValue(a, sortKey)
    )
    return sorted.slice(0, MAX_ROWS).map((row) => {
      // 从上一周期 project_breakdown 计算同比
      const prevEntry = compareProjectBreakdown?.[row.projectId]
      const prevSummaryRows = prevEntry?.summary_rows ?? []
      const prevMainValue = prevSummaryRows.reduce(
        (s, r) => s + (sortKey === 'sales' ? (r.sales_amount ?? 0) : (r.ad_spend ?? 0)),
        0
      )
      const mainValue = getSortValue(row, sortKey)
      const change = prevMainValue > 0 ? ((mainValue - prevMainValue) / prevMainValue) * 100 : null
      return {
        ...row,
        mainValue,
        pct: total > 0 ? (mainValue / total) * 100 : 0,
        change,
      }
    })
  }, [aggregated, compareProjectBreakdown, sortKey, totalSales, totalAdSpend])

  return (
    <DataTableCard className="h-full">
      <DataTableCardHeader
        title="TOP 项目/店铺"
        description={`按${getMainLabel(sortKey)}降序 Top ${MAX_ROWS}`}
        action={
          <div className="inline-flex items-center rounded-md border border-border/60 bg-background/70 p-0.5">
            <TabButton active={sortKey === 'sales'} onClick={() => setSortKey('sales')}>
              销售额
            </TabButton>
            <TabButton active={sortKey === 'ad_spend'} onClick={() => setSortKey('ad_spend')}>
              广告花费
            </TabButton>
          </div>
        }
      />
      <div className="px-4 py-3 sm:px-6 sm:py-4">
        {loading && aggregated.length === 0 ? (
          <SkeletonList />
        ) : topRows.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* 桌面/平板(≥640px):表格,容器可容纳 420px 最小宽度,无需横滚 */}
            <div className="hidden sm:block">
              <div className={`${TABLE_MAX_HEIGHT} overflow-y-auto overflow-x-auto`}>
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
                      <th className="w-10 pb-2 font-medium">#</th>
                      <th className="pb-2 font-medium">店铺</th>
                      <th className="pb-2 text-right font-medium">{getMainLabel(sortKey)}</th>
                      <th className="hidden pb-2 text-right font-medium sm:table-cell">订单量</th>
                      <th className="w-28 pb-2 font-medium">占比</th>
                      <th className="w-20 pb-2 text-right font-medium">环比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topRows.map((row, idx) => (
                      <tr
                        key={row.projectId}
                        className="border-b border-border/40 last:border-b-0 transition-colors hover:bg-muted/30"
                      >
                        <td className="py-2.5 align-middle text-xs text-muted-foreground tabular-nums">
                          {idx + 1}
                        </td>
                        <td className="py-2.5 align-middle">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                              <Store className="h-3.5 w-3.5" />
                            </span>
                            <span className="truncate font-medium text-foreground">
                              {row.projectName}
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 align-middle text-right tabular-nums">
                          {fmtMoneyPrecise(row.mainValue)}
                        </td>
                        <td className="hidden py-2.5 align-middle text-right tabular-nums text-muted-foreground sm:table-cell">
                          {fmtNumPrecise(row.totalOrders)}
                        </td>
                        <td className="py-2.5 align-middle">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-500"
                                style={{ width: `${Math.max(2, row.pct)}%` }}
                              />
                            </div>
                            <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
                              {row.pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 align-middle text-right tabular-nums">
                          {renderChangeIndicator(row.change)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 手机端(<640px):卡片列表,避免表格横向滚动(Rule 1) */}
            <div className="space-y-2.5 sm:hidden">
              {topRows.map((row, idx) => (
                <ProjectMobileCard
                  key={row.projectId}
                  row={row}
                  index={idx}
                  metricLabel={getMainLabel(sortKey)}
                  sortKey={sortKey}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </DataTableCard>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center rounded px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: MAX_ROWS }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-2 rounded-xl bg-secondary/10 p-2.5 text-secondary">
        <Store className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">暂无项目数据</p>
      <p className="mt-1 max-w-[220px] text-xs leading-relaxed text-muted-foreground">
        当前时段没有可统计的项目/店铺销售数据。
      </p>
    </div>
  )
}

/** 手机端(<640px)表格行 → 卡片(Rule 1):关键信息不丢失,避免横向滚动 */
function ProjectMobileCard({
  row,
  index,
  metricLabel,
  sortKey,
}: {
  row: AggregatedRow & { mainValue: number; pct: number; change: number | null }
  index: number
  metricLabel: string
  sortKey: SortKey
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2.5 dark:bg-[hsl(var(--surface-soft))] dark:border-border/50">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Store className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {row.projectName}
        </span>
        {renderChangeIndicator(row.change)}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            {metricLabel}
          </div>
          <div className="text-base font-semibold tabular-nums leading-tight text-foreground">
            {fmtMoneyPrecise(row.mainValue)}
          </div>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${Math.max(2, row.pct)}%` }}
            />
          </div>
          <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
            {row.pct.toFixed(0)}%
          </span>
        </div>
      </div>
      {sortKey === 'sales' && (
        <div className="mt-1 text-[10px] text-muted-foreground/80">
          订单量 {fmtNumPrecise(row.totalOrders)}
        </div>
      )}
    </div>
  )
}
