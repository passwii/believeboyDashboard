'use client'

import { useMemo, useState } from 'react'
import {
  Pie,
  PieChart,
  Cell,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/charts'
import { WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { useMobile } from '@/lib/hooks/use-mobile'
import type { ProjectPortfolioKPI } from '@/lib/hooks/use-portfolio-data'

interface PortfolioPieChartProps {
  projects: ProjectPortfolioKPI[]
  country: string
}

/** Page-local Warm Ledger chart colors are supplied through the existing `--chart-N` variables. */
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

export function PortfolioPieChart({ projects, country }: PortfolioPieChartProps) {
  const [metric, setMetric] = useState<MetricKey>('sales_amount')
  const isMobile = useMobile()
  const isSessionsMetric = metric === 'sessions'

  // 图例/tooltip 的 label 解析：ChartLegendContent 走 item.value（= 项目名），
  // ChartTooltipContent 走 item.name（= 项目名）——都以项目名为 config key。
  const chartConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {}
    projects.forEach((p, idx) => {
      cfg[p.project_name] = {
        label: p.project_name,
        color: CHART_COLORS[idx % CHART_COLORS.length],
      }
    })
    return cfg
  }, [projects])

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
      <div className="flex h-64 items-center justify-center font-mono text-xs leading-5 text-term-muted">
        暂无数据
      </div>
    )
  }

  return (
    <div
      data-portfolio-pie-chart
      className="rounded-none border border-term-border bg-term-bg p-3 sm:p-4"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-xs uppercase tracking-wider text-term-text">
          {isSessionsMetric ? '各项目访问量' : '各项目贡献占比'}
        </h3>
        <WarmSelect
          id="portfolio-pie-metric"
          label="图表指标"
          value={metric}
          options={(Object.keys(METRIC_CONFIG) as MetricKey[]).map((key) => ({
            value: key,
            label: METRIC_CONFIG[key].label,
          }))}
          onChange={(value) => setMetric(value as MetricKey)}
          className="portfolio-pie-metric-select"
        />
      </div>
      <ChartContainer config={chartConfig} className="h-[260px] w-full sm:h-[350px]">
        <PieChart>
          <Pie
            data={pieData}
            cx="50%"
            cy="50%"
            innerRadius={isMobile ? 42 : 60}
            outerRadius={isMobile ? 92 : 120}
            paddingAngle={2}
            dataKey="value"
            nameKey="name"
          >
            {pieData.map((d, i) => (
              <Cell
                key={d.name}
                fill={CHART_COLORS[i % CHART_COLORS.length]}
                stroke="none"
              />
            ))}
          </Pie>
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, _name, item) => {
                  const payload = item?.payload as { contribution?: number } | undefined
                  return (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
                        {formatValue(Number(value), metric, country)}
                      </span>
                      {!isSessionsMetric && payload?.contribution !== undefined && (
                        <span className="font-mono text-[11px] leading-4 text-term-muted">
                          ({payload.contribution.toFixed(1)}%)
                        </span>
                      )}
                    </div>
                  )
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
        </PieChart>
      </ChartContainer>
      {/* Contribution table below */}
      <div className="mt-4">
        <div className="flex items-center justify-between border-b border-term-border px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-term-muted">
          <span>项目</span>
          <span>{isSessionsMetric ? METRIC_CONFIG[metric].label : '贡献占比'}</span>
        </div>
        {pieData.map((d, i) => (
          <div
            key={d.name}
            className="flex items-center justify-between gap-3 border-b border-term-border px-2 py-1.5 last:border-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-none"
                style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
              />
              <span className="truncate font-mono text-xs leading-5 text-term-text">{d.name}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
                {formatValue(d.value, metric, country)}
              </span>
              {!isSessionsMetric && (
                <span className="font-mono text-[11px] leading-4 text-term-muted">
                  ({d.contribution.toFixed(1)}%)
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
