'use client'

// Shared chart primitives & defaults — single source of truth for the unified
// chart layer (BLF-911). All dashboard / reports / monthly-report / display
// pages should consume these instead of importing recharts + ui/chart directly.
//
// Layering:
//   1. ui/chart (shadcn ChartContainer / ChartTooltip / ChartTooltipContent /
//      ChartLegend) — primitive recharts wrappers, theme-aware via CSS vars.
//   2. components/charts/primitives.tsx (this file) — default props for axes,
//      tooltip, legend, gradient, mobile margin, dual-axis formatting.
//   3. components/charts/cards.tsx — opinionated card-style wrappers used by
//      v2-* and portfolio-* charts.
//   4. Pages and v2 chart components import the wrapper, not recharts.
//
// Why: digital-display/page.tsx still uses raw ResponsiveContainer + raw
// Tooltip + raw rgba colors; v2 charts hardcode blue-100 / #2563eb / etc;
// portfolio charts duplicate the CHART_COLORS palette; ad-analysis uses
// term-* mono font, others don't. Adapter layer removes the drift.

import * as React from 'react'
import { Area, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { useMobile } from '@/lib/hooks/use-mobile'
import {
  ChartContainer as UiChartContainer,
  ChartLegend as UiChartLegend,
  ChartLegendContent as UiChartLegendContent,
  ChartStyle as UiChartStyle,
  ChartTooltip as UiChartTooltip,
  ChartTooltipContent as UiChartTooltipContent,
  type ChartConfig as UiChartConfig,
} from '@/components/ui/chart'

// Re-export the shadcn primitives so consumers can import everything from the
// charts module. These are the single source of truth.
export {
  UiChartContainer as ChartContainer,

  UiChartLegend as ChartLegend,
  UiChartLegendContent as ChartLegendContent,
  UiChartStyle as ChartStyle,
  UiChartTooltip as ChartTooltip,
  UiChartTooltipContent as ChartTooltipContent,
}
export type { UiChartConfig as ChartConfig }

// ---------- Recharts passthroughs (so callers don't import recharts) -------

export { Area, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, ResponsiveContainer, XAxis, YAxis }


/**
 * Common axis tick props — 11px mono with term-muted fill. Applied to every
 * axis via `defaultXAxisProps` / `defaultYAxisProps` so all unified charts
 * get the terminal typography without per-call repetition (BLF-909 stage B).
 */
export const termAxisTick = {
  fontSize: 11,
  fontFamily: 'var(--font-mono, monospace)',
  fill: 'var(--term-muted)',
} as const

/**
 * Default XAxis override. Use as `<XAxis {...defaultXAxisProps} … />`.
 * No axis line, no tick line, with breathing room. `tick` carries
 * termAxisTick so every chart axes is mono + term-muted by default.
 */
export const defaultXAxisProps = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  interval: 0,
  minTickGap: 24,
  tick: termAxisTick,
} as const

/**
 * Default YAxis override. width gives ~3 chars of headroom.
 * `tick` carries termAxisTick so vertical axes match XAxis typography.
 */
export const defaultYAxisProps = {
  axisLine: false,
  tickLine: false,
  width: 52,
  tick: termAxisTick,
} as const

/** Right-side YAxis — narrower (44) since most y labels are shorter. */
export const rightYAxisProps = {
  ...defaultYAxisProps,
  width: 44,
  orientation: 'right',
} as const

/** Default ChartTooltip cursor — soft dashed line in the muted foreground. */
export const defaultTooltipCursor = {
  stroke: 'hsl(var(--muted-foreground))',
  strokeDasharray: '4 4',
  strokeWidth: 1,
} as const

/** Hide the cursor — useful for bar charts where the hover column is implicit. */
export const hiddenTooltipCursor = false

/** Default ChartTooltipContent — hide the dataKey label when only one series. */
export const singleSeriesTooltipContentProps = { hideLabel: true } as const

/** Mobile-friendly margin — shrink left/right edges when stacked. */
export function useChartMargin(defaultMargin: {
  top: number
  right: number
  bottom: number
  left: number
}): {
  top: number
  right: number
  bottom: number
  left: number
} {
  const isMobile = useMobile()
  return React.useMemo(() => {
    if (!isMobile) return defaultMargin
    return {
      top: Math.max(4, Math.floor(defaultMargin.top / 2)),
      right: Math.max(4, Math.floor(defaultMargin.right / 2)),
      bottom: Math.max(4, Math.floor(defaultMargin.bottom / 2)),
      left: 0,
    }
  }, [defaultMargin, isMobile])
}

/**
 * Default XAxis text formatter — splits ISO date "YYYY-MM-DD" to "MM-DD" if
 * it looks like a date; otherwise stringifies. Centralized so every chart
 * page renders the same label.
 */
export function defaultXTickFormatter(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  // ISO date YYYY-MM-DD → MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5)
  // Month label like "2024-08" → "08"
  if (/^\d{4}-\d{2}$/.test(s)) return s.slice(5)
  return s
}

// ---------- Chart height rhythm (matches existing v2-* cards) -------------

/** Default chart height — `aspect-auto` + `h-52` / `md:h-64` rhythm used by v2. */
export const CHART_HEIGHTS = {
  compact: 'aspect-auto h-40 w-full md:h-52',
  default: 'aspect-auto h-52 w-full md:h-64',
  tall: 'aspect-auto h-60 w-full md:h-80',
} as const

/** Default chart container class — used by every chart wrapper. */
export const defaultChartContainerClass = CHART_HEIGHTS.default

// ---------- Color palette --------------------------------------------------

/**
 * Canonical chart color palette — keys map to `--chart-N` CSS vars in
 * globals.css (already 8 entries in both light/dark themes).
 */
export const CHART_COLOR_VARS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-6))',
  'hsl(var(--chart-7))',
  'hsl(var(--chart-8))',
] as const

/** Helper to build a ChartConfig from a `label` map + per-key palette. */
export function buildChartConfig(
  keys: readonly string[],
  labels: Record<string, string>,
  /** Optional override — defaults to `var(--chart-N)` */
  colors?: Record<string, string>
): UiChartConfig {
  const cfg: UiChartConfig = {}
  keys.forEach((key, idx) => {
    cfg[key] = {
      label: labels[key] ?? key,
      color: colors?.[key] ?? `var(--chart-${(idx % 8) + 1})`,
    }
  })
  return cfg
}

/** Build a `<linearGradient>` def suitable for an Area chart fill. */
export function buildAreaGradient(id: string, colorVar: string): React.ReactElement {
  return (
    <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stopColor={`var(--color-${colorVar})`} stopOpacity={0.35} />
      <stop offset="100%" stopColor={`var(--color-${colorVar})`} stopOpacity={0} />
    </linearGradient>
  )
}