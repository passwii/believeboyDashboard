import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

/**
 * BLF-836 · Scheduled Reports 终端化共享常量与语义色（BLF-817 同款控件基类）。
 *
 * 本页不把筛选上移 Top Header 插槽（layout 双 View 常驻挂载、hidden 切换，
 * 两个 View 同时 portal 会互相覆盖），沿用 order-info 的页内 Console 工具栏
 * 模式；控件统一终端规格（h-9 / 零圆角 / 1px 边界 / 等宽数值）。
 */

export const TERM_TRIGGER =
  'h-9 rounded-none border-term-border bg-term-bg text-sm text-term-text focus:ring-0 data-[state=open]:border-term-border-strong'
export const TERM_SELECT_ITEM = 'rounded-none text-sm focus:bg-term-hover focus:text-term-text'
export const TERM_INPUT =
  'h-9 rounded-none border-term-border bg-term-bg font-mono text-sm text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0'
export const TERM_BUTTON =
  'flex h-9 shrink-0 items-center gap-1 border border-term-border bg-term-panel px-2 font-mono text-sm text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-50'

/** 频率徽标：终端单色系（去彩色胶囊，仅用 term 文本色区分） */
export const FREQUENCY_TERM_CLASS: Record<string, string> = {
  daily: 'text-term-text',
  weekly: 'text-term-accent',
  monthly: 'text-term-muted',
}

/** 台账状态 → 终端语义色（sent=pos · failed=neg · missing=warn） */
export const STATUS_TERM_TONE: Record<string, { text: string; icon: string }> = {
  sent: { text: 'text-term-pos border-term-pos/40', icon: '✓' },
  failed: { text: 'text-term-neg border-term-neg/40', icon: '✗' },
  missing: { text: 'text-term-warn border-term-warn/40', icon: '⚠' },
}

/** 终端状态 pill（1px 边界 + mono 字形 + tabular 计数） */
export function TermStatusPill({
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
  const tone = STATUS_TERM_TONE[status] ?? STATUS_TERM_TONE.missing!
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-none border px-1.5 py-0.5 font-mono text-[11px] tabular-nums',
        tone.text,
        className
      )}
    >
      <span aria-hidden>{tone.icon}</span>
      {label}
    </span>
  )
}

/** 终端频率标签（Badge 外壳 + 单色文本，无彩色底） */
export function TermFrequencyTag({
  frequency,
  labels,
  className,
}: {
  frequency: string
  labels: Record<string, string>
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-nowrap rounded-none border-term-border font-mono text-[10px] uppercase tracking-wider',
        FREQUENCY_TERM_CLASS[frequency] ?? 'text-term-muted',
        className
      )}
    >
      {labels[frequency] ?? frequency}
    </Badge>
  )
}
