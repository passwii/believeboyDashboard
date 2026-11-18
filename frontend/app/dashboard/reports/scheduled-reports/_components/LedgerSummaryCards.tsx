import type { LedgerSummary } from './types'
import styles from './ledger-warm.module.css'

interface Props {
  summary: LedgerSummary | null
  loading?: boolean
}

/**
 * 台账汇总条：只呈现后端返回的 summary，不在前端自行计算或补零。
 * `sent` 语义是「报告已完成」（含仅生成、未发送邮件的条目），
 * 因此展示为「已完成」而不是「已发送」。
 */
export function LedgerSummaryCards({ summary, loading }: Props) {
  if (!summary && !loading) return null

  const items: Array<{
    label: string
    value: number | null
    tone?: 'negative' | 'accent'
  }> = [
    { label: '应发', value: summary?.expected ?? null },
    { label: '已完成', value: summary?.sent ?? null },
    { label: '失败', value: summary?.failed ?? null, tone: 'negative' },
    { label: '缺失', value: summary?.missing ?? null, tone: 'accent' },
    { label: '可重新生成', value: summary?.resendable ?? null },
  ]

  return (
    <div className={styles.summary} aria-label="当前筛选汇总" aria-busy={loading || undefined}>
      {items.map((item) => (
        <div key={item.label} className={styles.summaryItem}>
          <span className={styles.summaryLabel}>{item.label}</span>
          <span className={styles.summaryValue} data-tone={item.tone}>
            {loading ? '—' : item.value ?? '—'}
          </span>
        </div>
      ))}
      <span className={styles.summaryPush} />
      <span
        className={styles.summaryFoot}
        title="sent 状态包含「仅生成、未发送邮件」的条目"
      >
        已完成含「仅生成」
      </span>
    </div>
  )
}
