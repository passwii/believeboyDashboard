/**
 * 明细视图 tab（BLF-428 前端重构）— Detail 视图每笔事件账。
 *
 * 全局筛选在上游（inventory-ledger-client）应用；本组件负责展示、
 * 过滤结果摘要条、客户端分页与 CSV 导出。
 */

import { useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
  DENSE_CELL,
  DENSE_HEAD,
} from '@/components/ui/data-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyTableState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

import { DispositionBadge } from './ledger-badges'
import { ExportCsvButton, PaginationBar } from './ledger-table-parts'
import { eventTypeLabel, type LedgerDetailRow } from './ledger-types'

const PAGE_SIZE = 50

export function LedgerDetailTab({
  rows,
  failed,
  period,
}: {
  /** 已按全局筛选过滤的 detail 行（date desc） */
  rows: LedgerDetailRow[]
  failed?: boolean
  period: string
}) {
  const [page, setPage] = useState(0)

  useEffect(() => setPage(0), [rows])

  const pageCount = Math.ceil(rows.length / PAGE_SIZE)
  const pageRows = useMemo(
    () => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [rows, page],
  )

  const netQty = useMemo(() => rows.reduce((s, r) => s + r.quantity, 0), [rows])

  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '无事件明细'

  const csvRows = useMemo(
    () =>
      rows.map((r) => [
        r.date,
        r.msku,
        r.title ?? '',
        eventTypeLabel(r.event_type),
        r.event_type,
        r.quantity,
        r.fulfillment_center,
        r.disposition,
        r.reference_id ?? '',
        r.reason ?? '',
        r.batch_id ?? '',
      ]),
    [rows],
  )

  return (
    <DataTableCard>
      <DataTableCardHeader
        title="事件明细"
        description={`${rows.length} 条事件 · 净数量 ${netQty > 0 ? `+${netQty}` : netQty}`}
        action={
          <ExportCsvButton
            filename={`库存分类账-事件明细-${period || 'all'}.csv`}
            headers={[
              '日期',
              'MSKU',
              '品名',
              '事件类型',
              'Event Type',
              '数量',
              '仓库',
              'Disposition',
              'Reference ID',
              'Reason',
              '批次',
            ]}
            rows={csvRows}
          />
        }
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>日期</TableHead>
              <TableHead className={DENSE_HEAD}>SKU</TableHead>
              <TableHead className={DENSE_HEAD}>事件</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>数量</TableHead>
              <TableHead className={DENSE_HEAD}>仓库</TableHead>
              <TableHead className={DENSE_HEAD}>Disposition</TableHead>
              <TableHead className={DENSE_HEAD}>Reference ID</TableHead>
              <TableHead className={DENSE_HEAD}>批次</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <EmptyTableState colSpan={8} message={emptyText} />
            ) : (
              pageRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className={DENSE_CELL}>{r.date}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{r.msku}</TableCell>
                  <TableCell className={DENSE_CELL}>
                    <Badge variant="outline" className="text-xs">
                      {eventTypeLabel(r.event_type)}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={cn(
                      DENSE_CELL,
                      'text-right font-mono text-xs tabular-nums',
                      r.quantity > 0 ? 'text-green-600' : r.quantity < 0 ? 'text-red-600' : undefined,
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
        <PaginationBar page={page} pageCount={pageCount} total={rows.length} onPageChange={setPage} />
      </DataTableCardBody>
    </DataTableCard>
  )
}
