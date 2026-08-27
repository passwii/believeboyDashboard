import type * as React from 'react'

import { cn } from '@/lib/utils'

interface TermPanelProps {
  title?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

/**
 * Terminal 面板（BLF-809 规范 §1；二档放大 2026-08-25）：
 * 1px 边界分割、零阴影、零圆角；标题条 36px，内部间距锁 4/8px。
 */
export function TermPanel({ title, actions, children, className, bodyClassName }: TermPanelProps) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-none border border-term-border bg-term-panel shadow-none', className)}>
      {(title || actions) && (
        <header className="flex h-9 shrink-0 items-center gap-2 rounded-none border-b border-term-border bg-transparent pl-2 pr-1">
          {title && (
            <h2 className="truncate text-sm font-semibold uppercase tracking-wider text-term-muted">
              {title}
            </h2>
          )}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}
