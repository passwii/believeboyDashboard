'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseSnapshot, type OfficeEmployee } from './office-stream-types'

const STREAM_URL = '/api/backend/api/v1/digital-employees/office/stream'

/** 重连退避：1s → 2s → 4s → 8s → 最大 30s */
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

export function useOfficeStream() {
  const [employees, setEmployees] = useState<OfficeEmployee[]>([])
  const [connected, setConnected] = useState(false)
  const retriesRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    const es = new EventSource(STREAM_URL)

    es.addEventListener('snapshot', (e) => {
      const snap = parseSnapshot((e as MessageEvent).data)
      if (snap) setEmployees(snap.employees)
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

  useEffect(() => {
    const es = connect()
    return () => {
      es.close()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [connect])

  return { employees, connected }
}
