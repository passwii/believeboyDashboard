'use client'

import { formatDate, formatFullCurrency, formatInteger } from '../../v2-format'

import { TableLoadingState, TableMessage } from './table-state'

export interface DailyLedgerRow {
  date: string
  sales_amount: number
  order_qty: number
  ad_spend: number
  pending_order_qty: number
}

export interface DailyLedgerTableProps {
  rows: readonly DailyLedgerRow[]
  loading?: boolean
  error?: string | null
  onClick?: (row: DailyLedgerRow) => void
}

const DAILY_HEADERS = ['日期', '销售额', '订单', '广告花费', '待处理（日快照）'] as const
const DAILY_MIN_WIDTH = 'min-w-[640px]'

export function DailyLedgerTable({
  rows,
  loading = false,
  error,
  onClick,
}: DailyLedgerTableProps) {
  if (loading) {
    return (
      <TableLoadingState
        headers={DAILY_HEADERS}
        loadingLabel="正在加载日明细"
        minWidthClass={DAILY_MIN_WIDTH}
        tableName="日明细"
      />
    )
  }

  if (error) return <TableMessage detail={error} kind="error" title="日明细加载失败" />
  if (rows.length === 0) return <TableMessage kind="empty" title="暂无日明细" />

  return (
    <div
      aria-label="日明细表格"
      className="w-full min-w-0 overflow-x-auto overscroll-x-contain touch-pan-x focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--warm-ledger-focus-color)]"
      data-table-scroll
      role="region"
      tabIndex={0}
    >
      <table
        aria-label="日明细"
        className={`w-full ${DAILY_MIN_WIDTH} border-collapse text-left text-xs`}
      >
        <thead>
          <tr className="border-b border-[color:var(--warm-ledger-color-hairline)] text-[color:var(--warm-ledger-color-text-muted)]">
            {DAILY_HEADERS.map((header, index) => (
              <th
                className={`px-3 py-3 font-medium ${index > 0 ? 'text-right' : 'text-left'}`}
                key={header}
                scope="col"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const clickable = Boolean(onClick)

            return (
              <tr
                aria-label={clickable ? `打开日明细 ${formatDate(row.date, 'day-month')}` : undefined}
                className={`border-b border-[color:var(--warm-ledger-color-hairline)] text-[color:var(--warm-ledger-color-text)] last:border-b-0 ${clickable ? 'cursor-pointer hover:bg-[var(--warm-ledger-color-raised)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--warm-ledger-focus-color)]' : ''}`}
                key={row.date}
                onClick={clickable ? () => onClick?.(row) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onClick?.(row)
                        }
                      }
                    : undefined
                }
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
              >
                <td className="px-3 py-3 align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums text-[color:var(--warm-ledger-color-text-soft)]">
                  {formatDate(row.date, 'day-month')}
                </td>
                <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums">
                  {formatFullCurrency(row.sales_amount)}
                </td>
                <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums">
                  {formatInteger(row.order_qty)}
                </td>
                <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums text-[color:var(--warm-ledger-color-text-soft)]">
                  {formatFullCurrency(row.ad_spend)}
                </td>
                <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums">
                  {formatInteger(row.pending_order_qty)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
