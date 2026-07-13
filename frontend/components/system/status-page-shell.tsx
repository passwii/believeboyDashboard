import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Home, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type StatusTone = 'error' | 'warning'

const toneClasses: Record<StatusTone, string> = {
  error:
    'border-[hsl(var(--destructive)/0.2)] bg-[hsl(var(--destructive)/0.08)] text-[hsl(var(--destructive))]',
  warning:
    'border-[hsl(var(--warning)/0.2)] bg-[hsl(var(--warning)/0.09)] text-[hsl(var(--warning))]',
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
        'relative overflow-hidden rounded-[2rem] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)/0.98),hsl(var(--surface-soft)/0.98))] shadow-[var(--shadow-overlay)]',
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
              <span className="rounded-full border border-border/80 bg-background/80 px-4 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">
                {code}
              </span>
            ) : null}
            <span
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold',
                toneClasses[tone]
              )}
            >
              <Icon className="h-4 w-4" />
              系统状态提示
            </span>
          </div>
          <div className="space-y-3">
            <h1 className="text-4xl font-semibold tracking-[-0.05em] text-foreground sm:text-5xl">
              {title}
            </h1>
            <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
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
