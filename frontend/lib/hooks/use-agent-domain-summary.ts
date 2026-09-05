'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Agent 中心 · 数据流总览「域活动聚合」数据源(P2b 前端预埋)。
 *
 * 契约(docs/superpowers/plans/2026-09-05-agent-dataflow-overview §P2b):
 * GET /api/backend/api/v1/agent-ops/domain-summary?days=7
 * → { generated_at, items: [{ domain, calls_24h, calls_7d, writes_24h, writes_7d, errors_7d, last_active_at }] }
 *
 * 端点未上线(404)或出错时本 hook 优雅降级:data = null,总览矩阵三列渲染占位「—」;
 * 后端交付后无需前端改动即可点亮。无轮询(管理总览页,进页拉一次)。
 */

export type DomainSummaryStatus = 'loading' | 'ok' | 'error'

export type DomainSummary = {
  /** 域 code(= agent_api_audit_log.operation_type,与 AGENT_DOMAINS.code 一致) */
  domain: string
  calls_24h: number
  calls_7d: number
  writes_24h: number
  writes_7d: number
  errors_7d: number
  /** 最近活动 ISO 时间;从未活动可缺省 */
  last_active_at?: string | null
}

export type DomainSummaryMap = Record<string, DomainSummary>

type DomainSummaryResponse = {
  generated_at?: string
  items?: DomainSummary[] | null
}

const API_BASE = '/api/backend'

/** 纯函数:聚合 items → 按 domain code 索引的 map(容错:非法条目跳过) */
export function reduceDomainSummaries(
  items: DomainSummary[] | null | undefined
): DomainSummaryMap {
  const map: DomainSummaryMap = {}
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.domain === 'string' && item.domain) {
      map[item.domain] = item
    }
  }
  return map
}

export type Freshness = 'green' | 'yellow' | 'gray'

/** 纯函数:最近活动时间 → 新鲜度档位(绿 <24h / 黄 1-7d / 灰 >7d 或从未;每日巡检域黄灯即需人工介入) */
export function freshnessFor(
  lastActiveAt: string | null | undefined,
  now: Date = new Date()
): Freshness {
  if (!lastActiveAt) return 'gray'
  const t = new Date(lastActiveAt).getTime()
  if (Number.isNaN(t)) return 'gray'
  const hours = (now.getTime() - t) / 3_600_000
  if (hours < 24) return 'green'
  if (hours < 24 * 7) return 'yellow'
  return 'gray'
}

export function useAgentDomainSummary(): { data: DomainSummaryMap | null; status: DomainSummaryStatus } {
  const [data, setData] = useState<DomainSummaryMap | null>(null)
  const [status, setStatus] = useState<DomainSummaryStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const response = await fetch(`${API_BASE}/api/v1/agent-ops/domain-summary?days=7`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`agent-ops/domain-summary ${response.status}`)
      const payload = (await response.json()) as DomainSummaryResponse
      if (seq !== requestSeqRef.current) return
      setData(reduceDomainSummaries(payload?.items))
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
      // 仅本面板降级:端点未上线(404)或出错 → data 置 null,矩阵列渲染占位
      setData(null)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { data, status }
}
