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
 * Default XAxis override. Use as `<XAxis {...defaultXAxisProps} … />`.
 * No axis line, no tick line, with breathing room.
 */
export const defaultXAxisProps = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  interval: 0,
  minTickGap: 24,
  tick: { fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' },
} as const

/**
 * Default YAxis override. width gives ~3 chars of headroom.
 * BLF-978 Stage 1: 同 XAxis —— mono + muted。
 */
export const defaultYAxisProps = {
  axisLine: false,
  tickLine: false,
  width: 52,
  tick: { fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' },
} as const

/** Right-side YAxis — narrower (44) since most y labels are shorter. */
export const rightYAxisProps = {
  ...defaultYAxisProps,
  width: 44,
  orientation: 'right',
} as const

/** Default ChartTooltip cursor — dashed line in the strong term border (BLF-978). */
export const defaultTooltipCursor = {
  stroke: 'var(--term-border-strong)',
  strokeDasharray: '4 4',
  strokeWidth: 1,
} as const

/** BLF-978 Stage 3：recharts 系列动效默认值（≤300ms、ease-out、逐 series stagger）。 */
export const defaultSeriesAnimation = {
  isAnimationActive: true,
  animationDuration: 300,
  animationEasing: 'ease-out',
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
 * Canonical chart color palette — keys map to `--term-chart-N` CSS vars in
 * globals.css (BLF-978 Stage 1: 8 entries × light/dark, full color values).
 */
export const CHART_COLOR_VARS = [
  'var(--term-chart-1)',
  'var(--term-chart-2)',
  'var(--term-chart-3)',
  'var(--term-chart-4)',
  'var(--term-chart-5)',
  'var(--term-chart-6)',
  'var(--term-chart-7)',
  'var(--term-chart-8)',
] as const

/** Helper to build a ChartConfig from a `label` map + per-key palette. */
export function buildChartConfig(
  keys: readonly string[],
  labels: Record<string, string>,
  /** Optional override — defaults to `var(--term-chart-N)` */
  colors?: Record<string, string>
): UiChartConfig {
  const cfg: UiChartConfig = {}
  keys.forEach((key, idx) => {
    cfg[key] = {
      label: labels[key] ?? key,
      color: colors?.[key] ?? CHART_COLOR_VARS[idx % CHART_COLOR_VARS.length],
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