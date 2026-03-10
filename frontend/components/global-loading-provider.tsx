'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

type GlobalLoadingKind = 'blocking' | 'navigation'

type GlobalLoadingContextValue = {
  isLoading: boolean
  isBlockingLoading: boolean
  isNavigationLoading: boolean
  startGlobalLoading: (kind?: GlobalLoadingKind) => void
  endGlobalLoading: (kind?: GlobalLoadingKind) => void
  withGlobalLoading: <T>(task: () => Promise<T>) => Promise<T>
}

const GlobalLoadingContext = createContext<GlobalLoadingContextValue | null>(null)

export function GlobalLoadingProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [blockingPendingCount, setBlockingPendingCount] = useState(0)
  const [navigationPendingCount, setNavigationPendingCount] = useState(0)

  const startGlobalLoading = useCallback((kind: GlobalLoadingKind = 'blocking') => {
    if (kind === 'navigation') {
      setNavigationPendingCount((count) => count + 1)
      return
    }
    setBlockingPendingCount((count) => count + 1)
  }, [])

  const endGlobalLoading = useCallback((kind: GlobalLoadingKind = 'blocking') => {
    if (kind === 'navigation') {
      setNavigationPendingCount((count) => Math.max(0, count - 1))
      return
    }
    setBlockingPendingCount((count) => Math.max(0, count - 1))
  }, [])

  const withGlobalLoading = useCallback(async <T,>(task: () => Promise<T>) => {
    startGlobalLoading('blocking')
    try {
      return await task()
    } finally {
      endGlobalLoading('blocking')
    }
  }, [endGlobalLoading, startGlobalLoading])

  const value = useMemo<GlobalLoadingContextValue>(
    () => ({
      isLoading: blockingPendingCount > 0 || navigationPendingCount > 0,
      isBlockingLoading: blockingPendingCount > 0,
      isNavigationLoading: navigationPendingCount > 0,
      startGlobalLoading,
      endGlobalLoading,
      withGlobalLoading,
    }),
    [blockingPendingCount, endGlobalLoading, navigationPendingCount, startGlobalLoading, withGlobalLoading]
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
