'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'

type ProjectOption = { id: number; name: string }

interface ProjectSelectProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  autoSelectFirst?: boolean
  onAutoSelected?: (project: ProjectOption) => void
}

export function ProjectSelect({
  value,
  onChange,
  placeholder = '请选择项目',
  disabled = false,
  className,
  triggerClassName,
  autoSelectFirst = false,
  onAutoSelected,
}: ProjectSelectProps) {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function loadProjects() {
      setLoading(true)
      setError(null)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return

        setProjects(payload)

        if (autoSelectFirst && !value && payload[0]?.id) {
          onChange(String(payload[0].id))
          onAutoSelected?.(payload[0])
        }
      } catch (e) {
        if (!active) return
        setError(e instanceof Error ? e.message : '项目列表加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadProjects()

    return () => {
      active = false
    }
  }, [session, autoSelectFirst, value, onChange, onAutoSelected])

  if (loading) {
    return (
      <div className={cn('space-y-2', className)}>
        <div className="h-4 w-12 rounded" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('space-y-2', className)}>
        <div className="h-4 w-12 rounded" />
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      </div>
    )
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={cn(
          'h-10 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]',
          triggerClassName,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {projects.map((item) => (
          <SelectItem key={item.id} value={String(item.id)}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}