'use client'

type AdAnalysisContextItem = {
  label: string
  value: string
}

export function AdAnalysisContextBanner({ items }: { items: AdAnalysisContextItem[] }) {
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-none border border-term-border bg-term-panel px-2 py-1.5 font-mono text-xs text-term-muted">
      {items.map((item) => (
        <span key={`${item.label}-${item.value}`} className="flex items-center gap-1">
          <span className="text-term-faint">{item.label}:</span>
          <span className="font-medium text-term-text">{item.value}</span>
        </span>
      ))}
    </div>
  )
}
