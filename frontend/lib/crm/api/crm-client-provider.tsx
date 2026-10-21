'use client'

import { createContext, useContext, useMemo } from 'react'
import type { CrmClient } from './crm-client'
import { MockCrmClient } from './mock-crm-client'
import { HttpCrmClient } from './http-crm-client'

const CrmClientContext = createContext<CrmClient | null>(null)

const apiMode = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'http'
if (apiMode !== 'http' && apiMode !== 'mock') {
  throw new Error(`Unknown NEXT_PUBLIC_CRM_API_MODE: ${apiMode}`)
}
if (process.env.NODE_ENV === 'production' && apiMode === 'mock') {
  throw new Error('CRM mock client is disabled in production')
}

interface CrmClientProviderProps {
  children: React.ReactNode
  currentUserId?: string
}

export function CrmClientProvider({ children, currentUserId = 'u-001' }: CrmClientProviderProps) {
  const client = useMemo<CrmClient>(() => {
    if (apiMode === 'http') {
      return new HttpCrmClient() as CrmClient
    }
    const mock = new MockCrmClient(currentUserId)
    return mock
  }, [currentUserId])

  return <CrmClientContext.Provider value={client}>{children}</CrmClientContext.Provider>
}

export function useCrmClient(): CrmClient {
  const ctx = useContext(CrmClientContext)
  if (!ctx) {
    throw new Error('useCrmClient must be used within CrmClientProvider')
  }
  return ctx
}

/** 仅测试用：导出当前 API mode。 */
export const __crmApiMode = apiMode
