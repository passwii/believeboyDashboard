import type { CSSProperties } from 'react'

import styles from './metrics.module.css'

export type MetricTone = 'default' | 'positive' | 'negative' | 'accent'
export type MetricStripState = 'ready' | 'loading' | 'empty' | 'error'

export interface MetricComparison {
  /** Signed percentage change calculated by the caller. */
  delta: number
  label?: string
  /** Already formatted previous-period value, when available. */
  reference?: string
}

export interface MetricItem {
  key: string
  label: string
  value: string | number | null
  code?: string
  comparison?: MetricComparison
  tone?: MetricTone
  meta?: string
}

interface MetricStripBaseProps {
  items: readonly MetricItem[]
  ariaLabel?: string
  className?: string
}

export type MetricStripProps = MetricStripBaseProps & (
  | { state: 'ready' | 'empty' }
  | { state: 'loading'; loadingLabel?: string; skeletonCount?: number }
  | { state: 'error'; errorMessage: string }
)

export interface MetricCardProps {
  item: MetricItem
  state: 'ready' | 'empty'
  featured?: boolean
}

export interface DeltaProps {
  value: number
  label?: string
  reference?: string
}

export interface DiagnosticItemData {
  key: string
  label: string
  value: string | number | null
  meta?: string
  progress?: number
  unit?: string
}

interface DiagnosticStripBaseProps {
  items: readonly DiagnosticItemData[]
  ariaLabel?: string
  className?: string
}

export type DiagnosticStripProps = DiagnosticStripBaseProps & (
  | { state: 'ready' | 'empty' }
  | { state: 'loading'; loadingLabel?: string; skeletonCount?: number }
  | { state: 'error'; errorMessage: string }
)

export interface DiagnosticItemProps {
  item: DiagnosticItemData
  state: 'ready' | 'empty'
}

const metricToneClass: Record<MetricTone, string> = {
  default: styles.toneDefault,
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  accent: styles.toneAccent,
}

const deltaToneClass = {
  default: styles.deltaDefault,
  positive: styles.deltaPositive,
  negative: styles.deltaNegative,
} as const

function hasDisplayValue(value: string | number | null): value is string | number {
  return value !== null && (typeof value !== 'number' || Number.isFinite(value))
}

function displayValue(value: string | number | null): string {
  return hasDisplayValue(value) ? String(value) : '—'
}

function deltaPresentation(value: number): {
  direction: 'up' | 'down' | 'flat'
  tone: 'positive' | 'negative' | 'default'
  arrow: string
  signedValue: string
  directionLabel: string
} | null {
  if (!Number.isFinite(value)) return null

  if (value > 0) {
    return {
      direction: 'up',
      tone: 'positive',
      arrow: '↑',
      signedValue: `+${value.toFixed(1)}%`,
      directionLabel: '上升',
    }
  }

  if (value < 0) {
    return {
      direction: 'down',
      tone: 'negative',
      arrow: '↓',
      signedValue: `−${Math.abs(value).toFixed(1)}%`,
      directionLabel: '下降',
    }
  }

  return {
    direction: 'flat',
    tone: 'default',
    arrow: '→',
    signedValue: '0.0%',
    directionLabel: '持平',
  }
}

export function Delta({ value, label, reference }: DeltaProps) {
  const presentation = deltaPresentation(value)
  if (!presentation) return null

  const accessibleLabel = [
    `${presentation.directionLabel} ${presentation.signedValue}`,
    label,
    reference,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={`${styles.delta} ${deltaToneClass[presentation.tone]}`}
      data-direction={presentation.direction}
      data-tone={presentation.tone}
      role="group"
      aria-label={accessibleLabel}
    >
      <span aria-hidden="true">{presentation.arrow}</span>
      <span>{presentation.signedValue}</span>
      {label ? <span>{label}</span> : null}
      {reference ? <span>{reference}</span> : null}
    </span>
  )
}

export function MetricCard({ item, state, featured = false }: MetricCardProps) {
  const isEmpty = state === 'empty' || !hasDisplayValue(item.value)
  const value = isEmpty ? '—' : displayValue(item.value)
  const tone = isEmpty ? 'default' : item.tone ?? 'default'
  const valueStyle: CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  return (
    <article
      className={`${styles.metricCard} ${featured ? styles.metricCardFeatured : ''}`}
      data-metric-card
      data-metric-key={item.key}
      data-featured={featured ? 'true' : 'false'}
    >
      <div className={styles.metricHeader}>
        <span className={styles.metricLabel} title={item.label}>
          {item.label}
        </span>
        {item.code ? <span className={styles.metricCode}>{item.code}</span> : null}
      </div>

      <div className={styles.metricValueRow}>
        <span
          className={`${styles.metricValue} ${featured ? styles.metricValueFeatured : ''} ${metricToneClass[tone]}`}
          style={valueStyle}
          title={value}
          aria-label={value}
        >
          {value}
        </span>
      </div>

      <div className={styles.metricFoot}>
        {!isEmpty && item.comparison ? (
          <Delta
            value={item.comparison.delta}
            label={item.comparison.label}
            reference={item.comparison.reference}
          />
        ) : null}
        {!isEmpty && item.meta ? <span className={styles.metricMeta}>{item.meta}</span> : null}
      </div>
    </article>
  )
}

