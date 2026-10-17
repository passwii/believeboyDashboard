'use client'

import { useEffect, useState } from 'react'

import { clearAdClientCaches } from '@/lib/ad-client-cache'

/** Shared refresh signal for ad-analysis and ad-data client data owners. */
export const AD_CLIENT_REFRESH_EVENT = 'believeboy:ad-client-refresh'

/** Invalidate cached responses and ask mounted ad data owners to reload. */
export function requestAdClientRefresh(): void {
  clearAdClientCaches()
  window.dispatchEvent(new Event(AD_CLIENT_REFRESH_EVENT))
}

/** Subscribe to the shared refresh signal and rerun the owning data effects. */
export function useAdClientRefreshKey(): number {
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const onRefresh = () => setRefreshKey((current) => current + 1)
    window.addEventListener(AD_CLIENT_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(AD_CLIENT_REFRESH_EVENT, onRefresh)
  }, [])

  return refreshKey
}
