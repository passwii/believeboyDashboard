'use client'

import { useMemo } from 'react'

import { WarmSegmentedControl } from '../controls'
import { formatFullCurrency, formatPercent } from '../../v2-format'

import { TableLoadingState, TableMessage } from './table-state'

export interface ProjectRankRow {
  projectId: number
  projectName: string
  totalSales: number
  totalAdSpend: number
  /** Sales change against the comparison period, expressed as a percent. */
  change: number | null
}

export type ProjectRankSortKey = 'sales' | 'ad_spend'

export interface ProjectRankTableProps {
  rows: readonly ProjectRankRow[]
  sortKey: ProjectRankSortKey
  onSortChange: (sortKey: ProjectRankSortKey) => void
  loading?: boolean
  error?: string | null
  onClick?: (row: ProjectRankRow) => void
}

const RANK_HEADERS = ['项目', '销售额', '广告花费', '环比'] as const
const RANK_MIN_WIDTH = 'min-w-[600px]'
const RANK_SORT_OPTIONS: ReadonlyArray<{ value: ProjectRankSortKey; label: string }> = [
  { value: 'sales', label: '销售额' },
  { value: 'ad_spend', label: '广告花费' },
]

function metricValue(row: ProjectRankRow, sortKey: ProjectRankSortKey): number {
  const value = sortKey === 'sales' ? row.totalSales : row.totalAdSpend
  return Number.isFinite(value) ? value : 0
}

function getRowChangeLabel(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return '无环比数据'
  const direction = change > 0 ? '上升' : change < 0 ? '下降' : '持平'
  return `环比${direction} ${formatPercent(Math.abs(change), 1)}`
}

export function ProjectRankTable({
  rows,
  sortKey,
  onSortChange,
  loading = false,
  error,
  onClick,
}: ProjectRankTableProps) {
  const sortedRows = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .sort(
          (a, b) =>
            metricValue(b.row, sortKey) - metricValue(a.row, sortKey) ||
            a.index - b.index
        )
        .map(({ row }) => row),
    [rows, sortKey]
  )
  const maxMetric = Math.max(0, ...sortedRows.map((row) => metricValue(row, sortKey)))

  const renderRows = () =>
    sortedRows.map((row) => {
      const value = Math.max(0, metricValue(row, sortKey))
      const width = maxMetric > 0 ? Math.round((value / maxMetric) * 100) : 0
      const clickable = Boolean(onClick)

      return (
        <tr
          className="border-b border-[color:var(--warm-ledger-color-hairline)] text-[color:var(--warm-ledger-color-text)] last:border-b-0"
          key={row.projectId}
        >
          <td className="px-3 py-3 align-middle">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="relative h-1 w-14 shrink-0 bg-[var(--warm-ledger-color-hairline-strong)]"
              >
                <span
                  className="absolute inset-y-0 start-0 bg-[var(--warm-ledger-color-accent)]"
                  data-testid="project-rank-bar"
                  style={{ width: `${width}%` }}
                />
              </span>
              {clickable ? (
                <button
                  type="button"
                  className="warm-ledger__table-project-action min-w-0 [overflow-wrap:anywhere]"
                  aria-label={`打开项目 ${row.projectName}`}
                  onClick={() => onClick?.(row)}
                >
                  {row.projectName}
                </button>
              ) : (
                <span className="min-w-0 [overflow-wrap:anywhere]">{row.projectName}</span>
              )}
            </div>
          </td>
          <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums">
            {formatFullCurrency(row.totalSales)}
          </td>
          <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums text-[color:var(--warm-ledger-color-text-soft)]">
            {formatFullCurrency(row.totalAdSpend)}
          </td>
          <td className="px-3 py-3 text-right align-middle [font-family:var(--warm-ledger-font-mono)] tabular-nums">
            {row.change === null || !Number.isFinite(row.change) ? (
              <span
                aria-label={getRowChangeLabel(row.change)}
                className="text-[color:var(--warm-ledger-color-text-muted)]"
              >
                —
              </span>
            ) : (
              <span
                aria-label={getRowChangeLabel(row.change)}
                className={
                  row.change > 0
                    ? 'text-[color:var(--warm-ledger-color-positive)]'
                    : row.change < 0
                      ? 'text-[color:var(--warm-ledger-color-negative)]'
                      : 'text-[color:var(--warm-ledger-color-text-muted)]'
                }
              >
                {row.change > 0 ? '▲ ' : row.change < 0 ? '▼ ' : ''}
                {formatPercent(Math.abs(row.change), 1)}
              </span>
            )}
          </td>
        </tr>
      )
    })

  return (
    <div className="min-w-0">
      <div className="mb-3 flex justify-end">
        <WarmSegmentedControl
          ariaLabel="项目排行排序"
          onChange={(value) => {
            if (value === 'sales' || value === 'ad_spend') onSortChange(value)
          }}
          options={RANK_SORT_OPTIONS}
          value={sortKey}
        />
      </div>

      {loading ? (
        <TableLoadingState
          headers={RANK_HEADERS}
          loadingLabel="正在加载项目排行"
          minWidthClass={RANK_MIN_WIDTH}
          tableName="项目排行"
        />
      ) : error ? (
        <TableMessage detail={error} kind="error" title="项目排行加载失败" />
      ) : sortedRows.length === 0 ? (
        <TableMessage kind="empty" title="暂无项目数据" />
      ) : (
        <div
          aria-label="项目排行表格"
          className="w-full min-w-0 overflow-x-auto overscroll-x-contain touch-pan-x focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--warm-ledger-focus-color)]"
          data-table-scroll
          role="region"
          tabIndex={0}
        >
          <table
            aria-label="项目排行"
            className={`w-full ${RANK_MIN_WIDTH} border-collapse text-left text-xs`}
          >
            <thead>
              <tr className="border-b border-[color:var(--warm-ledger-color-hairline)] text-[color:var(--warm-ledger-color-text-muted)]">
                {RANK_HEADERS.map((header, index) => (
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
            <tbody>{renderRows()}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
