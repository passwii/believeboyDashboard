"use client"

import * as React from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/line-charts-6"

/**
 * MetricSwitcherCard
 *
 * 单 line + 顶部 metric 切换的通用卡片，包装 `line-charts-6`。
 * 适配项目里的场景：
 *   - 首页"销售概览"（dashboard-sales-chart 的简化版，不带比较周期）
 *   - data-analysis 通用 KPI 趋势
 *   - financial-data 选中一个指标做月度趋势
 *   - data-analysis/daily-analysis（line 视图，可选虚线对比）
 *
 * 与 `dashboard-sales-chart` / `dashboard-ad-spend-chart` 的区别：
 *   - 单一 metric 不画 Bar + Line 双 Y 轴的复杂组合图
 *   - 上方 metric 切换用 button 网格（参考 demo.tsx），不用 Badge + 一段 KPI 拼凑
 *   - 颜色直接读 CSS 变量（与 chart.tsx 配色方案对齐）
 *
 * 两条使用路径：
 *
 *   1. 简单模式 — 传入 data + xKey + metrics，组件自动从 data 求和；
 *      用于没有"上一周期对比"的场景。
 *
 *   2. 计算模式 — 不传 data，传入 `getCurrent` / `getPrevious` 函数 + 可选
 *      `renderLine` 渲染函数；用于 daily-analysis 这类已经有现成 metric
 *      聚合值 + 自定义 chart rows 的场景。
 */

export type MetricDef<K extends string> = {
  key: K
  label: string
  /** 数值越小越好的 metric（例如广告花费）；为 true 时 change < 0 视为正向 */
  isNegativeBetter?: boolean
  /** 把 raw number 渲染为中文/带单位的字符串 */
  format: (val: number) => string
}

export interface MetricSwitcherCardProps<K extends string> {
  title?: string
  description?: string
  /** 简单模式：直接传入行数据 + xKey；组件按 metric.key 取数并求和 */
  data?: Array<Record<string, unknown>>
  xKey?: string
  metrics: MetricDef<K>[]
  defaultMetric: K
  /** 颜色表：每个 metric 的颜色，未提供则回退到 chart-* CSS 变量 */
  colors?: Partial<Record<K, string>>
  heightClass?: string
  /** metric 是否用 Badge 显示变化百分比，否则只显示数字 */
  showChange?: boolean
  /** 自定义 x 轴 formatter */
  xTickFormatter?: (value: string) => string
  /**
   * 计算模式：传入"当前周期值"和"上一周期值"取数函数。
   * 业务里通常对应 aggregateMetric(rows, metricKey) — 已存在 daily-analysis。
   * 不传则回退到 data 求和。
   */
  getCurrent?: (metricKey: K) => number
  getPrevious?: (metricKey: K) => number | null
  /**
   * 计算模式：传入 chart rows（带 compareMetricValue 等字段）。
   * 不传则回退到 data 求和。
   */
  renderLine?: (metricKey: K) => Array<Record<string, unknown>>
  /**
   * 计算模式：传入 tooltip formatter，每条 series 自定义渲染。
   * 不传则用默认 formatter（按 metric.format 渲染）。
   */
  tooltipFormatter?: (
    value: number,
    metricKey: K,
  ) => React.ReactNode
  /**
   * 计算模式：传入 y 轴 formatter；不传则用 metric.format。
   */
  yAxisFormatter?: (value: number, metricKey: K) => string
}

