'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeStream } from '@/lib/digital-employee/use-office-stream'
import { OfficeBadge } from '@/components/digital-employee/office/office-badge'
import { OfficeChatterTicker, OfficeSpotlightToast } from '@/components/digital-employee/office/office-chatter'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
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

function OfficeOverview({ employees, large }: { employees: OfficeEmployee[]; large?: boolean }) {
  const working = employees.filter((e) => e.display_status === 'WORKING').length
  const busy = employees.filter((e) => e.busy_level === 'BUSY' || e.busy_level === 'SWAMPED').length
  const pausing = employees.filter((e) => e.display_status === 'PAUSING').length
  const idle = employees.filter((e) => e.display_status === 'IDLE').length
  const offline = employees.filter((e) => e.display_status === 'OFFLINE').length
  const failed = employees.filter((e) => e.display_status === 'FAILED').length
  const todayTotal = employees.reduce((sum, e) => sum + e.today_done, 0)

  return (
    <div className={cn(
      'flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground',
      large ? 'text-lg' : 'text-sm',
    )}>
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
  const searchParams = useSearchParams()
  const isPresentation = searchParams.get('mode') === 'presentation'
  const { employees, connected, chatterFeed } = useOfficeStream()
  const sorted = useMemo(() => sortEmployees(employees), [employees])
  const [clock, setClock] = useState('')

  // 投屏模式：显示时钟
  useEffect(() => {
    if (!isPresentation) return
    const tick = () => setClock(new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'medium' }))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isPresentation])

  // 投屏模式：强制深色
  useEffect(() => {
    if (!isPresentation) return
    document.documentElement.classList.add('dark')
    return () => { document.documentElement.classList.remove('dark') }
  }, [isPresentation])

  // 投屏模式：ESC 退出全屏
  const exitPresentation = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    }
    window.location.href = '/dashboard/ai/digital-employees/office'
  }, [])

  useEffect(() => {
    if (!isPresentation) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') exitPresentation() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPresentation, exitPresentation])

  // ── 投屏模式布局 ──
  if (isPresentation) {
    return (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">虚拟办公室</h1>
            <p className="mt-1 text-sm text-muted-foreground">{clock}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {connected ? '🟢 实时同步中' : '🔌 连接中…'}
            </span>
            <button
              onClick={exitPresentation}
              className="min-h-[44px] rounded-none border border-term-border bg-term-bg px-3 py-1.5 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text sm:min-h-[auto]"
            >
              ESC 退出
            </button>
          </div>
        </div>

        {employees.length > 0 && (
          <div className="mb-6">
            <OfficeOverview employees={employees} large />
          </div>
        )}

        <OfficeChatterTicker feed={chatterFeed} />

        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((e) => (
            <div key={e.employee_id} className="scale-[1.02]">
              <OfficeBadge employee={e} />
            </div>
          ))}
        </div>

        <OfficeSpotlightToast feed={chatterFeed} />
      </div>
    )
  }

  // ── 普通模式布局 ──
  return (
    <div className="dashboard-page-shell space-y-6">
      <header className="space-y-2">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="dashboard-display">虚拟办公室</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {connected ? '🟢 实时同步中' : '🔌 连接中…'}
            </span>
            <button
              onClick={() => {
                void document.documentElement.requestFullscreen?.()
                window.location.href = '/dashboard/ai/digital-employees/office?mode=presentation'
              }}
              className="min-h-[44px] rounded-none border border-term-border bg-term-bg px-3 py-1.5 font-mono text-xs text-term-muted transition-colors hover:border-term-accent/50 hover:text-term-text sm:min-h-[auto]"
            >
              🖥️ 投屏
            </button>
          </div>
        </div>
        {employees.length > 0 && <OfficeOverview employees={employees} />}
      </header>

      {/* P3-B: 办公室 chatter 信息流 */}
      <OfficeChatterTicker feed={chatterFeed} />

      {employees.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-none border border-term-border" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((e) => (
            <OfficeBadge key={e.employee_id} employee={e} />
          ))}
        </div>
      )}

      {/* P3-B: 完成/失败 Spotlight Toast */}
      <OfficeSpotlightToast feed={chatterFeed} />
    </div>
  )
}
