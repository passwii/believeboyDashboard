'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'

/**
 * Footer「全局快报」频道数据源（BLF-816）。
 *
 * 复用首页 daily-analysis 聚合端点：取美西时区「今天」的
 * GMV（sales_amount）/ 订单数（order_qty）/ Pending 数（pending_order_qty）全局汇总。
 * 失败仅本频道降级（返回 null），不影响其他 ticker 频道。
 */

export type DailyBrief = {
  /** 今日 GMV（美元） */
  gmv: number | null
  /** 今日订单数 */
  orders: number | null
  /** 今日 Pending 订单数 */
  pending: number | null
}

export type DailyBriefStatus = 'loading' | 'ok' | 'error'

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

/** 纯函数：把 summary_rows 求和为全局快报 */
export function reduceDailyBrief(rows: SummaryRow[]): DailyBrief {
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

function todayYMDinTimezone(tz: string): string {
  // en-CA locale 输出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}

const US_TIMEZONE = 'America/Los_Angeles'

export function useDailyBrief(): { brief: DailyBrief; status: DailyBriefStatus } {
  const [brief, setBrief] = useState<DailyBrief>({ gmv: null, orders: null, pending: null })
  const [status, setStatus] = useState<DailyBriefStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const params = new URLSearchParams({
        project_ids: 'all',
        country: 'US',
        start_date: todayYMDinTimezone(US_TIMEZONE),
        end_date: todayYMDinTimezone(US_TIMEZONE),
      })
      const response = await fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`daily-analysis ${response.status}`)
      const payload = (await response.json()) as { summary_rows?: SummaryRow[] }
      if (seq !== requestSeqRef.current) return
      setBrief(reduceDailyBrief(Array.isArray(payload.summary_rows) ? payload.summary_rows : []))
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
      // 仅本频道降级：保留上次数据或保持占位，不抛出
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, TERMINAL_TICKER.pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [load])

  return { brief, status }
}
