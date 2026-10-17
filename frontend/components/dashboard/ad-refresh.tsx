'use client'

import { useEffect, useState } from 'react'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

/** Shared cache-busting signal for the ad-analysis and ad-data client subtrees. */
export const AD_CLIENT_REFRESH_EVENT = 'believeboy:ad-client-refresh'

export function requestAdClientRefresh(): void {
  clearAdClientCaches()
  window.dispatchEvent(new Event(AD_CLIENT_REFRESH_EVENT))
}

/** Remount only the ad data owner so its effects reload against an empty client cache. */
export function AdClientRefreshBoundary({ children }: { children: React.ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const onRefresh = () => setRefreshKey((current) => current + 1)
    window.addEventListener(AD_CLIENT_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(AD_CLIENT_REFRESH_EVENT, onRefresh)
  }, [])

  return <div key={refreshKey}>{children}</div>
}
