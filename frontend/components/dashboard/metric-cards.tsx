import { ArrowDown, ArrowUp, DollarSign, Users, Activity, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  value: string
  change: string
  changeType: 'up' | 'down' | 'neutral'
  trend: number[]
  icon: React.ReactNode
}

function MetricCard({ title, value, change, changeType, trend, icon }: MetricCardProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const max = Math.max(...trend, 1)
  const min = Math.min(...trend)
  const range = Math.max(max - min, 1)
  const path = trend
    .map((point, index) => {
      const x = (index / Math.max(trend.length - 1, 1)) * 100
      const y = 28 - ((point - min) / range) * 22
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')

  return (
    <Card className="hover-lift animate-enter min-w-[11rem] max-w-[13rem]">
      <CardHeader className="relative z-10 flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="flex flex-col gap-2">
          <p className="dashboard-kicker">{title}</p>
          <CardTitle className="dashboard-display text-[clamp(1.6rem,1.8vw,2rem)]">
            {value}
          </CardTitle>
          <div className="flex items-center gap-1">
            <span
              className={cn(
                'inline-flex items-center text-xs font-medium',
                changeType === 'up'
                  ? 'text-secondary'
                  : changeType === 'down'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              )}
            >
              {changeType === 'up' && <ArrowUp className="mr-0.5 h-3 w-3" />}
              {changeType === 'down' && <ArrowDown className="mr-0.5 h-3 w-3" />}
              {change}
            </span>
          </div>
        </div>
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </CardHeader>
      <CardContent className="relative z-10 px-4 pb-4">
        <div className="h-10 w-full rounded-md bg-[hsl(var(--surface-subtle))] px-1 py-1">
          <svg viewBox="0 0 100 30" className="h-full w-full overflow-visible">
            <defs>
              <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--secondary) / 0.22)" />
                <stop offset="100%" stopColor="hsl(var(--secondary) / 0)" />
              </linearGradient>
            </defs>
            <path d={`${path} L 100 30 L 0 30 Z`} fill={`url(#spark-${gradientId})`} />
            <path
              d={path}
              fill="none"
              stroke="hsl(var(--secondary))"
              strokeWidth="2.25"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </CardContent>
    </Card>
  )
}

function MetricCardSkeleton() {
  return (
    <Card className="min-w-[11rem] max-w-[13rem]">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-11 w-11 rounded-lg" />
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Skeleton className="h-10 w-full rounded-md" />
      </CardContent>
    </Card>
  )
}

interface MetricCardsProps {
  metrics?: MetricCardProps[]
  loading?: boolean
}

export function MetricCards({ metrics, loading = false }: MetricCardsProps) {
  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (!metrics) {
    metrics = [
      {
        title: '销售额',
        value: '$0.00',
        change: '+0.0%',
        changeType: 'neutral' as const,
        trend: [0, 0, 0, 0, 0, 0, 0],
        icon: <DollarSign className="h-4 w-4" />,
      },
      {
        title: '订单量',
        value: '0',
        change: '+0.0%',
        changeType: 'neutral' as const,
        trend: [0, 0, 0, 0, 0, 0, 0],
        icon: <Users className="h-4 w-4" />,
      },
      {
        title: '广告投放比',
        value: '0.0%',
        change: '0.0%',
        changeType: 'neutral' as const,
        trend: [0, 0, 0, 0, 0, 0, 0],
        icon: <Activity className="h-4 w-4" />,
      },
      {
        title: '增长指数',
        value: '+0.0%',
        change: '+0.0%',
        changeType: 'neutral' as const,
        trend: [0, 0, 0, 0, 0, 0, 0],
        icon: <TrendingUp className="h-4 w-4" />,
      },
    ]
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.title} {...metric} />
      ))}
    </div>
  )
}

export type { MetricCardProps }
