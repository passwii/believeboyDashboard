'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

export type Option = {
  value: string
  label: string
}

interface MultiSelectProps {
  options: Option[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
  className?: string
  /** BEL-422：下拉首次打开时回调（供按需加载选项数据，避免首屏预拉） */
  onOpen?: () => void
}

export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Select...',
  className,
  onOpen,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) onOpen?.()
  }

  const selectedOptions = options.filter((opt) => selected.includes(opt.value))

  function toggleValue(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value))
    } else {
      onChange([...selected, value])
    }
  }

  function clearAll() {
    onChange([])
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-8 min-w-[120px] justify-start gap-1 rounded-none border border-term-border bg-term-bg px-2 font-mono text-sm leading-5 text-term-text shadow-none focus-visible:border-term-border-strong focus-visible:ring-0 focus-visible:ring-offset-0 u-focus-glow',
            selected.length === 0 && 'text-term-faint',
            'disabled:opacity-50 disabled:cursor-not-allowed aria-[invalid=true]:border-term-neg',
            className
          )}
        >
          {selected.length > 0 ? (
            <>
              <span className="flex flex-wrap gap-1">
                {selectedOptions.slice(0, 2).map((opt) => (
                  <Badge key={opt.value} variant="secondary" className="h-5 gap-1 rounded-none border border-term-border bg-term-raised px-1.5 font-mono text-xs text-term-text">
                    {opt.label}
                    <span
                      role="button"
                      tabIndex={0}
                      className="ml-0.5 cursor-pointer rounded-none outline-none hover:bg-term-hover"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleValue(opt.value)
                      }}
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </Badge>
                ))}
                {selected.length > 2 && (
                  <Badge variant="secondary" className="h-5 rounded-none border border-term-border bg-term-raised px-1.5 font-mono text-xs text-term-text">
                    +{selected.length - 2}
                  </Badge>
                )}
              </span>
            </>
          ) : (
            <span>{placeholder}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] rounded-none border border-term-border bg-term-panel p-0 text-term-text shadow-none" align="start">
        <Command>
          <CommandInput placeholder="搜索..." />
          <CommandList>
            <CommandEmpty>没有找到</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => toggleValue(option.value)}
                  className="cursor-pointer"
                >
                  <div
                    className={cn(
                      'mr-2 flex h-4 w-4 items-center justify-center rounded-none border text-xs',
                      selected.includes(option.value)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-term-border bg-term-bg text-transparent'
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {selected.includes(option.value) && '✓'}
                  </div>
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {selected.length > 0 && (
            <div className="border-t border-term-border p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 rounded-none font-mono text-xs"
                onClick={() => {
                  clearAll()
                  setOpen(false)
                }}
              >
                清除全部
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
