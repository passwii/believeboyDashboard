'use client'

import { useEffect } from 'react'
import { Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeGrid } from '@/components/digital-employee/digital-employee-grid'
import { cn } from '@/lib/utils'

export default function DisplayPage() {
  const { employees, isLoading } = useDigitalEmployees({ pollInterval: 10000 })

  useEffect(() => {
    document.documentElement.classList.add('dark')
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [])

  return (
    <div className={cn(
      'min-h-screen bg-background p-8 text-foreground',
      '[&_*]:!text-foreground'
    )}>
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">数字员工监控</h1>
          <p className="mt-2 text-xl text-muted-foreground">
            {new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full bg-[hsl(var(--sidebar-foreground)/0.08)] px-4 py-2">
            <span className="h-3 w-3 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-sm font-medium">实时监控中</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.close()}
          >
            退出展示
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="mb-8 grid grid-cols-4 gap-4">
        <StatBox label="全部员工" value={employees.length} />
        <StatBox
          label="运行中"
          value={employees.filter((e) => e.status === 'RUNNING').length}
          color="text-blue-500"
        />
        <StatBox
          label="空闲"
          value={employees.filter((e) => e.status === 'IDLE').length}
          color="text-muted-foreground"
        />
        <StatBox
          label="异常"
          value={employees.filter((e) => e.status === 'FAILED').length}
          color="text-red-500"
        />
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 rounded-2xl border-2 border-dashed" />
          ))}
        </div>
      ) : (
        <DigitalEmployeeGrid
          employees={employees}
          displayMode={true}
        />
      )}
    </div>
  )
}

function StatBox({ label, value, color = 'text-foreground' }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-2xl border-2 border-[hsl(var(--sidebar-foreground)/0.12)] bg-[hsl(var(--sidebar-foreground)/0.04)] p-6 text-center">
      <p className="text-5xl font-bold tabular-nums">{value}</p>
      <p className="mt-2 text-lg text-muted-foreground">{label}</p>
    </div>
  )
}