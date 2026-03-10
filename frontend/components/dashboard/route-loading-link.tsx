'use client'

import Link, { type LinkProps } from 'next/link'
import { usePathname } from 'next/navigation'
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
  target,
  ...props
}: RouteLoadingLinkProps) {
  const pathname = usePathname()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()
  const pendingRef = useRef(false)
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  return (
    <Link
      href={href}
      target={target}
      onClick={(event) => {
        onClick?.(event)
        if (!canHandleNavigationClick(event, target)) return

        if (typeof href !== 'string') {
          beginNavigationLoading()
          return
        }

        if (!href.startsWith('/')) return
        if (href === pathname || href.startsWith(`${pathname}#`)) return

        beginNavigationLoading()
      }}
      {...props}
    />
  )
}
