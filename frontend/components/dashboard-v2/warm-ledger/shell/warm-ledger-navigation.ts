'use client'

import { createContext, useContext, type RefObject } from 'react'

export type MobileNavigationDomain = 'operations' | 'reports' | 'ai' | 'all'

export type WarmLedgerNavigationValue = {
  isMobile: boolean
  isPhone: boolean
  isDrawerOpen: boolean
  mobileDomain: MobileNavigationDomain
  menuButtonRef: RefObject<HTMLButtonElement>
  sidebarRef: RefObject<HTMLElement>
  workspaceRef: RefObject<HTMLElement>
  openNavigation: (
    domain?: MobileNavigationDomain,
    trigger?: HTMLElement | null
  ) => void
  closeNavigation: () => void
}

export const WarmLedgerNavigationContext = createContext<WarmLedgerNavigationValue | null>(null)

export function useWarmLedgerNavigation() {
  const value = useContext(WarmLedgerNavigationContext)
  if (!value) {
    throw new Error('Warm Ledger shell components must be rendered inside WarmLedgerShell')
  }
  return value
}
