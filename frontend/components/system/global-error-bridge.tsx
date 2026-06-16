'use client'

import { useEffect, useRef } from 'react'

import {
  BACKEND_UNAVAILABLE_MESSAGE,
  BACKEND_UNAVAILABLE_TITLE,
  isBackendUnavailableError,
} from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'

// BEL-119: 抑制后端不可用 toast 的刷新/挂起/堆叠误报
// 规则：
//   1. 静默期：组件挂载后 2.5 s 内的后端不可用错误不弹（覆盖页面刷新）。
//   2. 冷却期：同一提醒 30 s 内只弹一次（覆盖后端宕机并发堆叠 + 多事件源重复触发）。
//   3. 页面隐藏时不弹（覆盖 tab 挂起）。
//   4. 浏览器已离线时不弹（属于用户环境问题，不是后端问题）。
//   5. fetch 包装抛出的标准化 Error 带 __backendUnavailableHandled 标记，
//      unhandledrejection 监听发现该标记就跳过（双保险，不依赖时间窗）。
const GRACE_MS = 2_500
const COOLDOWN_MS = 30_000
const BACKEND_HANDLED_FLAG = '__backendUnavailableHandled'

type BackendHandledError = Error & { [BACKEND_HANDLED_FLAG]?: boolean }

export function GlobalErrorBridge() {
  const { notify } = useNotifications()
  const mountedAtRef = useRef<number>(Date.now())
  const lastNotifyAtRef = useRef<number>(0)

  useEffect(() => {
    const showBackendUnavailableNotice = (): boolean => {
      // 1) tab 隐藏时直接跳过（用户在挂起态下看不到提醒，也不需要提醒）
      if (typeof document !== 'undefined' && document.hidden) return false

      // 2) 浏览器已离线（属于用户网络问题，不是后端问题；后端可能自愈）
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false

      const now = Date.now()

      // 3) 静默期：刷新后 2.5 s 内不弹（让首屏并发 fetch 失败被吞掉）
      if (now - mountedAtRef.current < GRACE_MS) return false

      // 4) 冷却期：30 s 内只弹一次（避免后端宕机时 toast 堆叠 + 三个事件源重复触发）
      if (now - lastNotifyAtRef.current < COOLDOWN_MS) return false

      lastNotifyAtRef.current = now
      notify(
        {
          type: 'error',
          title: BACKEND_UNAVAILABLE_TITLE,
          message: BACKEND_UNAVAILABLE_MESSAGE,
          skipHistory: true,
        },
        6000,
      )
      return true
    }

    const originalFetch = window.fetch.bind(window)

    window.fetch = async (...args) => {
      try {
        return await originalFetch(...args)
      } catch (error) {
        const url =
          typeof args[0] === 'string'
            ? args[0]
            : args[0] instanceof URL
              ? args[0].href
              : args[0].url
        if (url.includes('/api/auth/')) throw error
        if (isBackendUnavailableError(error)) {
          showBackendUnavailableNotice()
          // 抛出带标记的 Error，让 unhandledrejection 监听能够识别为「已被处理过」
          const handled: BackendHandledError = new Error(BACKEND_UNAVAILABLE_MESSAGE)
          handled[BACKEND_HANDLED_FLAG] = true
          throw handled
        }
        throw error
      }
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as BackendHandledError | undefined
      if (reason && reason[BACKEND_HANDLED_FLAG] === true) {
        // fetch 包装里已经弹过（或被闸门拒绝），这里不再弹
        return
      }
      if (isBackendUnavailableError(event.reason)) {
        showBackendUnavailableNotice()
      }
    }

    const handleWindowError = (event: ErrorEvent) => {
      if (isBackendUnavailableError(event.error ?? event.message)) {
        showBackendUnavailableNotice()
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
