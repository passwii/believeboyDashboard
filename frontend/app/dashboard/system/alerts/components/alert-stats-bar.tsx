'use client'

import type { AlertStats } from '@/lib/alerts-api'
import styles from '../alerts-warm.module.css'

const CARDS = [
  { key: 'total_active', label: '活跃告警', tone: undefined },
  { key: 'critical_count', label: '严重', tone: 'neg' as const },
  { key: 'warning_count', label: '警告', tone: 'warn' as const },
  { key: 'info_count', label: '提示', tone: 'info' as const },
  { key: 'acknowledged_today', label: '今日确认', tone: undefined },
  { key: 'resolved_today', label: '今日解决', tone: 'pos' as const },
] as const

export function AlertStatsBar({ stats }: { stats: AlertStats | null }) {
  return (
    <div
      className={styles.statsGrid}
      data-warm-alert-stats="true"
      aria-busy={stats == null || undefined}
    >
      {CARDS.map((c) => {
        const value = stats ? String(stats[c.key]) : ''
        return (
          <article
            key={c.key}
            className={styles.statCard}
            data-tone={c.tone ?? 'default'}
          >
            <span className={styles.statLabel}>{c.label}</span>
            {stats == null ? (
              <span className={styles.statSkeleton} aria-hidden />
            ) : (
              <span className={styles.statValue}>{value}</span>
            )}
          </article>
        )
      })}
    </div>
  )
}

export function AlertStatsBarSkeleton() {
  return (
    <div className={styles.statsGrid} data-warm-alert-stats="true" aria-busy="true">
      {CARDS.map((c) => (
        <article key={c.key} className={styles.statCard}>
          <span className={styles.statLabel}>{c.label}</span>
          <span className={styles.statSkeleton} aria-hidden />
        </article>
      ))}
    </div>
  )
}
