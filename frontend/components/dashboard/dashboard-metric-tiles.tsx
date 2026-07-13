'use client'

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { AreaSparkline } from './area-sparkline'

export interface MetricTileProps {
  title: string
  value: string
  change: string
  changeType: 'up' | 'down' | 'neutral'
  trend: number[]
  /** Date labels for tooltip (e.g. ["6/1", "6/2", ...]) */
  labels?: string[]
  /** Formats a trend value for the tooltip display */
  formatValue?: (value: number) => string
  icon: React.ReactNode
  accentColor?: string
  badge?: string
  badgeColor?: string
}

function ChangeIndicator({ change, type }: { change: string; type: 'up' | 'down' | 'neutral' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-xs font-medium',
        type === 'up' && 'text-secondary',
        type === 'down' && 'text-destructive',
        type === 'neutral' && 'text-muted-foreground'
      )}
    >
      {type === 'up' && <ArrowUp className="mr-0.5 h-3 w-3" />}
      {type === 'down' && <ArrowDown className="mr-0.5 h-3 w-3" />}
      {type === 'neutral' && <Minus className="mr-0.5 h-3 w-3" />}
      {change}
    </span>
  )
}

function TileCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'hover-lift animate-enter relative flex flex-col rounded-xl border border-border/50 bg-background/70 backdrop-blur-sm transition-all duration-200 overflow-hidden',
        className
      )}
    >
      {children}
    </div>
  )
}

function RoasTile({
  title,
  value,
  change,
  changeType,
  trend,
  labels,
  formatValue,
  icon,
  badge,
  badgeColor,
}: MetricTileProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')

  const bgClass = cn(
    badgeColor === 'green' && 'bg-secondary/5',
    badgeColor === 'yellow' && 'bg-amber-500/5',
    badgeColor === 'red' && 'bg-destructive/5'
  )

  return (
    <TileCard className={bgClass}>
      <div className="flex items-start justify-between gap-2.5 px-3.5 pt-4 pb-2 sm:gap-3 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="dashboard-kicker truncate">{title}</p>
          {/*
           * Display number: floor 1.5rem (24px) prevents phone blow-up
           * when the tile is ~158px wide; ceiling 2.4rem (38.4px) keeps
           * desktop KPI punch. 1.2vw mid-term gives gentle growth from
           * phone -> iPad Pro landscape without a hard jump.
           */}
          <p className="dashboard-display text-[clamp(1.5rem,1.2rem+1.2vw,2.4rem)] leading-none">
            {value}
          </p>
          <div className="flex items-center gap-1.5">
            <ChangeIndicator change={change} type={changeType} />
            {badge && (
              <span
                className={cn(
                  'inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  badgeColor === 'green' && 'bg-secondary/10 text-secondary',
                  badgeColor === 'yellow' && 'bg-amber-500/10 text-amber-600',
                  badgeColor === 'red' && 'bg-destructive/10 text-destructive'
                )}
              >
                {badge}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 rounded-lg bg-[hsl(var(--chart-3))]/10 p-2 text-[hsl(var(--chart-3))] sm:p-2.5">
          {icon}
        </div>
      </div>
      <div className="flex-1 min-h-[60px] px-3.5 pb-3.5 pt-1 sm:min-h-[72px] sm:px-5 sm:pb-4">
        <AreaSparkline
          trend={trend}
          gradientId={gradientId}
          strokeColor="hsl(var(--chart-3))"
          labels={labels}
          formatValue={formatValue}
        />
      </div>
    </TileCard>
  )
}

function DefaultTile({
  title,
  value,
  change,
  changeType,
  trend,
  labels,
  formatValue,
  icon,
  accentColor,
}: MetricTileProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const lineColor = accentColor || 'hsl(var(--secondary))'

  return (
    <TileCard>
      <div className="flex items-start justify-between gap-2.5 px-3.5 pt-4 pb-2 sm:gap-3 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="dashboard-kicker truncate">{title}</p>
          <p className="dashboard-display text-[clamp(1.5rem,1.2rem+1.2vw,2.4rem)] leading-none">
            {value}
          </p>
          <ChangeIndicator change={change} type={changeType} />
        </div>
        <div className="shrink-0 rounded-lg bg-secondary/10 p-2 text-secondary sm:p-2.5">
          {icon}
        </div>
      </div>
      <div className="flex-1 min-h-[60px] px-3.5 pb-3.5 pt-1 sm:min-h-[72px] sm:px-5 sm:pb-4">
        <AreaSparkline
          trend={trend}
          gradientId={gradientId}
          strokeColor={lineColor}
          labels={labels}
          formatValue={formatValue}
        />
      </div>
    </TileCard>
  )
}

function MetricTileSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border border-border/50 bg-background/70 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2.5 px-3.5 pt-4 pb-2 sm:gap-3 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-24 sm:w-28" />
          <Skeleton className="h-3 w-14" />
        </div>
        <Skeleton className="h-9 w-9 shrink-0 rounded-lg sm:h-10 sm:w-10" />
      </div>
      <div className="flex-1 min-h-[60px] px-3.5 pb-3.5 pt-1 sm:min-h-[72px] sm:px-5 sm:pb-4">
        <Skeleton className="h-full w-full rounded" />
      </div>
    </div>
  )
}

export interface DashboardMetricTilesProps {
  metrics?: MetricTileProps[]
  loading?: boolean
}

export function DashboardMetricTiles({ metrics, loading = false }: DashboardMetricTilesProps) {
  /*
   * Grid breakpoints:
   *   phone  (<640px)        : 2 columns  -> 2x2 stack, no truncation
   *   sm     (640-767px)     : 4 columns  -> single 4-wide row
   *   md/iPad (768-1023px)   : 2 columns  -> 2x2 stack, tiles are wide
   *                             enough for the sparkline to breathe
   *   lg+    (>=1024px)      : 2 columns  -> stays 2x2 inside the
   *                             2fr/3fr parent grid, so it's actually
   *                             2x2 next to the chart (4 tiles total
   *                             visible at once)
   *
   * The 4-col sm range is the phone-friendly mode. On a 700px tablet
   * (iPad Mini portrait) we drop back to 2-col so each tile gets
   * ~360px of width and the sparkline + label fit on one line.
   */
  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (!metrics || metrics.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4 md:grid-cols-2">
      {metrics.map((metric) =>
        metric.title === '广告投放比' ? (
          <RoasTile key={metric.title} {...metric} />
        ) : (
          <DefaultTile
            key={metric.title}
            {...metric}
            accentColor={
              metric.title === '销售额'
                ? 'hsl(var(--chart-1))'
                : metric.title === '订单量'
                  ? 'hsl(var(--chart-3))'
                  : undefined
            }
          />
        )
      )}
    </div>
  )
}
