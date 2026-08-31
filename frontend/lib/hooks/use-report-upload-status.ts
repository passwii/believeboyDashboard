'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { TERMINAL_TICKER } from '@/components/terminal/terminal-constants'

/**
 * Footer「报表上传完成度」频道数据源（BLF-918 Stage 2）。
 *
 * 复用 RPA 报表状态矩阵端点（与「报表自动上传」页同源）：
 * GET /api/backend/api/v1/rpa-reports/status?report_date=美西今天&country=US，
 * 响应 items[].statuses[] 每 cell {report_type, has_data, is_uploaded}。
 * 聚合口径：M = 项目数 × 每项目类型数，N = is_uploaded===true 的 cell 数。
 * 缺口 >0 才渲染频道（全齐是默认态，不占滚动带宽）。
 *
 * 失败仅本频道降级（保留上次值/占位），不影响其他 ticker 频道（BLF-816 契约）。
 */

export type ReportUploadStatusStatus = 'loading' | 'ok' | 'error'

export type ReportUploadStatus = {
  /** 已上传 cell 数；null = 未就绪 */
  uploaded: number | null
  /** 总 cell 数（项目数 × 类型数）；null = 未就绪 */
  total: number | null
  /** 缺口 = total - uploaded；null = 未就绪 */
  missing: number | null
  status: ReportUploadStatusStatus
}

type StatusCell = {
  is_uploaded?: boolean | null
}

type ProjectItem = {
  statuses?: StatusCell[] | null
}

type ReportStatusResponse = {
  items?: ProjectItem[] | null
}

/** 纯函数：把状态矩阵 items 聚合为 {uploaded, total, missing}（容错：statuses 缺失按 0 cell） */
export function reduceUploadStatus(
  items: Array<{ statuses?: Array<{ is_uploaded?: boolean | null }> | null }>
): { uploaded: number; total: number; missing: number } {
  let uploaded = 0
  let total = 0
  for (const item of Array.isArray(items) ? items : []) {
    for (const cell of Array.isArray(item?.statuses) ? item.statuses : []) {
      total += 1
      if (cell?.is_uploaded === true) uploaded += 1
    }
  }
  return { uploaded, total, missing: total - uploaded }
}

function todayYMDinTimezone(tz: string): string {
  // en-CA locale 输出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}

const US_TIMEZONE = 'America/Los_Angeles'

const API_BASE = '/api/backend'

export function useReportUploadStatus(): ReportUploadStatus {
  const [counts, setCounts] = useState<{
    uploaded: number
    total: number
    missing: number
  } | null>(null)
  const [status, setStatus] = useState<ReportUploadStatusStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const params = new URLSearchParams({
        report_date: todayYMDinTimezone(US_TIMEZONE),
        country: 'US',
      })
      const response = await fetch(
        `${API_BASE}/api/v1/rpa-reports/status?${params.toString()}`,
        { cache: 'no-store' }
      )
      if (!response.ok) throw new Error(`rpa-reports/status ${response.status}`)
      const payload = (await response.json()) as ReportStatusResponse
      if (seq !== requestSeqRef.current) return
      const items = Array.isArray(payload?.items) ? payload.items : []
      setCounts(reduceUploadStatus(items))
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
      // 仅本频道降级：保留上次值（若有），状态置 error
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

  return {
    uploaded: counts?.uploaded ?? null,
    total: counts?.total ?? null,
    missing: counts?.missing ?? null,
    status,
  }
}
