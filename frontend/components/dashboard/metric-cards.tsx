import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  DollarSign,
  Users,
  Activity,
  TrendingUp,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface MetricCardProps {
  title: string
  value: string
  change: string
  changeType: 'up' | 'down' | 'neutral'
  trend: number[]
  icon: React.ReactNode
}

function MetricCard({
  title,
  value,
  change,
  changeType,
  trend,
  icon,
}: MetricCardProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const max = Math.max(...trend)
  const min = Math.min(...trend)
  const path = trend
    .map((point, index) => {
      const x = (index / (trend.length - 1)) * 100
      const y = 28 - ((point - min) / Math.max(max - min, 1)) * 22
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')

  return (
    <Card className="hover-lift animate-enter min-w-[13rem]">
      <CardHeader className="relative z-10 flex flex-row items-start justify-between space-y-0 pb-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="dashboard-kicker">{title}</p>
            <span
              className={`inline-flex items-center text-xs font-medium ${
                changeType === 'up'
                  ? 'text-secondary'
                  : changeType === 'down'
                  ? 'text-destructive'
                  : 'text-muted-foreground'
              }`}
            >
              {changeType === 'up' && <ArrowUp className="mr-0.5 h-3 w-3" />}
              {changeType === 'down' && <ArrowDown className="mr-0.5 h-3 w-3" />}
              {change}
              {changeType === 'neutral' && <ArrowRight className="ml-1 h-3 w-3" />}
            </span>
          </div>
          <CardTitle className="dashboard-display text-[clamp(2rem,2.4vw,2.55rem)]">{value}</CardTitle>
        </div>
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </CardHeader>
      <CardContent className="relative z-10">
        <div className="h-12 w-full rounded-md bg-[hsl(var(--surface-subtle))] px-1 py-1">
          <svg viewBox="0 0 100 30" className="h-full w-full overflow-visible">
            <defs>
              <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--secondary) / 0.22)" />
                <stop offset="100%" stopColor="hsl(var(--secondary) / 0)" />
              </linearGradient>
            </defs>
            <path d={`${path} L 100 30 L 0 30 Z`} fill={`url(#spark-${gradientId})`} />
            <path d={path} fill="none" stroke="hsl(var(--secondary))" strokeWidth="2.25" strokeLinecap="round" />
          </svg>
        </div>
      </CardContent>
    </Card>
  )
}

export function MetricCards() {
  const metrics = [
    {
      title: '销售额',
      value: '$19,791.72',
      change: '+12.4%',
      changeType: 'up' as const,
      trend: [15, 18, 16, 21, 20, 24, 28],
      icon: <DollarSign className="h-4 w-4" />,
    },
    {
      title: '订单量',
      value: '1,284',
      change: '+8.2%',
      changeType: 'up' as const,
      trend: [10, 12, 11, 15, 14, 18, 17],
      icon: <Users className="h-4 w-4" />,
    },
    {
      title: 'Ad Cost Ratio',
      value: '21.4%',
      change: '-1.3%',
      changeType: 'down' as const,
      trend: [24, 25, 23, 24, 22, 22, 21],
      icon: <Activity className="h-4 w-4" />,
    },
    {
      title: 'Growth Index',
      value: '+14.6%',
      change: '+4.8%',
      changeType: 'up' as const,
      trend: [8, 10, 13, 12, 16, 18, 21],
      icon: <TrendingUp className="h-4 w-4" />,
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.title} {...metric} />
      ))}
    </div>
  )
}
