'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

/**
 * 统一的项目列表选项类型,供 hook + ProjectSelect 共用。
 * 命名上脱离"option"以避免与 console 里的 ProjectOption(id: number | null)
 * 混淆 —— 本 hook 返回的 id 一定为 number(后端 /projects/manage 不会返回 null id)。
 */
export interface ManagedProjectOption {
  id: number
  name: string
}

export interface UseManagedProjectsResult {
  projects: ManagedProjectOption[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
}

/**
 * Dashboard 首页 + ProjectSelect 共用的项目列表 hook。
 *
 * 设计要点:
 *  - 单一 fetch 源:首页 DashboardPage 和子组件 ProjectSelect 不再各自调
 *    fetchManagedProjectsCached,避免重复请求与状态分叉。
 *  - 复用 2-min TTL 缓存:仍然走 fetchManagedProjectsCached 内部的 clientCache。
 *  - 错误向上抛:不再静默 swallow,调用方可以决定是否弹 notification。
 *  - 返回 refetch:用于权限/项目下架后手动刷新(目前未挂载到 UI,留口子)。
 *
 * 注意:此 hook 内部用 stale-request 保护 —— session 变化时取消上一次未完成请求,
 * 避免快闪历史数据。
 */
export function useManagedProjects(): UseManagedProjectsResult {
  const { data: session, status } = useSession()
  const [projects, setProjects] = useState<ManagedProjectOption[]>([])
  const [loading, setLoading] = useState<boolean>(status !== 'authenticated')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchManagedProjectsCached<ManagedProjectOption[]>(session)
      setProjects(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (status === 'loading') return
    void load()
  }, [load, status])

  return {
    projects,
    loading,
    error,
    refetch: load,
  }
}
