'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

type GlobalLoadingContextValue = {
  isLoading: boolean
  startGlobalLoading: () => void
  endGlobalLoading: () => void
  withGlobalLoading: <T>(task: () => Promise<T>) => Promise<T>
}

const GlobalLoadingContext = createContext<GlobalLoadingContextValue | null>(null)

export function GlobalLoadingProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [pendingCount, setPendingCount] = useState(0)

  const startGlobalLoading = useCallback(() => {
    setPendingCount((count) => count + 1)
  }, [])

  const endGlobalLoading = useCallback(() => {
    setPendingCount((count) => Math.max(0, count - 1))
  }, [])

  const withGlobalLoading = useCallback(async <T,>(task: () => Promise<T>) => {
    startGlobalLoading()
    try {
      return await task()
    } finally {
      endGlobalLoading()
    }
  }, [endGlobalLoading, startGlobalLoading])

  const value = useMemo<GlobalLoadingContextValue>(
    () => ({
      isLoading: pendingCount > 0,
      startGlobalLoading,
      endGlobalLoading,
      withGlobalLoading,
    }),
    [endGlobalLoading, pendingCount, startGlobalLoading, withGlobalLoading]
  )

  return (
    <GlobalLoadingContext.Provider value={value}>
      {children}
    </GlobalLoadingContext.Provider>
  )
}

export function useGlobalLoading() {
  const context = useContext(GlobalLoadingContext)
  if (!context) {
    throw new Error('useGlobalLoading must be used within GlobalLoadingProvider')
  }
  return context
}
