'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bell, Boxes, CheckCircle, RefreshCw, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { fmtNumPrecise } from '@/lib/dashboard-format'
import { AreaSparkline } from './area-sparkline'

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

/** 库存健康度快照 —— 来自 DashboardHealthKpis 同一份 currentRows */
export interface StockSnapshot {
  /** 区间最后一天的快照值 */
  current: number
  /** 7 日序列(每日的 available_qty) */
  trend: number[]
  /** trend 对应的日期标签(可选,用于 sparkline tooltip) */
  labels?: string[]
}

interface DashboardAlertWidgetProps {
  className?: string
  /** 库存健康度数据(由 DashboardPage 注入,与 HealthKpis 同一份数据源) */
  stockSnapshot?: StockSnapshot
  stockLoading?: boolean
}

export function DashboardAlertWidget({
  className,
  stockSnapshot,
  stockLoading = false,
}: DashboardAlertWidgetProps) {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [recentEvents, setRecentEvents] = useState<AlertEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async (isRefresh = false) => {
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
    } catch (err) {
      console.error('Failed to fetch alert data:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleRefresh = () => fetchData(true)

  if (loading) {
    return (
      <DataCard className={cn('h-full', className)}>
        <DataCardHeader title="告警中心" />
        <DataCardContent>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-7 w-8" />
                </div>
              ))}
            </div>
            <div className="space-y-2 pt-1">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </div>
        </DataCardContent>
      </DataCard>
    )
  }

  const hasActive = stats && stats.total_active > 0

  return (
    <DataCard className={cn('h-full', className)}>
      <DataCardHeader
        title="告警中心"
        action={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </Button>
        }
      />
      <DataCardContent className="space-y-4">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col items-center rounded-lg border border-destructive/30 bg-destructive/5 py-3">
            <XCircle className="mb-1.5 h-4 w-4 text-destructive" />
            <span className="text-2xl font-bold tabular-nums text-destructive">
              {stats?.critical_count ?? 0}
            </span>
            <span className="mt-0.5 text-[10px] text-muted-foreground">严重</span>
          </div>
          <div className="flex flex-col items-center rounded-lg border border-term-warn/30 bg-term-warn/5 py-3">
            <AlertTriangle className="mb-1.5 h-4 w-4 text-term-warn" />
            <span className="text-2xl font-bold tabular-nums text-term-warn">
              {stats?.warning_count ?? 0}
            </span>
            <span className="mt-0.5 text-[10px] text-muted-foreground">警告</span>
          </div>
          <div className="flex flex-col items-center rounded-lg border border-primary/30 bg-primary/5 py-3">
            <Bell className="mb-1.5 h-4 w-4 text-primary" />
            <span className="text-2xl font-bold tabular-nums text-primary">
              {stats?.info_count ?? 0}
            </span>
            <span className="mt-0.5 text-[10px] text-muted-foreground">提示</span>
          </div>
        </div>

        {/* Recent events */}
        {recentEvents.length > 0 ? (
          <div className="space-y-2">
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
                        ? 'bg-term-warn'
                        : 'bg-primary'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium leading-tight text-foreground line-clamp-1">
                    {event.message}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {event.deviation_pct >= 0 ? '+' : ''}
                      {event.deviation_pct.toFixed(1)}%
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
        ) : (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="mb-3 rounded-xl bg-secondary/10 p-3 text-secondary">
              <CheckCircle className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">暂无活跃告警</h3>
            <p className="mt-1 max-w-[200px] text-xs leading-relaxed text-muted-foreground">
              系统运行正常，所有指标在正常范围内。
            </p>
          </div>
        )}

        {/* Footer summary */}
        {stats && (stats.acknowledged_today > 0 || stats.resolved_today > 0) && (
          <div className="flex items-center justify-center gap-4 border-t border-border/60 pt-3">
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

        {/* 库存健康度 —— 从 DashboardHealthKpis 迁回,与 currentRows 同一份数据源 */}
        <StockHealthBlock snapshot={stockSnapshot} loading={stockLoading} />
      </DataCardContent>
    </DataCard>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { className: string; label: string }> = {
    critical: {
      className: 'bg-destructive/10 text-destructive border-destructive/20',
      label: '严重',
    },
    warning: { className: 'bg-term-warn/10 text-term-warn border-term-warn/20', label: '警告' },
    info: { className: 'bg-primary/10 text-primary border-primary/20', label: '提示' },
  }
  const cfg = map[severity] ?? map.info
  return <Badge className={cn(cfg.className, 'text-[10px] px-1.5 border')}>{cfg.label}</Badge>
}

/**
 * 库存健康度子区块 —— 位于告警中心卡片底部
 * 视觉与 HealthKpiRow 对齐:左侧 icon+标签+数值,右侧 AreaSparkline 7 日趋势
 */
function StockHealthBlock({ snapshot, loading }: { snapshot?: StockSnapshot; loading: boolean }) {
  const hasData = !!snapshot && snapshot.trend.length > 0
  return (
    <div className="border-t border-border/60 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
          库存健康度
        </span>
        {hasData && <span className="text-[10px] text-muted-foreground">区间末日快照</span>}
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-white/90"
              style={{ backgroundColor: 'hsl(var(--chart-1))' }}
            >
              <Boxes className="h-3.5 w-3.5" />
            </span>
            <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
              可用库存
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            {loading && !hasData ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              <span className="truncate text-sm font-semibold tabular-nums leading-tight">
                {hasData ? `${fmtNumPrecise(snapshot!.current)} 件` : '—'}
              </span>
            )}
          </div>
        </div>
        <div className="h-10 w-24 shrink-0">
          {loading && !hasData ? (
            <Skeleton className="h-full w-full" />
          ) : hasData ? (
            <AreaSparkline
              trend={snapshot!.trend}
              gradientId="alert-stock-health"
              strokeColor="hsl(var(--chart-1))"
              strokeWidth={2}
              labels={snapshot!.labels}
              formatValue={(n) => `${fmtNumPrecise(n)} 件`}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground/70">
              暂无库存数据
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
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
