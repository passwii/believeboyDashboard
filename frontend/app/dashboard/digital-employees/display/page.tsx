'use client'

import { useEffect, useState } from 'react'
import { Monitor, RefreshCw, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeGrid } from '@/components/digital-employee/digital-employee-grid'
import { ActivityFeed } from '@/components/digital-employee/activity-feed'
import { cn } from '@/lib/utils'

export default function DisplayPage() {
  const { employees, isLoading, mutate } = useDigitalEmployees({ pollInterval: 10000 })
  const [showFeed, setShowFeed] = useState(true)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    document.documentElement.classList.add('dark')
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
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
    <div className={cn(
      'min-h-screen bg-background p-6 text-foreground',
      '[&_*]:!text-foreground'
    )}>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mb-1">
            <Activity className="h-3 w-3" />
            <span>数字员工监控台</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">数字员工实时动态</h1>
          <p className="mt-1 text-sm text-muted-foreground">
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.close()}
          >
            退出
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <StatBox label="全部员工" value={employees.length} sub="名数字员工在线" />
        <StatBox
          label="运行中"
          value={runningCount}
          sub="任务执行中"
          accent="text-blue-400"
          pulse={runningCount > 0}
        />
        <StatBox
          label="空闲"
          value={idleCount}
          sub="待命中"
          accent="text-muted-foreground"
        />
        <StatBox
          label="异常"
          value={failedCount}
          sub={failedCount > 0 ? '需要关注' : '一切正常'}
          accent={failedCount > 0 ? 'text-red-400' : 'text-emerald-400'}
        />
      </div>

      {/* Main content: grid + activity feed */}
      <div className={cn('grid gap-6', showFeed ? 'lg:grid-cols-[1fr,400px]' : 'grid-cols-1')}>
        {/* Employee grid */}
        <div>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-48 rounded-2xl border-2 border-dashed" />
              ))}
            </div>
          ) : (
            <DigitalEmployeeGrid employees={employees} displayMode={true} />
          )}
        </div>

        {/* Activity feed */}
        {showFeed && (
          <div className="flex flex-col rounded-2xl border bg-card/50">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <h2 className="text-sm font-semibold">实时动态</h2>
              <span className="ml-auto text-xs text-muted-foreground">每15秒更新</span>
            </div>
            <div className="flex-1 overflow-hidden px-3 py-3">
              <ActivityFeed pollInterval={15000} maxHeight="calc(100vh - 280px)" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatBox({
  label,
  value,
  sub,
  accent = 'text-foreground',
  pulse = false,
}: {
  label: string
  value: number
  sub?: string
  accent?: string
  pulse?: boolean
}) {
  return (
    <div className="rounded-2xl border border-[hsl(var(--sidebar-foreground)/0.12)] bg-[hsl(var(--sidebar-foreground)/0.04)] p-5 text-center">
      <div className="flex items-center justify-center gap-2">
        <p className={cn('text-4xl font-bold tabular-nums', accent)}>{value}</p>
        {pulse && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-medium">{label}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}
