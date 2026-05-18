'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bell, CheckCircle, RefreshCw, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
} from '@/components/ui/data-card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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

interface DashboardAlertWidgetProps {
  className?: string
}

export function DashboardAlertWidget({ className }: DashboardAlertWidgetProps) {
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
              {[1, 2, 3].map(i => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-7 w-8" />
                </div>
              ))}
            </div>
            <div className="space-y-2 pt-1">
              {[1, 2, 3].map(i => (
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
          <div className="flex flex-col items-center rounded-lg border border-amber-500/30 bg-amber-500/5 py-3">
            <AlertTriangle className="mb-1.5 h-4 w-4 text-amber-500" />
            <span className="text-2xl font-bold tabular-nums text-amber-600">
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
            {recentEvents.map(event => (
              <div
                key={event.id}
                className="flex items-start gap-2.5 rounded-md border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2.5 dark:bg-[hsl(var(--surface-soft))]"
              >
                <div className={cn(
                  'mt-0.5 h-2 w-2 shrink-0 rounded-full',
                  event.severity === 'critical' ? 'bg-destructive' :
                  event.severity === 'warning' ? 'bg-amber-500' : 'bg-primary'
                )} />
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
        ) : (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="mb-3 rounded-xl bg-secondary/10 p-3 text-secondary">
              <CheckCircle className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">
              暂无活跃告警
            </h3>
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
      </DataCardContent>
    </DataCard>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { className: string, label: string }> = {
    critical: { className: 'bg-destructive/10 text-destructive border-destructive/20', label: '严重' },
    warning: { className: 'bg-amber-500/10 text-amber-600 border-amber-500/20', label: '警告' },
    info: { className: 'bg-primary/10 text-primary border-primary/20', label: '提示' },
  }
  const cfg = map[severity] ?? map.info
  return <Badge className={cn(cfg.className, "text-[10px] px-1.5 border")}>{cfg.label}</Badge>
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