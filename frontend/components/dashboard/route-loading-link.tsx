'use client'

import Link, { type LinkProps } from 'next/link'
import { usePathname } from 'next/navigation'
import { type MouseEvent, useCallback, useEffect, useRef } from 'react'
import { useGlobalLoading } from '@/components/global-loading-provider'

type RouteLoadingLinkProps = LinkProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    minVisibleMs?: number
  }

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
  minVisibleMs = 240,
  ...props
}: RouteLoadingLinkProps) {
  const pathname = usePathname()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()
  const pendingRef = useRef(false)
  const startAtRef = useRef(0)
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const finishNavigationLoading = useCallback(() => {
    if (!pendingRef.current) return
    pendingRef.current = false
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current)
      watchdogTimerRef.current = null
    }
    endGlobalLoading()
  }, [endGlobalLoading])

  const beginNavigationLoading = useCallback(() => {
    if (pendingRef.current) return
    pendingRef.current = true
    startAtRef.current = Date.now()
    startGlobalLoading()
    watchdogTimerRef.current = setTimeout(() => {
      finishNavigationLoading()
    }, 8000)
  }, [finishNavigationLoading, startGlobalLoading])

  useEffect(() => {
    if (!pendingRef.current) return
    const elapsed = Date.now() - startAtRef.current
    const remaining = Math.max(0, minVisibleMs - elapsed)
    const timer = setTimeout(() => {
      finishNavigationLoading()
    }, remaining)
    return () => clearTimeout(timer)
  }, [finishNavigationLoading, minVisibleMs, pathname])

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
