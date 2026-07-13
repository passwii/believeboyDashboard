'use client'

import { useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import type { ProjectPortfolioKPI } from '@/lib/hooks/use-portfolio-data'

interface PortfolioPieChartProps {
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

type MetricKey = 'sales_amount' | 'order_qty' | 'ad_spend' | 'sessions'

const METRIC_CONFIG: Record<MetricKey, { label: string; field: keyof ProjectPortfolioKPI }> = {
  sales_amount: { label: '销售额', field: 'sales_amount' },
  order_qty: { label: '订单量', field: 'order_qty' },
  ad_spend: { label: '广告费', field: 'ad_spend' },
  sessions: { label: '访问量', field: 'sessions' },
}

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

function formatValue(value: number, metric: MetricKey, country: string): string {
  if (metric === 'sales_amount' || metric === 'ad_spend') {
    return `${CURRENCY_SYMBOL[country] ?? '$'}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return value.toLocaleString('zh-CN')
}

interface TooltipPayloadItem {
  name: string
  value: number
  payload: {
    contribution: number
  }
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-background/95 px-3 py-2 shadow-md backdrop-blur-sm">
      <p className="text-sm font-medium">{payload[0].name}</p>
      <p className="text-xs text-muted-foreground">
        贡献占比: {payload[0].payload.contribution.toFixed(1)}%
      </p>
    </div>
  )
}

export function PortfolioPieChart({ projects, country }: PortfolioPieChartProps) {
  const [metric, setMetric] = useState<MetricKey>('sales_amount')

  const pieData = projects.map((p) => ({
    name: p.project_name,
    value: p[METRIC_CONFIG[metric].field] as number,
    contribution: p[
      METRIC_CONFIG[metric].field === 'sales_amount'
        ? 'sales_contribution'
        : metric === 'order_qty'
          ? 'order_contribution'
          : metric === 'ad_spend'
            ? 'ad_spend_contribution'
            : 'sessions'
    ] as number,
  }))

  if (projects.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">暂无数据</div>
    )
  }

  return (
    <div className="dashboard-surface rounded-xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium">各项目贡献占比</h3>
        <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
          <SelectTrigger className="w-32">
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
      <ResponsiveContainer width="100%" height={350}>
        <PieChart>
          <Pie
            data={pieData}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={120}
            paddingAngle={2}
            dataKey="value"
            nameKey="name"
          >
            {pieData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="none" />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend formatter={(value) => <span className="text-xs">{value}</span>} />
        </PieChart>
      </ResponsiveContainer>
      {/* Contribution table below */}
      <div className="mt-4">
        <div className="flex items-center justify-between border-b px-2 py-1 text-xs font-medium text-muted-foreground">
          <span>项目</span>
          <span>贡献占比</span>
        </div>
        {pieData.map((d, i) => (
          <div
            key={d.name}
            className="flex items-center justify-between border-b px-2 py-1.5 last:border-0"
          >
            <div className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
              />
              <span className="text-sm">{d.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm tabular-nums">{formatValue(d.value, metric, country)}</span>
              <span className="text-xs text-muted-foreground">({d.contribution.toFixed(1)}%)</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
