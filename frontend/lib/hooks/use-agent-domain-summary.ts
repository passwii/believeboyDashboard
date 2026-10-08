'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Agent 中心 · 数据流总览「域活动聚合」数据源(P2b 前端预埋)。
 *
 * 契约(docs/superpowers/plans/2026-09-05-agent-dataflow-overview §P2b):
 * GET /api/backend/api/v1/agent-ops/domain-summary?days=30
 * → 后端响应字段仍叫 calls_7d / writes_7d / errors_7d,但统计窗口由 days 参数决定;
 * 本 hook 将其映射成前端的 30d 字段,供总览页明确展示为 30 天窗口。
 *
 * 端点未上线(404)或出错时本 hook 优雅降级:data = null,总览矩阵三列渲染占位「—」;
 * 后端交付后无需前端改动即可点亮。无轮询(管理总览页,进页拉一次)。
 */

export type DomainSummaryStatus = 'loading' | 'ok' | 'error'

export type DomainSummary = {
  /** 域 code(= agent_api_audit_log.operation_type,与 AGENT_DOMAINS.code 一致) */
  domain: string
  calls_24h: number
  calls_30d: number
  writes_24h: number
  writes_30d: number
  errors_30d: number
  /** 最近活动 ISO 时间;从未活动可缺省 */
  last_active_at?: string | null
}

export type DomainSummaryMap = Record<string, DomainSummary>

type DomainSummaryResponseItem = {
  domain: string
  calls_24h: number
  calls_7d: number
  writes_24h: number
  writes_7d: number
  errors_7d: number
  last_active_at?: string | null
}

type DomainSummaryResponse = {
  generated_at?: string
  items?: DomainSummaryResponseItem[] | null
}

const API_BASE = '/api/backend'

/** 纯函数:聚合 items → 按 domain code 索引的 map(容错:非法条目跳过) */
export function reduceDomainSummaries(
  items: DomainSummaryResponseItem[] | null | undefined
): DomainSummaryMap {
  const map: DomainSummaryMap = {}
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.domain === 'string' && item.domain) {
      map[item.domain] = {
        domain: item.domain,
        calls_24h: item.calls_24h,
        calls_30d: item.calls_7d,
        writes_24h: item.writes_24h,
        writes_30d: item.writes_7d,
        errors_30d: item.errors_7d,
        last_active_at: item.last_active_at,
      }
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

/** 纯函数:ISO 时间 → 相对时长文案(刚刚 / N 分钟前 / N 小时前 / N 天前 / M/D);总览页与员工花名册共用 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date()
): string {
  if (!iso) return '从未'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '从未'
  const minutes = (now.getTime() - t) / 60_000
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`
  const hours = minutes / 60
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  const days = hours / 24
  if (days < 30) return `${Math.floor(days)} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function useAgentDomainSummary(): {
  data: DomainSummaryMap | null
  status: DomainSummaryStatus
  reload: () => void
} {
  const [data, setData] = useState<DomainSummaryMap | null>(null)
  const [status, setStatus] = useState<DomainSummaryStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const response = await fetch(`${API_BASE}/api/v1/agent-ops/domain-summary?days=30`, {
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

  return { data, status, reload: load }
}
