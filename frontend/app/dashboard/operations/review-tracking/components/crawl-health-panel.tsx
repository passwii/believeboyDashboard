'use client'

import { EmptyState } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type CrawlRunRow, MISSING_VALUE } from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'

/**
 * 采集健康度（阶段 C，BLF-1377）。
 *
 * 运行记录是**独立**于评分/评论的：同一业务日期重试会更新当天快照，但每次运行都留档。
 * 因此这里按 `started_at` 倒序展示最近运行，用来判断「这天的数据为什么缺」：
 *  - `is_complete_list=false` → 本次不是完整评论列表，不能据此判定评论疑似移除；
 *  - `reviews_seen=null` → 本次没取到评论数（不是 0）；
 *  - `ratings_captured=false` → 本次没取到评分，快照缺失；
 *  - `error_message` → 采集端返回的错误原因。
 */
const TONE_CLASS = {
  pos: 'text-term-pos',
  warn: 'text-term-warn',
  neg: 'text-term-neg',
  muted: 'text-term-muted',
} as const

function formatTimestamp(value: string | null): string {
  if (!value) return MISSING_VALUE
  return value.replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, '').slice(0, 19)
}

export function CrawlHealthPanel({ runs }: { runs: CrawlRunRow[] }) {
  return (
    <div className="space-y-3" data-testid="crawl-health-panel">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[160px]">开始时间</TableHead>
            <TableHead className="w-[90px]">状态</TableHead>
            <TableHead className="w-[110px]">完整列表</TableHead>
            <TableHead className="w-[90px] text-right">评论数</TableHead>
            <TableHead className="w-[90px]">评分为</TableHead>
            <TableHead className="w-[110px]">抓取 ASIN</TableHead>
            <TableHead>错误</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell className="font-mono text-[12px] text-term-muted">
                {formatTimestamp(run.startedAt)}
              </TableCell>
              <TableCell>
                <span className={cn('font-mono text-[11px]', TONE_CLASS[run.statusTone])}>
                  {run.statusLabel}
                </span>
              </TableCell>
              <TableCell className="font-mono text-[11px]">
                {run.isCompleteList ? (
                  <span className="text-term-pos">完整</span>
                ) : (
                  <span className="text-term-warn">不完整</span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-[12px] tabular-nums text-term-muted">
                {run.reviewsSeen === null ? MISSING_VALUE : run.reviewsSeen}
              </TableCell>
              <TableCell className="font-mono text-[11px]">
                {run.ratingsCaptured ? (
                  <span className="text-term-pos">已取到</span>
                ) : (
                  <span className="text-term-neg">未取到</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-[11px] text-term-muted">
                {run.asinScraped || MISSING_VALUE}
              </TableCell>
              <TableCell className="max-w-[240px] truncate font-mono text-[11px] text-term-neg" title={run.errorMessage ?? ''}>
                {run.errorMessage || MISSING_VALUE}
              </TableCell>
            </TableRow>
          ))}
          {runs.length === 0 ? (
            <EmptyState
              colSpan={7}
              message="还没有采集运行记录（等待采集端接入）"
            />
          ) : null}
        </TableBody>
      </Table>
      <p className="font-mono text-[10px] text-term-faint">
        只有「完整列表」的成功运行才参与「连续 2 次未出现 → 疑似移除」判定；失败或不完整运行不改变评论状态。
        同一天可以有多条运行记录，但快照只有一条。
      </p>
    </div>
  )
}
