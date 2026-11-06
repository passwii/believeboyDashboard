'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useGlobalLoading } from '@/components/global-loading-provider'

const GLOBAL_LOADING_OVERLAY_DELAY_MS = 180

export function GlobalLoadingOverlay() {
  const { isBlockingLoading, isNavigationLoading } = useGlobalLoading()
  const [isBlockingVisible, setIsBlockingVisible] = useState(false)
  const [isNavigationVisible, setIsNavigationVisible] = useState(false)

  useEffect(() => {
    if (!isBlockingLoading) {
      setIsBlockingVisible(false)
      return
    }

    const timer = setTimeout(() => {
      setIsBlockingVisible(true)
    }, GLOBAL_LOADING_OVERLAY_DELAY_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [isBlockingLoading])

  useEffect(() => {
    if (!isNavigationLoading) {
      setIsNavigationVisible(false)
      return
    }

    const timer = setTimeout(() => {
      setIsNavigationVisible(true)
    }, 120)

    return () => {
      clearTimeout(timer)
    }
  }, [isNavigationLoading])

  return (
    <>
      {isNavigationVisible ? (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[150] h-[3px] overflow-hidden bg-transparent">
          <div className="global-loading-indicator h-full w-[22%]" />
        </div>
      ) : null}
      {isBlockingVisible ? (
        <div className="pointer-events-auto fixed inset-0 z-[140] flex items-center justify-center bg-background/50 backdrop-blur-[1.5px]">
          <div className="w-[min(92vw,360px)] rounded-xl border border-border/70 bg-background/95 p-5 text-center shadow-lg">
            <div className="mb-3 inline-flex items-center gap-2 text-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm font-medium">加载中，请稍候...</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
