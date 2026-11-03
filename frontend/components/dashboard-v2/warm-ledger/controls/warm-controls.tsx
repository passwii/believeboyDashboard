'use client'

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from 'react'
import { forwardRef, useEffect, useState } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'

export type WarmSelectOption = {
  value: string
  label: string
}

type WarmButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean
  loadingLabel?: string
  variant?: 'primary' | 'secondary' | 'quiet'
}

export const WarmButton = forwardRef<HTMLButtonElement, WarmButtonProps>(function WarmButton(
  {
    children,
    className,
    disabled,
    loading = false,
    loadingLabel,
    variant = 'secondary',
    'aria-label': ariaLabel,
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? 'button'}
      className={['warm-ledger__button', `warm-ledger__button--${variant}`, className]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={loading && loadingLabel ? loadingLabel : ariaLabel}
    >
      {loading ? <span className="warm-ledger__loading-mark" aria-hidden="true" /> : null}
      {children}
      {loading && loadingLabel ? (
        <span className="warm-ledger__visually-hidden" role="status">
          {loadingLabel}
        </span>
      ) : null}
    </button>
  )
})

type WarmIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  'aria-label': string
  loading?: boolean
  loadingLabel?: string
}

export const WarmIconButton = forwardRef<HTMLButtonElement, WarmIconButtonProps>(
  function WarmIconButton(
    {
      children,
      className,
      disabled,
      loading = false,
      loadingLabel,
      'aria-label': ariaLabel,
      ...props
    },
    ref
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={props.type ?? 'button'}
        className={['warm-ledger__icon-button', className].filter(Boolean).join(' ')}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-label={loading && loadingLabel ? loadingLabel : ariaLabel}
      >
        {loading ? <span className="warm-ledger__loading-mark" aria-hidden="true" /> : null}
        {children}
        {loading && loadingLabel ? (
          <span className="warm-ledger__visually-hidden" role="status">
            {loadingLabel}
          </span>
        ) : null}
      </button>
    )
  }
)

type WarmSegmentedControlProps<T extends string> = {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}

export function WarmSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: WarmSegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={['warm-ledger__segmented', className].filter(Boolean).join(' ')}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="warm-ledger__segment"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

type WarmSelectProps = {
  id: string
  label: string
  value: string
  options: ReadonlyArray<WarmSelectOption>
  onChange: (value: string) => void
  onOpenChange?: (open: boolean) => void
  placeholder?: string
  disabled?: boolean
  error?: string | null
  className?: string
}

export function WarmSelect({
  id,
  label,
  value,
  options,
  onChange,
  onOpenChange,
  placeholder,
  disabled = false,
  error,
  className,
}: WarmSelectProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const labelId = `${id}-label`
  const errorId = `${id}-error`

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  return (
    <div
      className={['warm-ledger__select-wrap', className].filter(Boolean).join(' ')}
      data-invalid={error ? 'true' : undefined}
    >
      <span id={labelId} className="warm-ledger__control-label">
        {label}
      </span>
      <SelectPrimitive.Root
        value={value}
        onValueChange={onChange}
        onOpenChange={onOpenChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          id={id}
          className="warm-ledger__select"
          aria-labelledby={labelId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon asChild>
            <ChevronDown className="warm-ledger__select-chevron" aria-hidden="true" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={portalContainer}>
          <SelectPrimitive.Content
            className="warm-ledger__select-content"
            position="popper"
            align="start"
            sideOffset={4}
            collisionPadding={8}
          >
            <SelectPrimitive.ScrollUpButton className="warm-ledger__select-scroll-button">
              <ChevronUp aria-hidden="true" />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="warm-ledger__select-viewport">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  className="warm-ledger__select-item"
                  value={option.value}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="warm-ledger__select-item-indicator">
                    <Check aria-hidden="true" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="warm-ledger__select-scroll-button">
              <ChevronDown aria-hidden="true" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {error ? (
        <span id={errorId} className="warm-ledger__select-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

export type WarmBadgeTone = 'neutral' | 'accent' | 'positive' | 'negative'

type WarmBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  tone?: WarmBadgeTone
  children: ReactNode
}

export function WarmBadge({ tone = 'neutral', children, className, ...props }: WarmBadgeProps) {
  return (
    <span
      {...props}
      data-tone={tone}
      className={['warm-ledger__badge', `warm-ledger__badge--${tone}`, className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}
