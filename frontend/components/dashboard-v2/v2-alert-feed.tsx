'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bell, CheckCircle, XCircle } from 'lucide-react'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import { V2Card } from './v2-card'

export interface AlertStats {
  total_active: number
  critical_count: number
  warning_count: number
  info_count: number
  acknowledged_today: number
  resolved_today: number
}

export interface AlertEvent {
  id: number
  message: string
  severity: string
  status: string
  triggered_at: string
  metric: string
  deviation_pct: number
}

/** 活跃告警拉取（复用 v1 告警中心的同一组端点，自管 fetch） */
async function fetchAlertData() {
  const [statsRes, eventsRes] = await Promise.all([
    fetch('/api/backend/alerts/stats'),
    fetch('/api/backend/alerts/events?status=active&page_size=4'),
  ])
  let stats: AlertStats | null = null
  let events: AlertEvent[] = []
  if (statsRes.ok) stats = (await statsRes.json()) as AlertStats
  if (eventsRes.ok) {
    const data = (await eventsRes.json()) as { items?: AlertEvent[] }
    events = data.items ?? []
  }
  return { stats, events }
}

export function V2AlertFeed({ className }: { className?: string }) {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const { stats: nextStats, events: nextEvents } = await fetchAlertData()
      setStats(nextStats)
      setEvents(nextEvents)
    } catch {
      // 静默降级为空态
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <V2Card className={cn('gap-0 md:col-span-2', className)}>
      <CardHeader className="border-b">
        <CardTitle className="text-base">告警动态</CardTitle>
        <CardDescription>实时活跃告警与今日处理情况</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        {loading ? (
          <div className="space-y-3 p-5">
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <Skeleton className="h-16 w-full" key={i} />
              ))}
            </div>
            {[1, 2].map((i) => (
              <Skeleton className="h-12 w-full" key={i} />
            ))}
          </div>
        ) : (
          <>
            {/* 严重/警告/提示 计数 */}
            <div className="grid grid-cols-3 gap-3 px-5 pt-4">
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

            {/* 最近活跃告警 */}
            {events.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border">
                {events.map((event) => (
                  <li className="flex items-start gap-3 px-5 py-3" key={event.id}>
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        event.severity === 'critical'
                          ? 'bg-destructive'
                          : event.severity === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-primary'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-1 text-sm leading-snug text-foreground">
                        {event.message}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {event.deviation_pct >= 0 ? '+' : ''}
                          {event.deviation_pct.toFixed(1)}%
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(event.triggered_at)}
                        </span>
                      </div>
                    </div>
                    <SeverityBadge severity={event.severity} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="mb-3 rounded-xl bg-secondary/10 p-3 text-secondary">
                  <CheckCircle className="h-6 w-6" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">暂无活跃告警</h3>
                <p className="mt-1 max-w-[220px] text-xs leading-relaxed text-muted-foreground">
                  系统运行正常，所有指标在正常范围内。
                </p>
              </div>
            )}

            {/* 今日小结 */}
            {stats && (stats.acknowledged_today > 0 || stats.resolved_today > 0) && (
              <div className="flex items-center justify-center gap-4 border-t border-border/60 pt-3 pb-4">
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
          </>
        )}
      </CardContent>
    </V2Card>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { className: string; label: string }> = {
    critical: {
      className: 'bg-destructive/10 text-destructive border-destructive/20',
      label: '严重',
    },
    warning: { className: 'bg-amber-500/10 text-amber-600 border-amber-500/20', label: '警告' },
    info: { className: 'bg-primary/10 text-primary border-primary/20', label: '提示' },
  }
  const cfg = map[severity] ?? map.info
  return <Badge className={cn(cfg.className, 'px-1.5 text-[10px] border')}>{cfg.label}</Badge>
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
