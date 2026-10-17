'use client'

import { useEffect, useState } from 'react'

/** Active advertisement data surfaces listen for a cache-busting Head refresh from their shared filters. */
export const AD_CLIENT_REFRESH_EVENT = 'believeboy:ad-client-refresh'

export function useAdClientRefreshKey(): number {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const onRefresh = () => setRefreshKey((current) => current + 1)
    window.addEventListener(AD_CLIENT_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(AD_CLIENT_REFRESH_EVENT, onRefresh)
  }, [])

  return refreshKey
}
