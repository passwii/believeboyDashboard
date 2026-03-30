'use client'

import { useEffect } from 'react'

import {
  StatusHomeAction,
  StatusPageShell,
} from '@/components/system/status-page-shell'
import { StatusRetryButton } from '@/components/system/status-retry-button'
import {
  BACKEND_UNAVAILABLE_MESSAGE,
  BACKEND_UNAVAILABLE_TITLE,
  GENERIC_ERROR_MESSAGE,
  GENERIC_ERROR_TITLE,
  isBackendUnavailableError,
} from '@/lib/error-utils'

export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  const isBackendError = isBackendUnavailableError(error)

  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <StatusPageShell
          code={isBackendError ? 'SERVER' : 'ERROR'}
          title={isBackendError ? BACKEND_UNAVAILABLE_TITLE : GENERIC_ERROR_TITLE}
          description={isBackendError ? BACKEND_UNAVAILABLE_MESSAGE : GENERIC_ERROR_MESSAGE}
          primaryAction={<StatusRetryButton onClick={reset} />}
          secondaryAction={<StatusHomeAction />}
        />
      </body>
    </html>
  )
}
