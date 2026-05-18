'use client'

import { Truck, RotateCcw, TrendingUp } from 'lucide-react'
import { DataCard, DataCardContent } from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import type { DashboardOverviewResponse } from '@/hooks/use-dashboard-overview'

function formatMoney(val: number) {
  if (val >= 1000) {
    return `$${(val / 1000).toFixed(1)}k`
  }
  return `$${val.toFixed(2)}`
}

function formatNumber(val: number) {
  if (val >= 1000) {
    return `${(val / 1000).toFixed(1)}k`
  }
  return String(val)
}

interface DashboardStatusCardsProps {
  data: DashboardOverviewResponse | undefined
  loading?: boolean
}

export function DashboardStatusCards({ data, loading = false }: DashboardStatusCardsProps) {
  if (loading && !data) {
    return (
      <div className="space-y-4">
        <StatusCardSkeleton title="发货状态" icon={<Truck className="h-4 w-4" />} />
        <StatusCardSkeleton title="退货概况" icon={<RotateCcw className="h-4 w-4" />} />
        <StatusCardSkeleton title="广告效果" icon={<TrendingUp className="h-4 w-4" />} />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <EmptyStatusCard title="发货状态" icon={<Truck className="h-4 w-4" />} />
        <EmptyStatusCard title="退货概况" icon={<RotateCcw className="h-4 w-4" />} />
        <EmptyStatusCard title="广告效果" icon={<TrendingUp className="h-4 w-4" />} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 发货状态 */}
      <DataCard>
        <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
          <span className="text-secondary">{<Truck className="h-4 w-4" />}</span>
          <span className="text-sm font-medium">发货状态</span>
        </div>
        <DataCardContent className="px-5 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">在途批次</p>
              <p className="mt-1 font-semibold text-lg">{formatNumber(data.shipments.in_transit_count)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">在途数量</p>
              <p className="mt-1 font-semibold text-lg">{formatNumber(data.shipments.in_transit_qty)}</p>
            </div>
          </div>
        </DataCardContent>
      </DataCard>

      {/* 退货概况 */}
      <DataCard>
        <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
          <span className="text-secondary">{<RotateCcw className="h-4 w-4" />}</span>
          <span className="text-sm font-medium">退货概况</span>
        </div>
        <DataCardContent className="px-5 py-4">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-xs text-muted-foreground">退货数</p>
              <p className="mt-1 font-semibold text-lg">{formatNumber(data.returns.total_returns)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">退货率</p>
              <p className="mt-1 font-semibold text-lg">{data.returns.return_rate.toFixed(1)}%</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">主因</p>
              <p className="mt-1 truncate text-sm font-medium text-muted-foreground">
                {data.returns.top_reason || '-'}
              </p>
            </div>
          </div>
        </DataCardContent>
      </DataCard>

      {/* 广告效果 */}
      <DataCard>
        <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
          <span className="text-secondary">{<TrendingUp className="h-4 w-4" />}</span>
          <span className="text-sm font-medium">广告效果</span>
        </div>
        <DataCardContent className="px-5 py-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <p className="text-xs text-muted-foreground">ROAS</p>
              <p className="mt-1 font-semibold text-lg text-secondary">{data.ads.period_roas.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">ACOS</p>
              <p className="mt-1 font-semibold text-lg">{data.ads.period_acos.toFixed(1)}%</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">花费</p>
              <p className="mt-1 font-semibold text-lg">{formatMoney(data.ads.period_spend)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">CTR</p>
              <p className="mt-1 font-semibold text-lg">{data.ads.period_ctr.toFixed(2)}%</p>
            </div>
          </div>
        </DataCardContent>
      </DataCard>
    </div>
  )
}

function StatusCardSkeleton({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <DataCard>
      <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
        <span className="text-secondary">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <DataCardContent className="px-5 py-4">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-1 h-6 w-16" />
          </div>
          <div>
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-1 h-6 w-16" />
          </div>
          <div>
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-1 h-6 w-16" />
          </div>
          <div>
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-1 h-6 w-16" />
          </div>
        </div>
      </DataCardContent>
    </DataCard>
  )
}

function EmptyStatusCard({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <DataCard>
      <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
        <span className="text-secondary">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <DataCardContent className="px-5 py-4">
        <p className="text-sm text-muted-foreground">暂无数据</p>
      </DataCardContent>
    </DataCard>
  )
}