'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Footer 右侧固定区「在线人数」数据源（BLF-918 Stage 3）。
 *
 * 复用团队在线状态端点：
 * GET /api/backend/api/v1/system-management/presence，
 * 响应 {server_time, items[]}，items.length 即活跃用户数（90s 过期口径由后端定）。
 *
 * footer 只读不发 heartbeat（观察者不上报）；失败仅本段降级（online 保持 null → 隐藏），
 * 不影响其他右侧区段（BLF-816 契约）。
 */

export type PresenceStatus = 'loading' | 'ok' | 'error'

export type PresenceResponse = {
  server_time?: string | null
  items?: Array<{ user_id?: string | null }> | null
}

export type PresenceCountResult = {
  /** 当前在线人数；null = 未就绪/失败（渲染侧隐藏） */
  online: number | null
  status: PresenceStatus
}

/** presence 轮询间隔（在线状态分钟级时效，60s） */
export const PRESENCE_POLL_INTERVAL_MS = 60 * 1000

const API_BASE = '/api/backend'

export function usePresenceCount(): PresenceCountResult {
  const [online, setOnline] = useState<number | null>(null)
  const [status, setStatus] = useState<PresenceStatus>('loading')
  const requestSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/presence`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`presence ${response.status}`)
      const payload = (await response.json()) as PresenceResponse
      if (seq !== requestSeqRef.current) return
      const items = Array.isArray(payload?.items) ? payload.items : []
      setOnline(items.length)
      setStatus('ok')
    } catch {
      if (seq !== requestSeqRef.current) return
      // 仅本段降级：保留上次值（若有），状态置 error
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, PRESENCE_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return { online, status }
}
