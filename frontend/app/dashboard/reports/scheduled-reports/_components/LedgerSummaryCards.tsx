import { TermKpiTile } from '@/components/terminal/term-controls'
import type { LedgerSummary } from './types'

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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
      {cards.map((card) => (
        <TermKpiTile key={card.label} label={card.label} value={card.value} tone={card.tone} loading={loading} />
      ))}
    </div>
  )
}
