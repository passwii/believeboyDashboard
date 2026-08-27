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
    <div className="flex flex-wrap gap-1.5">
      {scenarios.map((s) => {
        const active = s.id === selectedId
        return (
          <button
            key={s.id}
            type="button"
            disabled={s.disabled}
            onClick={() => !s.disabled && onSelect(s.id)}
            className={[
              'rounded-none border px-3 py-1.5 font-mono text-xs leading-5 transition-colors',
              active
                ? 'border-term-border-strong bg-term-raised text-term-text'
                : 'border-term-border bg-term-bg text-term-muted',
              s.disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-term-border-strong hover:text-term-text',
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
