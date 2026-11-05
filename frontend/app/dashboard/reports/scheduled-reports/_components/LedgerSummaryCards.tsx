import type { LedgerSummary } from './types'
import styles from '../scheduled-reports-warm.module.css'

interface Props {
  summary: LedgerSummary | null
  loading?: boolean
}

export function LedgerSummaryCards({ summary, loading }: Props) {
  if (!summary) return null

  const cards: Array<{ label: string; value: string; tone?: 'pos' | 'neg' | 'warn' | 'accent' | 'info' | 'muted' }> = [
    { label: '应发', value: String(summary.expected) },
    { label: '成功', value: String(summary.sent), tone: 'pos' },
    { label: '失败', value: String(summary.failed), tone: 'neg' },
    { label: '缺失', value: String(summary.missing), tone: 'warn' },
    { label: '可补发', value: String(summary.resendable), tone: 'accent' },
  ]

  return (
    <div className={styles.summaryGrid} aria-busy={loading || undefined}>
      {cards.map((card) => (
        <div key={card.label} className={styles.summaryCard} data-tone={card.tone}>
          <span className={styles.summaryLabel}>{card.label}</span>
          <span className={styles.summaryValue}>{loading ? '—' : card.value}</span>
        </div>
      ))}
    </div>
  )
}
