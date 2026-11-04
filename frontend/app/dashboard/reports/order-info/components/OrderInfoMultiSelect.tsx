'use client'

import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Command as CommandPrimitive } from 'cmdk'
import { Search, X } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'
import styles from '../order-info-warm.module.css'

export type Option = {
  value: string
  label: string
}

type OrderInfoMultiSelectProps = {
  options: Option[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
  className?: string
  onOpen?: () => void
}

export function OrderInfoMultiSelect({
  options,
  selected,
  onChange,
  placeholder = '请选择',
  className,
  onOpen,
}: OrderInfoMultiSelectProps) {
  const [open, setOpen] = React.useState(false)
  const contentId = React.useId()
  const [portalContainer] = React.useState<HTMLElement | null>(() =>
    typeof document === 'undefined'
      ? null
      : document.getElementById('warm-ledger-portal-root')
  )

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) onOpen?.()
  }

  const selectedOptions = options.filter((option) => selected.includes(option.value))

  function toggleValue(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((current) => current !== value)
        : [...selected, value]
    )
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <div
          role="combobox"
          tabIndex={0}
          aria-controls={contentId}
          aria-expanded={open}
          data-warm-order-multiselect="true"
          className={cn(styles.multiSelectTrigger, className)}
        >
          {selectedOptions.length > 0 ? (
            <span className={styles.multiSelectChips}>
              {selectedOptions.slice(0, 2).map((option) => (
                <span key={option.value} className={styles.multiSelectChip}>
                  {option.label}
                  <button
                    type="button"
                    className={styles.multiSelectChipRemove}
                    aria-label={`移除 ${option.label}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleValue(option.value)
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              ))}
              {selectedOptions.length > 2 && (
                <span className={styles.multiSelectChip}>+{selectedOptions.length - 2}</span>
              )}
            </span>
          ) : (
            <span className={styles.multiSelectPlaceholder}>{placeholder}</span>
          )}
        </div>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          id={contentId}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn('warm-ledger', styles.multiSelectContent)}
        >
          <CommandPrimitive className={styles.multiSelectCommand}>
            <div className={styles.multiSelectSearch}>
              <Search aria-hidden="true" />
              <CommandPrimitive.Input
                className={styles.multiSelectSearchInput}
                placeholder="搜索..."
              />
            </div>
            <CommandPrimitive.List className={styles.multiSelectList}>
              <CommandPrimitive.Empty className={styles.multiSelectEmpty}>
                没有找到
              </CommandPrimitive.Empty>
              {options.map((option) => {
                const isSelected = selected.includes(option.value)
                return (
                  <CommandPrimitive.Item
                    key={option.value}
                    value={option.value}
                    onSelect={() => toggleValue(option.value)}
                    className={styles.multiSelectItem}
                  >
                    <span
                      className={styles.multiSelectOptionCheck}
                      data-selected={isSelected ? 'true' : 'false'}
                      aria-hidden="true"
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                    {option.label}
                  </CommandPrimitive.Item>
                )
              })}
            </CommandPrimitive.List>
            {selected.length > 0 && (
              <div className={styles.multiSelectFooter}>
                <button
                  type="button"
                  className={styles.multiSelectClear}
                  onClick={() => {
                    onChange([])
                    setOpen(false)
                  }}
                >
                  清除全部
                </button>
              </div>
            )}
          </CommandPrimitive>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
