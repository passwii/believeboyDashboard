'use client'

import { useState } from 'react'
import { Monitor, RefreshCw, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeGrid } from '@/components/digital-employee/digital-employee-grid'
import { DigitalEmployeeStats } from '@/components/digital-employee/stats'
import { ActivityFeed } from '@/components/digital-employee/activity-feed'
import { cn } from '@/lib/utils'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'
import { TERM_BUTTON } from '@/components/terminal/term-controls'

const STATUS_FILTERS = [
  { label: '全部', value: null },
  { label: '空闲', value: 'IDLE' },
  { label: '运行中', value: 'RUNNING' },
  { label: '成功', value: 'SUCCEEDED' },
  { label: '失败', value: 'FAILED' },
  { label: '暂停', value: 'SUSPENDED' },
]

export default function DigitalEmployeesPage() {
  const router = useRouter()
  const { employees, isLoading, error, mutate } = useDigitalEmployees()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)

  const { showSkeleton, isRefreshing } = useSmoothRefresh({
    loading: isLoading,
    hasData: employees.length > 0,
  })

  const filtered = employees.filter((emp) => {
    const matchSearch =
      !search || emp.name.includes(search) || (emp.description ?? '').includes(search)
    const matchStatus = !statusFilter || emp.status === statusFilter
    return matchSearch && matchStatus
  })

  const runningCount = employees.filter((e) => e.status === 'RUNNING').length
  const failedCount = employees.filter((e) => e.status === 'FAILED').length

  return (
    // BLF-838：页面标题由面包屑承载；运行/异常计数换终端 mono 徽标
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between">
        {runningCount > 0 && (
          <div className="flex items-center gap-1.5 rounded-none border border-term-accent/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-term-accent">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-term-accent opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-term-accent" />
            </span>
            {runningCount} 个运行中
          </div>
        )}
        {failedCount > 0 && (
          <div className="flex items-center gap-1.5 rounded-none border border-term-neg/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-term-neg">
            ⚠ {failedCount} 个异常
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open('/dashboard/ai/digital-employees/office', '_blank')}
          className={TERM_BUTTON}
        >
          <Monitor className="h-3.5 w-3.5" strokeWidth={1.75} />
          全屏展示
        </Button>
        <Button variant="outline" size="sm" onClick={() => void mutate()} className={TERM_BUTTON}>
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          刷新
        </Button>
      </div>

      {showSkeleton ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-none border border-term-border" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-none border border-term-border p-4">
                <Skeleton className="h-5 w-28 rounded-none" />
                <Skeleton className="mx-auto h-16 w-16 rounded-none" />
                <Skeleton className="h-16 w-full rounded-none" />
                <Skeleton className="h-4 w-full rounded-none" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? (
        <div role="alert" className="flex items-center justify-center rounded-none border border-term-neg/50 bg-term-neg/10 p-8 font-mono text-xs text-term-neg">
          <p>ERR · 加载失败：{error.message}</p>
        </div>
      ) : (
        <div className="relative">
          <RefreshProgressBar refreshing={isRefreshing}>
            <DigitalEmployeeStats employees={employees} />

            <div className="flex flex-col gap-3 mt-4 sm:flex-row sm:items-center sm:gap-4">
              <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索数字员工..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 rounded-none border-term-border bg-term-bg font-mono text-sm text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0 pl-10"
                />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {STATUS_FILTERS.map((f) => {
                  const count =
                    f.value === null
                      ? employees.length
                      : employees.filter((e) => e.status === f.value).length
                  return (
                    <Badge
                      key={f.label}
                      variant={statusFilter === f.value ? 'default' : 'outline'}
                      className={cn(
                        'cursor-pointer rounded-none border font-mono text-[11px] transition-colors',
                        statusFilter === f.value
                          ? 'border-term-border-strong bg-term-raised text-term-text'
                          : 'border-term-border bg-term-bg text-term-muted hover:text-term-text'
                      )}
                      onClick={() => setStatusFilter(statusFilter === f.value ? null : f.value)}
                    >
                      {f.label}
                      <span className="ml-1 opacity-60">({count})</span>
                    </Badge>
                  )
                })}
              </div>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr,360px]">
              <div>
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-none border border-dashed border-term-border p-10 font-mono text-xs text-term-faint">
                    <span className="text-2xl">○</span>
                    <p>暂无数字员工</p>
                  </div>
                ) : (
                  <DigitalEmployeeGrid
                    employees={filtered}
                    onCardClick={(id) => router.push(`/dashboard/ai/digital-employees/${id}`)}
                  />
                )}
              </div>

              <div className="hidden overflow-hidden rounded-none border border-term-border bg-term-panel lg:flex flex-col">
                <div className="flex h-9 items-center gap-2 border-b border-term-border px-3">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-term-pos opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-term-pos" />
                  </span>
                  <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">实时动态</h2>
                  <span className="ml-auto font-mono text-[11px] text-term-faint">15s 更新</span>
                </div>
                <div className="flex-1 overflow-hidden px-3 py-3">
                  <ActivityFeed pollInterval={15000} maxHeight="calc(100vh - 320px)" compact />
                </div>
              </div>
            </div>
          </RefreshProgressBar>
        </div>
      )}
    </div>
  )
}
