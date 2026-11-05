'use client'

import type * as React from 'react'
import { AlertCircle, Database } from 'lucide-react'

import { SkeletonReveal } from '@/components/ui/skeleton-reveal'
import { useInViewOnce } from '@/lib/hooks/use-in-view-once'
import { cn } from '@/lib/utils'
import styles from './warm-analysis.module.css'

export type WarmTone =
  | 'positive'
  | 'negative'
  | 'warning'
  | 'accent'
  | 'neutral'
  | 'pos'
  | 'neg'
  | 'warn'
  | 'info'
  | 'muted'

const toneClass: Record<WarmTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  accent: styles.toneAccent,
  neutral: styles.toneMuted,
  pos: styles.tonePositive,
  neg: styles.toneNegative,
  warn: styles.toneWarning,
  info: styles.toneNeutral,
  muted: styles.toneMuted,
}

export function WarmErrorBar({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className={styles.errorBar}>
      <AlertCircle aria-hidden="true" />
      <span title={message}>{message}</span>
    </div>
  )
}

export function WarmRefreshStatus({
  loading,
  error,
  hasData,
}: {
  loading: boolean
  error?: string | null
  hasData: boolean
}) {
  if (!loading && !error) return null

  return (
    <div className={styles.refreshStack}>
      {loading ? (
        <div role="status" aria-live="polite" className={styles.refreshBar}>
          <span className={styles.refreshMark} aria-hidden="true" />
          正在刷新广告分析数据…
        </div>
      ) : null}
      {error ? (
        <div role="alert" className={styles.errorBar}>
          <AlertCircle aria-hidden="true" />
          <span title={error}>
            {error}
            {hasData ? ' · 已保留上次成功结果' : ''}
          </span>
        </div>
      ) : null}
    </div>
  )
}

export function WarmMetricTile({
  label,
  value,
  changeRatio,
  helper,
}: {
  label: string
  value: string
  changeRatio?: number | null
  helper?: string | null
}) {
  const hasChange = typeof changeRatio === 'number' && Number.isFinite(changeRatio)
  const positive = hasChange && (changeRatio as number) >= 0
  return (
    <div className={styles.metricTile} title={helper || undefined}>
      <div className={styles.metricHead}>
        <span className={styles.metricLabel}>{label}</span>
        {hasChange ? (
          <span
            className={cn(
              styles.metricChange,
              positive ? styles.tonePositive : styles.toneNegative
            )}
          >
            {positive ? '▲' : '▼'}
            {Math.abs(changeRatio as number).toFixed(2)}%
          </span>
        ) : (
          <span className={styles.metricNoChange}>—</span>
        )}
      </div>
      <div className={styles.metricValue} title={value}>
        {value}
      </div>
    </div>
  )
}

export function WarmGridHeader({
  title,
  meta,
  actions,
}: {
  title: string
  meta?: string
  actions?: React.ReactNode
}) {
  return (
    <header className={styles.panelHeader}>
      <h2>{title}</h2>
      {meta ? <span className={styles.panelMeta}>{meta}</span> : null}
      {actions ? <div className={styles.panelActions}>{actions}</div> : null}
    </header>
  )
}

export function WarmPanel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(styles.panel, className)}
      aria-label={title}
      data-warm-surface="true"
    >
      {title || actions ? (
        <header className={styles.panelHeader}>
          {title ? <h2>{title}</h2> : null}
          {actions ? <div className={styles.panelActions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(styles.panelBody, bodyClassName)}>{children}</div>
    </section>
  )
}

export function WarmPill({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: WarmTone
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(styles.pill, toneClass[tone], className)}
    >
      {children}
    </span>
  )
}

export function WarmNumber({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span title={title} className={cn(styles.numericText, className)}>
      {children}
    </span>
  )
}

export function WarmSkeleton({
  className,
}: {
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(styles.skeleton, className)}
      data-warm-skeleton="true"
    />
  )
}

