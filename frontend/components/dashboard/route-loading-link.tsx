'use client'

import Link, { type LinkProps } from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { type MouseEvent, useCallback, useEffect, useRef } from 'react'
import { useGlobalLoading } from '@/components/global-loading-provider'

const NAVIGATION_LOADING_WATCHDOG_MS = 30000

type RouteLoadingLinkProps = LinkProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>

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
    startGlobalLoading('navigation')
    watchdogTimerRef.current = setTimeout(() => {
      finishNavigationLoading()
    }, NAVIGATION_LOADING_WATCHDOG_MS)
  }, [finishNavigationLoading, startGlobalLoading])

  useEffect(() => {
    finishNavigationLoading()
  }, [finishNavigationLoading, pathname])

  useEffect(() => {
    return () => {
      finishNavigationLoading()
    }
  }, [finishNavigationLoading])

  useEffect(() => {
    prefetchedRef.current = false
  }, [hrefString])

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
