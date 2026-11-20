'use client'

import { useEffect } from 'react'

import { ThemeProvider } from '@/components/theme-provider'
import { StatusHomeAction, StatusPageShell } from '@/components/system/status-page-shell'
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
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <StatusPageShell
            code={isBackendError ? 'SERVER' : 'ERROR'}
            kind="error"
            title={isBackendError ? BACKEND_UNAVAILABLE_TITLE : GENERIC_ERROR_TITLE}
            description={isBackendError ? BACKEND_UNAVAILABLE_MESSAGE : GENERIC_ERROR_MESSAGE}
            primaryAction={<StatusHomeAction />}
            secondaryAction={<StatusRetryButton onClick={reset} />}
          />
        </ThemeProvider>
      </body>
    </html>
  )
}
