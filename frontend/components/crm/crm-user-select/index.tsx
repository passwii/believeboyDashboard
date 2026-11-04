'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { User } from '@/lib/crm/types/user'
import styles from './crm-user-select-warm.module.css'

export interface CrmUserSelectProps {
  users: User[]
  value?: string | null
  onChange: (userId: string | null) => void
  placeholder?: string
  /** 是否允许清空（如"移入公海"场景） */
  allowClear?: boolean
  disabled?: boolean
  className?: string
  visual?: 'terminal' | 'warm'
}

/** 选人（搜索 + 头像）。转移客户 / 指派负责人复用。 */
export function CrmUserSelect({
  users,
  value,
  onChange,
  placeholder = '选择负责人',
  allowClear = false,
  disabled,
  className,
  visual = 'terminal',
}: CrmUserSelectProps) {
  const [open, setOpen] = useState(false)
  const selected = users.find((u) => u.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between', className)}
        >
          {selected ? (
            <span className="flex items-center gap-2">
              <Avatar className="h-5 w-5">
                {selected.avatarUrl && <AvatarImage src={selected.avatarUrl} />}
                <AvatarFallback className="text-[10px]">
                  {selected.name.slice(0, 1)}
                </AvatarFallback>
              </Avatar>
              {selected.name}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('w-[--radix-popover-trigger-width] p-0', visual === 'warm' && styles.content)}
        align="start"
      >
        <Command>
          <CommandInput placeholder="搜索姓名…" />
          <CommandList>
            <CommandEmpty>未找到用户</CommandEmpty>
            <CommandGroup>
              {allowClear && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                >
                  <span className="text-muted-foreground">（清空 / 移入公海）</span>
                </CommandItem>
              )}
              {users.map((u) => (
                <CommandItem
                  key={u.id}
                  value={u.name}
                  onSelect={() => {
                    onChange(u.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn('mr-2 h-4 w-4', value === u.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <Avatar className="mr-2 h-5 w-5">
                    {u.avatarUrl && <AvatarImage src={u.avatarUrl} />}
                    <AvatarFallback className="text-[10px]">{u.name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  {u.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
