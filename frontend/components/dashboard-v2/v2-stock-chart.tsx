'use client'

import { Area, AreaChart, XAxis } from 'recharts'
import { Boxes } from 'lucide-react'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { fmtNumPrecise } from '@/lib/dashboard-format'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'

export interface V2StockRow {
  date: string
  available_qty: number
}

export interface V2StockTrend {
  /** 图表行：{ day, qty } */
  rows: { day: string; qty: number }[]
  /** 区间末库存快照 */
  current: number
  /** 上一周期末快照 */
  prev: number
  /** 环比 %（prev>0 时计算，否则 0） */
  delta: number
}

/** 由 summary_rows 计算库存趋势（纯函数，供测试） */
export function computeStockTrend(
  currentRows: V2StockRow[],
  comparisonRows: V2StockRow[] = []
): V2StockTrend {
  const rows = currentRows.map((r) => {
    const [, m, d] = r.date.split('-')
    return { day: `${Number(m)}/${Number(d)}`, qty: r.available_qty ?? 0 }
  })
  const current = rows.length > 0 ? rows[rows.length - 1].qty : 0
  const prev =
    comparisonRows.length > 0 ? (comparisonRows[comparisonRows.length - 1].available_qty ?? 0) : 0
  const delta = prev > 0 ? ((current - prev) / prev) * 100 : 0
  return { rows, current, prev, delta }
}

export interface V2StockChartProps {
  currentRows: V2StockRow[]
  comparisonRows?: V2StockRow[]
  loading?: boolean
}

const chartConfig = {
  qty: {
    label: '可用库存',
    color: '#1d4ed8',
  },
} satisfies ChartConfig

export function V2StockChart({ currentRows, comparisonRows = [], loading }: V2StockChartProps) {
  const { rows, current, delta } = computeStockTrend(currentRows, comparisonRows)

  return (
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-[hsl(var(--surface-subtle)/0.4)] md:col-span-2">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
            <Boxes className="size-4" />
          </span>
          <CardTitle>库存水位</CardTitle>
          <Delta value={delta} variant="badge">
            <DeltaIcon variant="trend" />
            <DeltaValue />
          </Delta>
        </div>
        <CardDescription>可用库存每日变化（近 7 天）</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length > 0 ? (
          <>
            <div className="mb-2 flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums">{fmtNumPrecise(current)}</span>
              <span className="text-xs text-muted-foreground">件 · 区间末快照</span>
            </div>
            <ChartContainer className="aspect-auto h-52 w-full md:h-64" config={chartConfig}>
              <AreaChart accessibilityLayer data={rows} margin={{ left: 4, right: 4, top: 4 }}>
                <defs>
                  <linearGradient id="v2-stock-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-qty)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-qty)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  axisLine={false}
                  dataKey="day"
                  interval={0}
                  tickFormatter={(value) => String(value)}
                  tickLine={false}
                  tickMargin={8}
                />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
                <Area
                  dataKey="qty"
                  fill="url(#v2-stock-fill)"
                  stroke="var(--color-qty)"
                  strokeWidth={2}
                  type="monotone"
                />
              </AreaChart>
            </ChartContainer>
          </>
        ) : (
          <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
            {loading ? '加载中…' : '暂无库存数据'}
          </div>
        )}
      </CardContent>
    </V2Card>
  )
}
