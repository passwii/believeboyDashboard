'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseSnapshot, parseChatter, type OfficeEmployee, type ChatterEvent } from './office-stream-types'

const STREAM_URL = '/api/backend/api/v1/digital-employees/office/stream'

/** 重连退避：1s → 2s → 4s → 8s → 最大 30s */
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

/** chatter feed 最多保留条数 */
const MAX_CHATTER = 50

export function useOfficeStream() {
  const [employees, setEmployees] = useState<OfficeEmployee[]>([])
  const [connected, setConnected] = useState(false)
  const [chatterFeed, setChatterFeed] = useState<ChatterEvent[]>([])
  const retriesRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const snapshotResolverRef = useRef<(() => void) | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const connect = useCallback(() => {
    const es = new EventSource(STREAM_URL)
    eventSourceRef.current = es

    es.addEventListener('snapshot', (e) => {
      const snap = parseSnapshot((e as MessageEvent).data)
      if (snap) {
        setEmployees(snap.employees)
        if (snapshotResolverRef.current) {
          snapshotResolverRef.current()
          snapshotResolverRef.current = null
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = null
          setRefreshing(false)
        }
      }
    })

    // P3-B: 监听 chatter 事件，追加到 feed（最新在前，上限 MAX_CHATTER）
    es.addEventListener('chatter', (e) => {
      const evt = parseChatter((e as MessageEvent).data)
      if (evt) {
        setChatterFeed((prev) => [evt, ...prev].slice(0, MAX_CHATTER))
      }
    })

    es.onopen = () => {
      setConnected(true)
      retriesRef.current = 0 // 连接成功，重置退避
    }

    es.onerror = () => {
      setConnected(false)
      es.close()
      // 指数退避重连
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** retriesRef.current, BACKOFF_MAX_MS)
      retriesRef.current += 1
      timerRef.current = setTimeout(connect, delay)
    }

    return es
  }, [])

  const refresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    eventSourceRef.current?.close()

    snapshotResolverRef.current = () => undefined
    refreshTimerRef.current = setTimeout(() => {
      snapshotResolverRef.current = null
      refreshTimerRef.current = null
      setRefreshing(false)
    }, 10_000)
    connect()
  }, [connect, refreshing])

  useEffect(() => {
    connect()
    return () => {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (timerRef.current) clearTimeout(timerRef.current)
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      snapshotResolverRef.current = null
    }
  }, [connect])

  return { employees, connected, chatterFeed, refreshing, refresh }
}
