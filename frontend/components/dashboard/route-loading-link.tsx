'use client'

import { type MouseEvent, useCallback, useEffect, useRef } from 'react'
import Link, { type LinkProps } from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useGlobalLoading } from '@/components/global-loading-provider'
// BLF-809：路由级加载反馈不依赖 SidebarProvider 上下文；
// 移动端抽屉由外壳自管（导航回调里自行关闭）。

const NAVIGATION_LOADING_WATCHDOG_MS = 10_000
const IDLE_PREFETCH_DELAY_MS = 120

type RouteLoadingLinkProps = LinkProps & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>

type RequestIdleCallbackHandle = ReturnType<typeof setTimeout> | number

type RequestIdleCallbackFn = (
  callback: IdleRequestCallback,
  options?: IdleRequestOptions
) => RequestIdleCallbackHandle

type CancelIdleCallbackFn = (handle: RequestIdleCallbackHandle) => void

function canHandleNavigationClick(event: MouseEvent<HTMLAnchorElement>, target?: string) {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (target && target !== '_self') return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  return true
}

export function RouteLoadingLink({
  href,
  onClick,
  onMouseEnter,
  onFocus,
  target,
  ...props
}: RouteLoadingLinkProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()
  const pendingRef = useRef(false)
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefetchedRef = useRef(false)

  const hrefString = typeof href === 'string' ? href : href.pathname || ''

  const prefetchRoute = useCallback(() => {
    if (prefetchedRef.current) return
    if (!hrefString.startsWith('/')) return
    if (hrefString === pathname || hrefString.startsWith(`${pathname}#`)) return

    prefetchedRef.current = true
    router.prefetch(hrefString)
  }, [hrefString, pathname, router])

  const finishNavigationLoading = useCallback(() => {
    if (!pendingRef.current) return
    pendingRef.current = false
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current)
      watchdogTimerRef.current = null
    }
    endGlobalLoading('navigation')
  }, [endGlobalLoading])

  const beginNavigationLoading = useCallback(() => {
    if (pendingRef.current) return
    pendingRef.current = true
    startGlobalLoading('navigation', { targetPath: hrefString })
    watchdogTimerRef.current = setTimeout(() => {
      finishNavigationLoading()
    }, NAVIGATION_LOADING_WATCHDOG_MS)
  }, [finishNavigationLoading, hrefString, startGlobalLoading])

  useEffect(() => {
    finishNavigationLoading()
  }, [finishNavigationLoading, pathname])

  useEffect(() => {
    prefetchedRef.current = false
  }, [hrefString])

  useEffect(() => {
    if (!hrefString.startsWith('/dashboard')) return
    if (hrefString === pathname || hrefString.startsWith(`${pathname}#`)) return

    const requestIdle =
      (window.requestIdleCallback as RequestIdleCallbackFn | undefined) ??
      ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 0,
            } as IdleDeadline),
          IDLE_PREFETCH_DELAY_MS
        ))
    const cancelIdle =
      (window.cancelIdleCallback as CancelIdleCallbackFn | undefined) ??
      ((handle: RequestIdleCallbackHandle) => window.clearTimeout(handle))

    const idleHandle = requestIdle(() => {
      prefetchRoute()
    })

    return () => {
      cancelIdle(idleHandle)
    }
  }, [hrefString, pathname, prefetchRoute])

  return (
    <Link
      href={href}
      target={target}
      onMouseEnter={(event) => {
        onMouseEnter?.(event)
        prefetchRoute()
      }}
      onFocus={(event) => {
        onFocus?.(event)
        prefetchRoute()
      }}
      onClick={(event) => {
        onClick?.(event)
        if (!canHandleNavigationClick(event, target)) return

        prefetchRoute()
        if (!hrefString.startsWith('/')) return
        if (hrefString === pathname || hrefString.startsWith(`${pathname}#`)) return

        beginNavigationLoading()
      }}
      {...props}
    />
  )
}
