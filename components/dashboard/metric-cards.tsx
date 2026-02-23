import {
  ArrowDown,
  ArrowUp,
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
  description: string
  icon: React.ReactNode
}

function MetricCard({
  title,
  value,
  change,
  changeType,
  description,
  icon,
}: MetricCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground">
          <span
            className={`inline-flex items-center ${
              changeType === 'up'
                ? 'text-green-600 dark:text-green-400'
                : changeType === 'down'
                ? 'text-red-600 dark:text-red-400'
                : 'text-muted-foreground'
            }`}
          >
            {changeType === 'up' && <ArrowUp className="mr-1 h-3 w-3" />}
            {changeType === 'down' && <ArrowDown className="mr-1 h-3 w-3" />}
            {change}
          </span>{' '}
          {description}
        </p>
      </CardContent>
    </Card>
  )
}

export function MetricCards() {
  const metrics = [
    {
      title: 'Total Revenue',
      value: '$45,231.89',
      change: '+20.1%',
      changeType: 'up' as const,
      description: 'from last month',
      icon: <DollarSign className="h-4 w-4 text-muted-foreground" />,
    },
    {
      title: 'New Customers',
      value: '+2,350',
      change: '+180.1%',
      changeType: 'up' as const,
      description: 'from last month',
      icon: <Users className="h-4 w-4 text-muted-foreground" />,
    },
    {
      title: 'Active Accounts',
      value: '+12,234',
      change: '+19%',
      changeType: 'up' as const,
      description: 'from last month',
      icon: <Activity className="h-4 w-4 text-muted-foreground" />,
    },
    {
      title: 'Growth Rate',
      value: '+4.5%',
      change: '+4.5%',
      changeType: 'up' as const,
      description: 'from last month',
      icon: <TrendingUp className="h-4 w-4 text-muted-foreground" />,
    },
  ]

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.title} {...metric} />
      ))}
    </div>
  )
}
