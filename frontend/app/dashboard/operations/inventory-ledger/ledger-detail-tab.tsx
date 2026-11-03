/**
 * 明细视图 tab（BLF-428 前端重构）— Detail 视图每笔事件账。
 *
 * 全局筛选在上游（inventory-ledger-client）应用；本组件负责展示、
 * 过滤结果摘要条、客户端分页与 CSV 导出。
 */

import { useEffect, useMemo, useState } from 'react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
  DENSE_CELL,
} from '@/components/ui/data-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EmptyTableState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

import { DispositionBadge } from './ledger-badges'
import { dailyEventSummary } from './ledger-derive'
import { ColumnHeader, PaginationBar } from './ledger-table-parts'
import { detailEn, detailLabel, technicalEn, technicalLabel } from './ledger-glossary'
import { eventTypeLabel, type LedgerDetailRow } from './ledger-types'
import styles from './inventory-ledger-warm.module.css'

const PAGE_SIZE = 50

/** 表格列头：键 → 中文 label + 英文列名 tooltip（BLF-431，spec 表头为准） */
const DETAIL_HEADERS: {
  key: string
  label: string
  tooltip: string
  align?: 'right'
}[] = [
  { key: 'date', label: detailLabel('date'), tooltip: detailEn('date') },
  { key: 'msku', label: detailLabel('msku'), tooltip: detailEn('msku') },
  { key: 'event_type', label: detailLabel('event_type'), tooltip: detailEn('event_type') },
  { key: 'quantity', label: detailLabel('quantity'), tooltip: detailEn('quantity'), align: 'right' },
  { key: 'fulfillment_center', label: detailLabel('fulfillment_center'), tooltip: detailEn('fulfillment_center') },
  { key: 'disposition', label: detailLabel('disposition'), tooltip: detailEn('disposition') },
  { key: 'reference_id', label: detailLabel('reference_id'), tooltip: detailEn('reference_id') },
  { key: 'batch_id', label: technicalLabel('batch_id'), tooltip: technicalEn('batch_id') },
]

export function LedgerDetailTab({
  rows,
  failed,
}: {
  /** 已按全局筛选过滤的 detail 行（date desc） */
  rows: LedgerDetailRow[]
  failed?: boolean
}) {
  const [page, setPage] = useState(0)

  useEffect(() => setPage(0), [rows])

  const pageCount = Math.ceil(rows.length / PAGE_SIZE)
  const pageRows = useMemo(
    () => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [rows, page],
  )

  const netQty = useMemo(() => rows.reduce((s, r) => s + r.quantity, 0), [rows])
  const dailyRows = useMemo(() => dailyEventSummary(rows), [rows])

  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '无事件明细'

  return (
    <div className="space-y-4">
      <DataTableCard className={styles.tableCard}>
        <DataTableCardHeader
          className={styles.tableHeader}
          title="每日事件汇总"
          description={`${dailyRows.length} 个有事件日期 · 按 Detail 实际发生日期聚合`}
        />
        <DataTableCardBody className={styles.tableBody}>
          <div className={styles.tableScroll}>
          <Table className={cn(styles.ledgerTable, styles.dailyEventsTable)}>
            <TableHeader>
              <TableRow>
                <ColumnHeader label="日期" className={styles.dailyEventsDate} />
                <ColumnHeader
                  label="事件数"
                  className={cn('text-right', styles.dailyEventsCount)}
                />
                <ColumnHeader
                  label="净数量"
                  className={cn('text-right', styles.dailyEventsNetQty)}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {dailyRows.map((row) => (
                <TableRow key={row.date}>
                  <TableCell className={cn(DENSE_CELL, styles.dailyEventsDate)}>{row.date}</TableCell>
                  <TableCell
                    className={cn(DENSE_CELL, 'text-right tabular-nums', styles.dailyEventsCount)}
                  >
                    {row.eventCount}
                  </TableCell>
                  <TableCell
                    className={cn(
                      DENSE_CELL,
                      'text-right tabular-nums',
                      styles.dailyEventsNetQty,
                      row.netQty > 0
                        ? styles.positive
                        : row.netQty < 0
                          ? styles.negative
                          : undefined,
                    )}
                  >
                    {row.netQty > 0 ? `+${row.netQty}` : row.netQty}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </DataTableCardBody>
      </DataTableCard>

      <DataTableCard className={styles.tableCard}>
        <DataTableCardHeader
          className={styles.tableHeader}
          title="事件明细"
          description={`${rows.length} 条事件 · 净数量 ${netQty > 0 ? `+${netQty}` : netQty}`}
        />
        <DataTableCardBody className={styles.tableBody}>
          <TooltipProvider delayDuration={150}>
            <div className={styles.tableScroll}>
            <Table className={styles.ledgerTable}>
              <TableHeader>
                <TableRow>
                  {DETAIL_HEADERS.map((h) => (
                    <ColumnHeader
                      key={h.key}
                      label={h.label}
                      tooltip={h.tooltip}
                      className={h.align === 'right' ? 'text-right' : undefined}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.length === 0 ? (
                  <EmptyTableState colSpan={DETAIL_HEADERS.length} message={emptyText} />
                ) : (
                  pageRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className={DENSE_CELL}>{r.date}</TableCell>
                      <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{r.msku}</TableCell>
                      <TableCell className={DENSE_CELL}>
                        <WarmBadge className={styles.eventBadge}>
                          {eventTypeLabel(r.event_type)}
                        </WarmBadge>
                      </TableCell>
                      <TableCell
                        className={cn(
                          DENSE_CELL,
                          'text-right font-mono text-xs tabular-nums',
                          r.quantity > 0 ? styles.positive : r.quantity < 0 ? styles.negative : undefined,
                        )}
                      >
                        {r.quantity > 0 ? `+${r.quantity}` : r.quantity}
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>
                        {r.fulfillment_center}
                      </TableCell>
                      <TableCell className={DENSE_CELL}>
                        <DispositionBadge disposition={r.disposition} />
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'font-mono text-xs text-muted-foreground')}>
                        {r.reference_id || '—'}
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'font-mono text-xs text-muted-foreground')}>
                        {r.batch_id ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            </div>
          </TooltipProvider>
          <PaginationBar page={page} pageCount={pageCount} total={rows.length} onPageChange={setPage} />
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}
