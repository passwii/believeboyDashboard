'use client'

import { createContext, useContext, type RefObject } from 'react'

export type WarmLedgerNavigationValue = {
  isMobile: boolean
  isDrawerOpen: boolean
  menuButtonRef: RefObject<HTMLButtonElement>
  sidebarRef: RefObject<HTMLElement>
  workspaceRef: RefObject<HTMLElement>
  openNavigation: () => void
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
