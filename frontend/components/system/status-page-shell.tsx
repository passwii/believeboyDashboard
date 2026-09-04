import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Home, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type StatusTone = 'error' | 'warning'

const toneClasses: Record<StatusTone, string> = {
  error: 'border-term-neg/40 bg-term-neg/5 text-term-neg',
  warning: 'border-term-warn/40 bg-term-warn/5 text-term-warn',
}

const toneIcons = {
  error: ShieldAlert,
  warning: AlertTriangle,
} as const

type StatusPageShellProps = {
  code?: string
  title: string
  description: string
  tone?: StatusTone
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  compact?: boolean
}

export function StatusPageShell({
  code,
  title,
  description,
  tone = 'error',
  primaryAction,
  secondaryAction,
  compact = false,
}: StatusPageShellProps) {
  const Icon = toneIcons[tone]

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-none border border-term-border bg-term-panel shadow-none',
        compact ? 'mx-auto max-w-4xl p-6 sm:p-8' : 'min-h-screen p-6 sm:p-10'
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_26%),radial-gradient(circle_at_82%_18%,hsl(var(--warning)/0.12),transparent_22%)]" />
      <div
        className={cn(
          'relative mx-auto flex max-w-4xl flex-col justify-center',
          compact ? 'min-h-[24rem]' : 'min-h-[calc(100vh-5rem)]'
        )}
      >
        <div className="max-w-2xl space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            {code ? (
              <span className="rounded-none border border-term-border bg-term-bg px-4 py-1 font-mono text-xs uppercase tracking-wider text-term-muted">
                {code}
              </span>
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-2 rounded-none border px-4 py-1.5 font-mono text-xs uppercase tracking-wider',
                toneClasses[tone]
              )}
            >
              <Icon className="h-4 w-4" />
              系统状态提示
            </span>
          </div>
          <div className="space-y-3">
            <h1 className="font-mono text-3xl font-semibold tracking-tight text-term-text sm:text-4xl">
              {title}
            </h1>
            <p className="max-w-xl font-mono text-sm leading-6 text-term-muted sm:text-base">
              {description}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {primaryAction}
            {secondaryAction}
          </div>
        </div>
      </div>
    </div>
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
    <Button asChild>
      <Link href={href}>
        <Home className="h-4 w-4" />
        {children}
      </Link>
    </Button>
  )
}
