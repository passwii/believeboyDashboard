'use client'

import {
  WarmBadge,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { formatRmb, formatPercent } from './utils'
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

function getRateTone(rate: number): WarmBadgeTone {
  if (rate >= 1) return 'positive'
  if (rate < 0.2) return 'negative'
  return 'accent'
}

interface ProjectSummaryTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

const TOTAL_MONTH_COLS = 12
const DATA_COLS = TOTAL_MONTH_COLS + 3

function ProjectSummarySkeleton({ year }: { year: string }) {
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
            {Array.from({ length: 3 }).map((_, index) => (
              <th key={index}>
                <span className={`${styles.skeletonBlock} ${styles.skeletonBlockRight}`} />
              </th>
            ))}
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

export function ProjectSummaryTab({ items, year, loading }: ProjectSummaryTabProps) {
  const months = getYearMonths(year)
  const totals = items.reduce(
    (acc, project) => {
      for (const month of months) {
        const monthData = project.months[month]
        acc.months[month] = (acc.months[month] ?? 0) + (monthData?.factory_commission_rmb ?? 0)
      }
      acc.commission += project.total_commission_rmb
      acc.received += project.total_received_rmb
      return acc
    },
    { months: {} as Record<string, number>, commission: 0, received: 0 }
  )
  const totalsRate = totals.commission > 0 ? totals.received / totals.commission : 0

  return (
    <div className={styles.tableLayout} aria-busy={loading || undefined}>
      {loading ? (
        <>
          <ProjectSummarySkeleton year={year} />
          <span className={styles.visuallyHidden} role="status">
            正在加载项目汇总
          </span>
        </>
      ) : (
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
                  年度佣金合计
                </th>
                <th className={`${styles.tableHeaderCell} ${styles.tableHeaderNumeric}`}>
                  年度回款
                </th>
                <th className={`${styles.tableHeaderCell} ${styles.tableHeaderNumeric}`}>回款率</th>
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
                <>
                  {items.map((project) => (
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
                            className={`${styles.tableCell} ${styles.tableCellNumeric} ${styles.tableCellMuted}`}
                          >
                            {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
                          </td>
                        )
                      })}
                      <td
                        className={`${styles.tableCell} ${styles.tableCellNumeric} ${styles.tableCellStrong}`}
                      >
                        {formatRmb(project.total_commission_rmb)}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        {formatRmb(project.total_received_rmb)}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        <WarmBadge tone={getRateTone(project.receive_rate)} className={styles.rateBadge}>
                          {formatPercent(project.receive_rate)}
                        </WarmBadge>
                      </td>
                    </tr>
                  ))}
                  <tr className={`${styles.tableRow} ${styles.totalRow}`}>
                    <td className={`${styles.tableCell} ${styles.stickyProjectCell}`}>合计</td>
                    {months.map((month) => (
                      <td
                        key={month}
                        className={`${styles.tableCell} ${styles.tableCellNumeric}`}
                      >
                        {totals.months[month] > 0 ? formatRmb(totals.months[month]) : '-'}
                      </td>
                    ))}
                    <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                      {formatRmb(totals.commission)}
                    </td>
                    <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                      {formatRmb(totals.received)}
                    </td>
                    <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                      <WarmBadge tone={getRateTone(totalsRate)} className={styles.rateBadge}>
                        {formatPercent(totalsRate)}
                      </WarmBadge>
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
