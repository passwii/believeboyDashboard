'use client'

import {
  WarmBadge,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { formatUsd, formatRmb, formatPercent } from './utils'
import styles from './commission-management-warm.module.css'

type CommissionYearlyMonthlySummaryItem = {
  report_month: string
  income_total_usd: number
  factory_commission_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

interface MonthlySummaryTabProps {
  items: CommissionYearlyMonthlySummaryItem[]
  year: string
  loading: boolean
}

const HEADERS = [
  '月份',
  '销售收入(USD)',
  '工厂佣金(USD)',
  '工厂佣金(RMB)',
  '已回款(RMB)',
  '回款率',
]

function getRateTone(rate: number): WarmBadgeTone {
  if (rate >= 1) return 'positive'
  if (rate < 0.2) return 'negative'
  return 'accent'
}

function MonthlySummarySkeleton() {
  return (
    <div className={styles.skeletonLayer} aria-hidden="true">
      <table className={styles.skeletonTable}>
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th key={header}>
                <span className={styles.skeletonBlock} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 12 }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {HEADERS.map((header, cellIndex) => (
                <td key={header}>
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

export function MonthlySummaryTab({ items, year, loading }: MonthlySummaryTabProps) {
  const totals = items.reduce(
    (acc, item) => ({
      income: acc.income + item.income_total_usd,
      commissionUsd: acc.commissionUsd + item.factory_commission_usd,
      commissionRmb: acc.commissionRmb + item.factory_commission_rmb,
      received: acc.received + item.received_rmb,
    }),
    { income: 0, commissionUsd: 0, commissionRmb: 0, received: 0 }
  )
  const totalsRate = totals.commissionRmb > 0 ? totals.received / totals.commissionRmb : 0

  return (
    <div className={styles.tableLayout} aria-busy={loading || undefined}>
      {loading ? (
        <>
          <MonthlySummarySkeleton />
          <span className={styles.visuallyHidden} role="status">
            正在加载年度月度汇总
          </span>
        </>
      ) : (
        <div className={styles.tableScroller}>
          <table className={styles.table} data-warm-table="true">
            <thead className={styles.tableHead}>
              <tr>
                {HEADERS.map((header, index) => (
                  <th
                    key={header}
                    className={`${styles.tableHeaderCell} ${
                      index > 0 ? styles.tableHeaderNumeric : ''
                    }`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className={styles.emptyCell} role="status">
                    {year}年暂无数据
                  </td>
                </tr>
              ) : (
                <>
                  {items.map((item) => (
                    <tr key={item.report_month} className={styles.tableRow}>
                      <td className={`${styles.tableCell} ${styles.tableCellMono}`}>
                        {item.report_month}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        {formatUsd(item.income_total_usd)}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        {formatUsd(item.factory_commission_usd)}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        {formatRmb(item.factory_commission_rmb)}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        {formatRmb(item.received_rmb)}
                      </td>
                      <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                        <WarmBadge tone={getRateTone(item.receive_rate)} className={styles.rateBadge}>
                          {formatPercent(item.receive_rate)}
                        </WarmBadge>
                      </td>
                    </tr>
                  ))}
                  <tr className={`${styles.tableRow} ${styles.totalRow}`}>
                    <td className={`${styles.tableCell} ${styles.tableCellStrong}`}>合计</td>
                    <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                      {formatUsd(totals.income)}
                    </td>
                    <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                      {formatUsd(totals.commissionUsd)}
                    </td>
                    <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
                      {formatRmb(totals.commissionRmb)}
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
