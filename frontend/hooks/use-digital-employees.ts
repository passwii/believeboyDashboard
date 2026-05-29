'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import type { DigitalEmployee } from '@/types/digital-employee'
import { fetchDigitalEmployees } from '@/lib/digital-employee-api'

interface UseDigitalEmployeesOptions {
  pollInterval?: number
}

export function useDigitalEmployees({ pollInterval = 10000 }: UseDigitalEmployeesOptions = {}) {
  const [employees, setEmployees] = useState<DigitalEmployee[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const activeRef = useRef(true)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await fetchDigitalEmployees()
      if (!activeRef.current) return
      setEmployees(data.items)
      setError(null)
    } catch (err) {
      if (!activeRef.current) return
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      if (activeRef.current) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    activeRef.current = true
    load()
    const interval = setInterval(load, pollInterval)
    return () => {
      activeRef.current = false
      clearInterval(interval)
    }
  }, [load, pollInterval])

  return { employees, isLoading, error, mutate: load }
}