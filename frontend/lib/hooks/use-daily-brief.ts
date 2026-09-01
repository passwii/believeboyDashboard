'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'

/**
 * Footer「全局快报」频道数据源（BLF-816 / BLF-920 Stage 1）。
 *
 * 复用首页 daily-analysis 聚合端点：取美西时区「今天」的
 * GMV（sales_amount）/ 订单数（order_qty）/ Pending 数（pending_order_qty）
 * / 广告花费（ad_spend）/ 广告订单（ad_orders）全局汇总，
 * 并对「昨天」「上周同日」各发一次同参请求（仅日期不同）计算环比参照
 * （DoD = vs 昨天，WoW = vs 上周同日），解决「看到 GMV 但不知道好坏」。
 * 失败仅本频道降级（返回 null），不影响其他 ticker 频道（BLF-816 契约）。
 */

export type DailyBrief = {
  /** 今日 GMV（美元） */
  gmv: number | null
  /** 今日订单数 */
  orders: number | null
  /** 今日 Pending 订单数（绝对值，无环比意义） */
  pending: number | null
  /** 今日广告花费（美元） */
  adSpend: number | null
  /** 今日广告订单数 */
  adOrders: number | null
  /** GMV 环比 vs 昨天（百分比；基数为 0 或无数据 → null） */
  gmvDoD: number | null
  /** GMV 环比 vs 上周同日（百分比；基数为 0 或无数据 → null） */
  gmvWoW: number | null
  /** 订单环比 vs 昨天（百分比；基数为 0 或无数据 → null） */
  ordersDoD: number | null
  /** 订单环比 vs 上周同日（百分比；基数为 0 或无数据 → null） */
  ordersWoW: number | null
  /** 关键报表最新数据日期（available_dates.sales_report[0]，YYYY-MM-DD；无 → null，BLF-921 数据新鲜度） */
  latestSalesDate: string | null
}

export type DailyBriefStatus = 'loading' | 'ok' | 'error'

