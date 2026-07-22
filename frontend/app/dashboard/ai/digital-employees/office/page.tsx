'use client'
import { useOfficeStream } from '@/lib/digital-employee/use-office-stream'
import { OfficeBadge } from '@/components/digital-employee/office/office-badge'
import { Skeleton } from '@/components/ui/skeleton'

export default function DigitalOfficePage() {
  const { employees, connected } = useOfficeStream()

  return (
    <div className="dashboard-page-shell space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="dashboard-display">虚拟办公室</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {connected ? `🟢 实时同步中 · 在岗 ${employees.length} 位员工` : '🔌 连接中…'}
          </p>
        </div>
      </header>

      {employees.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {employees.map((e) => (
            <OfficeBadge key={e.employee_id} employee={e} />
          ))}
        </div>
      )}
    </div>
  )
}