'use client'

import { useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ProjectPortfolioKPI } from '@/lib/hooks/use-portfolio-data'

interface PortfolioTrendChartProps {
  projects: ProjectPortfolioKPI[]
  country: string
}

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-6))',
  'hsl(var(--chart-7))',
  'hsl(var(--chart-8))',
]

type MetricKey = 'sales_amount' | 'order_qty' | 'ad_spend' | 'conversion_rate'

const METRIC_CONFIG: Record<MetricKey, { label: string; color: string }> = {
  sales_amount: { label: '销售额', color: CHART_COLORS[0] },
  order_qty: { label: '订单量', color: CHART_COLORS[1] },
  ad_spend: { label: '广告费', color: CHART_COLORS[2] },
  conversion_rate: { label: '转化率', color: CHART_COLORS[3] },
}

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

function formatMetricValue(value: number, metric: MetricKey, country: string): string {
  if (metric === 'sales_amount' || metric === 'ad_spend') {
    return `${CURRENCY_SYMBOL[country] ?? '$'}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (metric === 'conversion_rate') return `${value.toFixed(2)}%`
  return value.toLocaleString('zh-CN')
}

export function PortfolioTrendChart({ projects, country }: PortfolioTrendChartProps) {
  const [metric, setMetric] = useState<MetricKey>('sales_amount')

  // Build chart data: merge all project daily trends by date
  const chartData = (() => {
    type ChartEntry = Record<string, string | number>
    const dateMap = new Map<string, ChartEntry>()

    for (const project of projects) {
      for (const row of project.daily_trend) {
        if (!dateMap.has(row.date)) {
          dateMap.set(row.date, { date: row.date })
        }
        const entry = dateMap.get(row.date)!
        const key = `p${project.project_id}_${metric}`
        entry[key] = ((entry[key] as number) || 0) + ((row[metric] as number) || 0)
      }
    }

    return Array.from(dateMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, entry]) => entry)
  })()

  if (projects.length === 0) {
    return (
      <div className='flex h-64 items-center justify-center text-muted-foreground'>
        暂无趋势数据
      </div>
    )
  }

  return (
    <div className='dashboard-surface rounded-xl p-4'>
      <div className='mb-4 flex items-center justify-between'>
        <h3 className='text-sm font-medium'>多项目趋势对比</h3>
        <Select
          value={metric}
          onValueChange={(v) => setMetric(v as MetricKey)}
        >
          <SelectTrigger className='w-32'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(METRIC_CONFIG) as MetricKey[]).map((k) => (
              <SelectItem key={k} value={k}>
                {METRIC_CONFIG[k].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ResponsiveContainer width='100%' height={350}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' />
          <XAxis
            dataKey='date'
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => v.slice(5)}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => formatMetricValue(v, metric, country)}
          />
          <Tooltip
            formatter={(value: number) => [formatMetricValue(value, metric, country), '']}
            labelFormatter={(label) => `日期: ${label}`}
          />
          <Legend />
          {projects.map((p, i) => (
            <Line
              key={p.project_id}
              type='monotone'
              dataKey={`p${p.project_id}_${metric}`}
              name={p.project_name}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}