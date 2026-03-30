'use client'

import { useCallback, useEffect, useState } from 'react'
import { Home, RefreshCw, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  BACKEND_UNAVAILABLE_MESSAGE,
  BACKEND_UNAVAILABLE_TITLE,
  isBackendUnavailableError,
} from '@/lib/error-utils'

type ErrorModalState = {
  title: string
  description: string
}

const BACKEND_ERROR_EVENT = 'app:backend-unavailable'

export function GlobalErrorBridge() {
  const [modalState, setModalState] = useState<ErrorModalState | null>(null)

  const openBackendUnavailableModal = useCallback(() => {
    setModalState({
      title: BACKEND_UNAVAILABLE_TITLE,
      description: BACKEND_UNAVAILABLE_MESSAGE,
    })
  }, [])

  useEffect(() => {
    const originalFetch = window.fetch.bind(window)

    window.fetch = async (...args) => {
      try {
        return await originalFetch(...args)
      } catch (error) {
        if (isBackendUnavailableError(error)) {
          window.dispatchEvent(new CustomEvent(BACKEND_ERROR_EVENT))
          throw new Error(BACKEND_UNAVAILABLE_MESSAGE)
        }
        throw error
      }
    }

    const handleBackendEvent = () => openBackendUnavailableModal()
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isBackendUnavailableError(event.reason)) {
        openBackendUnavailableModal()
      }
    }
    const handleWindowError = (event: ErrorEvent) => {
      if (isBackendUnavailableError(event.error ?? event.message)) {
        openBackendUnavailableModal()
      }
    }

    window.addEventListener(BACKEND_ERROR_EVENT, handleBackendEvent)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    window.addEventListener('error', handleWindowError)

    return () => {
      window.removeEventListener(BACKEND_ERROR_EVENT, handleBackendEvent)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      window.removeEventListener('error', handleWindowError)
      window.fetch = originalFetch
    }
  }, [openBackendUnavailableModal])

  if (!modalState) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[hsl(220_30%_8%/0.62)] p-4 backdrop-blur-md">
      <div className="relative w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-border/80 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] p-6 shadow-[var(--shadow-overlay)] sm:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--destructive)/0.12),transparent_28%),radial-gradient(circle_at_88%_16%,hsl(var(--warning)/0.14),transparent_20%)]" />
        <button
          type="button"
          aria-label="关闭提示"
          className="absolute right-4 top-4 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground transition hover:text-foreground"
          onClick={() => setModalState(null)}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative space-y-5">
          <div className="inline-flex rounded-full border border-[hsl(var(--destructive)/0.18)] bg-[hsl(var(--destructive)/0.08)] px-4 py-1.5 text-sm font-semibold text-[hsl(var(--destructive))]">
            系统连接异常
          </div>
          <div className="space-y-3">
            <h2 className="text-3xl font-semibold tracking-[-0.05em] text-foreground">
              {modalState.title}
            </h2>
            <p className="text-base leading-7 text-muted-foreground">
              {modalState.description}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
              刷新页面
            </Button>
            <Button variant="outline" onClick={() => window.location.assign('/dashboard')}>
              <Home className="h-4 w-4" />
              返回首页
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
