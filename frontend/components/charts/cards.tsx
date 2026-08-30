'use client'

// Public chart-card wrappers (BLF-911).
//
// Each wrapper composes:
//   - <ChartContainer>            (from @/components/charts primitives)
//   - one of {Line,Bar,Area,Pie,Composed}Chart
//   - default Tooltip / Legend / axis styling from primitives.tsx
//
// Pages and v2-* / portfolio-* / display charts should consume these instead
// of constructing <ChartContainer><LineChart>… by hand. This keeps tooltip
// cursors, axis tick styling, gradient fills, and responsive margins aligned.

import * as React from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'

import { cn } from '@/lib/utils'
import { useMobile } from '@/lib/hooks/use-mobile'

import {
  buildAreaGradient,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  defaultChartContainerClass,
  defaultTooltipCursor,
  defaultXAxisProps,
  defaultXTickFormatter,
  defaultYAxisProps,
  hiddenTooltipCursor,
  rightYAxisProps,
  singleSeriesTooltipContentProps,
  useChartMargin,
  type ChartConfig,
} from './primitives'

// Re-export Cell for consumers building pie charts.
export { Cell }

// ---------- LineChartCard --------------------------------------------------

export interface LineSeriesSpec {
  dataKey: string
  /** Optional override name shown in tooltip / legend. Defaults to dataKey. */
  name?: string
  /** Per-series overrides — see recharts Line for the supported props. */
  lineProps?: {
    type?: 'monotone' | 'linear' | 'step' | 'stepAfter' | 'stepBefore' | 'natural'
    dot?: boolean
    strokeWidth?: number
    strokeDasharray?: string
    activeDot?: { r?: number } | boolean
  }
  /** yAxisId to attach this line to. Defaults to 'left' (recharts default). */
  yAxisId?: string
}

export interface LineChartCardProps {
  /** Chart data — array of row objects. */
  data: ReadonlyArray<Record<string, unknown>>
  /** Key used for XAxis. */
  xKey: string
  /** Series to render. */
  series: LineSeriesSpec[]
  /** ChartConfig — colors keyed by series.dataKey. */
  config: ChartConfig
  /** Height class — defaults to defaultChartContainerClass. */
  className?: string
  /** Show legend — defaults to true when more than one series. */
  showLegend?: boolean
  /** Use a single left Y axis (default). If true, render dual-axis. */
  dualAxis?: boolean
  /** Right-side YAxis tick formatter. */
  rightYFormatter?: (value: number) => string
  /** Right-side YAxis label/unit. */
  rightYUnit?: string
  /** Tooltip formatter — defaults to identity. */
  tooltipFormatter?: (value: number, name: string) => string | React.ReactNode
  /** Optional override for the XAxis tick formatter. */
  xTickFormatter?: (value: unknown) => string
  /** Optional override for the YAxis (left) tick formatter. */
  yTickFormatter?: (value: number) => string
  /** Hide the Y axis entirely (useful on mobile). */
  hideYAxis?: boolean
}

/**
 * Drop-in LineChart wrapped in the unified ChartContainer + default styling.
 * Used by v2-channel-chart, ledger-overview, ledger-summary-tab, ad-analysis,
 * digital-display.
 */
