'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  type ReviewRow,
  type VisibilityStatus,
  MISSING_VALUE,
  visibilityLabel,
} from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'

/**
 * 评论明细表（阶段 C，BLF-1377）。
 *
 * 分页：后端 `GET /targets/{id}/reviews` 不返回 total，因此用「本页返回行数」
 * 判定是否还有下一页（`hasMore`），文案显示「第 N 页」而不是总页数——不编造总数。
 *
 * 可见性：`suspected_removed` 只代表连续两次完整抓取未出现，不等于已删除；
 * 表里用 warn 色档 + 文案区分，并在表尾说明口径。
 */
export interface ReviewsTableProps {
  rows: ReviewRow[]
  loading?: boolean
  hasMore: boolean
  offset: number
  limit: number
  visibility: VisibilityStatus | 'all'
  onVisibilityChange: (value: VisibilityStatus | 'all') => void
  onPrevPage: () => void
  onNextPage: () => void
}

const VISIBILITY_OPTIONS: Array<{ value: VisibilityStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'visible', label: '可见' },
  { value: 'suspected_removed', label: '疑似移除' },
]

function starText(rating: number | null): string {
  return rating === null ? MISSING_VALUE : `${'★'.repeat(rating)}${'☆'.repeat(Math.max(0, 5 - rating))}`
}

export function ReviewsTable({
  rows,
  loading = false,
  hasMore,
  offset,
  limit,
  visibility,
  onVisibilityChange,
  onPrevPage,
  onNextPage,
}: ReviewsTableProps) {
  const page = Math.floor(offset / limit) + 1
  const canPrev = offset > 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="inline-flex border border-term-border bg-term-panel"
          role="group"
          aria-label="评论可见性筛选"
        >
          {VISIBILITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onVisibilityChange(option.value)}
              aria-pressed={visibility === option.value}
              className={cn(
                'h-8 px-3 font-mono text-[11px] transition-colors',
                visibility === option.value
                  ? 'bg-term-raised text-term-text'
                  : 'text-term-muted hover:text-term-text'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-term-muted">第 {page} 页</span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[92px]">星级</TableHead>
            <TableHead>标题 / 正文</TableHead>
            <TableHead className="w-[110px]">评论日期</TableHead>
            <TableHead className="w-[90px]">Verified</TableHead>
            <TableHead className="w-[80px] text-right">Helpful</TableHead>
            <TableHead className="w-[110px]">状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const visibilityInfo = visibilityLabel(row.visibility)
            return (
              <TableRow key={row.reviewKey}>
                <TableCell className="align-top tabular-nums text-term-warn">{starText(row.rating)}</TableCell>
                <TableCell className="align-top">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-term-text">{row.title?.trim() || '（无标题）'}</span>
                    {row.idConfidence === 'derived' ? (
                      <Badge
                        variant="outline"
                        className="border-term-warn/40 text-term-warn"
                        title={row.idConfidenceHint}
                      >
                        {row.idConfidenceLabel}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-term-muted">
                    {row.body?.trim() || '（无正文）'}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-term-faint">
                    评论者 {row.reviewerName || MISSING_VALUE} · 首次 {row.firstSeenAt.slice(0, 10)} · 最近{' '}
                    {row.lastSeenAt.slice(0, 10)}
                  </p>
                </TableCell>
                <TableCell className="align-top font-mono text-[12px] text-term-muted">
                  {row.reviewDate ?? MISSING_VALUE}
                </TableCell>
                <TableCell className="align-top font-mono text-[12px]">
                  {row.verifiedPurchase === null ? (
                    <span className="text-term-faint">未知</span>
                  ) : row.verifiedPurchase ? (
                    <span className="text-term-pos">是</span>
                  ) : (
                    <span className="text-term-muted">否</span>
                  )}
                </TableCell>
                <TableCell className="align-top text-right font-mono text-[12px] tabular-nums text-term-muted">
                  {row.helpfulCount === null ? MISSING_VALUE : row.helpfulCount}
                </TableCell>
                <TableCell className="align-top">
                  <span
                    className={cn(
                      'font-mono text-[11px]',
                      visibilityInfo.tone === 'warn'
                        ? 'text-term-warn'
                        : visibilityInfo.tone === 'neg'
                          ? 'text-term-neg'
                          : 'text-term-pos'
                    )}
                  >
                    {visibilityInfo.label}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
          {rows.length === 0 ? (
            <EmptyState
              colSpan={6}
              message={
                loading
                  ? '加载中…'
                  : visibility === 'all'
                    ? '还没有抓到评论（等待采集端接入）'
                    : '该可见性筛选下没有评论'
              }
            />
          ) : null}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] text-term-faint">
          「疑似移除」= 连续 2 次完整抓取未出现，采集失败或列表不完整时不会改状态；再抓到会恢复「可见」。
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!canPrev} onClick={onPrevPage}>
            上一页
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!hasMore} onClick={onNextPage}>
            下一页
          </Button>
        </div>
      </div>
    </div>
  )
}
