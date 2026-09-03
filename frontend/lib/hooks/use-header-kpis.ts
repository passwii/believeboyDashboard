'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * BLF-819 · Top Header KPI 磁贴数据源。
 *
 * 复用 Footer「全局快报」同一聚合端点（daily-analysis/all，美西今天），
 * 取今日 GMV / 订单数 / Pending 数。与 Footer 快报 hook（useSevenDayBrief，近 7 天聚合）的差别：
 * 该 hook 暴露 loading 态（磁贴显示 ··· 动画），且轮询间隔独立可调。
 * 失败仅本模块降级（value=null → 显示 "--"），不影响头部其他控件。
 */

export type HeaderKpis = {
  gmv: number | null
  orders: number | null
  pending: number | null
}

type SummaryRow = {
  sales_amount?: number | string | null
  order_qty?: number | string | null
  pending_order_qty?: number | string | null
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function reduceHeaderKpis(rows: SummaryRow[]): HeaderKpis {
  let gmv = 0
  let orders = 0
  let pending = 0
  for (const row of rows) {
    gmv += toNumber(row.sales_amount) ?? 0
    orders += toNumber(row.order_qty) ?? 0
    pending += toNumber(row.pending_order_qty) ?? 0
  }
  return { gmv, orders, pending }
}

function todayYMDInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}

const US_TIMEZONE = 'America/Los_Angeles'
const POLL_INTERVAL_MS = 5 * 60 * 1000

export function useHeaderKpis(): { kpis: HeaderKpis; loading: boolean } {
  const [kpis, setKpis] = useState<HeaderKpis>({ gmv: null, orders: null, pending: null })
  const [loading, setLoading] = useState(true)
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const today = todayYMDInTimezone(US_TIMEZONE)
      const params = new URLSearchParams({
        project_ids: 'all',
        country: 'US',
        start_date: today,
        end_date: today,
      })
      const response = await fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`daily-analysis ${response.status}`)
      const payload = (await response.json()) as { summary_rows?: SummaryRow[] }
      if (seq !== requestSeqRef.current) return
      setKpis(reduceHeaderKpis(Array.isArray(payload.summary_rows) ? payload.summary_rows : []))
    } catch {
      // 仅本模块降级：保持上次数据或占位
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return { kpis, loading }
}
