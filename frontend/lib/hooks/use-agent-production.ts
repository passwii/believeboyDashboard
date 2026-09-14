'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { reduceUploadStatus } from '@/lib/hooks/use-report-upload-status'

/**
 * Agent 中心 · 数据流总览「今日产出」数据源(P2c-1)。
 *
 * 三个子源相互独立、各自降级(单频道范式,失败仅本源占位「—」):
 * - 客诉:GET /api/v1/complaints/overview?date=美西今天 → 今日待回复数(无巡检 run → hasRun=false)
 * - 巡检:GET /api/v1/inspections/periods/current → /periods/{id}/overview → 当前周期已提交/总报告数
 * - 报表:GET /api/v1/rpa-reports/status?report_date=美西今天&country=US → 上传完成度 M/N
 *
 * 全部走 /api/backend 代理(主 key 由代理附加);进页拉取,无轮询。
 */

export type ProductionStatus = 'loading' | 'ok' | 'error'

const API_BASE = '/api/backend'
const US_TIMEZONE = 'America/Los_Angeles'

/** 美西今天 YYYY-MM-DD(en-CA locale 输出 ISO 日期) */
export function usTodayYMD(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: US_TIMEZONE }).format(now)
}

/**
 * 后端 `GET /api/v1/complaints/overview` 响应形状
 * (`backend/app/schemas/complaint_center.py` 的 `OverviewResponse`)。
 *
 * 自 BLF-981(#556,`shop_id → project_id + country`)起,店铺行是 `projects`
 * (`OverviewProjectRow[]`);旧名 `shops` 已被**有意**换掉且未留兼容别名。
 * 本接口读的键由 `tests/fixtures/complaints-overview-*.json`(真实响应快照)
 * 在单测里钉住 —— 后端再改名时该用例变红,不会再像 `shops` 那样静默降级。
 */
export interface ComplaintsOverviewResponse {
  /** 有当日巡检 run 时非空;无 run 时后端返回 `[]` */
  projects?: unknown[]
  metrics?: { total_needs_reply?: unknown }
}

/** 本解析器读取的响应键(与真实响应快照做形状断言,改名即红) */
export const COMPLAINTS_OVERVIEW_KEYS = ['projects', 'metrics'] as const

/** 纯函数:客诉概览响应 → { hasRun, needsReply }(容错:非预期形状返回无 run) */
export function parseComplaintsOverview(payload: unknown): {
  hasRun: boolean
  needsReply: number | null
} {
  const p = (payload ?? {}) as ComplaintsOverviewResponse
  const projects = Array.isArray(p.projects) ? p.projects : []
  const needsReply = p.metrics?.total_needs_reply
  return {
    hasRun: projects.length > 0,
    needsReply: typeof needsReply === 'number' ? needsReply : null,
  }
}

/** 纯函数:巡检周期概览响应 → { submitted, total }(容错:非数字返回 null) */
export function parseInspectionOverview(payload: unknown): {
  submitted: number | null
  total: number | null
} {
  const p = (payload ?? {}) as { submitted_count?: unknown; total_projects?: unknown }
  return {
    submitted: typeof p.submitted_count === 'number' ? p.submitted_count : null,
    total: typeof p.total_projects === 'number' ? p.total_projects : null,
  }
}

/** 内部通用单源异步装载:独立状态 + 竞态守卫,失败降级 data=null(仅本源) */
function useAsyncSource<T>(fetcher: () => Promise<T>): {
  data: T | null
  status: ProductionStatus
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [status, setStatus] = useState<ProductionStatus>('loading')
  const seqRef = useRef(0)
  // fetcher 走 ref:调用方可以传内联箭头函数,load 保持稳定引用,
  // useEffect 不会因 fetcher 身份变化而反复触发
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const result = await fetcherRef.current()
      if (seq !== seqRef.current) return
      setData(result)
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

export interface AgentProduction {
  complaints: { hasRun: boolean; needsReply: number | null; status: ProductionStatus }
  inspection: { submitted: number | null; total: number | null; status: ProductionStatus }
  reports: { uploaded: number | null; total: number | null; status: ProductionStatus }
  /** 任一子源加载中 */
  loading: boolean
  reload: () => void
}

export function useAgentProduction(): AgentProduction {
  const complaints = useAsyncSource(async () => {
    const response = await fetch(
      `${API_BASE}/api/v1/complaints/overview?date=${usTodayYMD()}`,
      { cache: 'no-store' }
    )
    if (!response.ok) throw new Error(`complaints/overview ${response.status}`)
    return parseComplaintsOverview(await response.json())
  })

  const inspection = useAsyncSource(async () => {
    const currentRes = await fetch(`${API_BASE}/api/v1/inspections/periods/current`, {
      cache: 'no-store',
    })
    if (!currentRes.ok) throw new Error(`inspections/periods/current ${currentRes.status}`)
    const current = (await currentRes.json()) as { id?: unknown }
    if (typeof current?.id !== 'number') throw new Error('inspections: period id missing')
    const overviewRes = await fetch(
      `${API_BASE}/api/v1/inspections/periods/${current.id}/overview`,
      { cache: 'no-store' }
    )
    if (!overviewRes.ok) throw new Error(`inspections/overview ${overviewRes.status}`)
    return parseInspectionOverview(await overviewRes.json())
  })

  const reports = useAsyncSource(async () => {
    const response = await fetch(
      `${API_BASE}/api/v1/rpa-reports/status?report_date=${usTodayYMD()}&country=US`,
      { cache: 'no-store' }
    )
    if (!response.ok) throw new Error(`rpa-reports/status ${response.status}`)
    const payload = (await response.json()) as {
      items?: Array<{ statuses?: Array<{ is_uploaded?: boolean | null }> | null }> | null
    }
    return reduceUploadStatus(payload?.items ?? [])
  })

  const reload = useCallback(() => {
    complaints.reload()
    inspection.reload()
    reports.reload()
  }, [complaints, inspection, reports])

  return {
    complaints: {
      hasRun: complaints.data?.hasRun ?? false,
      needsReply: complaints.data?.needsReply ?? null,
      status: complaints.status,
    },
    inspection: {
      submitted: inspection.data?.submitted ?? null,
      total: inspection.data?.total ?? null,
      status: inspection.status,
    },
    reports: {
      uploaded: reports.data?.uploaded ?? null,
      total: reports.data?.total ?? null,
      status: reports.status,
    },
    loading:
      complaints.status === 'loading' ||
      inspection.status === 'loading' ||
      reports.status === 'loading',
    reload,
  }
}
