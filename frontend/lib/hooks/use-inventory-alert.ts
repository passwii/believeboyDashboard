'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

/**
 * Footer「库存预警」频道数据源（BLF-840）。
 *
 * 复用补货分析端点，取「当前选中项目 + 当前选中站点」下处于断货风险态
 * （断货风险 / 短期断货 / 长期断货，即后端 risk_status 三段）的 SKU 数。
 * 这是后端维护的「低于安全库存」唯一真值（summary.out_of_stock_risk_count），
 * 前端不重算阈值 —— 任何阈值口径调整只在后端发生，避免前后端漂移。
 *
 * 契约（与后端 Damon 对齐）：
 *  - project_id 必填且 > 0；优先用全局筛选的当前选中项目，未选时回退第一个可管理项目。
 *  - country 必须显式带（默认 US），统计是 per (project, country) 不是纯 project 维度。
 *  - 不带 keyword / risk_status / in_transit_only 过滤；page_size=1 即可拿到全量 summary 计数。
 *  - 端点已有 5 分钟 Redis 缓存，前端按 pollIntervalMs(5min) 低频轮询，命中即返回。
 *
 * 失败仅本频道降级（保持上次值/占位），不影响其他 ticker 频道。
 */

export type InventoryAlertStatus = 'loading' | 'ok' | 'error'

export type InventoryAlert = {
  /** 低于安全库存的 SKU 数；null = 加载中或未就绪 */
  count: number | null
  status: InventoryAlertStatus
}

type ReplenishmentSummary = {
  out_of_stock_risk_count?: number
}

type ReplenishmentResponse = {
  summary?: ReplenishmentSummary
}

type ManagedProject = {
  id?: number | null
  name?: string
}

const API_BASE = '/api/backend'

/** 把全局筛选的项目 id 字符串解析为有效正整数；无效返回 null */
function resolveProjectId(globalProjectId: string): number | null {
  const parsed = Number(globalProjectId)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return null
}

export function useInventoryAlert(): InventoryAlert {
  const { data: session } = useSession()
  const { projectId: globalProjectId, country: globalCountry, ready } =
    useTerminalGlobalFilter()
  const [count, setCount] = useState<number | null>(null)
  const [status, setStatus] = useState<InventoryAlertStatus>('loading')
  const requestSeqRef = useRef(0)
  // 解析出的有效 project_id（全局无有效值时回退到第一个可管理项目）
  const [resolvedProjectId, setResolvedProjectId] = useState<number | null>(
    resolveProjectId(globalProjectId)
  )

  // 全局筛选未选有效项目时，回退到第一个可管理项目（保证频道有数据可取）
  useEffect(() => {
    const direct = resolveProjectId(globalProjectId)
    if (direct != null) {
      setResolvedProjectId(direct)
      return
    }
    let active = true
    async function fallbackToFirstProject() {
      try {
        const projects = await fetchManagedProjectsCached<ManagedProject[]>(session)
        const first = (Array.isArray(projects) ? projects : []).find((p) => p.id != null)
        if (active && first?.id != null) setResolvedProjectId(first.id)
      } catch {
        // 回退失败保持 null（频道降级隐藏）
      }
    }
    void fallbackToFirstProject()
    return () => {
      active = false
    }
  }, [globalProjectId, session])

  const load = useCallback(async () => {
    if (resolvedProjectId == null) return
    const seq = ++requestSeqRef.current
    try {
      const effectiveCountry = globalCountry || 'US'
      const params = new URLSearchParams({
        project_id: String(resolvedProjectId),
        country: effectiveCountry,
        page: '1',
        page_size: '1',
      })
      const response = await fetch(
        `${API_BASE}/api/v1/inventory-replenishment-analysis?${params.toString()}`,
        { cache: 'no-store' }
      )
      if (!response.ok) throw new Error(`inventory-replenishment-analysis ${response.status}`)
      const payload = (await response.json()) as ReplenishmentResponse
      if (seq !== requestSeqRef.current) return
      const next = payload.summary?.out_of_stock_risk_count ?? 0
      setCount(next)
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
      // 仅本频道降级：保留上次值（若有），状态置 error
      setStatus('error')
    }
  }, [resolvedProjectId, globalCountry])

  useEffect(() => {
    if (!ready || resolvedProjectId == null) return
    void load()
    const timer = window.setInterval(() => void load(), TERMINAL_TICKER.pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [ready, resolvedProjectId, load])

  return { count, status }
}
