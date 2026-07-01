import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { LedgerSummary } from './types'

interface Props {
  summary: LedgerSummary | null
  loading?: boolean
}

export function LedgerSummaryCards({ summary, loading }: Props) {
  if (!summary) return null

  const cards = [
    { label: '应发', value: summary.expected, color: '' },
    { label: '成功', value: summary.sent, color: 'text-emerald-600 dark:text-emerald-400' },
    { label: '失败', value: summary.failed, color: 'text-destructive' },
    { label: '缺失', value: summary.missing, color: 'text-amber-600 dark:text-amber-400' },
    { label: '可补发', value: summary.resendable, color: 'text-blue-600 dark:text-blue-400' },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
      {cards.map(card => (
        <Card key={card.label} className="border-border/70 bg-[hsl(var(--surface-panel))]">
          <CardContent className="p-3 text-center">
            <div className="text-xs text-muted-foreground mb-1">{card.label}</div>
            <div className={cn('text-lg font-semibold tabular-nums', card.color)}>
              {loading ? '...' : card.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
