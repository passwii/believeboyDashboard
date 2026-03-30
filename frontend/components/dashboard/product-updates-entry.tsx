'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  PRODUCT_UPDATES_SEEN_EVENT,
  getProductUpdatesContext,
  openProductUpdatesSpotlight,
  readSeenProductUpdateIds,
} from '@/lib/product-updates'

export function ProductUpdatesEntry() {
  const pathname = usePathname()
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const syncUnreadCount = () => {
      const seenIds = new Set(readSeenProductUpdateIds())
      const context = getProductUpdatesContext(pathname)
      const relevantUpdates = context.fallbackToGlobal ? [] : context.matchedUpdates
      setUnreadCount(relevantUpdates.filter((item) => !seenIds.has(item.id)).length)
    }

    syncUnreadCount()
    window.addEventListener(PRODUCT_UPDATES_SEEN_EVENT, syncUnreadCount)

    return () => {
      window.removeEventListener(PRODUCT_UPDATES_SEEN_EVENT, syncUnreadCount)
    }
  }, [pathname])

  const badgeLabel = useMemo(() => {
    if (unreadCount <= 0) return null
    return unreadCount > 9 ? '9+' : String(unreadCount)
  }, [unreadCount])

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="产品更新"
      className="relative h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
      onClick={() => {
        openProductUpdatesSpotlight()
      }}
    >
      <Sparkles className="h-4 w-4" />
      {badgeLabel ? (
        <span className="absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.62rem] font-semibold leading-4 text-primary-foreground shadow-sm">
          {badgeLabel}
        </span>
      ) : null}
      <span className="sr-only">Product updates</span>
    </Button>
  )
}
