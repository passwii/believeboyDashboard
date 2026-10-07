'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type AhrSeverity = 'normal' | 'warning' | 'critical'

type AhrRatingPresentation = {
  label: string
  severity: AhrSeverity
  background: string
  text: string
  border: string
}

const AHR_RATINGS: Record<string, AhrRatingPresentation> = {
  healthy: {
    label: '健康',
    severity: 'normal',
    background: 'bg-emerald-50 dark:bg-emerald-950/40',
    text: 'text-emerald-700 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
  good: {
    label: '良好',
    severity: 'normal',
    background: 'bg-blue-50 dark:bg-blue-950/40',
    text: 'text-blue-700 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
  },
  'at risk': {
    label: '预警',
    severity: 'warning',
    background: 'bg-term-warn/[0.07]',
    text: 'text-term-warn',
    border: 'border-term-warn/30',
  },
  critical: {
    label: '危险',
    severity: 'critical',
    background: 'bg-term-neg/[0.07]',
    text: 'text-term-neg',
    border: 'border-term-neg/30',
  },
}

const UNKNOWN_RATING: Omit<AhrRatingPresentation, 'label'> = {
  severity: 'normal',
  background: 'bg-term-raised',
  text: 'text-term-muted',
  border: 'border-term-border',
}

/** Resolve the backend's AHR enum without treating unknown values as a known status. */
export function getAhrRatingPresentation(
  rating: string | null | undefined
): AhrRatingPresentation {
  const knownRating = rating?.trim().toLowerCase()
  if (knownRating && AHR_RATINGS[knownRating]) return AHR_RATINGS[knownRating]

  return { ...UNKNOWN_RATING, label: rating ?? '' }
}

export function AhrRatingBadge({
  rating,
  showCode = false,
  compact = false,
  className,
}: {
  rating: string | null | undefined
  showCode?: boolean
  compact?: boolean
  className?: string
}) {
  if (!rating?.trim()) return null

  const presentation = getAhrRatingPresentation(rating)
  const content: ReactNode = (
    <>
      {showCode && <span className="text-xs font-medium text-muted-foreground">AHR</span>}
      <span className={cn('font-semibold', compact ? 'text-xs' : 'text-sm', presentation.text)}>
        {presentation.label}
      </span>
    </>
  )

  return (
    <span
      aria-label={`AHR ${presentation.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border',
        compact ? 'px-2 py-0.5' : 'px-2.5 py-1',
        presentation.background,
        presentation.border,
        className
      )}
      title={rating}
    >
      {content}
    </span>
  )
}
