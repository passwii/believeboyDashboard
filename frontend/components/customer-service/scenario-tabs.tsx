'use client'
import type { ScenarioSummary } from '@/lib/server/ai-chat'

export function ScenarioTabs({
  scenarios,
  selectedId,
  onSelect,
}: {
  scenarios: ScenarioSummary[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {scenarios.map((s) => {
        const active = s.id === selectedId
        return (
          <button
            key={s.id}
            type="button"
            disabled={s.disabled}
            onClick={() => !s.disabled && onSelect(s.id)}
            className={[
              'rounded-full border px-4 py-1.5 text-sm transition-colors',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground',
              s.disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-primary/50',
            ].join(' ')}
            title={s.disabled ? '即将上线' : s.description}
          >
            {s.label}
            {s.disabled ? '（即将上线）' : ''}
          </button>
        )
      })}
    </div>
  )
}
