'use client'

import { cn } from '@/lib/utils'

type LabelStyle = 'default' | 'sm' | 'lg'

interface FilterFieldProps {
  label: string
  children: React.ReactNode
  className?: string
  labelClassName?: string
  labelStyle?: LabelStyle
}

const LABEL_STYLES: Record<LabelStyle, string> = {
  default: 'text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground',
  sm: 'text-sm font-medium text-foreground',
  lg: 'text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground',
}

export function FilterField({
  label,
  children,
  className,
  labelClassName,
  labelStyle = 'default',
}: FilterFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className={cn(LABEL_STYLES[labelStyle], labelClassName)}>{label}</div>
      {children}
    </div>
  )
}

FilterField.displayName = 'FilterField'
