'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { User } from '@/lib/crm/types'

/**
 * CRM 用户列表上下文（P2a 负责人选择器数据源）。
 *
 * 在 CRM layout 顶层加载一次 `listUsers()`，经 context 共享给所有表单/Drawer 的
 * CrmUserSelect，替代此前各处硬编码的 `users={[]}`（负责人选择缺口）。
 * 须置于 CrmClientProvider 之内。加载失败静默降级为空列表（选择器显示"未找到用户"）。
 */
interface CrmUsersContextValue {
  users: User[]
  loading: boolean
}

const CrmUsersContext = createContext<CrmUsersContextValue | null>(null)

export function CrmUsersProvider({ children }: { children: React.ReactNode }) {
  const client = useCrmClient()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    client
      .listUsers()
      .then((u) => {
        if (!cancelled) setUsers(u)
      })
      .catch(() => {
        // 静默：拉不到用户时选择器降级为空，不阻断 CRM
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const value = useMemo(() => ({ users, loading }), [users, loading])
  return <CrmUsersContext.Provider value={value}>{children}</CrmUsersContext.Provider>
}

export function useCrmUsers(): User[] {
  const ctx = useContext(CrmUsersContext)
  if (!ctx) {
    throw new Error('useCrmUsers must be used within CrmUsersProvider')
  }
  return ctx.users
}