export function MetricSwitcherCard<K extends string>({
  title,
  description,
  data,
  xKey,
  metrics,
  defaultMetric,
  colors,
  heightClass = "h-80",
  showChange = true,
  xTickFormatter,
  getCurrent,
  getPrevious,
  renderLine,
  tooltipFormatter,
  yAxisFormatter,
}: MetricSwitcherCardProps<K>) {
  const [selected, setSelected] = React.useState<K>(defaultMetric)
  const metric = metrics.find((m) => m.key === selected) ?? metrics[0]

  // 把当前选中 metric 数值映射成 ChartConfig
  const config: ChartConfig = React.useMemo(() => {
    const result: ChartConfig = {}
    for (const m of metrics) {
      result[m.key] = {
        label: m.label,
        color:
          colors?.[m.key] ??
          `hsl(var(--chart-${((metrics.indexOf(m) % 8) + 1)}))`,
      }
    }
    return result
  }, [metrics, colors])

  // 计算模式：直接用外部传入的函数；简单模式：data 求和
  const { currentTotal, previousTotal } = React.useMemo(() => {
    if (getCurrent) {
      const cur = getCurrent(selected)
      const prev = getPrevious?.(selected) ?? null
      return { currentTotal: cur, previousTotal: prev ?? 0 }
    }
    if (data && data.length >= 2) {
      const half = Math.floor(data.length / 2)
      const sum = (slice: Array<Record<string, unknown>>) =>
        slice.reduce((acc, row) => acc + Number(row[selected] ?? 0), 0)
      return {
        currentTotal: sum(data.slice(half)),
        previousTotal: sum(data.slice(0, half)),
      }
    }
    return { currentTotal: 0, previousTotal: 0 }
  }, [data, selected, getCurrent, getPrevious])

  const hasPrevious = previousTotal > 0
  const change =
    previousTotal > 0
      ? ((currentTotal - previousTotal) / previousTotal) * 100
      : 0
  const isPositive = metric.isNegativeBetter ? change < 0 : change > 0

  // chart 数据：计算模式 → renderLine(selected)；简单模式 → data
  const chartData = React.useMemo(() => {
    if (renderLine) return renderLine(selected)
    return data ?? []
  }, [renderLine, data, selected])

  const effectiveXKey = xKey ?? "date"

  // 每个 metric 的"当前总值"（用于卡片上方的数字）
  const getCurrentForCard = React.useCallback(
    (k: K): number => {
      if (getCurrent) return getCurrent(k)
      if (data && data.length > 0) {
        const half = Math.floor(data.length / 2)
        return data
          .slice(half)
          .reduce((acc, row) => acc + Number(row[k] ?? 0), 0)
      }
      return 0
    },
    [getCurrent, data],
  )

  const getDaysLabel = (): string => {
    if (data) {
      const half = Math.floor(data.length / 2)
      return `近 ${data.length - half} 日合计`
    }
    return "本期合计"
  }

  return (
    <Card>
      {(title || description) && (
        <CardHeader className="border-b border-border/70 bg-[hsl(var(--surface-subtle))] py-3">
          <div className="space-y-1">
            {title && (
              <h2 className="text-base font-semibold leading-none text-foreground">
                {title}
              </h2>
            )}
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </CardHeader>
      )}
      <CardHeader className="p-0">
        <div className="grid grid-cols-2 @2xl:grid-cols-4 grow">
          {metrics.map((m) => {
            const isActive = m.key === selected
            const cur = getCurrentForCard(m.key)
            const prev = getPrevious?.(m.key) ?? null
            const mHasPrev = prev !== null && prev > 0
            const mChange =
              mHasPrev && prev !== null
                ? ((cur - prev) / prev) * 100
                : null
            const mIsPositive =
              mChange === null
                ? true
                : m.isNegativeBetter
                  ? mChange < 0
                  : mChange > 0
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setSelected(m.key)}
                className={cn(
                  "flex-1 cursor-pointer border-b border-r border-border/60 p-4 text-start transition-colors last:border-b-0",
                  "@2xl:[&:nth-child(2n)]:border-r-0 @2xl:[&:nth-child(odd)]:border-r",
                  "@3xl:border-b-0 @3xl:[&:nth-child(odd)]:border-r @3xl:[&:nth-child(2n)]:border-r @3xl:[&:nth-child(4n)]:border-r-0",
                  isActive && "bg-muted/50",
                )}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {m.label}
                  </span>
                  {isActive && showChange && mChange !== null && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "gap-1 text-[10px]",
                        mIsPositive
                          ? "bg-secondary/10 text-secondary"
                          : "bg-destructive/10 text-destructive",
                      )}
                    >
                      {mIsPositive ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      )}
                      {Math.abs(mChange).toFixed(1)}%
                    </Badge>
                  )}
                </div>
                <div className="text-2xl font-bold tabular-nums">
                  {m.format(cur)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {mHasPrev && prev !== null
                    ? `对比 ${m.format(prev)}`
                    : getDaysLabel()}
                </div>
              </button>
            )
          })}
        </div>
      </CardHeader>

      <CardContent className="px-2.5 py-6">
        <ChartContainer config={config} className={cn("w-full", heightClass)}>
          <LineChart
            data={chartData}
            margin={{ top: 16, right: 16, left: 0, bottom: 8 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="rgba(148,163,184,0.18)"
            />
            <XAxis
              dataKey={effectiveXKey}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(value) => {
                if (xTickFormatter) return xTickFormatter(String(value))
                // 默认按 "MM-DD" 截短
                const s = String(value)
                return s.length >= 10 ? s.slice(5) : s
              }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickCount={6}
              tickFormatter={(value) =>
                yAxisFormatter
                  ? yAxisFormatter(Number(value), selected)
                  : metric.format(Number(value))
              }
            />
            <ChartTooltip
              cursor={{
                stroke: "hsl(var(--muted-foreground))",
                strokeDasharray: "4 4",
              }}
              content={
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(value) => String(value)}
                  formatter={(value, name) => {
                    const numVal = Number(value)
                    const mKey = String(name) as K
                    if (tooltipFormatter) {
                      return (
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="font-medium">
                            {config[mKey]?.label ?? String(name)}
                          </span>
                          <span className="font-mono font-medium text-foreground">
                            {tooltipFormatter(numVal, mKey)}
                          </span>
                        </div>
                      )
                    }
                    return (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="font-medium">
                          {config[mKey]?.label ?? String(name)}
                        </span>
                        <span className="font-mono font-medium text-foreground">
                          {metric.format(numVal)}
                        </span>
                      </div>
                    )
                  }}
                />
              }
            />
            {/* 上一周期虚线（如果有 compareMetricValue 列） */}
            {chartData.some(
              (row) => row.compareMetricValue != null,
            ) && (
              <Line
                type="monotone"
                dataKey="compareMetricValue"
                name="compareMetricValue"
                stroke="rgba(148,163,184,0.9)"
                strokeWidth={2}
                strokeDasharray="6 6"
                dot={false}
                isAnimationActive
                animationDuration={320}
              />
            )}
            <Line
              type="monotone"
              dataKey={selected}
              stroke={`var(--color-${selected})`}
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={360}
              activeDot={{
                r: 5,
                fill: `var(--color-${selected})`,
                stroke: "white",
                strokeWidth: 2,
              }}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export default MetricSwitcherCard
