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
}

export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Select...',
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false)

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-9 min-w-[120px] justify-start gap-1 px-2 font-normal',
            selected.length === 0 && 'text-muted-foreground',
            className
          )}
        >
          {selected.length > 0 ? (
            <>
              <span className="flex flex-wrap gap-1">
                {selectedOptions.slice(0, 2).map((opt) => (
                  <Badge key={opt.value} variant="secondary" className="h-5 gap-1 px-1.5 text-xs">
                    {opt.label}
                    <span
                      role="button"
                      tabIndex={0}
                      className="ml-0.5 cursor-pointer rounded-sm outline-none hover:bg-accent"
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
                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
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
      <PopoverContent className="w-[200px] p-0" align="start">
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
                      'mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary text-xs',
                      selected.includes(option.value)
                        ? 'bg-primary text-primary-foreground'
                        : 'border-border bg-transparent text-transparent'
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
            <div className="border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs"
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
