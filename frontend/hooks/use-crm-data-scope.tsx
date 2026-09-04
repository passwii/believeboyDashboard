'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type CrmDataScope = 'mine' | 'all'

interface CrmDataScopeContextValue {
  scope: CrmDataScope
  setScope: (next: CrmDataScope) => void
  currentUserId: string
}

const CrmDataScopeContext = createContext<CrmDataScopeContextValue | null>(null)

const DEFAULT_SCOPE: CrmDataScope = 'all'
const DEFAULT_USER_ID = 'u-001'

interface CrmDataScopeProviderProps {
  children: React.ReactNode
  currentUserId?: string
  initialScope?: CrmDataScope
}

export function CrmDataScopeProvider({
  children,
  currentUserId = DEFAULT_USER_ID,
  initialScope = DEFAULT_SCOPE,
}: CrmDataScopeProviderProps) {
  const [scope, setScopeState] = useState<CrmDataScope>(initialScope)

  const setScope = useCallback((next: CrmDataScope) => {
    setScopeState(next)
  }, [])

  const value = useMemo<CrmDataScopeContextValue>(
    () => ({ scope, setScope, currentUserId }),
    [scope, setScope, currentUserId]
  )

  return <CrmDataScopeContext.Provider value={value}>{children}</CrmDataScopeContext.Provider>
}

export function useCrmDataScope(): CrmDataScopeContextValue {
  const ctx = useContext(CrmDataScopeContext)
  if (!ctx) {
    throw new Error('useCrmDataScope must be used within CrmDataScopeProvider')
  }
  return ctx
}
