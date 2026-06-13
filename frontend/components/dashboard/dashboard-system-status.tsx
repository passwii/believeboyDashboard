'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  RotateCcw,
  TrendingUp,
  Truck,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { DashboardOverviewResponse } from '@/hooks/use-dashboard-overview'

interface AlertStats {
  total_active: number
  critical_count: number
  warning_count: number
  info_count: number
  acknowledged_today: number
  resolved_today: number
}

interface AlertEvent {
  id: number
  message: string
  severity: string
  status: string
  triggered_at: string
  metric: string
  deviation_pct: number
}

function formatNumber(val: number) {
  return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val)
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)
    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins}分钟前`
    if (diffHours < 24) return `${diffHours}小时前`
    return `${diffDays}天前`
  } catch {
    return ''
  }
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { className: string; label: string }> = {
    critical: { className: 'bg-destructive/10 text-destructive border-destructive/20', label: '严重' },
    warning: { className: 'bg-amber-500/10 text-amber-600 border-amber-500/20', label: '警告' },
    info: { className: 'bg-primary/10 text-primary border-primary/20', label: '提示' },
  }
  const cfg = map[severity] ?? map.info
  return <Badge className={cn(cfg.className, 'text-[10px] px-1.5 border')}>{cfg.label}</Badge>
}

function StatCell({
  icon,
  label,
  children,
  className,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-lg p-4', className)}>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="text-secondary">{icon}</span>
        <span className="dashboard-kicker text-[0.65rem]">{label}</span>
      </div>
      {children}
    </div>
  )
}

interface DashboardSystemStatusProps {
  data: DashboardOverviewResponse | undefined
  loading?: boolean
}

export function DashboardSystemStatus({ data, loading = false }: DashboardSystemStatusProps) {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [recentEvents, setRecentEvents] = useState<AlertEvent[]>([])
  const [alertLoading, setAlertLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchAlerts = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [statsRes, eventsRes] = await Promise.all([
        fetch('/api/backend/alerts/stats'),
        fetch('/api/backend/alerts/events?status=active&page_size=3'),
      ])
      if (statsRes.ok && eventsRes.ok) {
        const statsData = await statsRes.json()
        const eventsData = await eventsRes.json()
        setStats(statsData)
        setRecentEvents(eventsData.items || [])
      }
    } catch {
    } finally {
      setAlertLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchAlerts()
  }, [fetchAlerts])

  const handleRefresh = () => fetchAlerts(true)

  const isLoading = (loading && !data) || alertLoading
  const hasActive = stats && stats.total_active > 0

  if (isLoading) {
    return (
      <DataCard>
        <DataCardHeader title="系统状态" />
        <DataCardContent>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
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
        </DataCardContent>
      </DataCard>
    )
  }

  return (
    <DataCard>
      <DataCardHeader
        title="系统状态"
        action={
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground',
              refreshing && 'opacity-50'
            )}
          >
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          </button>
        }
      />
      <DataCardContent className="space-y-4">
        {/*
         * md: (>=768px) -> 4 columns. Below md, 2x2. The 4-col layout
         * was originally sm: (>=640px) which squeezed 4 cells into a
         * narrow band on large phones; pushing it to md: gives iPad
         * portrait the same comfortable 4-col row it always had.
         */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
          <StatCell
            icon={<Truck className="h-3.5 w-3.5" />}
            label="发货"
            className="bg-secondary/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold">{formatNumber(data?.shipments.in_transit_count ?? 0)}</span>
              <span className="text-xs text-muted-foreground">批</span>
            </div>
            <span className="text-xs text-muted-foreground">{formatNumber(data?.shipments.in_transit_qty ?? 0)} 件</span>
          </StatCell>

          <StatCell
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label="退货"
            className="bg-amber-500/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold">{data?.returns.return_rate.toFixed(1) ?? '0.0'}%</span>
            </div>
            <span className="text-xs text-muted-foreground truncate">
              {data?.returns.top_reason || '—'}
            </span>
          </StatCell>

          <StatCell
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="广告效果"
            className="bg-[hsl(var(--chart-1))]/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold text-secondary">
                {data?.ads.period_roas.toFixed(2) ?? '0.00'}
              </span>
              <span className="text-[10px] text-muted-foreground">ROAS</span>
            </div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <span>ACOS {data?.ads.period_acos.toFixed(1) ?? '0.0'}%</span>
              <span>CTR {data?.ads.period_ctr.toFixed(2) ?? '0.00'}%</span>
            </div>
          </StatCell>

          <StatCell
            icon={hasActive ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle className="h-3.5 w-3.5" />}
            label="告警"
            className={hasActive ? 'bg-destructive/5' : 'bg-secondary/5'}
          >
            {hasActive ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold text-destructive">{stats?.total_active ?? 0}</span>
                  <span className="text-xs text-muted-foreground">条活跃</span>
                </div>
                <div className="flex gap-1.5">
                  {stats && stats.critical_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-destructive">
                      <XCircle className="h-2.5 w-2.5" />
                      {stats.critical_count}
                    </span>
                  )}
                  {stats && stats.warning_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-600">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {stats.warning_count}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <span className="text-sm font-medium text-secondary">系统正常</span>
            )}
          </StatCell>
        </div>

        {/*
         * 预留事件列表的稳定高度，避免 skeleton→真实内容
         * 出现 0→N 行突变造成 CLS。固定 min-h 与骨架两条 h-10 行（合计 80px）对齐。
         * 注意：skeleton 没有 footer 占位，所以这里也不预留 footer 高度——
         * 否则 0 acknowledged/0 resolved 的常见路径反而会多出 32px 新的 CLS。
         */}
        <div className="min-h-[5rem]">
          {recentEvents.length > 0 && (
            <div className="space-y-2 border-t border-border/50 pt-3">
              {recentEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-2.5 rounded-md border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2.5 dark:bg-[hsl(var(--surface-soft))]"
                >
                  <div
                    className={cn(
                      'mt-0.5 h-2 w-2 shrink-0 rounded-full',
                      event.severity === 'critical'
                        ? 'bg-destructive'
                        : event.severity === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-primary'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium leading-tight text-foreground line-clamp-1">
                      {event.message}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        {event.deviation_pct >= 0 ? '+' : ''}{event.deviation_pct.toFixed(1)}%
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelativeTime(event.triggered_at)}
                      </span>
                    </div>
                  </div>
                  <SeverityBadge severity={event.severity} />
                </div>
              ))}
            </div>
          )}
        </div>

        {stats && (stats.acknowledged_today > 0 || stats.resolved_today > 0) && (
          <div className="flex items-center justify-center gap-4 border-t border-border/50 pt-2">
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle className="h-2.5 w-2.5 text-secondary" />
              今日确认 {stats.acknowledged_today}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle className="h-2.5 w-2.5 text-primary" />
              今日解决 {stats.resolved_today}
            </span>
          </div>
        )}
      </DataCardContent>
    </DataCard>
  )
}