'use client'

import { useEffect } from 'react'

import {
  BACKEND_UNAVAILABLE_MESSAGE,
  BACKEND_UNAVAILABLE_TITLE,
  isBackendUnavailableError,
} from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'

export function GlobalErrorBridge() {
  const { notify } = useNotifications()

  useEffect(() => {
    const originalFetch = window.fetch.bind(window)

    window.fetch = async (...args) => {
      try {
        return await originalFetch(...args)
      } catch (error) {
        if (isBackendUnavailableError(error)) {
          notify({
            type: 'error',
            title: BACKEND_UNAVAILABLE_TITLE,
            message: BACKEND_UNAVAILABLE_MESSAGE,
            skipHistory: true,
          }, 6000)
          throw new Error(BACKEND_UNAVAILABLE_MESSAGE)
        }
        throw error
      }
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isBackendUnavailableError(event.reason)) {
        notify({
          type: 'error',
          title: BACKEND_UNAVAILABLE_TITLE,
          message: BACKEND_UNAVAILABLE_MESSAGE,
          skipHistory: true,
        }, 6000)
      }
    }

    const handleWindowError = (event: ErrorEvent) => {
      if (isBackendUnavailableError(event.error ?? event.message)) {
        notify({
          type: 'error',
          title: BACKEND_UNAVAILABLE_TITLE,
          message: BACKEND_UNAVAILABLE_MESSAGE,
          skipHistory: true,
        }, 6000)
      }
    }

    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    window.addEventListener('error', handleWindowError)

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      window.removeEventListener('error', handleWindowError)
      window.fetch = originalFetch
    }
  }, [notify])

  return null
}
