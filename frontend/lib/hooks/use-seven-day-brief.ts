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
  /** ACOAS（广告花费占销售额比）：近 7 天累计 adSpend / gmv × 100 */
  acoas: number | null
  /** ACOAS 变化百分点：近 7 天 ACOAS vs 上一周期 ACOAS（pp 差值） */
  acoasDelta: number | null
  /** 本月至今 GMV 合计（美元，BLF-967：当月 1 日 → T-1） */
  mtdGmv: number | null
  /** 本月 GMV 变化百分比：本月至今 vs 上月同期（同 pctChange 口径） */
  mtdGmvDelta: number | null
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

/** 百分点差值（percentage point difference）：current - previous（两个百分数的绝对差）
 *  用于 ACOAS 等比率指标的环比（非百分比变化率），避免歧义。 */
export function ppChange(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0
  return current - previous
}

/** 计算 ACOAS = adSpend / gmv × 100（保留 1 位小数） */
function computeAcoas(adSpend: number, gmv: number): number | null {
  if (gmv <= 0) return null
  return Math.round((adSpend / gmv) * 1000) / 10
}

/** 把 YYYY-MM-DD 平移 N 天 */
function shiftYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const shifted = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * 7 天快报的 4 个统计窗口 + 覆盖它们的并集区间（BLF-1038）。
 *
 * 输入 endDate 为数据终点 E（调用方传美西 T-1）：
 * - current：近 7 天 [E-6, E]
 * - previous：上一周期 [E-13, E-7]
 * - mtd / prevMtd：本月至今 vs 上月同期（见 mtdWindows）
 * - union：[min(E-13, prevMtd.start), E]
 *
 * union 恒覆盖全部 4 个窗口（prevMtd.start 是上月 1 日，早于 E-13 时取前者），
 * 因此一次请求即可在客户端按日期裁出各窗口，窗口口径与逐窗口分别请求一致。
 */
export function briefWindows(endDate: string): {
  unionStart: string
  unionEnd: string
  current: { start: string; end: string }
  previous: { start: string; end: string }
  mtd: { start: string; end: string }
  prevMtd: { start: string; end: string }
} {
  const currentStart = shiftYMD(endDate, -6)
  const previousEnd = shiftYMD(currentStart, -1)
  const previousStart = shiftYMD(previousEnd, -6)
  const mtd = mtdWindows(endDate)
  return {
    unionStart: previousStart <= mtd.prevStart ? previousStart : mtd.prevStart,
    unionEnd: endDate,
    current: { start: currentStart, end: endDate },
    previous: { start: previousStart, end: previousEnd },
    mtd: { start: mtd.mtdStart, end: mtd.mtdEnd },
    prevMtd: { start: mtd.prevStart, end: mtd.prevEnd },
  }
}

/** 按 YYYY-MM-DD 闭区间裁剪行（ISO 日期可字典序比较）；无 date 的行不参与窗口。 */
export function rowsInWindow<T extends { date?: string }>(
  rows: T[],
  start: string,
  end: string
): T[] {
  return rows.filter(
    (row) => typeof row.date === 'string' && row.date >= start && row.date <= end
  )
}

/**
 * 本月至今 vs 上月同期窗口（BLF-967）。
 *
 * 输入 endDate 为数据终点（调用方传 T-1，如 '2026-09-02'）：
 * - 本月窗口：当月 1 日 → endDate（含，`day` 天）
 * - 上月同期：上月 1 日 → 上月 `min(day, 上月天数)` 日（天数不足钳制，如 3-31 → 上月 02-01~02-28）
 *
 * 纯函数：与 shiftYMD 同风格（UTC + toISOString 切片），单测覆盖月中/月初/跨年/钳制/闰月。
 */
export function mtdWindows(endDate: string): {
  mtdStart: string
  mtdEnd: string
  prevStart: string
  prevEnd: string
} {
  const [y, m, d] = endDate.split('-').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  const mtdStart = `${y}-${pad(m!)}-01`
  const prevMonth = m === 1 ? 12 : m! - 1
  const prevYear = m === 1 ? y! - 1 : y
  const prevMonthDays = new Date(Date.UTC(prevYear!, prevMonth, 0)).getUTCDate()
  const prevDay = Math.min(d!, prevMonthDays)
  return {
    mtdStart,
    mtdEnd: endDate,
    prevStart: `${prevYear}-${pad(prevMonth)}-01`,
    prevEnd: `${prevYear}-${pad(prevMonth)}-${pad(prevDay)}`,
  }
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
    // BLF-1038：本 hook 只消费 summary_rows / available_dates，不需要逐 SKU
    // 的 detail_rows（30 天窗口实测 3.64MB vs 91KB）。后端 include_detail
    // 默认 true，故对其它调用方零影响；参数落地前后端忽略未知 query 参数。
    include_detail: 'false',
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
    acoas: null,
    acoasDelta: null,
    mtdGmv: null,
    mtdGmvDelta: null,
    latestSalesDate: null,
  })
  const [status, setStatus] = useState<SevenDayBriefStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const today = todayYMDinTimezone()
      const endDate = shiftYMD(today, -1)
      const windows = briefWindows(endDate)

      // BLF-1038：4 个窗口（近 7 天 / 上一周期 / 本月至今 / 上月同期）合并为
      // 1 次并集区间请求，取回后按日期各自裁剪。窗口间日期大量重叠，合并后
      // 请求数 4 → 1，传输量反而少于 4 次分别取，冷路径聚合成本也约减半。
      // 失败仍整体降级 error（与合并前 4 路并发失败同一语义）。
      const { rows, availableDates } = await fetchDailyTotals(
        windows.unionStart,
        windows.unionEnd
      )
      if (seq !== requestSeqRef.current) return

      const cur = aggregateWindow(rowsInWindow(rows, windows.current.start, windows.current.end))
      const prev = aggregateWindow(
        rowsInWindow(rows, windows.previous.start, windows.previous.end)
      )
      const mtdCurAgg = aggregateWindow(rowsInWindow(rows, windows.mtd.start, windows.mtd.end))
      const mtdPrevAgg = aggregateWindow(
        rowsInWindow(rows, windows.prevMtd.start, windows.prevMtd.end)
      )

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
        acoas: computeAcoas(cur.adSpend, cur.gmv),
        acoasDelta: (() => {
          const curAcoas = computeAcoas(cur.adSpend, cur.gmv)
          const prevAcoas = computeAcoas(prev.adSpend, prev.gmv)
          if (curAcoas == null || prevAcoas == null) return null
          return Math.round(ppChange(curAcoas, prevAcoas) * 10) / 10
        })(),
        mtdGmv: mtdCurAgg.gmv,
        mtdGmvDelta: pctChange(mtdCurAgg.gmv, mtdPrevAgg.gmv),
        // available_dates 由后端按项目取最新日期（与请求区间无关），并集请求
        // 得到的结果与原先「当前窗口」请求逐字节一致。
        latestSalesDate: pickLatestSalesDate(availableDates) ?? endDate,
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