'use client'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface QuickButtonConfig {
  label: string
  adjust: number
  unit: 'day' | 'month'
  variant?: 'default' | 'outline' | 'ghost'
}

export const QUICK_DATE_BUTTONS: QuickButtonConfig[] = [
  { label: '昨天', adjust: -1, unit: 'day' },
  { label: '上周', adjust: -7, unit: 'day' },
  { label: '上月', adjust: -1, unit: 'month' },
]

interface QuickButtonsProps {
  onSelect: (config: QuickButtonConfig) => void
  className?: string
  buttons?: QuickButtonConfig[]
  size?: 'default' | 'sm' | 'lg'
}

export function QuickButtons({
  onSelect,
  className,
  buttons = QUICK_DATE_BUTTONS,
  size = 'sm',
}: QuickButtonsProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {buttons.map((btn) => (
        <Button
          key={btn.label}
          type="button"
          variant={btn.variant || 'outline'}
          size={size}
          onClick={() => onSelect(btn)}
          className="h-8 text-xs"
        >
          {btn.label}
        </Button>
      ))}
    </div>
  )
}

interface QuickButtonsGroupProps {
  groups: Array<{ label?: string; buttons: QuickButtonConfig[] }>
  onSelect: (config: QuickButtonConfig) => void
  className?: string
}

export function QuickButtonsGroup({ groups, onSelect, className }: QuickButtonsGroupProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {groups.map((group, gi) => (
        <div key={gi} className="flex items-center gap-1">
          {group.label && (
            <span className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {group.label}
            </span>
          )}
          {group.buttons.map((btn) => (
            <Button
              key={btn.label}
              type="button"
              variant={btn.variant || 'outline'}
              size="sm"
              onClick={() => onSelect(btn)}
              className="h-8 text-xs"
            >
              {btn.label}
            </Button>
          ))}
        </div>
      ))}
    </div>
  )
}
