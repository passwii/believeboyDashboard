'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  type CommissionProjectMonth,
  type ExchangeRate,
  type ProjectMeta,
  type ProjectRow,
  type PaymentStatus,
} from './types'
import {
  SITE_INFO,
  formatIncomeWithCurrency,
  formatRmb,
  formatPercent,
} from './utils'
import styles from './commission-management-warm.module.css'

interface DetailTabProps {
  projectRows: ProjectRow[]
  exchangeRates: ExchangeRate[]
  projectMetaById: Record<number, ProjectMeta>
  loading: boolean
  updatingId: number | null
  receivedDraftById: Record<number, string>
  onUpdateDraft: (id: number, value: string) => void
  onUpdatePaymentStatus: (row: CommissionProjectMonth, status: PaymentStatus) => void
  onUpdateReceivedAmount: (row: CommissionProjectMonth) => void
}

const HEADERS = [
  { label: '项目', numeric: false },
  { label: '站点', numeric: false },
  { label: '销售收入', numeric: true },
  { label: '佣金比例', numeric: true },
  { label: '工厂佣金(RMB)', numeric: true },
  { label: '已回款(RMB)', numeric: true },
  { label: '回款状态', numeric: false },
]

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  paid: '已回款',
  partial: '部分回款',
  unpaid: '未回款',
}

function DetailSkeleton() {
  return (
    <div className={styles.skeletonLayer} aria-hidden="true">
      <table className={styles.skeletonTable}>
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th key={header.label}>
                <span
                  className={`${styles.skeletonBlock} ${
                    header.numeric ? styles.skeletonBlockRight : ''
                  }`}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {HEADERS.map((header, cellIndex) => (
                <td key={header.label}>
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

export function DetailTab({
  projectRows,
  exchangeRates,
  projectMetaById,
  loading,
  updatingId,
  receivedDraftById,
  onUpdateDraft,
  onUpdatePaymentStatus,
  onUpdateReceivedAmount,
}: DetailTabProps) {
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [displayData, setDisplayData] = useState(projectRows)
  const prevLoadingRef = useRef(loading)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    prevLoadingRef.current = loading
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current)
      }
    }
  }, [loading])

  useEffect(() => {
    if (!loading && projectRows !== displayData) {
      setIsTransitioning(true)
      transitionTimerRef.current = setTimeout(() => {
        setDisplayData(projectRows)
        setIsTransitioning(false)
      }, 200)
    }
  }, [loading, projectRows, displayData])

  const getCommissionRatioLabel = useCallback(
    (record: CommissionProjectMonth): string => {
      const projectMeta = projectMetaById[record.project_id]
      if (!projectMeta) {
        return formatPercent(record.factory_commission_rate)
      }
      if (projectMeta.commission_basis === 'cash_received') {
        return '阶梯(7/10/13/15%)'
      }
      if (
        typeof projectMeta.commission_rate === 'number' &&
        Number.isFinite(projectMeta.commission_rate)
      ) {
        return formatPercent(projectMeta.commission_rate)
      }
      return formatPercent(record.factory_commission_rate)
    },
    [projectMetaById]
  )

  const statusOptions = useMemo(
    () =>
      (Object.entries(PAYMENT_STATUS_LABELS) as Array<[PaymentStatus, string]>).map(
        ([value, label]) => ({ value, label })
      ),
    []
  )

  const renderRow = (row: ProjectRow) => {
    const { rowSpan, projectName, record } = row
    const country = record.country as 'US' | 'DE' | 'UK'
    const info = SITE_INFO[country]

    return (
      <tr key={record.id} className={styles.tableRow}>
        {rowSpan > 0 ? (
          <td
            rowSpan={rowSpan}
            title={projectName}
            className={`${styles.tableCell} ${styles.stickyProjectCell}`}
          >
            {projectName}
          </td>
        ) : null}

        <td className={`${styles.tableCell} ${styles.siteCell}`}>{info.label}</td>
        <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
          {formatIncomeWithCurrency(record.income_total_usd, country)}
        </td>
        <td
          className={`${styles.tableCell} ${styles.tableCellNumeric} ${styles.tableCellMuted}`}
        >
          {getCommissionRatioLabel(record)}
        </td>
        <td
          className={`${styles.tableCell} ${styles.tableCellNumeric} ${styles.tableCellStrong}`}
        >
          {formatRmb(record.factory_commission_rmb)}
        </td>
        <td className={`${styles.tableCell} ${styles.tableCellNumeric}`}>
          <Input
            type="number"
            step="0.01"
            min="0"
            aria-label={`${projectName} ${info.label} 已回款金额`}
            value={receivedDraftById[record.id] ?? ''}
            className={styles.tableInput}
            onChange={(event) => {
              onUpdateDraft(record.id, event.target.value)
            }}
            onBlur={() => {
              onUpdateReceivedAmount(record)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onUpdateReceivedAmount(record)
              }
            }}
            disabled={updatingId === record.id}
          />
        </td>
        <td className={styles.tableCell}>
          <WarmSelect
            id={`commission-payment-${record.id}`}
            label={`${projectName} ${info.label} 回款状态`}
            value={record.payment_status}
            options={statusOptions}
            onChange={(value) => onUpdatePaymentStatus(record, value as PaymentStatus)}
            disabled={updatingId === record.id}
            className={styles.paymentStatus}
          />
        </td>
      </tr>
    )
  }

  return (
    <div className={styles.tableLayout} aria-busy={loading || undefined}>
      {loading ? (
        <>
          <DetailSkeleton />
          <span className={styles.visuallyHidden} role="status">
            正在加载佣金明细
          </span>
        </>
      ) : (
        <div
          className={`${styles.tableScroller} ${
            isTransitioning ? styles.tableScrollerTransitioning : ''
          }`}
        >
          <table className={styles.table} data-warm-table="true">
            <thead className={styles.tableHead}>
              <tr>
                {HEADERS.map((header) => (
                  <th
                    key={header.label}
                    className={`${styles.tableHeaderCell} ${
                      header.numeric ? styles.tableHeaderNumeric : ''
                    } ${header.label === '项目' ? styles.stickyHeaderCell : ''}`}
                  >
                    {header.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projectRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.emptyCell}>
                    当前月份暂无数据，请先刷新核算
                  </td>
                </tr>
              ) : (
                displayData.map((row) => renderRow(row))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
