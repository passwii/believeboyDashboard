'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import styles from '../platform-inspection-warm.module.css'

type AhrSeverity = 'normal' | 'warning' | 'critical'

type AhrRatingPresentation = {
  label: string
  severity: AhrSeverity
  ratingKey: string
}

const AHR_RATINGS: Record<string, AhrRatingPresentation> = {
  healthy: {
    label: '健康',
    severity: 'normal',
    ratingKey: 'healthy',
  },
  good: {
    label: '良好',
    severity: 'normal',
    ratingKey: 'good',
  },
  'at risk': {
    label: '预警',
    severity: 'warning',
    ratingKey: 'at-risk',
  },
  critical: {
    label: '危险',
    severity: 'critical',
    ratingKey: 'critical',
  },
}

const UNKNOWN_RATING: Omit<AhrRatingPresentation, 'label'> = {
  severity: 'normal',
  ratingKey: 'unknown',
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
      {showCode && <span className={styles.ahrCode}>AHR</span>}
      <span className={styles.ahrLabel}>{presentation.label}</span>
    </>
  )

  return (
    <span
      aria-label={`AHR ${presentation.label}`}
      data-rating={presentation.ratingKey}
      data-tone={presentation.severity}
      className={cn(
        styles.ahrBadge,
        compact ? styles.ahrBadgeCompact : styles.ahrBadgeRegular,
        className
      )}
      title={rating}
    >
      {content}
    </span>
  )
}
