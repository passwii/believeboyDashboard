'use client'

import { AlertTriangle, BellRing, CheckCircle2, Info, XCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { AlertStats } from '@/lib/alerts-api'

const CARDS = [
  { key: 'total_active', label: '活跃告警', icon: BellRing, tone: 'text-foreground' },
  { key: 'critical_count', label: '严重', icon: XCircle, tone: 'text-red-600 dark:text-red-400' },
  { key: 'warning_count', label: '警告', icon: AlertTriangle, tone: 'text-amber-600 dark:text-amber-400' },
  { key: 'info_count', label: '提示', icon: Info, tone: 'text-blue-600 dark:text-blue-400' },
  { key: 'acknowledged_today', label: '今日确认', icon: CheckCircle2, tone: 'text-foreground' },
  { key: 'resolved_today', label: '今日解决', icon: CheckCircle2, tone: 'text-emerald-600 dark:text-emerald-400' },
] as const

export function AlertStatsBar({ stats }: { stats: AlertStats | null }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {CARDS.map((c) => {
        const Icon = c.icon
        const value = stats ? stats[c.key] : null
        return (
          <div
            key={c.key}
            className="dashboard-surface flex items-center gap-3 rounded-xl p-4"
          >
            <Icon className={`h-5 w-5 shrink-0 ${c.tone}`} />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              {value == null ? (
                <Skeleton className="mt-1 h-6 w-8" />
              ) : (
                <div className={`text-xl font-semibold tabular-nums ${c.tone}`}>{value}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}