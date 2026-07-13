'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Line, LineChart, XAxis, YAxis } from 'recharts'

import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/line-charts-6'

/**
 * demo.tsx — line-charts-6 重构参考示例
 *
 * 区别于原 demo.tsx（指向 components/login 重新导出）：
 * - 直接基于项目里既有的 `DailyAnalysisRow` 数据结构，不写死 18 行假数据。
 * - 演示 `line-charts-6` 的核心能力：单 line + 可切换 metric + 渐变投影 + 圆点网格。
 * - 作为后续把 dashboard / data-analysis / financial-data 三个页面里的 line / area
 *   chart 统一收口到 line-charts-6 的参考样例。
 *
 * 在生产页面里：
 * - 真实数据通过 fetch / props 传入（这里是 mockDailyData，是 DailyAnalysisRow[]）
 * - 颜色建议从 `hsl(var(--chart-*))` 读取，与现有 chart.tsx 保持一致
 *
 * 依赖：components/ui/badge + components/ui/card 已存在。
 * `ChartContainer` / `ChartTooltip` / `ChartTooltipContent` / `ChartConfig`
 * 来自同目录的 `line-charts-6.tsx`。
 */

// 与 app/dashboard/page.tsx 中 DailyAnalysisRow 字段对齐
type DailyAnalysisRow = {
  date: string
  sales_amount: number
  order_qty: number
  ad_spend: number
  ad_orders: number
  sessions: number
  conversion_rate: number
}

type MetricKey = 'sales_amount' | 'order_qty' | 'ad_spend' | 'sessions'

type MetricDef = {
  key: MetricKey
  label: string
  isNegativeBetter?: boolean
  format: (val: number) => string
}

// 真实业务里这几条 metric 是首页"销售概览"同口径聚合值；这里走 mock，
// 但形态与 dashboard-sales-chart 一致（基于 DailyAnalysisRow[] reduce）。
const mockDailyData: DailyAnalysisRow[] = Array.from({ length: 18 }).map((_, i) => {
  const day = String(i + 1).padStart(2, '0')
  return {
    date: `2024-04-${day}`,
    sales_amount: 1500 + Math.round(Math.sin(i / 2) * 600 + i * 30),
    order_qty: 60 + Math.round(Math.cos(i / 3) * 18 + i),
    ad_spend: 200 + Math.round(Math.sin(i) * 50 + i * 4),
    ad_orders: 8 + Math.round(Math.cos(i) * 4 + i * 0.5),
    sessions: 1200 + Math.round(Math.sin(i / 1.5) * 300 + i * 12),
    conversion_rate: 0.05 + Math.sin(i) * 0.01,
  }
})

const metrics: MetricDef[] = [
  {
    key: 'sales_amount',
    label: '销售额',
    format: (val) => `$${val.toLocaleString()}`,
  },
  {
    key: 'order_qty',
    label: '订单量',
    format: (val) => val.toLocaleString(),
  },
  {
    key: 'ad_spend',
    label: '广告花费',
    isNegativeBetter: true,
    format: (val) => `$${val.toLocaleString()}`,
  },
  {
    key: 'sessions',
    label: '会话数',
    format: (val) => val.toLocaleString(),
  },
]

// 使用项目里既有的 CSS 变量，与 chart.tsx 配色方案对齐
const chartConfig = {
  sales_amount: { label: '销售额', color: 'hsl(var(--chart-1))' },
  order_qty: { label: '订单量', color: 'hsl(var(--chart-2))' },
  ad_spend: { label: '广告花费', color: 'hsl(var(--chart-4))' },
  sessions: { label: '会话数', color: 'hsl(var(--chart-6))' },
} satisfies ChartConfig

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ dataKey?: string; value?: number; color?: string }>
  label?: string
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const entry = payload[0]
  if (!entry?.dataKey) return null
  const metric = metrics.find((m) => m.key === entry.dataKey)
  if (!metric || entry.value === undefined) return null
  return (
    <div className="rounded-lg border border-border/50 bg-popover px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: entry.color }} />
        <span className="text-muted-foreground">{metric.label}:</span>
        <span className="font-semibold text-popover-foreground">{metric.format(entry.value)}</span>
      </div>
    </div>
  )
}