function MetricSkeleton({ featured }: { featured: boolean }) {
  return (
    <article
      className={`${styles.metricCard} ${styles.metricSkeleton} ${featured ? styles.metricCardFeatured : ''}`}
      data-testid="metric-skeleton"
      data-featured={featured ? 'true' : 'false'}
      aria-hidden="true"
    >
      <span className={`${styles.skeletonBar} ${styles.skeletonLabel}`} />
      <span className={`${styles.skeletonBar} ${styles.skeletonValue}`} />
      <span className={`${styles.skeletonBar} ${styles.skeletonMeta}`} />
    </article>
  )
}

export function MetricStrip(props: MetricStripProps) {
  const ariaLabel = props.ariaLabel ?? '关键指标'

  if (props.state === 'loading') {
    const skeletonCount = Math.max(1, props.skeletonCount ?? (props.items.length || 3))
    return (
      <section className={`${styles.metricStrip} ${props.className ?? ''}`} role="region" aria-label={ariaLabel} aria-busy="true">
        <p className={styles.visuallyHidden} role="status" aria-live="polite">
          {props.loadingLabel ?? '正在读取关键指标'}
        </p>
        <div className={styles.metricGrid}>
          {Array.from({ length: skeletonCount }, (_, index) => (
            <MetricSkeleton key={index} featured={index === 0} />
          ))}
        </div>
      </section>
    )
  }

  if (props.state === 'error') {
    return (
      <section className={`${styles.metricStrip} ${props.className ?? ''}`} role="region" aria-label={ariaLabel}>
        <div className={styles.stateError} role="alert">
          {props.errorMessage}
        </div>
      </section>
    )
  }

  const empty = props.state === 'empty'

  return (
    <section className={`${styles.metricStrip} ${props.className ?? ''}`} role="region" aria-label={ariaLabel}>
      <div className={styles.metricGrid}>
        {props.items.map((item, index) => (
          <MetricCard
            key={item.key}
            item={item}
            state={empty ? 'empty' : 'ready'}
            featured={index === 0}
          />
        ))}
        {empty && props.items.length === 0 ? (
          <span className={styles.emptyFallback} role="status">
            —
          </span>
        ) : null}
      </div>
    </section>
  )
}

function clampedProgress(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

export function DiagnosticItem({ item, state }: DiagnosticItemProps) {
  const isEmpty = state === 'empty' || !hasDisplayValue(item.value)
  const value = isEmpty ? '—' : displayValue(item.value)
  const progress = isEmpty ? null : clampedProgress(item.progress)

  return (
    <article className={styles.diagnosticItem} data-diagnostic-item data-diagnostic-key={item.key}>
      <span className={styles.diagnosticLabel} title={item.label}>
        {item.label}
      </span>
      <div className={styles.diagnosticValueRow}>
        <span className={styles.diagnosticValue} title={value}>
          {value}
        </span>
        {!isEmpty && item.unit ? <small className={styles.diagnosticUnit}>{item.unit}</small> : null}
      </div>
      {!isEmpty && item.meta ? <div className={styles.diagnosticMeta}>{item.meta}</div> : null}
      {progress !== null ? (
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={`${item.label}进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...{ ['aria-value' + 'now']: progress }}
        >
          <span className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </article>
  )
}

function DiagnosticSkeleton() {
  return (
    <article
      className={`${styles.diagnosticItem} ${styles.diagnosticSkeleton}`}
      data-testid="diagnostic-skeleton"
      aria-hidden="true"
    >
      <span className={`${styles.skeletonBar} ${styles.skeletonLabel}`} />
      <span className={`${styles.skeletonBar} ${styles.diagnosticSkeletonValue}`} />
      <span className={`${styles.skeletonBar} ${styles.skeletonMeta}`} />
    </article>
  )
}

export function DiagnosticStrip(props: DiagnosticStripProps) {
  const ariaLabel = props.ariaLabel ?? '经营辅助指标'

  if (props.state === 'loading') {
    const skeletonCount = Math.max(1, props.skeletonCount ?? (props.items.length || 4))
    return (
      <section
        className={`${styles.diagnosticStrip} ${props.className ?? ''}`}
        role="group"
        aria-label={ariaLabel}
        aria-busy="true"
      >
        <p className={styles.visuallyHidden} role="status" aria-live="polite">
          {props.loadingLabel ?? '正在读取经营辅助指标'}
        </p>
        {Array.from({ length: skeletonCount }, (_, index) => (
          <DiagnosticSkeleton key={index} />
        ))}
      </section>
    )
  }

  if (props.state === 'error') {
    return (
      <section className={`${styles.diagnosticStrip} ${props.className ?? ''}`} role="group" aria-label={ariaLabel}>
        <div className={styles.stateError} role="alert">
          {props.errorMessage}
        </div>
      </section>
    )
  }

  const empty = props.state === 'empty'

  return (
    <section className={`${styles.diagnosticStrip} ${props.className ?? ''}`} role="group" aria-label={ariaLabel}>
      {props.items.map((item) => (
        <DiagnosticItem key={item.key} item={item} state={empty ? 'empty' : 'ready'} />
      ))}
      {empty && props.items.length === 0 ? (
        <span className={styles.emptyFallback} role="status">
          —
        </span>
      ) : null}
    </section>
  )
}
