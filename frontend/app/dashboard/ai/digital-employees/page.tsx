'use client'

import { useState } from 'react'
import { Monitor, RefreshCw, Users, Search } from 'lucide-react'
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/10 to-cyan-500/5 border border-blue-200/40 shadow-sm">
            <Users className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Operations · Digital Employees
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {runningCount > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 dark:bg-blue-950 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
              {runningCount} 个运行中
            </div>
          )}
          {failedCount > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 dark:bg-red-950 dark:text-red-400">
              ⚠ {failedCount} 个异常
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open('/dashboard/digital-employees/display', '_blank')}
            className="gap-1.5"
          >
            <Monitor className="h-4 w-4" />
            全屏展示
          </Button>
          <Button variant="outline" size="sm" onClick={() => void mutate()} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      {showSkeleton ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border p-4 space-y-3">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-16 w-16 rounded-2xl mx-auto" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 p-8 text-destructive">
          <p>加载失败：{error.message}</p>
        </div>
      ) : (
        <div className="relative">
          <RefreshProgressBar refreshing={isRefreshing}>
            <DigitalEmployeeStats employees={employees} />

            <div className="flex items-center gap-4 mt-4">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索数字员工..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
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
                        'cursor-pointer transition-all',
                        statusFilter === f.value && 'shadow-sm'
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

            <div className="mt-4 grid gap-6 lg:grid-cols-[1fr,360px]">
              <div>
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed p-16 text-muted-foreground gap-3">
                    <span className="text-4xl">🤖</span>
                    <p className="text-sm">暂无数字员工</p>
                  </div>
                ) : (
                  <DigitalEmployeeGrid
                    employees={filtered}
                    onCardClick={(id) => router.push(`/dashboard/digital-employees/${id}`)}
                  />
                )}
              </div>

              <div className="hidden lg:flex flex-col rounded-2xl border bg-card/50 overflow-hidden">
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  <h2 className="text-sm font-semibold">实时动态</h2>
                  <span className="ml-auto text-xs text-muted-foreground">15s 更新</span>
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