export function LineChartsSixDemo() {
  const [selectedMetric, setSelectedMetric] = React.useState<MetricKey>('sales_amount')

  // 聚合当前周期 vs 上一周期的变化（取数据前后两半做"对比"）
  const { currentTotal, previousTotal } = React.useMemo(() => {
    const half = Math.floor(mockDailyData.length / 2)
    const current = mockDailyData.slice(half)
    const previous = mockDailyData.slice(0, half)
    return {
      currentTotal: current.reduce((sum, row) => sum + row[selectedMetric], 0),
      previousTotal: previous.reduce((sum, row) => sum + row[selectedMetric], 0),
    }
  }, [selectedMetric])

  const metric = metrics.find((m) => m.key === selectedMetric)!
  const change = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0
  const isPositive = metric.isNegativeBetter ? change < 0 : change > 0

  return (
    <Card className="@container w-full max-w-4xl">
      <CardHeader className="space-y-4 p-0">
        <div className="grid @2xl:grid-cols-2 @3xl:grid-cols-4 grow">
          {metrics.map((m) => {
            const isActive = m.key === selectedMetric
            // 当前 metric 不再计算复杂 change，只做"是否被选中"高亮
            const half = Math.floor(mockDailyData.length / 2)
            const halfTotal = mockDailyData.slice(half).reduce((sum, row) => sum + row[m.key], 0)
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setSelectedMetric(m.key)}
                className={cn(
                  'flex-1 cursor-pointer border-b p-4 text-start transition-colors last:border-b-0',
                  '@2xl:border-b @2xl:even:border-e',
                  '@3xl:border-b-0 @3xl:border-e @3xl:last:border-e-0',
                  'border-border/60',
                  isActive && 'bg-muted/50'
                )}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{m.label}</span>
                  {m.key === selectedMetric && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        'gap-1 text-[10px]',
                        isPositive
                          ? 'bg-secondary/10 text-secondary'
                          : 'bg-destructive/10 text-destructive'
                      )}
                    >
                      {isPositive ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      )}
                      {Math.abs(change).toFixed(1)}%
                    </Badge>
                  )}
                </div>
                <div className="text-2xl font-bold tabular-nums">{m.format(halfTotal)}</div>
                <div className="mt-1 text-xs text-muted-foreground">近 9 日合计</div>
              </button>
            )
          })}
        </div>
      </CardHeader>

      <CardContent className="px-2.5 py-6">
        <ChartContainer config={chartConfig} className="h-96 w-full">
          <LineChart data={mockDailyData} margin={{ top: 20, right: 20, left: 5, bottom: 20 }}>
            <defs>
              {/* 圆点网格背景，与 snippet 的视觉风格保持一致 */}
              <pattern
                id="line-charts-6-dot-grid"
                x="0"
                y="0"
                width="20"
                height="20"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="10" cy="10" r="1" fill="hsl(var(--input))" fillOpacity="1" />
              </pattern>
            </defs>

            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickMargin={10}
              tickFormatter={(value) => {
                const date = new Date(value)
                return date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })
              }}
            />

            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickMargin={10}
              tickCount={6}
              tickFormatter={(value) => metric.format(Number(value))}
            />

            <ChartTooltip content={<CustomTooltip />} cursor={false} />

            <rect
              x="60px"
              y="-20px"
              width="calc(100% - 75px)"
              height="calc(100% - 10px)"
              fill="url(#line-charts-6-dot-grid)"
              style={{ pointerEvents: 'none' }}
            />

            <Line
              type="monotone"
              dataKey={selectedMetric}
              stroke={`var(--color-${selectedMetric})`}
              strokeWidth={2}
              dot={false}
              activeDot={{
                r: 6,
                fill: `var(--color-${selectedMetric})`,
                stroke: 'white',
                strokeWidth: 2,
              }}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export default function Demo() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6 lg:p-8">
      <LineChartsSixDemo />
    </div>
  )
}
