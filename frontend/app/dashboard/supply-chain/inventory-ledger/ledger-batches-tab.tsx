/**
 * 上传批次 tab（BLF-428 前端重构：从 v1 页面原样迁移，降级为运维/追溯视图）。
 */

import { Badge, type BadgeProps } from '@/components/ui/badge'
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
import { cn } from '@/lib/utils'

import type { IngestBatchInfo } from './ledger-types'

const BATCH_STATUS_LABELS: Record<string, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  success: { label: '成功', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
  running: { label: '处理中', variant: 'info' },
  pending: { label: '等待中', variant: 'warning' },
  partial: { label: '部分成功', variant: 'warning' },
}

export function LedgerBatchesTab({ batches, failed }: { batches: IngestBatchInfo[]; failed?: boolean }) {
  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '暂无上传记录'
  return (
    <DataTableCard>
      <DataTableCardHeader
        title="上传批次"
        description="每次 CSV 上传留档：文件指纹 / 行数 / 状态 / 对账结果，用于排查数据版本"
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>批次 ID</TableHead>
              <TableHead className={DENSE_HEAD}>报表月</TableHead>
              <TableHead className={DENSE_HEAD}>类型</TableHead>
              <TableHead className={DENSE_HEAD}>文件名</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>解析行</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>汇总行</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>明细行</TableHead>
              <TableHead className={DENSE_HEAD}>状态</TableHead>
              <TableHead className={DENSE_HEAD}>对账</TableHead>
              <TableHead className={DENSE_HEAD}>上传时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.length === 0 ? (
              <tr>
                <td colSpan={10} className="h-24 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            ) : (
              batches.map((b) => {
                const st = BATCH_STATUS_LABELS[b.status] ?? {
                  label: b.status,
                  variant: 'outline' as const,
                }
                return (
                  <TableRow key={b.id}>
                    <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{b.id}</TableCell>
                    <TableCell className={DENSE_CELL}>{b.report_month}</TableCell>
                    <TableCell className={DENSE_CELL}>
                      <Badge variant="outline" className="text-xs">
                        {b.file_kind === 'summary' ? '汇总' : b.file_kind === 'detail' ? '明细' : b.file_kind}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={cn(DENSE_CELL, 'max-w-[260px] truncate text-xs')}
                      title={b.source_filename}
                    >
                      {b.source_filename}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right font-mono text-xs')}>
                      {b.rows_parsed}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right font-mono text-xs')}>
                      {b.rows_written_summary}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right font-mono text-xs')}>
                      {b.rows_written_detail}
                    </TableCell>
                    <TableCell className={DENSE_CELL}>
                      <Badge className="text-xs" variant={st.variant}>
                        {st.label}
                      </Badge>
                    </TableCell>
                    <TableCell className={DENSE_CELL}>
                      {b.consistency_check ? (
                        b.consistency_check === 'ok' ? (
                          <Badge variant="success" className="text-xs">
                            OK
                          </Badge>
                        ) : b.consistency_check === 'mismatch' ? (
                          <Badge variant="destructive" className="text-xs">
                            异常（{b.consistency_mismatch_count}）
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{b.consistency_check}</span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-xs text-muted-foreground')}>
                      {b.loaded_at ? b.loaded_at.slice(0, 16).replace('T', ' ') : '—'}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}
