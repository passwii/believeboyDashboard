import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Home, ShieldAlert } from 'lucide-react'

import '@/components/dashboard-v2/warm-ledger/shell/theme.css'
import { cn } from '@/lib/utils'

import styles from './status-page-shell.module.css'

type StatusTone = 'error' | 'warning'
type StatusKind = 'not-found' | 'error'

type StatusPageShellProps = {
  code?: string
  title: string
  description: string
  tone?: StatusTone
  kind?: StatusKind
  headingLevel?: 'h1' | 'h2'
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  compact?: boolean
}

export function StatusPageShell({
  code,
  title,
  description,
  tone = 'error',
  kind = code === '404' ? 'not-found' : 'error',
  headingLevel = 'h1',
  primaryAction,
  secondaryAction,
  compact = false,
}: StatusPageShellProps) {
  const Icon = kind === 'error' ? ShieldAlert : AlertTriangle
  const Heading = headingLevel

  return (
    <section
      className={cn('warm-ledger', styles.root, compact ? styles.compactPage : styles.fullPage)}
      data-status-kind={kind}
      aria-labelledby="status-page-title"
    >
      <div className={cn(styles.surface, compact ? styles.compactSurface : styles.fullSurface)}>
        <div className={styles.content}>
          <div className={cn(styles.statusLine, tone === 'error' ? styles.errorTone : styles.warningTone)}>
            <Icon aria-hidden="true" className={styles.statusIcon} />
            {code ? (
              <span className={styles.code}>{code}</span>
            ) : (
              <span>{kind === 'not-found' ? '页面未找到' : '页面发生错误'}</span>
            )}
          </div>
          <div
            className={styles.message}
            role={kind === 'error' ? 'alert' : 'status'}
            aria-labelledby="status-page-title"
          >
            <Heading className={styles.title} id="status-page-title">
              {title}
            </Heading>
            <p className={styles.description}>{description}</p>
          </div>
          {primaryAction || secondaryAction ? (
            <div className={styles.actions}>
              {primaryAction}
              {secondaryAction}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function StatusHomeAction({
  href = '/dashboard',
  children = '返回首页',
}: {
  href?: string
  children?: ReactNode
}) {
  return (
    <Link
      className={cn(
        'warm-ledger__button',
        'warm-ledger__button--primary',
        styles.homeAction
      )}
      href={href}
    >
      <Home aria-hidden="true" className={styles.actionIcon} />
      {children}
    </Link>
  )
}
