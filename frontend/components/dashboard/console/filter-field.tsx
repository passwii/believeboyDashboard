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

// BLF-893：与 console 触发器对齐 term 规格——label 改 mono + tracking-wider + term-muted。
const LABEL_STYLES: Record<LabelStyle, string> = {
  default: 'font-mono text-[11px] uppercase tracking-wider text-term-muted',
  sm: 'font-mono text-xs leading-5 text-term-text',
  lg: 'font-mono text-[11px] uppercase tracking-wider text-term-muted',
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
