'use client'

import { useState } from 'react'
import { Monitor, RefreshCw, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeGrid } from '@/components/digital-employee/digital-employee-grid'
import { DigitalEmployeeStats } from '@/components/digital-employee/stats'
import { ActivityFeed } from '@/components/digital-employee/activity-feed'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import styles from '@/components/digital-employee/digital-employee-warm.module.css'

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

  useHeaderRefresh(() => mutate(), { loading: isLoading })

  const { showSkeleton, isRefreshing } = useSmoothRefresh({
    loading: isLoading,
    hasData: employees.length > 0,
  })

  const filtered = employees.filter((employee) => {
    const matchSearch =
      !search ||
      employee.name.includes(search) ||
      (employee.description ?? '').includes(search)
    const matchStatus = !statusFilter || employee.status === statusFilter
    return matchSearch && matchStatus
  })

  const runningCount = employees.filter((employee) => employee.status === 'RUNNING').length
  const failedCount = employees.filter((employee) => employee.status === 'FAILED').length

  return (
    <div
      className={styles.page}
      data-warm-digital-employees-list="true"
      aria-busy={isRefreshing || undefined}
    >
      <div className={styles.toolbar}>
        <div className={styles.statusSignals}>
          {runningCount > 0 ? (
            <span className={styles.statusSignal} data-tone="accent">
              <span className={styles.statusDot} aria-hidden="true" />
              {runningCount} 个运行中
            </span>
          ) : null}
          {failedCount > 0 ? (
            <span className={styles.statusSignal} data-tone="negative">
              <span className={styles.statusDot} aria-hidden="true" />
              {failedCount} 个异常
            </span>
          ) : null}
        </div>
        <div className={styles.toolbarActions}>
          <WarmButton
            type="button"
            variant="secondary"
            onClick={() => window.open('/dashboard/ai/digital-employees/office', '_blank')}
          >
            <Monitor aria-hidden="true" />
            全屏展示
          </WarmButton>
          <WarmButton type="button" variant="secondary" onClick={() => void mutate()}>
            <RefreshCw aria-hidden="true" />
            刷新
          </WarmButton>
        </div>
      </div>

      {showSkeleton ? (
        <div aria-busy="true">
          <div className={styles.skeletonStats}>
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className={styles.skeletonStat} />
            ))}
          </div>
          <div className={styles.skeletonLayout}>
            <div className={styles.skeletonRoster}>
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className={`${styles.skeleton} ${styles.skeletonRow}`} />
              ))}
            </div>
            <div className={styles.skeletonRail}>
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className={`${styles.skeleton} ${styles.skeletonRow}`} />
              ))}
            </div>
          </div>
        </div>
      ) : error ? (
        <div role="alert" className={styles.errorState}>
          <p>加载失败：{error.message}</p>
        </div>
      ) : (
        <>
          <DigitalEmployeeStats employees={employees} />

          <div className={styles.listLayout} data-testid="digital-employee-list-layout">
            <section
              className={`${styles.panel} ${styles.rosterPanel}`}
              aria-label="数字员工"
              data-warm-employee-roster="true"
            >
              <div className={styles.rosterToolbar}>
                <div className={styles.searchWrap}>
                  <Search className={styles.searchIcon} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="搜索数字员工"
                    placeholder="搜索数字员工..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className={styles.searchInput}
                  />
                </div>

                <div className={styles.filterGroup} role="group" aria-label="状态筛选">
                  {STATUS_FILTERS.map((filter) => {
                    const count =
                      filter.value === null
                        ? employees.length
                        : employees.filter((employee) => employee.status === filter.value).length
                    const active = statusFilter === filter.value

                    return (
                      <button
                        key={filter.label}
                        type="button"
                        className={styles.filterChip}
                        aria-pressed={active}
                        aria-label={`${filter.label} ${count}`}
                        onClick={() => setStatusFilter(active ? null : filter.value)}
                      >
                        {filter.label}
                        <span className={styles.filterCount}>{count}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {filtered.length === 0 ? (
                <div className={styles.emptyState}>
                  <p>暂无数字员工</p>
                </div>
              ) : (
                <DigitalEmployeeGrid
                  employees={filtered}
                  onCardClick={(id) => router.push(`/dashboard/ai/digital-employees/${id}`)}
                />
              )}
            </section>

            <section
              className={`${styles.panel} ${styles.activityPanel}`}
              aria-label="实时动态"
            >
              <div className={styles.activityHeader}>
                <h2>实时动态</h2>
                <span className={styles.activityLive}>15s 更新</span>
              </div>
              <div className={styles.activityBody}>
                <ActivityFeed
                  pollInterval={15000}
                  maxHeight="calc(100vh - 320px)"
                  compact
                />
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
