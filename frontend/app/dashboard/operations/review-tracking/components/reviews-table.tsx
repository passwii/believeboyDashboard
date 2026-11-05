'use client'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  type ReviewRow,
  type VisibilityStatus,
  MISSING_VALUE,
  visibilityLabel,
} from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'
import styles from '../review-tracking-warm.module.css'

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
  return rating === null
    ? MISSING_VALUE
    : `${'★'.repeat(rating)}${'☆'.repeat(Math.max(0, 5 - rating))}`
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
    <div>
      <div className={styles.filterBar}>
        <div className={styles.segmented} role="group" aria-label="评论可见性筛选">
          {VISIBILITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onVisibilityChange(option.value)}
              aria-pressed={visibility === option.value}
              className={styles.segment}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className={styles.pageMeta}>第 {page} 页</span>
      </div>

      <div className={styles.tableScroll} data-warm-table-scroll="true">
        <table className={styles.table}>
          <thead>
            <tr>
              <th>星级</th>
              <th>标题 / 正文</th>
              <th>评论日期</th>
              <th>Verified</th>
              <th className={styles.numeric}>Helpful</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const visibilityInfo = visibilityLabel(row.visibility)
              return (
                <tr key={row.reviewKey}>
                  <td className={cn(styles.toneAccent, styles.numeric)}>{starText(row.rating)}</td>
                  <td>
                    <div className={styles.reviewTitleRow}>
                      <span className={styles.tablePrimary}>
                        {row.title?.trim() || '（无标题）'}
                      </span>
                      {row.idConfidence === 'derived' ? (
                        <span
                          className={styles.statusBadge}
                          data-tone="accent"
                          title={row.idConfidenceHint}
                        >
                          {row.idConfidenceLabel}
                        </span>
                      ) : null}
                    </div>
                    <p className={styles.tableBody}>{row.body?.trim() || '（无正文）'}</p>
                    <p className={styles.tableMeta}>
                      评论者 {row.reviewerName || MISSING_VALUE} · 首次{' '}
                      {row.firstSeenAt.slice(0, 10)} · 最近 {row.lastSeenAt.slice(0, 10)}
                    </p>
                  </td>
                  <td className={styles.tableMeta}>{row.reviewDate ?? MISSING_VALUE}</td>
                  <td>
                    {row.verifiedPurchase === null ? (
                      <span className={styles.toneMuted}>未知</span>
                    ) : row.verifiedPurchase ? (
                      <span className={styles.tonePositive}>是</span>
                    ) : (
                      <span className={styles.toneMuted}>否</span>
                    )}
                  </td>
                  <td className={cn(styles.numeric, styles.tableMeta)}>
                    {row.helpfulCount === null ? MISSING_VALUE : row.helpfulCount}
                  </td>
                  <td>
                    <span
                      className={styles.statusText}
                      data-tone={
                        visibilityInfo.tone === 'warn'
                          ? 'warning'
                          : visibilityInfo.tone === 'neg'
                            ? 'negative'
                            : 'positive'
                      }
                    >
                      {visibilityInfo.label}
                    </span>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.emptyPanel}>
                  {loading
                    ? '加载中…'
                    : visibility === 'all'
                      ? '还没有抓到评论（等待采集端接入）'
                      : '该可见性筛选下没有评论'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className={styles.pagination}>
        <p className={styles.footnote}>
          「疑似移除」= 连续 2 次完整抓取未出现，采集失败或列表不完整时不会改状态；再抓到会恢复「可见」。
        </p>
        <div className={styles.paginationActions}>
          <WarmButton variant="secondary" disabled={!canPrev} onClick={onPrevPage}>
            上一页
          </WarmButton>
          <WarmButton variant="secondary" disabled={!hasMore} onClick={onNextPage}>
            下一页
          </WarmButton>
        </div>
      </div>
    </div>
  )
}
