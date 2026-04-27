'use client'

import { cn } from '@/lib/utils'

interface FilterFieldProps {
  label: string
  children: React.ReactNode
  className?: string
}

export function FilterField({ label, children, className }: FilterFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}