'use client'

import { createContext, useCallback, useEffect, useContext, useMemo, useRef, useState } from 'react'

type GlobalLoadingKind = 'blocking' | 'navigation'

const BLOCKING_WATCHDOG_MS = 10_000

type GlobalLoadingContextValue = {
  isLoading: boolean
  isBlockingLoading: boolean
  isNavigationLoading: boolean
  navigationTargetPath: string | null
  startGlobalLoading: (kind?: GlobalLoadingKind, options?: { targetPath?: string | null }) => void
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
  const [navigationTargetPath, setNavigationTargetPath] = useState<string | null>(null)
  const blockingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-clear blocking loading if it exceeds the watchdog timeout.
  useEffect(() => {
    if (blockingPendingCount > 0) {
      if (!blockingWatchdogRef.current) {
        blockingWatchdogRef.current = setTimeout(() => {
          setBlockingPendingCount(0)
          blockingWatchdogRef.current = null
        }, BLOCKING_WATCHDOG_MS)
      }
    } else {
      if (blockingWatchdogRef.current) {
        clearTimeout(blockingWatchdogRef.current)
        blockingWatchdogRef.current = null
      }
    }
    return () => {
      if (blockingWatchdogRef.current) {
        clearTimeout(blockingWatchdogRef.current)
        blockingWatchdogRef.current = null
      }
    }
  }, [blockingPendingCount])

  const startGlobalLoading = useCallback((
    kind: GlobalLoadingKind = 'blocking',
    options?: { targetPath?: string | null }
  ) => {
    if (kind === 'navigation') {
      setNavigationTargetPath(options?.targetPath?.trim() || null)
      setNavigationPendingCount((count) => count + 1)
      return
    }
    setBlockingPendingCount((count) => count + 1)
  }, [])

  const endGlobalLoading = useCallback((kind: GlobalLoadingKind = 'blocking') => {
    if (kind === 'navigation') {
      setNavigationPendingCount((count) => {
        const nextCount = Math.max(0, count - 1)
        if (nextCount === 0) {
          setNavigationTargetPath(null)
        }
        return nextCount
      })
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
      navigationTargetPath,
      startGlobalLoading,
      endGlobalLoading,
      withGlobalLoading,
    }),
    [blockingPendingCount, endGlobalLoading, navigationPendingCount, navigationTargetPath, startGlobalLoading, withGlobalLoading]
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
