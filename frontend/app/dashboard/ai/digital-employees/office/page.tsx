'use client'
import { useMemo } from 'react'
import { useOfficeStream } from '@/lib/digital-employee/use-office-stream'
import { OfficeBadge } from '@/components/digital-employee/office/office-badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { OfficeEmployee } from '@/lib/digital-employee/office-stream-types'

/** 排序权重：忙碌/在岗优先，休息/离线沉底 */
const STATUS_ORDER: Record<string, number> = {
  SWAMPED: 0,
  BUSY: 1,
  WORKING: 2,
  PAUSING: 3,
  IDLE: 4,
  OFFLINE: 5,
}

function sortEmployees(employees: OfficeEmployee[]): OfficeEmployee[] {
  return [...employees].sort((a, b) => {
    const aKey = a.busy_level === 'SWAMPED' ? 0 : a.busy_level === 'BUSY' ? 1 : STATUS_ORDER[a.display_status] ?? 4
    const bKey = b.busy_level === 'SWAMPED' ? 0 : b.busy_level === 'BUSY' ? 1 : STATUS_ORDER[b.display_status] ?? 4
    if (aKey !== bKey) return aKey - bKey
    return b.queued_count - a.queued_count
  })
}

function OfficeOverview({ employees }: { employees: OfficeEmployee[] }) {
  const working = employees.filter((e) => e.display_status === 'WORKING').length
  const busy = employees.filter((e) => e.busy_level === 'BUSY' || e.busy_level === 'SWAMPED').length
  const pausing = employees.filter((e) => e.display_status === 'PAUSING').length
  const idle = employees.filter((e) => e.display_status === 'IDLE').length
  const offline = employees.filter((e) => e.display_status === 'OFFLINE').length
  const failed = employees.filter((e) => e.display_status === 'FAILED').length
  const todayTotal = employees.reduce((sum, e) => sum + e.today_done, 0)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span>🟢 在岗 {working}</span>
      {busy > 0 && <span>🔥 忙碌 {busy}</span>}
      {pausing > 0 && <span>🍵 收尾 {pausing}</span>}
      {idle > 0 && <span>💤 待命 {idle}</span>}
      {offline > 0 && <span>🌙 离线 {offline}</span>}
      {failed > 0 && <span className="text-destructive">⚠️ 失败 {failed}</span>}
      <span className="border-l border-border pl-4">今日合计完成 {todayTotal} 件</span>
    </div>
  )
}

export default function DigitalOfficePage() {
  const { employees, connected } = useOfficeStream()
  const sorted = useMemo(() => sortEmployees(employees), [employees])

  return (
    <div className="dashboard-page-shell space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h1 className="dashboard-display">虚拟办公室</h1>
          <span className="text-xs text-muted-foreground">
            {connected ? '🟢 实时同步中' : '🔌 连接中…'}
          </span>
        </div>
        {employees.length > 0 && <OfficeOverview employees={employees} />}
      </header>

      {employees.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((e) => (
            <OfficeBadge key={e.employee_id} employee={e} />
          ))}
        </div>
      )}
    </div>
  )
}