type SummaryRow = {
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

/** 单日快照：reducer 输出的全是 number（非法值按 0 折算），null 只存在于合并前的 DailyBrief 占位态 */
type BriefTotals = {
  gmv: number
  orders: number
  pending: number
  adSpend: number
  adOrders: number
}

/** 纯函数：把 summary_rows 求和为单日全局快照（含广告字段） */
export function reduceDailyBrief(rows: SummaryRow[]): BriefTotals {
  let gmv = 0
  let orders = 0
  let pending = 0
  let adSpend = 0
  let adOrders = 0
  for (const row of rows) {
    gmv += toNumber(row.sales_amount) ?? 0
    orders += toNumber(row.order_qty) ?? 0
    pending += toNumber(row.pending_order_qty) ?? 0
    adSpend += toNumber(row.ad_spend) ?? 0
    adOrders += toNumber(row.ad_orders) ?? 0
  }
  return { gmv, orders, pending, adSpend, adOrders }
}

/** 涨跌百分比：(current - base) / base × 100；基数为 0 → null（除零防护） */
function pct(current: number, base: number): number | null {
  if (base === 0) return null
  return ((current - base) / base) * 100
}

/** 单日快照是否「有数据」：任一业务字段非 0 即视为有数据。
 * 供 T+1 数据滞后回退判断——请求「美西今天」通常还没数据，需回退到最近有数据日（BLF-xxx）。 */
export function hasData(totals: BriefTotals): boolean {
  return (
    totals.gmv > 0 ||
    totals.orders > 0 ||
    totals.pending > 0 ||
    totals.adSpend > 0 ||
    totals.adOrders > 0
  )
}

/** 从「日期从新到旧」的候选里选出最近一个有数据的日期；全无 → null。
 * 与 hasData 配合实现「美西今天无数据时回退到最近销售日」的快报展示。 */
export function pickLatestDataDay(
  candidates: Array<{ date: string; totals: BriefTotals }>
): string | null {
  for (const c of candidates) {
    if (hasData(c.totals)) return c.date
  }
  return null
}

/**
 * 纯函数：用今天/昨天/上周同日三个单日快照合成带环比的完整快报。
 * 今天或昨天缺数据时对应环比为 null（渲染层显示「—」）。
 */
export function computeChangePct(
  today: BriefTotals,
  yesterday: BriefTotals,
  lastWeek: BriefTotals
): DailyBrief {
  return {
    ...today,
    gmvDoD: pct(today.gmv, yesterday.gmv),
    ordersDoD: pct(today.orders, yesterday.orders),
    gmvWoW: pct(today.gmv, lastWeek.gmv),
    ordersWoW: pct(today.orders, lastWeek.orders),
    latestSalesDate: null,
  }
}

function todayYMDinTimezone(tz: string): string {
  // en-CA locale 输出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}

/** 把美西 YYYY-MM-DD 平移 N 天（按本地 Date 运算再格式化回 YMD，跨月/跨年安全） */
function shiftYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * 纯函数：从 daily-analysis 响应的 available_dates 提取最新销售数据日期。
 * 仅取 sales_report[0]（后端已保证数组内唯一且为各项目最新最大值）；
 * 缺失/空数组/非法响应 → null（数据新鲜度频道随之隐藏）。
 */
export function pickLatestSalesDate(
  availableDates: Record<string, string[] | undefined> | null | undefined
): string | null {
  const dates = availableDates?.sales_report
  return Array.isArray(dates) && dates.length > 0 ? dates[0] : null
}

const US_TIMEZONE = 'America/Los_Angeles'
/** T+1 数据滞后回退的最大天数：美西「今天」通常次日才入库，最多往前找 7 天 */
const MAX_FALLBACK_DAYS = 7

async function fetchDailyTotals(date: string): Promise<{ totals: BriefTotals; availableDates: Record<string, string[]> | undefined }> {
  const params = new URLSearchParams({
    project_ids: 'all',
    country: 'US',
    start_date: date,
    end_date: date,
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
    totals: reduceDailyBrief(Array.isArray(payload.summary_rows) ? payload.summary_rows : []),
    availableDates: payload.available_dates,
  }
}

/**
 * 从「美西今天」起逐日回退，找最近有销售数据的日期（T+1 数据滞后回退，BLF-xxx）。
 * 命中即返回该日期；窗口内（含今天）全无数据 → null（快报整体降级，避免误导性 $0）。
 */
async function findLatestDataDay(today: string): Promise<string | null> {
  for (let offset = 0; offset <= MAX_FALLBACK_DAYS; offset++) {
    const candidate = shiftYMD(today, -offset)
    const { totals } = await fetchDailyTotals(candidate)
    if (hasData(totals)) return candidate
  }
  return null
}

export function useDailyBrief(): { brief: DailyBrief; status: DailyBriefStatus } {
  const [brief, setBrief] = useState<DailyBrief>({
    gmv: null,
    orders: null,
    pending: null,
    adSpend: null,
    adOrders: null,
    gmvDoD: null,
    gmvWoW: null,
    ordersDoD: null,
    ordersWoW: null,
    latestSalesDate: null,
  })
  const [status, setStatus] = useState<DailyBriefStatus>('loading')
  const requestSeqRef = useRef(0)
  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const today = todayYMDinTimezone(US_TIMEZONE)
      // 回退锚点：优先「美西今天」，今天无数据（T+1 未入库）则取最近有数据日
      const anchorDate = await findLatestDataDay(today)
      if (seq !== requestSeqRef.current) return
      if (anchorDate == null) {
        // 窗口内无任何销售数据：整体降级（保持占位），不显示误导性的 $0
        setStatus('error')
        return
      }
      // 锚点日 + 昨日 + 上周同日并发取数，计算环比参照（同端点同参数，仅日期不同）
      const [anchorTotals, yesterdayTotals, lastWeekTotals] = await Promise.all([
        fetchDailyTotals(anchorDate),
        fetchDailyTotals(shiftYMD(anchorDate, -1)),
        fetchDailyTotals(shiftYMD(anchorDate, -7)),
      ])
      if (seq !== requestSeqRef.current) return
      // 数据新鲜度：直接以锚点日（最近有数据日）呈现，比 available_dates 更可信
      setBrief({
        ...computeChangePct(anchorTotals.totals, yesterdayTotals.totals, lastWeekTotals.totals),
        latestSalesDate: anchorDate,
      })
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
