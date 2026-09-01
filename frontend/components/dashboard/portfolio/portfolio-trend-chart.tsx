'use client'

import { useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
  ChartCard,
} from '@/components/charts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMobile } from '@/lib/hooks/use-mobile'
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
  const isMobile = useMobile()

  // 图例/tooltip 的 label 解析：ChartLegendContent 走 item.value（= name），
  // ChartTooltipContent 走 item.name —— 都以项目名为 config key。
  const chartConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {}
    projects.forEach((p) => {
      cfg[p.project_name] = { label: p.project_name }
    })
    return cfg
  }, [projects])

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
      <div className="flex h-64 items-center justify-center font-mono text-xs leading-5 text-term-muted">
        暂无趋势数据
      </div>
    )
  }

  return (
    <ChartCard
      title="多项目趋势对比"
      actions={
        <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
          <SelectTrigger className="h-9 w-32 rounded-none border-term-border bg-term-bg font-mono text-xs leading-5 text-term-text shadow-none focus-visible:outline-none focus-visible:border-term-border-strong">
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
      }
    >
      <ChartContainer config={chartConfig} className="h-[300px] w-full sm:h-[350px]">
        <LineChart
          data={chartData}
          margin={
            isMobile
              ? { top: 5, right: 8, left: -28, bottom: 5 }
              : { top: 5, right: 20, left: 10, bottom: 5 }
          }
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--term-border))" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
          {/* 手机端隐藏 Y 轴消除留白（规则：图表区域手机端优化），tooltip 仍可读精确值 */}
          {!isMobile && (
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => formatMetricValue(v, metric, country)}
            />
          )}
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => `日期: ${label}`}
                formatter={(value, name) => (
                  <div className="flex w-full items-center justify-between gap-4">
                    <span className="font-mono text-[11px] leading-4 text-term-muted">
                      {String(name)}
                    </span>
                    <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
                      {formatMetricValue(Number(value), metric, country)}
                    </span>
                  </div>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {projects.map((p, i) => (
            <Line
              key={p.project_id}
              type="monotone"
              dataKey={`p${p.project_id}_${metric}`}
              name={p.project_name}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </ChartCard>
  )
}