export function LineChartCard({
  data,
  xKey,
  series,
  config,
  className,
  showLegend,
  /** Tooltip formatter — defaults to identity string. Return ReactNode for rich rows. */
  tooltipFormatter,
  rightYUnit,
  dualAxis,
  rightYFormatter,
  xTickFormatter,
  yTickFormatter,
  hideYAxis,
}: LineChartCardProps) {
  const margin = useChartMargin({ top: 8, right: 8, bottom: 0, left: 0 })
  const isMobile = useMobile()
  const shouldShowLegend = showLegend ?? series.length > 1
  const tooltipProps = series.length === 1 ? singleSeriesTooltipContentProps : {}

  return (
    <ChartContainer config={config} className={cn(defaultChartContainerClass, className)}>
      <LineChart accessibilityLayer data={data as unknown as object[]} margin={margin}>
        <CartesianGrid vertical={false} />
        <XAxis
          {...defaultXAxisProps}
          dataKey={xKey}
          tickFormatter={xTickFormatter ?? defaultXTickFormatter}
        />
        {!hideYAxis && !isMobile && (
          <YAxis
            {...defaultYAxisProps}
            tickFormatter={(v) => (yTickFormatter ? yTickFormatter(Number(v)) : String(v))}
          />
        )}
        {dualAxis && (
          <YAxis
            {...rightYAxisProps}
            unit={rightYUnit}
            tickFormatter={(v) => (rightYFormatter ? rightYFormatter(Number(v)) : String(v))}
          />
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              {...tooltipProps}
              formatter={(value, name) => {
                if (tooltipFormatter) return tooltipFormatter(Number(value), String(name))
                return [String(value), String(name)]
              }}
            />
          }
          cursor={defaultTooltipCursor}
        />
        {shouldShowLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Line
            key={s.dataKey}
            type={s.lineProps?.type ?? 'monotone'}
            dot={s.lineProps?.dot ?? false}
            strokeWidth={s.lineProps?.strokeWidth ?? 2}
            strokeDasharray={s.lineProps?.strokeDasharray}
            activeDot={s.lineProps?.activeDot ?? { r: 4 }}
            dataKey={s.dataKey}
            name={s.name ?? s.dataKey}
            stroke={`var(--color-${s.dataKey})`}
            yAxisId={s.yAxisId}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}

// ---------- BarChartCard ---------------------------------------------------

export interface BarSeriesSpec {
  dataKey: string
  /** Override name shown in tooltip / legend. */
  name?: string
  /** Per-bar recharts overrides. */
  barProps?: {
    radius?: number | [number, number, number, number]
    barSize?: number
    stackId?: string
  }
  /** yAxisId to attach this bar to. */
  yAxisId?: string
}

export interface BarChartCardProps {
  data: ReadonlyArray<Record<string, unknown>>
  xKey: string
  series: BarSeriesSpec[]
  config: ChartConfig
  className?: string
  /** Layout — vertical (default) puts category on X, number on Y; horizontal flips. */
  layout?: 'vertical' | 'horizontal'
  /** Show legend. Defaults to series.length > 1. */
  showLegend?: boolean
  /** Tooltip formatter. */
  tooltipFormatter?: (value: number, name: string) => string | React.ReactNode
  /** Hide Y axis on mobile. */
  hideYAxis?: boolean
  /** XAxis tick formatter (used for the numeric axis in vertical layout). */
  xTickFormatter?: (value: unknown) => string
  /** YAxis (category in vertical layout) tick formatter. */
  yTickFormatter?: (value: unknown) => string
}

/**
 * Drop-in BarChart wrapped in the unified ChartContainer. Used by v2-country,
 * v2-project, v2-revenue, ledger-overview, ad-analysis (vertical layout).
 */
export function BarChartCard({
  data,
  xKey,
  series,
  config,
  className,
  layout = 'vertical',
  showLegend,
  tooltipFormatter,
  hideYAxis,
  xTickFormatter,
  yTickFormatter,
}: BarChartCardProps) {
  const isVertical = layout === 'vertical'
  const margin = useChartMargin(
    isVertical ? { top: 4, right: 8, bottom: 0, left: 0 } : { top: 4, right: 12, bottom: 0, left: 4 }
  )
  const isMobile = useMobile()
  const shouldShowLegend = showLegend ?? series.length > 1
  const tooltipProps = series.length === 1 ? singleSeriesTooltipContentProps : {}

  return (
    <ChartContainer config={config} className={cn(defaultChartContainerClass, className)}>
      <BarChart accessibilityLayer data={data as unknown as object[]} layout={layout} margin={margin}>
        <CartesianGrid vertical={!isVertical} horizontal={isVertical} />
        {isVertical ? (
          <>
            <XAxis
              {...defaultXAxisProps}
              dataKey={xKey}
              tickFormatter={xTickFormatter ?? defaultXTickFormatter}
            />
            {!hideYAxis && !isMobile && (
              <YAxis
                {...defaultYAxisProps}
                tickFormatter={(v) => (yTickFormatter ? yTickFormatter(v) : String(v))}
              />
            )}
          </>
        ) : (
          <>
            <XAxis
              {...defaultXAxisProps}
              type="number"
              tickFormatter={xTickFormatter ?? defaultXTickFormatter}
            />
            <YAxis
              {...defaultYAxisProps}
              dataKey={xKey}
              type="category"
              tickFormatter={(v) => (yTickFormatter ? yTickFormatter(v) : String(v))}
              width={96}
            />
          </>
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              {...tooltipProps}
              formatter={(value, name) => {
                if (tooltipFormatter) return tooltipFormatter(Number(value), String(name))
                return [String(value), String(name)]
              }}
            />
          }
          cursor={hiddenTooltipCursor}
        />
        {shouldShowLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Bar
            key={s.dataKey}
            radius={s.barProps?.radius ?? [2, 2, 0, 0]}
            barSize={s.barProps?.barSize}
            stackId={s.barProps?.stackId}
            dataKey={s.dataKey}
            name={s.name ?? s.dataKey}
            fill={`var(--color-${s.dataKey})`}
            yAxisId={s.yAxisId}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

// ---------- AreaChartCard --------------------------------------------------

export interface AreaSeriesSpec {
  dataKey: string
  /** Name override. */
  name?: string
  /** Per-area overrides. */
  areaProps?: {
    type?: 'monotone' | 'linear' | 'step' | 'stepAfter' | 'stepBefore' | 'natural'
    strokeWidth?: number
    fillOpacity?: number
  }
}

export interface AreaChartCardProps {
  data: ReadonlyArray<Record<string, unknown>>
  xKey: string
  series: AreaSeriesSpec[]
  config: ChartConfig
  className?: string
  /** Toggle gradient fill — defaults to true. */
  gradient?: boolean
  /** Show legend. */
  showLegend?: boolean
  /** Hide Y axis on mobile. */
  hideYAxis?: boolean
  /** YAxis tick formatter (already currency/percent aware). */
  yTickFormatter?: (value: number) => string
  /** Tooltip formatter. */
  tooltipFormatter?: (value: number, name: string) => string | React.ReactNode
}

/**
 * Drop-in AreaChart wrapped in the unified ChartContainer. Used by v2-stock,
 * monthly-report display, digital-display.
 */
export function AreaChartCard({
  data,
  xKey,
  series,
  config,
  className,
  gradient = true,
  showLegend,
  hideYAxis,
  yTickFormatter,
  tooltipFormatter,
}: AreaChartCardProps) {
  const margin = useChartMargin({ top: 8, right: 8, bottom: 0, left: 0 })
  const isMobile = useMobile()
  const shouldShowLegend = showLegend ?? series.length > 1
  const tooltipProps = series.length === 1 ? singleSeriesTooltipContentProps : {}

  // Unique prefix for gradient ids so multiple AreaCharts on one page do not
  // collide (recharts defs are document-global).
  const reactId = React.useId()
  const gradId = (dataKey: string) =>
    `${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}-fill-${dataKey}`

  return (
    <ChartContainer config={config} className={cn(defaultChartContainerClass, className)}>
      <AreaChart accessibilityLayer data={data as unknown as object[]} margin={margin}>
        {gradient && (
          <defs>
            {series.map((s) => (
              <React.Fragment key={s.dataKey}>
                {buildAreaGradient(gradId(s.dataKey), s.dataKey)}
              </React.Fragment>
            ))}
          </defs>
        )}
        <CartesianGrid vertical={false} />
        <XAxis {...defaultXAxisProps} dataKey={xKey} tickFormatter={defaultXTickFormatter} />
        {!hideYAxis && !isMobile && (
          <YAxis
            {...defaultYAxisProps}
            tickFormatter={(v) => (yTickFormatter ? yTickFormatter(Number(v)) : String(v))}
          />
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              {...tooltipProps}
              formatter={(value, name) => {
                if (tooltipFormatter) return tooltipFormatter(Number(value), String(name))
                return [String(value), String(name)]
              }}
            />
          }
          cursor={defaultTooltipCursor}
        />
        {shouldShowLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Area
            key={s.dataKey}
            type={s.areaProps?.type ?? 'monotone'}
            strokeWidth={s.areaProps?.strokeWidth ?? 2}
            fillOpacity={s.areaProps?.fillOpacity}
            dataKey={s.dataKey}
            name={s.name ?? s.dataKey}
            stroke={`var(--color-${s.dataKey})`}
            fill={gradient ? `url(#${gradId(s.dataKey)})` : `var(--color-${s.dataKey})`}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}

// ---------- ComposedChartCard ---------------------------------------------

/** Series union: a Bar OR a Line inside one ComposedChart. */
export type ComposedSeriesSpec =
  | ({ kind: 'bar' } & BarSeriesSpec)
  | ({ kind: 'line' } & LineSeriesSpec)

export interface ComposedChartCardProps {
  data: ReadonlyArray<Record<string, unknown>>
  xKey: string
  series: ComposedSeriesSpec[]
  config: ChartConfig
  className?: string
  /** Show legend. Defaults to series.length > 1. */
  showLegend?: boolean
  /** Use a single left Y axis (default). If true, render dual-axis. */
  dualAxis?: boolean
  /** Right-side YAxis tick formatter. */
  rightYFormatter?: (value: number) => string
  /** Right-side YAxis label/unit. */
  rightYUnit?: string
  /** Tooltip formatter. */
  tooltipFormatter?: (value: number, name: string) => string | React.ReactNode
  /** Optional override for the XAxis tick formatter. */
  xTickFormatter?: (value: unknown) => string
  /** Optional override for the YAxis (left) tick formatter. */
  yTickFormatter?: (value: number) => string
  /** Hide the Y axis entirely (useful on mobile). */
  hideYAxis?: boolean
}

/**
 * Drop-in ComposedChart wrapping the unified ChartContainer. Renders Bar +
 * Line series in one chart. Used by v2-revenue (sales bar + volume line),
 * v2-traffic (page views bar + conversion rate line), and any future dual
 * metric chart.
 */
export function ComposedChartCard({
  data,
  xKey,
  series,
  config,
  className,
  showLegend,
  dualAxis,
  rightYFormatter,
  rightYUnit,
  tooltipFormatter,
  xTickFormatter,
  yTickFormatter,
  hideYAxis,
}: ComposedChartCardProps) {
  const margin = useChartMargin({ top: 8, right: 8, bottom: 0, left: 0 })
  const isMobile = useMobile()
  const shouldShowLegend = showLegend ?? series.length > 1
  const tooltipProps = series.length === 1 ? singleSeriesTooltipContentProps : {}

  return (
    <ChartContainer config={config} className={cn(defaultChartContainerClass, className)}>
      <ComposedChart accessibilityLayer data={data as unknown as object[]} margin={margin}>
        <CartesianGrid vertical={false} />
        <XAxis
          {...defaultXAxisProps}
          dataKey={xKey}
          tickFormatter={xTickFormatter ?? defaultXTickFormatter}
        />
        {!hideYAxis && !isMobile && (
          <YAxis
            {...defaultYAxisProps}
            tickFormatter={(v) => (yTickFormatter ? yTickFormatter(Number(v)) : String(v))}
          />
        )}
        {dualAxis && (
          <YAxis
            {...rightYAxisProps}
            unit={rightYUnit}
            tickFormatter={(v) => (rightYFormatter ? rightYFormatter(Number(v)) : String(v))}
          />
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              {...tooltipProps}
              formatter={(value, name) => {
                if (tooltipFormatter) return tooltipFormatter(Number(value), String(name))
                return [String(value), String(name)]
              }}
            />
          }
          cursor={defaultTooltipCursor}
        />
        {shouldShowLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => {
          if (s.kind === 'bar') {
            return (
              <Bar
                key={s.dataKey}
                radius={s.barProps?.radius ?? [2, 2, 0, 0]}
                barSize={s.barProps?.barSize}
                stackId={s.barProps?.stackId}
                dataKey={s.dataKey}
                name={s.name ?? s.dataKey}
                fill={`var(--color-${s.dataKey})`}
                yAxisId={s.yAxisId}
              />
            )
          }
          return (
            <Line
              key={s.dataKey}
              type={s.lineProps?.type ?? 'monotone'}
              dot={s.lineProps?.dot ?? false}
              strokeWidth={s.lineProps?.strokeWidth ?? 2}
              strokeDasharray={s.lineProps?.strokeDasharray}
              activeDot={s.lineProps?.activeDot ?? { r: 4 }}
              dataKey={s.dataKey}
              name={s.name ?? s.dataKey}
              stroke={`var(--color-${s.dataKey})`}
              yAxisId={s.yAxisId}
            />
          )
        })}
      </ComposedChart>
    </ChartContainer>
  )
}

// ---------- PieChartCard ---------------------------------------------------

export interface PieSliceSpec {
  /** Stable per-slice key — used for Cell fill / config color. */
  key: string
  /** Value field name in `data`. */
  valueKey: string
  /** Name field name in `data` (used by Tooltip / Legend). */
  nameKey: string
}

export interface PieChartCardProps {
  data: ReadonlyArray<Record<string, unknown>>
  /** ChartConfig — keyed by slice.key with color + label. */
  config: ChartConfig
  /** Slices to render — order is preserved. */
  slices: PieSliceSpec[]
  className?: string
  /** Inner radius (donut hole). Defaults to 60. */
  innerRadius?: number | string
  /** Outer radius. Defaults to 120. */
  outerRadius?: number | string
  /** Show legend. Defaults to true. */
  showLegend?: boolean
  /** Tooltip formatter. */
  tooltipFormatter?: (value: number, name: string) => string | React.ReactNode
}

/**
 * Drop-in PieChart wrapped in the unified ChartContainer. Used by
 * portfolio-pie-chart; a generic consumer can also use this.
 */
export function PieChartCard({
  data,
  config,
  slices,
  className,
  innerRadius = 60,
  outerRadius = 120,
  showLegend = true,
  tooltipFormatter,
}: PieChartCardProps) {
  const isMobile = useMobile()
  const tooltipProps = singleSeriesTooltipContentProps
  const valueKey = slices[0]?.valueKey ?? 'value'
  const nameKey = slices[0]?.nameKey ?? 'name'

  return (
    <ChartContainer config={config} className={cn(defaultChartContainerClass, className)}>
      <PieChart>
        <Pie
          data={data as unknown as object[]}
          dataKey={valueKey}
          nameKey={nameKey}
          innerRadius={isMobile ? Math.round(Number(innerRadius) * 0.7) : innerRadius}
          outerRadius={isMobile ? Math.round(Number(outerRadius) * 0.77) : outerRadius}
          paddingAngle={2}
          stroke="none"
        >
          {data.map((entry, idx) => {
            const slice = slices[idx] ?? slices[0]
            if (!slice) return null
            return <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
          })}
        </Pie>
        <ChartTooltip
          content={
            <ChartTooltipContent
              {...tooltipProps}
              formatter={(value, name) => {
                if (tooltipFormatter) return tooltipFormatter(Number(value), String(name))
                return [String(value), String(name)]
              }}
            />
          }
        />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      </PieChart>
    </ChartContainer>
  )
}
