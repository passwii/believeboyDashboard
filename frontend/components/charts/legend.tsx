'use client'

// Unified chart legend system (BLF-942). Replaces default shadcn ChartLegendContent
// with a design-system-aware legend that:
//   - aligns swatch shape with series geometry (dot/line/dashed/bar)
//   - avoids hardcoded colors (uses --chart-N / var(--color-*) → light/dark adaptive)
//   - supports align, wrap, hover micro-interaction
//   - is testable independently of recharts
//
// Layering:
//   1. LegendSwatch  — pure visual swatch (dot / line / dashed / bar)
//   2. LegendItem    — swatch + label, with optional onClick
//   3. ChartLegend   — container: flex-wrap + align + verticalAlign
//
// The recharts bridge lives in cards.tsx (LegendBridge), which converts
// the recharts Legend payload into LegendItemProps.

import * as React from 'react'
import { cn } from '@/lib/utils'

// ---------- Types ----------------------------------------------------------

/** Swatch shape — matches the chart series geometry. */
export type LegendSwatchVariant = 'dot' | 'line' | 'dashed' | 'bar'

/** Single legend item props. */
export interface LegendItemProps {
  /** Display label. */
  label: React.ReactNode
  /** Resolved color string (e.g. `hsl(var(--chart-1))`). */
  color?: string
  /** Swatch shape. */
  variant?: LegendSwatchVariant
  /** Size preset. */
  size?: 'sm' | 'md'
  /** Whether the series is active (for future toggle). */
  active?: boolean
  /** Click handler (for future toggle). */
  onClick?: () => void
  className?: string
}

export interface LegendRowProps {
  /** Legend items. */
  items: LegendItemProps[]
  /** Horizontal alignment of the row. */
  align?: 'center' | 'start' | 'end'
  /** Vertical position (controls top/bottom padding). */
  verticalAlign?: 'top' | 'bottom'
  /** Size preset applied to all items. */
  size?: 'sm' | 'md'
  className?: string
}

// ---------- Swatch dimensions (sm / md) ------------------------------------

const SWATCH_SIZE: Record<LegendSwatchVariant, Record<string, string>> = {
  dot:    { sm: 'size-1.5',     md: 'size-2' },
  line:   { sm: 'h-0.5 w-4',   md: 'h-0.5 w-5' },
  dashed: { sm: 'h-0.5 w-4',   md: 'h-0.5 w-5' },
  bar:    { sm: 'h-1.5 w-1.5', md: 'h-2 w-2.5' },
}

// ---------- LegendSwatch ---------------------------------------------------

export interface LegendSwatchProps {
  variant?: LegendSwatchVariant
  color?: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * A single colored swatch matching the chart series geometry.
 * - dot: filled circle
 * - line: filled pill (horizontal)
 * - dashed: dashed line (via CSS background-image)
 * - bar: rounded rectangle
 */
export function LegendSwatch({
  variant = 'dot',
  color,
  size = 'md',
  className,
}: LegendSwatchProps) {
  const sizeClass = SWATCH_SIZE[variant]?.[size] ?? SWATCH_SIZE.dot[size]

  if (variant === 'dashed') {
    return (
      <span
        className={cn('shrink-0', sizeClass, className)}
        style={{
          background: color
            ? `repeating-linear-gradient(90deg, ${color} 0, ${color} 6px, transparent 6px, transparent 9px)`
            : undefined,
        }}
        aria-hidden
      />
    )
  }

  // BLF-976：terminal 直角语言——所有 swatch 零圆角，与 1px 边界体系一致
  const shapeClass = ''

  return (
    <span
      className={cn('shrink-0', shapeClass, sizeClass, className)}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

// ---------- LegendItem -----------------------------------------------------

/**
 * A single legend row: swatch + label, with optional click interaction.
 * Non-interactive items render as a <span>; interactive as a <button>.
 */
export function LegendItem({
  label,
  color,
  variant = 'dot',
  size = 'md',
  active = true,
  onClick,
  className,
}: LegendItemProps) {
  // When onClick is present, render as a button for accessibility
  const isInteractive = typeof onClick === 'function'
  const shared = cn(
    'inline-flex items-center gap-1.5 rounded-none px-1 py-0.5 font-mono text-xs leading-4 tabular-nums transition-colors',
    'text-term-muted',
    isInteractive && 'cursor-pointer hover:bg-term-hover hover:text-term-text',
    !active && 'opacity-50',
    className
  )

  const children = (
    <>
      <LegendSwatch variant={variant} color={color} size={size} />
      <span>{label}</span>
    </>
  )

  if (isInteractive) {
    return (
      <button type="button" className={shared} onClick={onClick}>
        {children}
      </button>
    )
  }

  return <span className={shared}>{children}</span>
}

// ---------- ChartLegend (container) ----------------------------------------

/**
 * Container for a row of legend items.
 * Supports flex-wrap, horizontal alignment, and vertical positioning padding.
 */
export function LegendRow({
  items,
  align = 'center',
  verticalAlign = 'bottom',
  size,
  className,
}: LegendRowProps) {
  if (!items.length) return null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1',
        align === 'center' && 'justify-center',
        align === 'start' && 'justify-start',
        align === 'end' && 'justify-end',
        verticalAlign === 'top' ? 'pb-3' : 'pt-3',
        className
      )}
    >
      {items.map((item, i) => (
        <LegendItem key={i} size={size} {...item} />
      ))}
    </div>
  )
}