export function WarmDeferredSection({
  children,
  fallbackHeight = 'h-40',
  className,
  'data-testid': testId,
}: {
  children: React.ReactNode
  fallbackHeight?: string
  className?: string
  'data-testid'?: string
}) {
  const { ref, inView } = useInViewOnce<HTMLDivElement>({ rootMargin: '320px' })

  return (
    <div ref={ref} className={className} data-testid={testId}>
      <SkeletonReveal
        loading={!inView}
        skeleton={<WarmSkeleton className={cn('w-full', fallbackHeight)} />}
      >
        {inView ? children : null}
      </SkeletonReveal>
    </div>
  )
}

export function WarmEmptyState({
  message = '暂无数据',
  rowHeight,
  chartHeight,
  className,
}: {
  message?: string
  rowHeight?: 'sm' | 'md' | 'lg'
  chartHeight?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        styles.emptyState,
        rowHeight === 'lg' && styles.emptyStateLarge,
        chartHeight && styles.emptyStateChart,
        chartHeight,
        className
      )}
      data-warm-empty-state="true"
    >
      <Database aria-hidden="true" className={styles.emptyStateIcon} />
      <span>{message}</span>
    </div>
  )
}

export function WarmEmptyTableState({
  colSpan,
  message = '暂无数据',
  className,
}: {
  colSpan: number
  message?: string
  className?: string
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn(styles.emptyTableCell, className)}>
        {message}
      </td>
    </tr>
  )
}

export function WarmKpiTile({
  label,
  value,
  hint,
  tone = 'neutral',
  loading,
}: {
  label: string
  value: string
  hint?: string
  tone?: WarmTone
  loading?: boolean
}) {
  return (
    <div className={styles.kpiTile}>
      <span className={styles.kpiLabel}>{label}</span>
      <span
        data-testid="kpi-value"
        className={cn(styles.kpiValue, toneClass[tone])}
        title={value}
      >
        {loading ? '···' : value}
      </span>
      {hint ? <span className={styles.kpiHint}>{hint}</span> : null}
    </div>
  )
}

export function WarmTable({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode
  className?: string
  'aria-label'?: string
}) {
  return (
    <div className={styles.tableScroll} data-warm-table-scroll="true">
      <table aria-label={ariaLabel} className={cn(styles.table, className)}>
        {children}
      </table>
    </div>
  )
}

export function WarmTHead({ children }: { children: React.ReactNode }) {
  return <thead className={styles.tableHead}>{children}</thead>
}

export function WarmHead({
  children,
  className,
  numeric,
  onClick,
  title,
}: {
  children?: React.ReactNode
  className?: string
  numeric?: boolean
  onClick?: () => void
  title?: string
}) {
  return (
    <th
      scope="col"
      title={title}
      onClick={onClick}
      className={cn(numeric && styles.numericCell, onClick && styles.sortableHead, className)}
    >
      {children}
    </th>
  )
}

export function WarmBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>
}

export function WarmRow({
  children,
  className,
  highlight,
  onClick,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode
  className?: string
  highlight?: boolean
  onClick?: () => void
  'aria-label'?: string
}) {
  return (
    <tr
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(styles.tableRow, highlight && styles.tableRowHighlight, onClick && styles.tableRowClickable, className)}
    >
      {children}
    </tr>
  )
}

export function WarmCell({
  children,
  className,
  numeric,
  tone,
  title,
  colSpan,
  rowSpan,
  onClick,
}: {
  children?: React.ReactNode
  className?: string
  numeric?: boolean
  tone?: 'pos' | 'warn' | 'neg' | 'muted'
  title?: string
  colSpan?: number
  rowSpan?: number
  onClick?: (event: React.MouseEvent<HTMLTableCellElement>) => void
}) {
  return (
    <td
      title={title}
      colSpan={colSpan}
      rowSpan={rowSpan}
      onClick={onClick}
      className={cn(
        styles.tableCell,
        numeric && styles.numericCell,
        tone === 'pos' && styles.tonePositive,
        tone === 'warn' && styles.toneWarning,
        tone === 'neg' && styles.toneNegative,
        tone === 'muted' && styles.toneMuted,
        className
      )}
    >
      {children}
    </td>
  )
}
