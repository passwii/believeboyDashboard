'use client'

import { createContext, useContext, type ReactNode } from 'react'

import type { IntentClient } from './client'

/**
 * 意向客户客户端 Provider（页面内创建，不复用 CrmClientProvider）。
 * 测试可传入 fake client，页面运行默认注入 HttpIntentClient。
 */
const IntentClientContext = createContext<IntentClient | null>(null)

export function IntentClientProvider({
  client,
  children,
}: {
  client: IntentClient
  children: ReactNode
}) {
  return <IntentClientContext.Provider value={client}>{children}</IntentClientContext.Provider>
}

export function useIntentClient(): IntentClient {
  const client = useContext(IntentClientContext)
  if (!client) {
    throw new Error('useIntentClient must be used within IntentClientProvider')
  }
  return client
}
