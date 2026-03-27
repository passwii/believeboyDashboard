'use client'

type AdAnalysisContextItem = {
  label: string
  value: string
}

export function AdAnalysisContextBanner({ items }: { items: AdAnalysisContextItem[] }) {
  if (items.length === 0) return null

  return (
    <div className='rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] px-4 py-3 text-sm text-muted-foreground'>
      {items.map((item, index) => (
        <span key={`${item.label}-${item.value}`}>
          {index > 0 ? <span className='mr-3' /> : null}
          {item.label}：<span className='font-medium text-foreground'>{item.value}</span>
        </span>
      ))}
    </div>
  )
}
