'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'

/**
 * Footer 汇率 ticker 数据源（BLF-809 / BLF-816）。
 *
 * 从 /api/exchange-rates 拉取各币种最新两条月度汇率，计算环比涨跌；
 * 5 分钟轮询一次；失败降级为占位符（rate=null），不影响其他频道。
 *
 * BLF-816：币种不再写死 3 个 —— 以接口实际返回的币种为准（去重、按字母序），
 * 后端新增币种后 Footer 自动展示。
 */

export type ExchangeRateTick = {
  currency: string
  /** 最新汇率；null = 暂无数据（显示 "--" 占位） */
  rate: number | null
  /** 所属年月，如 "2026-08"；无数据时为 null */
  yearMonth: string | null
  /** 环比涨跌：最新一条相对上一条月度汇率的百分比变化；数据不足时为 null */
  changePct: number | null
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

/** 纯函数：把接口返回的 items 归约为每个币种「最新 + 上一条」，算出环比涨跌 */
export function reduceLatestTicks(items: ApiItem[]): ExchangeRateTick[] {
  // currency -> 按 year_month 降序排列的记录
  const byCurrency = new Map<string, ApiItem[]>()
  for (const item of items) {
    if (!item.currency) continue
    const list = byCurrency.get(item.currency) ?? []
    list.push(item)
    byCurrency.set(item.currency, list)
  }

  return [...byCurrency.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((currency) => {
      const sorted = (byCurrency.get(currency) ?? []).sort((a, b) =>
        String(b.year_month ?? '').localeCompare(String(a.year_month ?? ''))
      )
      const latest = sorted[0]
      // 上一条 = 最近一条「不同月份」的记录（同月重复上传不参与环比）
      const prev = sorted.find(
        (it) =>
          it !== latest && String(it.year_month ?? '') !== String(latest?.year_month ?? '')
      )
      const rate = Number(latest.rate)
      let changePct: number | null = null
      if (prev && latest.year_month && prev.year_month !== latest.year_month) {
        const prevRate = Number(prev.rate)
        if (Number.isFinite(rate) && Number.isFinite(prevRate) && prevRate !== 0) {
          changePct = ((rate - prevRate) / prevRate) * 100
        }
      }
      return {
        currency,
        rate: Number.isFinite(rate) ? rate : null,
        yearMonth: latest?.year_month ?? null,
        changePct,
      }
    })
}

const POLL_INTERVAL_MS = TERMINAL_TICKER.pollIntervalMs

export function useExchangeRateTicker(): UseExchangeRateTickerResult {
  const [ticks, setTicks] = useState<ExchangeRateTick[]>([])
  const [status, setStatus] = useState<TickerStatus>('loading')
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const response = await fetch('/api/exchange-rates?pageSize=500', { cache: 'no-store' })
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
