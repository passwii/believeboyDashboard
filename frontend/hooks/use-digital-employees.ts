'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { DigitalEmployee } from '@/types/digital-employee'
import { fetchDigitalEmployees } from '@/lib/digital-employee-api'
import { useApiQuery } from '@/lib/hooks/use-api-query'

interface UseDigitalEmployeesOptions {
  pollInterval?: number
}

export function useDigitalEmployees({ pollInterval = 10000 }: UseDigitalEmployeesOptions = {}) {
  const loader = useCallback(async (signal: AbortSignal): Promise<DigitalEmployee[]> => {
    const data = await fetchDigitalEmployees(signal)
    return data.items
  }, [])

  const { data, loading, error, retry } = useApiQuery<DigitalEmployee[]>(loader, {
    timeoutMs: 5_000,
    autoRetry: true,
  })

  // Polling: trigger a refresh on an interval while the component is mounted.
  // retry() bumps an internal nonce in useApiQuery and re-runs the loader.
  const retryRef = useRef(retry)
  retryRef.current = retry
  useEffect(() => {
    if (pollInterval <= 0) return
    const id = setInterval(() => {
      retryRef.current()
    }, pollInterval)
    return () => clearInterval(id)
  }, [pollInterval])

  return {
    employees: data ?? [],
    isLoading: loading,
    error: error ? new Error(error.message) : null,
    mutate: retry,
  }
}
