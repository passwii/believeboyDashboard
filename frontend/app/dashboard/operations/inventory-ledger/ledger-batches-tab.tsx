/**
 * 上传批次 tab（BLF-428 前端重构：从 v1 页面原样迁移，降级为运维/追溯视图）。
 */

import { WarmBadge, type WarmBadgeTone } from '@/components/dashboard-v2/warm-ledger/controls'
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

import type { IngestBatchInfo } from './ledger-types'
import styles from './inventory-ledger-warm.module.css'

const BATCH_STATUS_LABELS: Record<string, { label: string; tone: WarmBadgeTone }> = {
  success: { label: '成功', tone: 'positive' },
  failed: { label: '失败', tone: 'negative' },
  running: { label: '处理中', tone: 'accent' },
  pending: { label: '等待中', tone: 'accent' },
  partial: { label: '部分成功', tone: 'accent' },
}

export function LedgerBatchesTab({ batches, failed }: { batches: IngestBatchInfo[]; failed?: boolean }) {
  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '暂无上传记录'
  return (
    <DataTableCard className={styles.tableCard}>
      <DataTableCardHeader
        className={styles.tableHeader}
        title="上传批次"
        description="所选项目 / 月份的 CSV 上传留档：文件指纹 / 行数 / 状态 / 对账结果，用于排查数据版本"
      />
      <DataTableCardBody className={styles.tableBody}>
        <div className={styles.tableScroll}>
        <Table className={styles.ledgerTable}>
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
              <EmptyTableState colSpan={10} message={emptyText} />
            ) : (
              batches.map((b) => {
                const st = BATCH_STATUS_LABELS[b.status] ?? {
                  label: b.status,
                  tone: 'neutral' as const,
                }
                return (
                  <TableRow key={b.id}>
                    <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{b.id}</TableCell>
                    <TableCell className={DENSE_CELL}>{b.report_month}</TableCell>
                    <TableCell className={DENSE_CELL}>
                      <WarmBadge>
                        {b.file_kind === 'summary' ? '汇总' : b.file_kind === 'detail' ? '明细' : b.file_kind}
                      </WarmBadge>
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
                      <WarmBadge tone={st.tone}>
                        {st.label}
                      </WarmBadge>
                    </TableCell>
                    <TableCell className={DENSE_CELL}>
                      {b.consistency_check ? (
                        b.consistency_check === 'ok' ? (
                          <WarmBadge tone="positive">
                            OK
                          </WarmBadge>
                        ) : b.consistency_check === 'mismatch' ? (
                          <WarmBadge tone="negative">
                            异常（{b.consistency_mismatch_count}）
                          </WarmBadge>
                        ) : (
                          <WarmBadge>{b.consistency_check}</WarmBadge>
                        )
                      ) : (
                        <span>—</span>
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
        </div>
      </DataTableCardBody>
    </DataTableCard>
  )
}
