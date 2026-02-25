'use client'

import { Loader2 } from 'lucide-react'
import { useGlobalLoading } from '@/components/global-loading-provider'

export function GlobalLoadingOverlay() {
  const { isLoading } = useGlobalLoading()

  if (!isLoading) {
    return null
  }

  return (
    <div className="pointer-events-auto absolute inset-0 z-[120] flex items-center justify-center bg-background/50 backdrop-blur-[1.5px]">
      <div className="w-[min(92vw,360px)] rounded-xl border border-border/70 bg-background/95 p-5 text-center shadow-lg">
        <div className="mb-3 inline-flex items-center gap-2 text-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm font-medium">加载中，请稍候...</span>
        </div>
        <div className="global-loading-track h-[3px] overflow-hidden rounded-full">
          <div className="global-loading-indicator h-full" />
        </div>
      </div>
    </div>
  )
}
