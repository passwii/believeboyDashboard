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
import {
  WarmLedgerNavigationContext,
  type MobileNavigationDomain,
} from './warm-ledger-navigation'
import { WarmLedgerSidebar } from './warm-ledger-sidebar'
import { WarmLedgerMobileDock } from './warm-ledger-mobile-dock'
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
  const [isPhone, setIsPhone] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [mobileDomain, setMobileDomain] = useState<MobileNavigationDomain>('all')
  const isMobileRef = useRef(false)
  const isPhoneRef = useRef(false)
  const isDrawerOpenRef = useRef(false)
  const focusTargetRef = useRef<FocusTarget>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)

  const openNavigation = useCallback(
    (domain: MobileNavigationDomain = 'all', trigger?: HTMLElement | null) => {
      if (!isMobileRef.current) return
      returnFocusRef.current = trigger ?? menuButtonRef.current
      setMobileDomain(domain)
      if (isDrawerOpenRef.current) return
      focusTargetRef.current = null
      isDrawerOpenRef.current = true
      setIsDrawerOpen(true)
    },
    []
  )

  const closeNavigation = useCallback(() => {
    if (!isDrawerOpenRef.current) return
    isDrawerOpenRef.current = false
    focusTargetRef.current = 'return'
    setIsDrawerOpen(false)
  }, [])

  useEffect(() => {
    const mobileMedia = window.matchMedia('(max-width: 820px)')
    const phoneMedia = window.matchMedia('(max-width: 430px)')

    const synchronizeViewport = () => {
      const nextIsMobile = mobileMedia.matches
      const nextIsPhone = phoneMedia.matches
      const previousIsMobile = isMobileRef.current
      const previousIsPhone = isPhoneRef.current

      if (previousIsPhone && !nextIsPhone && isDrawerOpenRef.current) {
        isDrawerOpenRef.current = false
        focusTargetRef.current = nextIsMobile ? 'menu' : 'workspace'
        setIsDrawerOpen(false)
      }

      if (nextIsMobile && !previousIsMobile) {
        if (sidebarRef.current?.contains(document.activeElement)) {
          focusTargetRef.current = nextIsPhone ? 'workspace' : 'menu'
        }
        if (isDrawerOpenRef.current) {
          isDrawerOpenRef.current = false
          setIsDrawerOpen(false)
        }
      } else if (!nextIsMobile && previousIsMobile && (
        isDrawerOpenRef.current ||
        document.activeElement === menuButtonRef.current
      )) {
        isDrawerOpenRef.current = false
        focusTargetRef.current = 'workspace'
        setIsDrawerOpen(false)
      }

      isMobileRef.current = nextIsMobile
      isPhoneRef.current = nextIsPhone
      setIsMobile(nextIsMobile)
      setIsPhone(nextIsPhone)
    }

    synchronizeViewport()
    mobileMedia.addEventListener('change', synchronizeViewport)
    phoneMedia.addEventListener('change', synchronizeViewport)
    return () => {
      mobileMedia.removeEventListener('change', synchronizeViewport)
      phoneMedia.removeEventListener('change', synchronizeViewport)
    }
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
      const initialFocus = isPhone
        ? sidebarRef.current?.querySelector<HTMLInputElement>(
            '[data-warm-ledger-search]'
          )
        : sidebarRef.current?.querySelector<HTMLButtonElement>(
            '[data-warm-ledger-close]'
          )
      initialFocus?.focus({ preventScroll: true })
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
  }, [isDrawerOpen, isMobile, isPhone])

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
      ).filter(
        (element) => !element.closest('[inert], [hidden], [aria-hidden="true"]')
      )
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
      isPhone,
      isDrawerOpen,
      mobileDomain,
      menuButtonRef,
      sidebarRef,
      workspaceRef,
      openNavigation,
      closeNavigation,
    }),
    [closeNavigation, isDrawerOpen, isMobile, isPhone, mobileDomain, openNavigation]
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
          <WarmLedgerMobileDock />
        </section>
        <div id="warm-ledger-portal-root" className="warm-ledger__portal-root" />
      </div>
    </WarmLedgerNavigationContext.Provider>
  )
}
