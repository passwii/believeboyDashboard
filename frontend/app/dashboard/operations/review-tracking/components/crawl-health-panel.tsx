'use client'

import { type CrawlRunRow, MISSING_VALUE } from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'
import styles from '../review-tracking-warm.module.css'

const TONE_CLASS = {
  pos: styles.tonePositive,
  warn: styles.toneAccent,
  neg: styles.toneNegative,
  muted: styles.toneMuted,
} as const

function formatTimestamp(value: string | null): string {
  if (!value) return MISSING_VALUE
  return value.replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, '').slice(0, 19)
}

export function CrawlHealthPanel({ runs }: { runs: CrawlRunRow[] }) {
  return (
    <div data-testid="crawl-health-panel">
      <div className={styles.tableScroll} data-warm-table-scroll="true">
        <table className={styles.table}>
          <thead>
            <tr>
              <th>开始时间</th>
              <th>状态</th>
              <th>完整列表</th>
              <th className={styles.numeric}>评论数</th>
              <th>评分为</th>
              <th>抓取 ASIN</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td className={styles.tableMeta}>{formatTimestamp(run.startedAt)}</td>
                <td>
                  <span
                    className={cn(styles.statusText, TONE_CLASS[run.statusTone])}
                  >
                    {run.statusLabel}
                  </span>
                </td>
                <td>
                  {run.isCompleteList ? (
                    <span className={styles.tonePositive}>完整</span>
                  ) : (
                    <span className={styles.toneAccent}>不完整</span>
                  )}
                </td>
                <td className={cn(styles.numeric, styles.tableMeta)}>
                  {run.reviewsSeen === null ? MISSING_VALUE : run.reviewsSeen}
                </td>
                <td>
                  {run.ratingsCaptured ? (
                    <span className={styles.tonePositive}>已取到</span>
                  ) : (
                    <span className={styles.toneNegative}>未取到</span>
                  )}
                </td>
                <td className={styles.tableMeta}>{run.asinScraped || MISSING_VALUE}</td>
                <td className={styles.toneNegative}>
                  {run.errorMessage || MISSING_VALUE}
                </td>
              </tr>
            ))}
            {runs.length === 0 ? (
              <tr>
                <td colSpan={7} className={styles.emptyPanel}>
                  还没有采集运行记录（等待采集端接入）
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className={styles.healthFootnote}>
        <span className={styles.footnote}>
          只有「完整列表」的成功运行才参与「连续 2 次未出现 → 疑似移除」判定；失败或不完整运行不改变评论状态。
          同一天可以有多条运行记录，但快照只有一条。
        </span>
      </div>
    </div>
  )
}
