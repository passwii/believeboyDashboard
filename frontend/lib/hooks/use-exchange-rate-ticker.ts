'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Footer 汇率 ticker 数据源（BLF-809）。
 *
 * 从 /api/exchange-rates 拉取各币种最新一条月度汇率（USD/EUR/GBP → RMB），
 * 5 分钟轮询一次；失败降级为占位符（rate=null），不影响 UI。
 */

export const TICKER_CURRENCIES = ['USD', 'EUR', 'GBP'] as const
export type TickerCurrency = (typeof TICKER_CURRENCIES)[number]

export type ExchangeRateTick = {
  currency: string
  /** 最新汇率；null = 暂无数据（显示 "--" 占位） */
  rate: number | null
  /** 所属年月，如 "2026-08"；无数据时为 null */
  yearMonth: string | null
}

export type TickerStatus = 'loading' | 'ok' | 'error'

export interface UseExchangeRateTickerResult {
  ticks: ExchangeRateTick[]
  status: TickerStatus
  /** 最近一次成功拉取时间（epoch ms）；null = 尚未成功过 */
  lastSuccessAt: number | null
  refresh: () => void
}

type ApiItem = {
  currency: string
  rate: number
  year_month: string | null
}

/** 纯函数：把接口返回的 items 归约为每个目标币种的最新一条（按 year_month 降序取首个） */
export function reduceLatestTicks(
  items: ApiItem[],
  currencies: readonly string[] = TICKER_CURRENCIES
): ExchangeRateTick[] {
  const byCurrency = new Map<string, ApiItem>()
  for (const item of items) {
    if (!currencies.includes(item.currency)) continue
    const prev = byCurrency.get(item.currency)
    if (!prev || String(item.year_month ?? '') > String(prev.year_month ?? '')) {
      byCurrency.set(item.currency, item)
    }
  }
  return currencies.map((currency) => {
    const hit = byCurrency.get(currency)
    return {
      currency,
      rate: hit ? Number(hit.rate) : null,
      yearMonth: hit?.year_month ?? null,
    }
  })
}

const POLL_INTERVAL_MS = 5 * 60 * 1000

export function useExchangeRateTicker(): UseExchangeRateTickerResult {
  const [ticks, setTicks] = useState<ExchangeRateTick[]>(
    TICKER_CURRENCIES.map((currency) => ({ currency, rate: null, yearMonth: null }))
  )
  const [status, setStatus] = useState<TickerStatus>('loading')
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const response = await fetch('/api/exchange-rates?pageSize=100', { cache: 'no-store' })
      if (!response.ok) throw new Error(`exchange-rates ${response.status}`)
      const payload = (await response.json()) as { data?: ApiItem[] }
      if (seq !== requestSeqRef.current) return
      setTicks(reduceLatestTicks(Array.isArray(payload.data) ? payload.data : []))
      setStatus('ok')
      setLastSuccessAt(Date.now())
    } catch {
      if (seq !== requestSeqRef.current) return
      // 失败降级：保留上次数据，仅置 error 态让 footer 显示警示点
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return { ticks, status, lastSuccessAt, refresh: load }
}
