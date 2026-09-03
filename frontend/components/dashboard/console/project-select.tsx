'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { getCountryLabel } from '@/lib/country'
import { cn } from '@/lib/utils'
import type { ManagedProjectOption } from '@/lib/hooks/use-managed-projects'

// 本地别名,保留组件内部使用旧名 ProjectOption 维持 git diff 友好;
// 类型上等价于 ManagedProjectOption(id 必为 number)
type ProjectOption = ManagedProjectOption

interface ProjectSelectProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  autoSelectFirst?: boolean
  onAutoSelected?: (project: ProjectOption) => void
  /**
   * 外部注入的项目列表(例如 DashboardPage 已通过 useManagedProjects 拿到)。
   * 传了则不再内部 fetch,避免重复请求与状态分叉。
   */
  projects?: ProjectOption[]
  /** 外部 loading 状态;只有不传 projects 时才生效(否则外部是真相来源)。 */
  loading?: boolean
  /** 外部 error 状态;只有不传 projects 时才生效(否则外部是真相来源)。 */
  error?: string | null
}

export function ProjectSelect({
  value,
  onChange,
  placeholder = '请选择项目',
  disabled = false,
  className,
  triggerClassName,
  autoSelectFirst = true,
  onAutoSelected,
  projects: externalProjects,
  loading: externalLoading,
  error: externalError,
}: ProjectSelectProps) {
  const { data: session } = useSession()
  // 内部兜底状态 —— 仅在调用方没传 projects 时使用
  const [internalProjects, setInternalProjects] = useState<ProjectOption[]>([])
  const [internalLoading, setInternalLoading] = useState<boolean>(externalProjects === undefined)
  const [internalError, setInternalError] = useState<string | null>(null)

  // 外部 props 优先(externalProjects 已注入时内部 fetch 直接跳过)
  const projects = externalProjects ?? internalProjects
  const loading = externalProjects !== undefined ? Boolean(externalLoading) : internalLoading
  const error = externalProjects !== undefined ? (externalError ?? null) : internalError

  useEffect(() => {
    // 外部已注入,不需要内部 fetch
    if (externalProjects !== undefined) return

    let active = true

    async function loadProjects() {
      setInternalLoading(true)
      setInternalError(null)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return

        setInternalProjects(payload)

        if (autoSelectFirst && !value && payload[0]?.id) {
          onChange(String(payload[0].id))
          onAutoSelected?.(payload[0])
        }
      } catch (e) {
        if (!active) return
        setInternalError(e instanceof Error ? e.message : '项目列表加载失败')
      } finally {
        if (active) setInternalLoading(false)
      }
    }

    void loadProjects()

    return () => {
      active = false
    }
  }, [session, autoSelectFirst, value, onChange, onAutoSelected, externalProjects])

  if (loading) {
    return (
      <div className={cn('space-y-2', className)}>
        <div className="h-4 w-12 rounded-none" />
        <Skeleton className="h-10 w-full rounded-none" />
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('space-y-2', className)}>
        <div className="h-4 w-12 rounded-none" />
        <div className="rounded-none border border-term-neg/30 bg-term-neg/5 px-3 py-2 font-mono text-xs leading-5 text-term-neg">
          {error}
        </div>
      </div>
    )
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={cn(
          // BLF-893：console 触发器统一 term 令牌 + 零圆角；保持 h-10 适配 FilterField 排版。
          'h-10 border-term-border bg-term-bg font-mono text-xs leading-5 text-term-text shadow-none focus-visible:outline-none focus-visible:border-term-border-strong data-[state=open]:border-term-border-strong',
          triggerClassName
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {projects.map((item) => {
          const siteLabel = item.country_name ?? getCountryLabel(item.country ?? '')
          return (
            <SelectItem key={item.id} value={String(item.id)}>
              {item.name}
              {siteLabel ? ` · ${siteLabel}` : ''}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
