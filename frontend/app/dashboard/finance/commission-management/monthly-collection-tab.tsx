'use client'

import {
  WarmBadge,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { formatPercent } from './utils'
import styles from './commission-management-warm.module.css'

type CommissionProjectMonthlySummaryMonthItem = {
  report_month: string
  income_total_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

type CommissionProjectYearlySummaryItem = {
  project_id: number
  project_name: string
  months: Record<string, CommissionProjectMonthlySummaryMonthItem>
  total_income_usd: number
  total_commission_rmb: number
  total_received_rmb: number
  receive_rate: number
}

function getYearMonths(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

const RATE_EPSILON = 1e-9
const DATA_COLS = 13

function getReceiveRateTone(rate: number): WarmBadgeTone {
  if (rate >= 1 - RATE_EPSILON) return 'positive'
  if (rate >= 0.2 - RATE_EPSILON) return 'accent'
  return 'negative'
}

interface MonthlyCollectionTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

function MonthlyCollectionSkeleton({ year }: { year: string }) {
  const months = getYearMonths(year)
  return (
    <div className={styles.skeletonLayer} aria-hidden="true">
      <table className={`${styles.skeletonTable} ${styles.tableWide}`}>
        <thead>
          <tr>
            <th>
              <span className={styles.skeletonBlock} />
            </th>
            {months.map((month) => (
              <th key={month}>
                <span className={`${styles.skeletonBlock} ${styles.skeletonBlockRight}`} />
              </th>
            ))}
            <th>
              <span className={`${styles.skeletonBlock} ${styles.skeletonBlockRight}`} />
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: DATA_COLS }).map((_, cellIndex) => (
                <td key={cellIndex}>
                  <span
                    className={`${styles.skeletonBlock} ${
                      cellIndex > 0 ? styles.skeletonBlockRight : ''
                    }`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RateCell({ rate }: { rate: number | null }) {
  if (rate === null || rate <= 0) {
    return <span className={styles.rateEmpty}>-</span>
  }
  return (
    <WarmBadge tone={getReceiveRateTone(rate)} className={styles.rateBadge}>
      {formatPercent(rate)}
    </WarmBadge>
  )
}

export function MonthlyCollectionTab({ items, year, loading }: MonthlyCollectionTabProps) {
  const months = getYearMonths(year)

  return (
    <div className={styles.tableLayout} aria-busy={loading || undefined}>
      {loading ? (
        <>
          <MonthlyCollectionSkeleton year={year} />
          <span className={styles.visuallyHidden} role="status">
            正在加载月度回款
          </span>
        </>
      ) : (
        <>
          <div className={styles.tableScroller}>
            <table className={`${styles.table} ${styles.tableWide}`} data-warm-table="true">
              <thead className={styles.tableHead}>
                <tr>
                  <th className={`${styles.tableHeaderCell} ${styles.stickyHeaderCell}`}>
                    项目名称
                  </th>
                  {months.map((month) => (
                    <th
                      key={month}
                      className={`${styles.tableHeaderCell} ${styles.tableHeaderNumeric}`}
                    >
                      {month.slice(5)}月
                    </th>
                  ))}
                  <th className={`${styles.tableHeaderCell} ${styles.tableHeaderNumeric}`}>
                    年度汇总
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={DATA_COLS} className={styles.emptyCell}>
                      {year}年暂无数据
                    </td>
                  </tr>
                ) : (
                  items.map((project) => (
                    <tr key={project.project_id} className={styles.tableRow}>
                      <td
                        title={project.project_name}
                        className={`${styles.tableCell} ${styles.stickyProjectCell}`}
                      >
                        {project.project_name}
                      </td>
                      {months.map((month) => {
                        const monthData = project.months[month]
                        return (
                          <td
                            key={month}
                            className={`${styles.tableCell} ${styles.tableCellNumeric}`}
                          >
                            <RateCell rate={monthData ? monthData.receive_rate : null} />
                          </td>
                        )
                      })}
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        <RateCell rate={project.receive_rate} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className={styles.legend}>
            <span>回款率色块：</span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.legendPositive}`} />
              ≥100%
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.legendAccent}`} />
              20%~100%
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.legendNegative}`} />
              &lt;20%
            </span>
          </div>
        </>
      )}
    </div>
  )
}
