'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'
import { pctChange } from '@/components/dashboard-v2/v2-stats'

/**
 * Footer「全局快报」7 天聚合数据源（BLF-950）。
 *
 * 复用 Dashboard 首页近 7 天数据处理逻辑：对 daily-analysis 端点取「近 7 天」
 * （美西时区 T-1 为终点，往前 7 天）和「上一周期」（前 7 天窗口）两组数据，
 * 分别汇总 GMV/订单数/广告花费/广告订单数（Pending 取最新日），
 * 并计算当前窗口 vs 上一周期的变化百分比。
 *
 * 对比 Dashboard 首页的 computeStats / pctChange 同口径：
 * - sum('sales_amount') → gmv
 * - sum('order_qty') → orders
 * - sum('ad_spend') → adSpend
 * - sum('ad_orders') → adOrders
 * - pctChange = (current - previous) / previous * 100
 */

export type SevenDayBrief = {
  /** 近 7 天 GMV 合计（美元） */
  gmv: number | null
  /** 近 7 天订单数合计 */
  orders: number | null
  /** 近 7 天 Pending 订单数（取最新日） */
  pending: number | null
  /** 近 7 天广告花费合计（美元） */
  adSpend: number | null
  /** 近 7 天广告订单数合计 */
  adOrders: number | null
  /** GMV 变化百分比：近 7 天 vs 上一周期 */
  gmvDelta: number | null
  /** 订单数变化百分比：近 7 天 vs 上一周期 */
  ordersDelta: number | null
  /** 广告花费变化百分比：近 7 天 vs 上一周期 */
  adSpendDelta: number | null
  /** 广告订单数变化百分比：近 7 天 vs 上一周期 */
  adOrdersDelta: number | null
  /** 关键报表最新数据日期（available_dates.sales_report[0]，YYYY-MM-DD；无 → null） */
  latestSalesDate: string | null
}

export type SevenDayBriefStatus = 'loading' | 'ok' | 'error'

export type SummaryRow = {
  date?: string
  sales_amount?: number | string | null
  order_qty?: number | string | null
  pending_order_qty?: number | string | null
  ad_spend?: number | string | null
  ad_orders?: number | string | null
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 纯函数：把 summary_rows 求和为 7 天窗口聚合快照（复用 Dashboard 首页 computeStats 模式）。
 * Pending 为存量快照非流量指标：取窗口内最新日期的值（跨日累加无意义）。 */
export function aggregateWindow(rows: SummaryRow[]): {
  gmv: number
  orders: number
  pending: number
  adSpend: number
  adOrders: number
} {
  let gmv = 0
  let orders = 0
  let pending = 0
  let adSpend = 0
  let adOrders = 0
  let latestDate = ''
  for (const row of rows) {
    gmv += toNumber(row.sales_amount) ?? 0
    orders += toNumber(row.order_qty) ?? 0
    adSpend += toNumber(row.ad_spend) ?? 0
    adOrders += toNumber(row.ad_orders) ?? 0
    // Pending 取窗口内最新日（date 最大行）的值
    const date = typeof row.date === 'string' ? row.date : ''
    if (date >= latestDate && toNumber(row.pending_order_qty) != null) {
      latestDate = date
      pending = toNumber(row.pending_order_qty) ?? 0
    }
  }
  return { gmv, orders, pending, adSpend, adOrders }
}

/** 美西时区 YYYY-MM-DD */
function todayYMDinTimezone(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date())
}

/** 把 YYYY-MM-DD 平移 N 天 */
function shiftYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const shifted = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

/** 从 available_dates 提取最新销售数据日期 */
export function pickLatestSalesDate(
  availableDates: Record<string, string[] | undefined> | null | undefined
): string | null {
  const dates = availableDates?.sales_report
  return Array.isArray(dates) && dates.length > 0 ? dates[0] : null
}

async function fetchDailyTotals(
  startDate: string,
  endDate: string
): Promise<{
  rows: SummaryRow[]
  availableDates: Record<string, string[]> | undefined
}> {
  const params = new URLSearchParams({
    project_ids: 'all',
    country: 'US',
    start_date: startDate,
    end_date: endDate,
  })
  const response = await fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`daily-analysis ${response.status}`)
  const payload = (await response.json()) as {
    summary_rows?: SummaryRow[]
    available_dates?: Record<string, string[]>
  }
  return {
    rows: Array.isArray(payload.summary_rows) ? payload.summary_rows : [],
    availableDates: payload.available_dates,
  }
}

export function useSevenDayBrief(): {
  brief: SevenDayBrief
  status: SevenDayBriefStatus
} {
  const [brief, setBrief] = useState<SevenDayBrief>({
    gmv: null,
    orders: null,
    pending: null,
    adSpend: null,
    adOrders: null,
    gmvDelta: null,
    ordersDelta: null,
    adSpendDelta: null,
    adOrdersDelta: null,
    latestSalesDate: null,
  })
  const [status, setStatus] = useState<SevenDayBriefStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const today = todayYMDinTimezone()
      // 近 7 天窗口：T-7 到 T-1（美西昨天为终点）
      const endDate = shiftYMD(today, -1)
      const startDate = shiftYMD(endDate, -6)
      // 上一周期窗口：紧邻的前 7 天
      const prevEndDate = shiftYMD(startDate, -1)
      const prevStartDate = shiftYMD(prevEndDate, -6)

      // 当前窗口 + 上一周期窗口并发取数
      const [current, previous] = await Promise.all([
        fetchDailyTotals(startDate, endDate),
        fetchDailyTotals(prevStartDate, prevEndDate),
      ])
      if (seq !== requestSeqRef.current) return

      const cur = aggregateWindow(current.rows)
      const prev = aggregateWindow(previous.rows)

      setBrief({
        gmv: cur.gmv,
        orders: cur.orders,
        pending: cur.pending,
        adSpend: cur.adSpend,
        adOrders: cur.adOrders,
        gmvDelta: pctChange(cur.gmv, prev.gmv),
        ordersDelta: pctChange(cur.orders, prev.orders),
        adSpendDelta: pctChange(cur.adSpend, prev.adSpend),
        adOrdersDelta: pctChange(cur.adOrders, prev.adOrders),
        latestSalesDate: pickLatestSalesDate(current.availableDates) ?? endDate,
      })
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
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