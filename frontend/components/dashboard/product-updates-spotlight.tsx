'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Sparkles, ArrowRight, MapPin } from 'lucide-react'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  PRODUCT_UPDATES_OPEN_EVENT,
  getProductUpdatesContext,
  getProductUpdatesSnapshot,
  readSeenProductUpdateIds,
  writeSeenProductUpdateIds,
} from '@/lib/product-updates'

export function ProductUpdatesSpotlight() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const snapshot = useMemo(() => getProductUpdatesSnapshot(), [])
  const context = useMemo(() => getProductUpdatesContext(pathname), [pathname])
  const activeUpdate = context.primaryUpdate

  useEffect(() => {
    if (pathname.startsWith('/dashboard/feature-updates')) {
      writeSeenProductUpdateIds(snapshot.updates.map((item) => item.id))
      return
    }

    if (context.fallbackToGlobal) {
      return
    }

    const seenIds = new Set(readSeenProductUpdateIds())
    if (!seenIds.has(activeUpdate.id)) {
      setOpen(true)
    }
  }, [activeUpdate.id, context.fallbackToGlobal, pathname, snapshot.updates])

  useEffect(() => {
    const handleOpen = () => {
      setOpen(true)
    }

    window.addEventListener(PRODUCT_UPDATES_OPEN_EVENT, handleOpen)
    return () => {
      window.removeEventListener(PRODUCT_UPDATES_OPEN_EVENT, handleOpen)
    }
  }, [])

  const closeAndMarkSeen = () => {
    const seenIds = new Set(readSeenProductUpdateIds())
    seenIds.add(activeUpdate.id)
    writeSeenProductUpdateIds(Array.from(seenIds))
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        closeAndMarkSeen()
        return
      }
      setOpen(nextOpen)
    }}>
      <DialogContent className="max-w-xl overflow-hidden rounded-[1.75rem] border-border/80 p-0 dark:border-border/90">
        <div className="relative overflow-hidden bg-[linear-gradient(135deg,rgba(12,74,110,0.98),rgba(14,116,144,0.96)_48%,rgba(251,191,36,0.88))] px-6 py-6 text-white">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.22),transparent_32%),radial-gradient(circle_at_85%_18%,rgba(255,255,255,0.18),transparent_24%)]" />
          <DialogHeader className="relative space-y-3 text-left">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold tracking-[0.18em] uppercase text-white/88">
              <Sparkles className="h-3.5 w-3.5" />
              {context.fallbackToGlobal ? '最近功能更新' : '当前页面功能更新'}
            </div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/16 bg-white/8 px-3 py-1 text-xs text-white/80">
              <MapPin className="h-3.5 w-3.5" />
              {context.fallbackToGlobal ? '当前页面暂无专属更新，先看最近上新' : '这条说明和你当前页面直接相关'}
            </div>
            <DialogTitle className="text-2xl font-semibold tracking-tight text-white">
              {activeUpdate.title}
            </DialogTitle>
            <DialogDescription className="max-w-lg text-sm leading-6 text-white/78">
              {activeUpdate.summary}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 bg-background px-6 py-6 dark:bg-[hsl(var(--surface-panel))]">
          <div className="rounded-[1.35rem] border border-border/70 bg-[hsl(var(--surface-soft)/0.68)] p-4 dark:border-border/90">
            <p className="text-sm leading-6 text-foreground/88">{activeUpdate.narrative}</p>
          </div>

          <div className="space-y-3">
            {activeUpdate.audienceValue.slice(0, 3).map((item) => (
              <div
                key={item}
                className="flex items-start gap-3 rounded-[1.15rem] border border-border/70 bg-background/90 px-4 py-3 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.72)]"
              >
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
                <p className="text-sm leading-6 text-muted-foreground">{item}</p>
              </div>
            ))}
          </div>

          <DialogFooter className="gap-3 sm:justify-between sm:space-x-0">
            <Button variant="ghost" onClick={closeAndMarkSeen} className="justify-center">
              稍后再看
            </Button>
            <Button asChild className="justify-center rounded-xl">
              <RouteLoadingLink
                href="/dashboard/feature-updates"
                onClick={() => {
                  writeSeenProductUpdateIds(snapshot.updates.map((item) => item.id))
                  setOpen(false)
                }}
              >
                查看完整更新
                <ArrowRight className="h-4 w-4" />
              </RouteLoadingLink>
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
