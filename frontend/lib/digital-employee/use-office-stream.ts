'use client'
import { useEffect, useRef, useState } from 'react'
import { parseSnapshot, type OfficeEmployee } from './office-stream-types'

const STREAM_URL = '/api/backend/api/v1/digital-employees/office/stream'

export function useOfficeStream() {
  const [employees, setEmployees] = useState<OfficeEmployee[]>([])
  const [connected, setConnected] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource(STREAM_URL)
    sourceRef.current = es
    es.addEventListener('snapshot', (e) => {
      const snap = parseSnapshot((e as MessageEvent).data)
      if (snap) setEmployees(snap.employees)
    })
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { employees, connected }
}
