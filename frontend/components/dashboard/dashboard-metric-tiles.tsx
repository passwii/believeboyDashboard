'use client'

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface MetricTileProps {
  title: string
  value: string
  change: string
  changeType: 'up' | 'down' | 'neutral'
  trend: number[]
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
        'hover-lift animate-enter relative rounded-xl border border-border/50 bg-background/70 p-5 backdrop-blur-sm transition-all duration-200',
        className
      )}
    >
      {children}
    </div>
  )
}

function SparkLineSvg({
  gradientId,
  accentColor,
  children,
}: {
  gradientId: string
  accentColor?: string
  children: React.ReactNode
}) {
  const color = accentColor || 'hsl(var(--secondary))'
  return (
    <svg viewBox="0 0 100 30" className="h-full w-full overflow-visible">
      <defs>
        <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {children}
    </svg>
  )
}

function buildSparklinePath(trend: number[]): string {
  const max = Math.max(...trend, 1)
  const min = Math.min(...trend)
  const range = Math.max(max - min, 1)
  return trend
    .map((point, index) => {
      const x = (index / Math.max(trend.length - 1, 1)) * 100
      const y = 28 - ((point - min) / range) * 22
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')
}

function AcosTile({
  title,
  value,
  change,
  changeType,
  trend,
  icon,
  badge,
  badgeColor,
}: MetricTileProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const path = buildSparklinePath(trend)

  const bgClass = cn(
    badgeColor === 'green' && 'bg-secondary/5',
    badgeColor === 'yellow' && 'bg-amber-500/5',
    badgeColor === 'red' && 'bg-destructive/5',
  )

  return (
    <TileCard className={bgClass}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <p className="dashboard-kicker">{title}</p>
          <p className="dashboard-display text-[clamp(1.8rem,2.8vw,2.6rem)]">{value}</p>
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
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </div>
      <div className="mt-2 h-8 w-full">
        <SparkLineSvg gradientId={gradientId}>
          <path d={`${path} L 100 30 L 0 30 Z`} fill={`url(#spark-${gradientId})`} />
          <path d={path} fill="none" stroke="hsl(var(--secondary))" strokeWidth="2.25" strokeLinecap="round" />
        </SparkLineSvg>
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
  icon,
  accentColor,
}: MetricTileProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const path = buildSparklinePath(trend)
  const lineColor = accentColor || 'hsl(var(--secondary))'

  return (
    <TileCard>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <p className="dashboard-kicker">{title}</p>
          <p className="dashboard-display text-[clamp(1.8rem,2.8vw,2.6rem)]">{value}</p>
          <ChangeIndicator change={change} type={changeType} />
        </div>
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </div>
      <div className="mt-2 h-8 w-full">
        <SparkLineSvg gradientId={gradientId} accentColor={lineColor}>
          <path d={`${path} L 100 30 L 0 30 Z`} fill={`url(#spark-${gradientId})`} />
          <path d={path} fill="none" stroke={lineColor} strokeWidth="2.25" strokeLinecap="round" />
        </SparkLineSvg>
      </div>
    </TileCard>
  )
}

function MetricTileSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-background/70 p-5 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-14" />
        </div>
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>
      <Skeleton className="mt-2 h-8 w-full rounded" />
    </div>
  )
}

export interface DashboardMetricTilesProps {
  metrics?: MetricTileProps[]
  loading?: boolean
}

export function DashboardMetricTiles({ metrics, loading = false }: DashboardMetricTilesProps) {
  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (!metrics || metrics.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {metrics.map((metric) =>
        metric.title === '广告成本比' ? (
          <AcosTile key={metric.title} {...metric} />
        ) : (
          <DefaultTile
            key={metric.title}
            {...metric}
            accentColor={
              metric.title === '销售额'
                ? 'hsl(var(--secondary))'
                : metric.title === '订单量'
                  ? 'hsl(var(--chart-2))'
                  : undefined
            }
          />
        )
      )}
    </div>
  )
}