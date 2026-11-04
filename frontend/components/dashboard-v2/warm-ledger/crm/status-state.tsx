import type { ComponentProps, ReactNode } from 'react'

import { WarmBadge } from '../controls'
import { cn } from '@/lib/utils'

import styles from './warm-crm-kit.module.css'

export type WarmCrmStatusTone = 'neutral' | 'accent' | 'positive' | 'negative'

export type WarmCrmStatusPillProps = Omit<
  ComponentProps<typeof WarmBadge>,
  'tone' | 'children'
> & {
  tone?: WarmCrmStatusTone
  children: ReactNode
}

export function WarmCrmStatusPill({
  tone = 'neutral',
  className,
  children,
  ...props
}: WarmCrmStatusPillProps) {
  return (
    <WarmBadge
      {...props}
      className={cn(styles.statusPill, className)}
      data-warm-crm-status-pill
      tone={tone}
    >
      {children}
    </WarmBadge>
  )
}

export type WarmCrmStateKind = 'loading' | 'empty' | 'error'

export type WarmCrmStateProps = {
  kind: WarmCrmStateKind
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
  className?: string
}

const stateClass: Record<WarmCrmStateKind, string> = {
  loading: styles.stateLoading,
  empty: styles.stateEmpty,
  error: styles.stateError,
}

export function WarmCrmState({
  kind,
  title,
  detail,
  action,
  className,
}: WarmCrmStateProps) {
  const isError = kind === 'error'

  return (
    <section
      aria-busy={kind === 'loading' ? 'true' : undefined}
      className={cn(styles.state, stateClass[kind], className)}
      data-state={kind}
      data-warm-crm-state
      role={isError ? 'alert' : 'status'}
    >
      {kind === 'loading' ? (
        <div aria-hidden="true" className={styles.stateSkeletons}>
          {Array.from({ length: 3 }, (_, index) => (
            <span data-warm-crm-state-skeleton key={index} />
          ))}
        </div>
      ) : null}
      <div className={styles.stateCopy}>
        <p className={styles.stateTitle}>{title}</p>
        {detail ? <p className={styles.stateDetail}>{detail}</p> : null}
      </div>
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </section>
  )
}
