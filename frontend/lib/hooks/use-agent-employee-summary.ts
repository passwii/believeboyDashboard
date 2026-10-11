'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Agent 员工活动聚合数据源(P3b)。
 *
 * 契约(docs/superpowers/plans/2026-09-05-agent-employee-roster §P3b):
 * GET /api/backend/api/v1/agent-ops/employee-summary?days=30
 * → 响应仍使用 calls_7d / writes_7d / errors_7d 字段名,但统计窗口由 days 参数决定;
 * 本 hook 将它们映射为 30d 字段,24h 字段保持独立。
 *
 * 端点未上线(404)或出错时优雅降级:data = null,花名册活动列渲染占位「—」。
 * 前端以 listAgentApiKeys 花名册按 api_key_id join;未活动员工无条目。
 */

export type EmployeeSummaryStatus = 'loading' | 'ok' | 'error'

export type EmployeeSummary = {
  api_key_id: number
  calls_24h: number
  calls_30d: number
  writes_24h: number
  writes_30d: number
  errors_30d: number
  last_active_at?: string | null
}

export type EmployeeSummaryMap = Record<string, EmployeeSummary>

type EmployeeSummaryResponseItem = {
  api_key_id: number
  calls_24h: number
  calls_7d: number
  writes_24h: number
  writes_7d: number
  errors_7d: number
  last_active_at?: string | null
}

type EmployeeSummaryResponse = {
  generated_at?: string
  window_days?: number
  items?: EmployeeSummaryResponseItem[] | null
}

const API_BASE = '/api/backend'

/** 纯函数:聚合 items → 按 api_key_id 索引的 map(容错:非法条目跳过) */
export function reduceEmployeeSummaries(
  items: EmployeeSummaryResponseItem[] | null | undefined
): EmployeeSummaryMap {
  const map: EmployeeSummaryMap = {}
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.api_key_id === 'number') {
      map[String(item.api_key_id)] = {
        api_key_id: item.api_key_id,
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

export function useAgentEmployeeSummary(): {
  data: EmployeeSummaryMap | null
  status: EmployeeSummaryStatus
  reload: () => void
} {
  const [data, setData] = useState<EmployeeSummaryMap | null>(null)
  const [status, setStatus] = useState<EmployeeSummaryStatus>('loading')
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const response = await fetch(`${API_BASE}/api/v1/agent-ops/employee-summary?days=30`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`agent-ops/employee-summary ${response.status}`)
      const payload = (await response.json()) as EmployeeSummaryResponse
      if (seq !== seqRef.current) return
      setData(reduceEmployeeSummaries(payload?.items))
      setStatus('ok')
    } catch {
      if (seq !== seqRef.current) return
      setData(null)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { data, status, reload: load }
}
