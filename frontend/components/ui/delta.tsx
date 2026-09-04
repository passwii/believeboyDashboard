'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Minus, TrendingDown, TrendingUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * Delta 原语（BLF-503 从 components/dashboard-v2/v2-delta.tsx 上移全站通用）。
 *
 * 语义：`<Delta value={n}><DeltaIcon /><DeltaValue /></Delta>` 组合渲染涨跌。
 * - 正值 → emerald，负值 → rose，0 → 中性灰（Minus）。
 * - `DeltaValue` 默认输出绝对值 + % 后缀（precision=1），见使用处按需调参。
 * - 变体：`default`（行内文字）与 `badge`（胶囊徽章）。
 *
 * 原 `v2-delta.tsx` 现在只是本文件的 re-export，Dashboard 主页（v2）行为不变。
 */
type DeltaIconVariant = 'default' | 'trend' | 'arrow'
type DeltaVariant = 'default' | 'badge'

type DeltaContextValue = { value: number }

const DeltaContext = React.createContext<DeltaContextValue | null>(null)

function useDeltaValue() {
  const context = React.useContext(DeltaContext)
  if (!context) {
    throw new Error('DeltaIcon and DeltaValue must be used inside a `Delta` component.')
  }
  return context.value
}

function Delta({
  className,
  value,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & {
  value: number
  variant?: DeltaVariant
}) {
  return (
    <DeltaContext.Provider value={{ value }}>
      {variant === 'badge' ? (
        <Badge
          className={cn(
            'gap-1 border-none tabular-nums [&_svg]:size-4 [&_svg]:shrink-0',
            value > 0 ? 'bg-term-pos/10 text-term-pos' : 'bg-term-neg/10 text-term-neg',
            className
          )}
          data-slot="delta"
          variant="secondary"
          {...(props as React.ComponentProps<typeof Badge>)}
        />
      ) : (
        <div
          className={cn(
            'inline-flex items-center gap-1 text-muted-foreground tabular-nums',
            '[&_svg]:size-3 [&_svg]:shrink-0',
            value > 0 ? 'text-term-pos' : '',
            value < 0 ? 'text-term-neg' : '',
            className
          )}
          data-slot="delta"
          {...props}
        />
      )}
    </DeltaContext.Provider>
  )
}

function FilledShell({ value, children }: { value: number; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex size-3 shrink-0 items-center justify-center rounded-full',
        '[&_svg]:size-2! [&_svg]:shrink-0 [&_svg]:stroke-3! [&_svg]:text-background',
        value > 0 && 'bg-term-pos',
        value < 0 && 'bg-term-neg',
        (!value || value === 0) && 'bg-muted-foreground'
      )}
      data-slot="delta-icon"
    >
      {children}
    </span>
  )
}

function DeltaIcon({
  variant = 'default',
  filled = false,
  className,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'fill'> & {
  variant?: DeltaIconVariant
  filled?: boolean
}) {
  const resolvedValue = useDeltaValue()

  const shell = (node: React.ReactElement) =>
    filled ? <FilledShell value={resolvedValue}>{node}</FilledShell> : node
  const slotProps = filled ? {} : { 'data-slot': 'delta-icon' as const }

  let Icon = Minus
  if (resolvedValue > 0) {
    Icon = variant === 'trend' ? TrendingUp : variant === 'arrow' ? ArrowUp : ChevronUp
  } else if (resolvedValue < 0) {
    Icon = variant === 'trend' ? TrendingDown : variant === 'arrow' ? ArrowDown : ChevronDown
  }

  return shell(<Icon {...slotProps} className={className} {...props} />)
}

function DeltaValue({
  className,
  precision = 1,
  suffix = '%',
  absolute = true,
  ...props
}: React.ComponentProps<'span'> & {
  precision?: number
  suffix?: string
  absolute?: boolean
}) {
  const resolvedValue = useDeltaValue()
  const formattedValue = (absolute ? Math.abs(resolvedValue) : resolvedValue).toFixed(precision)

  return (
    <span className={cn('tabular-nums', className)} data-slot="delta-value" {...props}>
      {formattedValue}
      {suffix}
    </span>
  )
}

export { Delta, DeltaIcon, DeltaValue }
