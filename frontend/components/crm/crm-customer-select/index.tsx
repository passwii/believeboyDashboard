'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Customer } from '@/lib/crm/types'

export interface CrmCustomerSelectProps {
  customers: Customer[]
  value?: string | null
  onChange: (customerId: string | null) => void
  placeholder?: string
  allowClear?: boolean
  disabled?: boolean
}

/** 选客户（搜索 + 名称）。商机关联客户复用。 */
export function CrmCustomerSelect({
  customers,
  value,
  onChange,
  placeholder = '选择客户',
  allowClear = false,
  disabled,
}: CrmCustomerSelectProps) {
  const [open, setOpen] = useState(false)
  const selected = customers.find((c) => c.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
        >
          {selected ? selected.name : <span className="text-muted-foreground">{placeholder}</span>}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索客户名…" />
          <CommandList>
            <CommandEmpty>未找到客户</CommandEmpty>
            <CommandGroup>
              {allowClear && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                >
                  <span className="text-muted-foreground">（清空）</span>
                </CommandItem>
              )}
              {customers.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  onSelect={() => {
                    onChange(c.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn('mr-2 h-4 w-4', value === c.id ? 'opacity-100' : 'opacity-0')}
                  />
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
