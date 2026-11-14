'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Monitor } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useOfficeStream } from '@/lib/digital-employee/use-office-stream'
import { OfficeBadge } from '@/components/digital-employee/office/office-badge'
import {
  OfficeChatterTicker,
  OfficeSpotlightToast,
} from '@/components/digital-employee/office/office-chatter'
import { forceDarkDocument } from '@/lib/forced-dark'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import type { OfficeEmployee } from '@/lib/digital-employee/office-stream-types'
import styles from '@/components/digital-employee/digital-employee-warm.module.css'

const STATUS_ORDER: Record<string, number> = {
  SWAMPED: 0,
  BUSY: 1,
  WORKING: 2,
  PAUSING: 3,
  IDLE: 4,
  OFFLINE: 5,
}

function sortEmployees(employees: OfficeEmployee[]): OfficeEmployee[] {
  return [...employees].sort((left, right) => {
    const leftKey =
      left.busy_level === 'SWAMPED'
        ? 0
        : left.busy_level === 'BUSY'
          ? 1
          : STATUS_ORDER[left.display_status] ?? 4
    const rightKey =
      right.busy_level === 'SWAMPED'
        ? 0
        : right.busy_level === 'BUSY'
          ? 1
          : STATUS_ORDER[right.display_status] ?? 4
    if (leftKey !== rightKey) return leftKey - rightKey
    return right.queued_count - left.queued_count
  })
}

function OfficeOverview({
  employees,
  large,
  presentation = false,
}: {
  employees: OfficeEmployee[]
  large?: boolean
  presentation?: boolean
}) {
  const working = employees.filter((employee) => employee.display_status === 'WORKING').length
  const busy = employees.filter(
    (employee) => employee.busy_level === 'BUSY' || employee.busy_level === 'SWAMPED'
  ).length
  const pausing = employees.filter(
    (employee) => employee.display_status === 'PAUSING'
  ).length
  const idle = employees.filter((employee) => employee.display_status === 'IDLE').length
  const offline = employees.filter((employee) => employee.display_status === 'OFFLINE').length
  const failed = employees.filter((employee) => employee.display_status === 'FAILED').length
  const todayTotal = employees.reduce((sum, employee) => sum + employee.today_done, 0)

  return (
    <section
      className={`${styles.panel} ${presentation ? styles.overviewPresentation : ''}`}
      aria-label="虚拟办公室概览"
      data-presentation={presentation ? 'true' : undefined}
    >
      <div className={styles.overview}>
        <div className={styles.overviewGroup}>
          <span className={styles.overviewItem} data-status="WORKING">
            在岗 {working}
          </span>
          {busy > 0 ? (
            <span className={styles.overviewItem} data-status="WORKING">
              忙碌 {busy}
            </span>
          ) : null}
          {pausing > 0 ? (
            <span className={styles.overviewItem} data-status="PAUSING">
              收尾 {pausing}
            </span>
          ) : null}
          {idle > 0 ? (
            <span className={styles.overviewItem} data-status="IDLE">
              待命 {idle}
            </span>
          ) : null}
          {offline > 0 ? (
            <span className={styles.overviewItem} data-status="OFFLINE">
              离线 {offline}
            </span>
          ) : null}
          {failed > 0 ? (
            <span className={styles.overviewItem} data-status="FAILED">
              失败 {failed}
            </span>
          ) : null}
        </div>
        <span
          className={`${styles.overviewToday} ${large || presentation ? styles.overviewTodayLarge : ''}`}
        >
          今日合计完成 {todayTotal} 件
        </span>
      </div>
    </section>
  )
}

export default function DigitalOfficePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isPresentation = searchParams.get('mode') === 'presentation'
  const { employees, connected, chatterFeed, refreshing, refresh } = useOfficeStream()
  const sorted = useMemo(() => sortEmployees(employees), [employees])
  useHeaderRefresh(refresh, { loading: refreshing })
  const [clock, setClock] = useState('')

  useEffect(() => {
    if (!isPresentation) return
    const tick = () =>
      setClock(
        new Date().toLocaleString('zh-CN', {
          dateStyle: 'full',
          timeStyle: 'medium',
        })
      )
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isPresentation])

  useEffect(() => {
    if (!isPresentation) return
    return forceDarkDocument()
  }, [isPresentation])

  const exitPresentation = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    }
    router.push('/dashboard/ai/digital-employees/office')
  }, [router])

  useEffect(() => {
    if (!isPresentation) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitPresentation()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPresentation, exitPresentation])

  if (isPresentation) {
    return (
      <main
        className={`${styles.presentationPage} warm-ledger`}
        data-office-presentation="true"
        data-warm-surface="warm-ledger"
      >
        <header className={styles.presentationHeader}>
          <div>
            <h1 className={styles.presentationTitle}>虚拟办公室</h1>
            <p className={styles.presentationClock}>{clock}</p>
          </div>
          <div className={styles.presentationControls}>
            <span className={styles.presentationStatus}>
              {connected ? '🟢 实时同步中' : '🔌 连接中…'}
            </span>
            <button
              type="button"
              onClick={exitPresentation}
              className={styles.presentationExit}
            >
              ESC 退出
            </button>
          </div>
        </header>

        {employees.length > 0 && (
          <div className={styles.presentationOverview}>
            <OfficeOverview employees={employees} large presentation />
          </div>
        )}

        <OfficeChatterTicker feed={chatterFeed} presentation />

        <div className={styles.presentationGrid}>
          {sorted.map((employee) => (
            <div key={employee.employee_id}>
              <OfficeBadge employee={employee} presentation />
            </div>
          ))}
        </div>

        <OfficeSpotlightToast feed={chatterFeed} presentation />
      </main>
    )
  }

  return (
    <div
      className={`${styles.officePage} warm-ledger`}
      data-warm-digital-office="true"
      data-warm-surface="warm-ledger"
      aria-busy={refreshing || undefined}
    >
      <div className={styles.officeToolbar}>
        <span className={styles.connectionState}>
          <span
            className={styles.connectionDot}
            data-connected={connected}
            aria-hidden="true"
          />
          {connected ? '实时同步中' : '连接中…'}
        </span>
        <WarmButton
          type="button"
          variant="secondary"
          onClick={() => {
            void document.documentElement.requestFullscreen?.()
            router.push('/dashboard/ai/digital-employees/office?mode=presentation')
          }}
        >
          <Monitor aria-hidden="true" />
          投屏
        </WarmButton>
      </div>

      {employees.length > 0 ? <OfficeOverview employees={employees} /> : null}

      <OfficeChatterTicker feed={chatterFeed} />

      {employees.length === 0 ? (
        <div className={styles.officeSkeletonGrid} aria-busy="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className={`${styles.skeleton} ${styles.officeSkeletonCard}`}
            />
          ))}
        </div>
      ) : (
        <div className={styles.officeGrid} data-testid="digital-office-grid">
          {sorted.map((employee) => (
            <OfficeBadge key={employee.employee_id} employee={employee} />
          ))}
        </div>
      )}

      <OfficeSpotlightToast feed={chatterFeed} />
    </div>
  )
}
