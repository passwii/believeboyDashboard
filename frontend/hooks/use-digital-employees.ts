'use client'

import { useEffect, useState, useCallback } from 'react'
import type { DigitalEmployee } from '@/types/digital-employee'
import { fetchDigitalEmployees } from '@/lib/digital-employee-api'

interface UseDigitalEmployeesOptions {
  pollInterval?: number
}

export function useDigitalEmployees({ pollInterval = 10000 }: UseDigitalEmployeesOptions = {}) {
  const [employees, setEmployees] = useState<DigitalEmployee[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await fetchDigitalEmployees()
      setEmployees(data.items)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, pollInterval)
    return () => clearInterval(interval)
  }, [load, pollInterval])

  return { employees, isLoading, error, mutate: load }
}