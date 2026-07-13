'use client'

import { useEffect, useRef, useState } from 'react'

interface UseSmoothRefreshOptions {
  /** Loading state from the data fetch */
  loading: boolean
  /** Whether the data source currently has data (e.g. rows.length > 0) */
  hasData: boolean
}

interface UseSmoothRefreshReturn {
  /** True when this is the first load and there's no data yet — show skeleton */
  showSkeleton: boolean
  /** True when refreshing existing data — show progress bar, keep content visible */
  isRefreshing: boolean
}

/**
 * Distinguishes first load (show skeleton) from subsequent refresh (keep content, show progress).
 *
 * Usage:
 * ```tsx
 * const [loading, setLoading] = useState(true)
 * const [rows, setRows] = useState([])
 * const { showSkeleton, isRefreshing } = useSmoothRefresh({ loading, hasData: rows.length > 0 })
 * ```
 */
export function useSmoothRefresh({
  loading,
  hasData,
}: UseSmoothRefreshOptions): UseSmoothRefreshReturn {
  const everHadData = useRef(hasData)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

  // Track whether data has ever been present
  if (hasData) {
    everHadData.current = true
  }

  // Mark as "loaded once" whenever loading finishes
  useEffect(() => {
    if (!loading) {
      setHasLoadedOnce(true)
    }
  }, [loading])

  // First load with no data → skeleton
  // Subsequent loads (or first load but data exists from filter change) → refresh mode
  const showSkeleton = loading && !hasData && !hasLoadedOnce
  const isRefreshing = loading && !showSkeleton

  return { showSkeleton, isRefreshing }
}
