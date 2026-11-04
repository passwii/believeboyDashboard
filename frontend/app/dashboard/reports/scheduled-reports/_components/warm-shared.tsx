import type * as React from 'react'

import styles from '../scheduled-reports-warm.module.css'

const STATUS_TONE: Record<string, 'positive' | 'negative' | 'accent'> = {
  sent: 'positive',
  failed: 'negative',
  missing: 'accent',
}

export function WarmStatusPill({
  status,
  label,
  className,
  title,
}: {
  status: string
  label?: React.ReactNode
  className?: string
  title?: string
}) {
  const tone = STATUS_TONE[status] ?? 'accent'
  const icon = status === 'sent' ? '✓' : status === 'failed' ? '✗' : '⚠'

  return (
    <span
      title={title}
      data-tone={tone}
      className={[styles.statusPill, className].filter(Boolean).join(' ')}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </span>
  )
}

export function WarmFrequencyTag({
  frequency,
  labels,
  className,
}: {
  frequency: string
  labels: Record<string, string>
  className?: string
}) {
  return (
    <span
      data-frequency={frequency}
      className={[styles.frequencyTag, className].filter(Boolean).join(' ')}
    >
      {labels[frequency] ?? frequency}
    </span>
  )
}
