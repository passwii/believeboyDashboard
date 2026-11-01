'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { WarmLedgerNavigationContext } from './warm-ledger-navigation'
import { WarmLedgerSidebar } from './warm-ledger-sidebar'
import { WarmLedgerTopbar } from './warm-ledger-topbar'
import './theme.css'

type FocusTarget = 'menu' | 'workspace' | 'return' | null

export type WarmLedgerShellProps = {
  children: ReactNode
  sidebar?: ReactNode
  topbar?: ReactNode
}

export function WarmLedgerShell({ children, sidebar, topbar }: WarmLedgerShellProps) {
  const [isMobile, setIsMobile] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const isMobileRef = useRef(false)
  const isDrawerOpenRef = useRef(false)
  const focusTargetRef = useRef<FocusTarget>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)

  const openNavigation = useCallback(() => {
    if (!isMobileRef.current || isDrawerOpenRef.current) return
    returnFocusRef.current = menuButtonRef.current
    focusTargetRef.current = null
    isDrawerOpenRef.current = true
    setIsDrawerOpen(true)
  }, [])

  const closeNavigation = useCallback(() => {
    if (!isDrawerOpenRef.current) return
    isDrawerOpenRef.current = false
    focusTargetRef.current = 'return'
    setIsDrawerOpen(false)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)')

    const synchronizeViewport = () => {
      const nextIsMobile = media.matches
      const previousIsMobile = isMobileRef.current
      if (nextIsMobile === previousIsMobile) return

      if (nextIsMobile) {
        if (sidebarRef.current?.contains(document.activeElement)) {
          focusTargetRef.current = 'menu'
        }
        if (isDrawerOpenRef.current) {
          isDrawerOpenRef.current = false
          setIsDrawerOpen(false)
        }
      } else if (
        isDrawerOpenRef.current ||
        document.activeElement === menuButtonRef.current
      ) {
        isDrawerOpenRef.current = false
        focusTargetRef.current = 'workspace'
        setIsDrawerOpen(false)
      }

      isMobileRef.current = nextIsMobile
      setIsMobile(nextIsMobile)
    }

    synchronizeViewport()
    media.addEventListener('change', synchronizeViewport)
    return () => media.removeEventListener('change', synchronizeViewport)
  }, [])

  useLayoutEffect(() => {
    // Crossing into the mobile breakpoint can strand focus in a sidebar that is about to
    // become inert. Move it to the visible menu control first.
    if (isMobile && !isDrawerOpen && focusTargetRef.current === 'menu') {
      menuButtonRef.current?.focus({ preventScroll: true })
    }

    sidebarRef.current?.toggleAttribute('inert', isMobile && !isDrawerOpen)
    workspaceRef.current?.toggleAttribute('inert', isMobile && isDrawerOpen)

    if (isDrawerOpen && isMobile) {
      sidebarRef.current
        ?.querySelector<HTMLButtonElement>('[data-warm-ledger-close]')
        ?.focus({ preventScroll: true })
      return
    }

    const focusTarget = focusTargetRef.current
    focusTargetRef.current = null
    if (focusTarget === 'menu') {
      menuButtonRef.current?.focus({ preventScroll: true })
    } else if (focusTarget === 'workspace') {
      workspaceRef.current?.focus({ preventScroll: true })
    } else if (focusTarget === 'return') {
      const returnTarget = returnFocusRef.current
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true })
    }
  }, [isDrawerOpen, isMobile])

  useEffect(() => {
    if (!isMobile || !isDrawerOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeNavigation()
        return
      }
      if (event.key !== 'Tab') return

      const sidebarElement = sidebarRef.current
      if (!sidebarElement) return
      const focusable = Array.from(
        sidebarElement.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.closest('[inert]'))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!sidebarElement.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeNavigation, isDrawerOpen, isMobile])

  const navigationValue = useMemo(
    () => ({
      isMobile,
      isDrawerOpen,
      menuButtonRef,
      sidebarRef,
      workspaceRef,
      openNavigation,
      closeNavigation,
    }),
    [closeNavigation, isDrawerOpen, isMobile, openNavigation]
  )

  return (
    <WarmLedgerNavigationContext.Provider value={navigationValue}>
      <div
        className="warm-ledger warm-ledger-shell"
        data-nav-open={isMobile && isDrawerOpen ? 'true' : 'false'}
      >
        <button
          type="button"
          className="warm-ledger__scrim"
          aria-label="关闭导航"
          aria-hidden={!isMobile || !isDrawerOpen}
          tabIndex={-1}
          onClick={closeNavigation}
        />
        <section className="warm-ledger__app-window" aria-label="BelieveBoy 运营总览">
          {sidebar ?? <WarmLedgerSidebar />}
          <section
            ref={workspaceRef}
            className="warm-ledger__workspace"
            aria-label="Dashboard 工作区"
            tabIndex={-1}
          >
            {topbar ?? <WarmLedgerTopbar />}
            <main id="main-content" className="warm-ledger__main-scroll">
              {children}
            </main>
          </section>
        </section>
        <div id="warm-ledger-portal-root" className="warm-ledger__portal-root" />
      </div>
    </WarmLedgerNavigationContext.Provider>
  )
}
