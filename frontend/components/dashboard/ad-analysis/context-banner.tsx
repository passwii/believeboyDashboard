'use client'

type AdAnalysisContextItem = {
  label: string
  value: string
}

export function AdAnalysisContextBanner({ items }: { items: AdAnalysisContextItem[] }) {
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-[var(--warm-ledger-radius-inner)] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-2 py-1.5 font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
      {items.map((item) => (
        <span key={`${item.label}-${item.value}`} className="flex items-center gap-1">
          <span className="text-[var(--warm-ledger-color-text-faint)]">{item.label}:</span>
          <span className="font-medium text-[var(--warm-ledger-color-text)]">{item.value}</span>
        </span>
      ))}
    </div>
  )
}
