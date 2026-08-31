'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'

/**
 * Footer「告警事件」频道数据源（BLF-918 Stage 3）。
 *
 * 复用告警中心全局统计端点：
 * GET /api/backend/api/v1/alerts/stats（不带 project_id = 全局），
 * 响应 {total_active, critical_count, warning_count, ...}。
 *
 * 渲染契约：total_active > 0 才显示「告警 N」；critical>0 → text-term-neg，
 * 仅 warning → text-term-warn，0 → 频道不渲染（正常态不占带宽）。
 *
 * 失败仅本频道降级（保留上次值/占位），不影响其他 ticker 频道（BLF-816 契约）。
 */

export type AlertStatsStatus = 'loading' | 'ok' | 'error'

/** 告警严重度分级：critical（有 critical）> warning（仅 warning）> none（无 active） */
export type AlertSeverity = 'critical' | 'warning' | 'none'

export type AlertStatsPayload = {
  total_active?: number | null
  critical_count?: number | null
  warning_count?: number | null
  acknowledged_today?: number | null
  resolved_today?: number | null
}

export type AlertStatsSummary = {
  /** 全局 active 告警事件总数；null = 未就绪 */
  totalActive: number | null
  /** active 且 severity=critical 的事件数；null = 未就绪 */
  criticalCount: number | null
  /** active 且 severity=warning 的事件数；null = 未就绪 */
  warningCount: number | null
  /** 分级结果（供着色）：critical / warning / none */
  severity: AlertSeverity
  status: AlertStatsStatus
}

/** 纯函数：从 alerts/stats 响应归约分级（critical 优先；全 0 → none） */
export function reduceAlertStats(payload: AlertStatsPayload | null | undefined): {
  totalActive: number
  criticalCount: number
  warningCount: number
  severity: AlertSeverity
} {
  const totalActive = Math.max(0, Number(payload?.total_active ?? 0) || 0)
  const criticalCount = Math.max(0, Number(payload?.critical_count ?? 0) || 0)
  const warningCount = Math.max(0, Number(payload?.warning_count ?? 0) || 0)
  const severity: AlertSeverity =
    criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'none'
  return { totalActive, criticalCount, warningCount, severity }
}

/** 告警轮询间隔（分钟级时效；告警变化低频，5min） */
export const ALERT_STATS_POLL_INTERVAL_MS = 5 * 60 * 1000

const API_BASE = '/api/backend'

export function useAlertStats(): AlertStatsSummary {
  const [summary, setSummary] = useState<Omit<AlertStatsSummary, 'status'> | null>(null)
  const [status, setStatus] = useState<AlertStatsStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const response = await fetch(`${API_BASE}/api/v1/alerts/stats`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`alerts/stats ${response.status}`)
      const payload = (await response.json()) as AlertStatsPayload
      if (seq !== requestSeqRef.current) return
      setSummary(reduceAlertStats(payload))
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
      // 仅本频道降级：保留上次值（若有），状态置 error
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, ALERT_STATS_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return {
    totalActive: summary?.totalActive ?? null,
    criticalCount: summary?.criticalCount ?? null,
    warningCount: summary?.warningCount ?? null,
    severity: summary?.severity ?? 'none',
    status,
  }
}
