'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { cn } from '@/lib/utils'

interface CountrySelectProps {
  value: string
  onChange: (value: string) => void
  options?: readonly { value: string; label: string }[]
  placeholder?: string
  className?: string
  triggerClassName?: string
}

export function CountrySelect({
  value,
  onChange,
  options = COUNTRY_OPTIONS,
  placeholder = '请选择国家站点',
  className,
  triggerClassName,
}: CountrySelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={cn(
          'h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]',
          triggerClassName,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}