'use client'

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from 'react'
import { forwardRef } from 'react'

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
  disabled = false,
  error,
  className,
}: WarmSelectProps) {
  const errorId = `${id}-error`

  return (
    <label
      className={['warm-ledger__select-wrap', className].filter(Boolean).join(' ')}
      data-invalid={error ? 'true' : undefined}
    >
      <span className="warm-ledger__control-label">{label}</span>
      <select
        id={id}
        className="warm-ledger__select"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span id={errorId} className="warm-ledger__select-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
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
