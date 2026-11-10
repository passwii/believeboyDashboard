'use client'

import type { CSSProperties, ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { WarmBadge, WarmIconButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import {
  INTENT_LEVEL_LABELS,
  INTENT_LEVEL_TONES,
  INTENT_STATE_LABELS,
  INTENT_STATE_ORDER,
  INTENT_STATE_TONES,
  type IntentLevel,
  type IntentState,
} from '@/lib/crm/intent/types'
import { cn } from '@/lib/utils'

import styles from '../intent-warm.module.css'

type IntentLevelBadgeProps = {
  level: IntentLevel
  className?: string
}

/** 级别 badge：A=accent，B/C/D=neutral，始终带「A · 强意向」文字（V4 只用 4 个 tone）。 */
export function IntentLevelBadge({ level, className }: IntentLevelBadgeProps) {
  return (
    <WarmBadge
      className={cn(styles.levelBadge, className)}
      data-intent-level={level}
      tone={INTENT_LEVEL_TONES[level]}
    >
      {`${level} · ${INTENT_LEVEL_LABELS[level]}`}
    </WarmBadge>
  )
}

type IntentStatePillProps = {
  state: IntentState
  label?: string | null
  className?: string
}

/** 8 态 pill：颜色映射见设计稿 §8.2，始终带状态文字。 */
export function IntentStatePill({ state, label, className }: IntentStatePillProps) {
  return (
    <WarmCrmStatusPill className={cn(styles.statePill, className)} tone={INTENT_STATE_TONES[state]}>
      {label ?? INTENT_STATE_LABELS[state]}
    </WarmCrmStatusPill>
  )
}

type IntentMetricPanelProps = {
  label: string
  value: number | null
  primary?: boolean
  active?: boolean
  onClick?: () => void
  className?: string
}

/** 5 张 metric panel 之一：label + DM Mono 数字；整卡是筛选联动按钮。 */
export function IntentMetricPanel({
  label,
  value,
  primary = false,
  active = false,
  onClick,
  className,
}: IntentMetricPanelProps) {
  const content = (
    <>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue} data-primary={primary ? 'true' : undefined}>
        {value === null ? '—' : value}
      </span>
    </>
  )

  if (!onClick) {
    return <div className={cn(styles.metricPanel, className)}>{content}</div>
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(styles.metricPanel, styles.metricButton, className)}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
    >
      {content}
    </button>
  )
}

type IntentPaginationProps = {
  page: number
  pageSize: number
  total: number
  unit?: string
  onPage: (page: number) => void
  className?: string
}

/** 统一分页条：共 N 家 · 第 x/y 页 · 上一页/下一页。 */
export function IntentPagination({
  page,
  pageSize,
  total,
  unit = '家',
  onPage,
  className,
}: IntentPaginationProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  return (
    <div className={cn(styles.pagination, className)}>
      <span className={styles.paginationCount}>
        共 {total} {unit}
      </span>
      <span className={styles.paginationPages}>
        第 {page} / {pages} 页
      </span>
      <div className={styles.paginationActions}>
        <WarmIconButton
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </WarmIconButton>
        <WarmIconButton
          aria-label="下一页"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </WarmIconButton>
      </div>
    </div>
  )
}

/** 抽屉分区：标题 + 内容（V4 hairline 分隔，不做卡片套卡片）。 */
export function IntentDetailSection({
  title,
  children,
  tone,
}: {
  title: string
  children: ReactNode
  tone?: 'negative'
}) {
  return (
    <section className={styles.drawerSection} data-tone={tone}>
      <h3 className={styles.drawerSectionTitle}>{title}</h3>
      <div className={styles.drawerSectionBody}>{children}</div>
    </section>
  )
}

type IntentFieldProps = {
  label: string
  children: ReactNode
  mono?: boolean
  style?: CSSProperties
}

export function IntentField({ label, children, mono, style }: IntentFieldProps) {
  return (
    <div className={styles.field} style={style}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={cn(styles.fieldValue, mono && styles.fieldValueMono)}>{children ?? '—'}</span>
    </div>
  )
}

/** 状态 select 的 option 列表（抽屉/表格共用）。 */
export function intentStateOptions(): Array<{ value: IntentState; label: string }> {
  return INTENT_STATE_ORDER.map((state) => ({ value: state, label: INTENT_STATE_LABELS[state] }))
}
