'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeCard } from '@/components/digital-employee/digital-employee-card'
import { ActivityFeed } from '@/components/digital-employee/activity-feed'
import { cn } from '@/lib/utils'
import type { DigitalEmployee } from '@/types/digital-employee'

export default function DisplayPage() {
  const { employees, isLoading, mutate } = useDigitalEmployees({ pollInterval: 10000 })
  const [showFeed, setShowFeed] = useState(true)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    document.documentElement.classList.add('dark')
    const ticker = setInterval(() => setNow(new Date()), 1000)
    return () => {
      document.documentElement.classList.remove('dark')
      clearInterval(ticker)
    }
  }, [])

  const runningCount = employees.filter((e) => e.status === 'RUNNING').length
  const idleCount = employees.filter((e) => e.status === 'IDLE').length
  const failedCount = employees.filter((e) => e.status === 'FAILED').length

  return (
    <div className="min-h-screen bg-[#0f172a] p-6 text-slate-100">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Activity className="h-3 w-3" />
            <span className="uppercase tracking-wider">数字员工监控台</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">实时运行状态</h1>
          <p className="mt-1 text-sm text-slate-400">
            {now.toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'medium' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showFeed ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowFeed((v) => !v)}
            className="gap-1.5"
          >
            <Activity className="h-4 w-4" />
            {showFeed ? '隐藏动态' : '显示动态'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void mutate()}
            className="gap-1.5"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <DarkStatBox label="全部员工" value={employees.length} />
        <DarkStatBox
          label="运行中"
          value={runningCount}
          accent="text-blue-400"
          pulse={runningCount > 0}
          highlight
        />
        <DarkStatBox label="空闲" value={idleCount} accent="text-slate-400" />
        <DarkStatBox
          label="异常"
          value={failedCount}
          accent={failedCount > 0 ? 'text-red-400' : 'text-emerald-400'}
          highlight={failedCount > 0}
        />
      </div>

      <div className={cn('grid gap-6', showFeed ? 'lg:grid-cols-[1fr,380px]' : 'grid-cols-1')}>
        <div>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-56 rounded-2xl border-2 border-dashed border-slate-800" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {employees.map((emp) => (
                <DigitalEmployeeCard key={emp.id} employee={emp} />
              ))}
            </div>
          )}
        </div>

        {showFeed && (
          <div className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <h2 className="text-sm font-semibold text-slate-200">实时动态</h2>
              <span className="ml-auto text-xs text-slate-500">15s 更新</span>
            </div>
            <div className="flex-1 overflow-hidden px-3 py-3">
              <ActivityFeed pollInterval={15000} maxHeight="calc(100vh - 280px)" compact />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DarkStatBox({
  label,
  value,
  accent = 'text-slate-100',
  pulse = false,
  highlight = false,
}: {
  label: string
  value: number
  accent?: string
  pulse?: boolean
  highlight?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4 text-center',
        highlight
          ? 'border-blue-500/20 bg-blue-500/10'
          : 'border-slate-800 bg-slate-900/30',
      )}
    >
      <div className="flex items-center justify-center gap-2">
        <p className={cn('text-3xl font-bold tabular-nums', accent)}>{value}</p>
        {pulse && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-400">{label}</p>
    </div>
  )
}
