"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, BarChart3, LineChart as LineIcon, Square } from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

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
 * 单 chart + 顶部 metric 切换的通用卡片，包装 `line-charts-6`。
 * 支持 line / area / bar 三种 chart 形态，通过 `chartKind` prop 切换：
 *   - `'auto'`（默认）：按 metric.preferredChart 自动选
 *   - `'line' / 'area' / 'bar'`：手动指定
 *
 * 三层组件关系：
 *   line-charts-6.tsx          ← ChartContainer + tooltip 样式
 *   MetricSwitcherCard.tsx     ← 单 chart + KPI grid（当前）
 *   chart-with-kpi-grid.tsx    ← 上层 composition（待实现）
 */

export type ChartKind = "line" | "area" | "bar"

export type MetricDef<K extends string> = {
  key: K
  label: string
  /** 数值越小越好的 metric（例如广告花费）；为 true 时 change < 0 视为正向 */
  isNegativeBetter?: boolean
  /** 把 raw number 渲染为中文/带单位的字符串 */
  format: (val: number) => string
  /** 自选 chart 形态（auto 模式下生效）。不填默认 line。 */
  preferredChart?: ChartKind
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
   * Chart 形态：
   *   - `'auto'`：按当前选中 metric 的 preferredChart 切换（推荐）
   *   - `'line' / 'area' / 'bar'`：手动指定，固定形态
   * 默认 `'auto'`
   */
  chartKind?: "auto" | ChartKind

  /** 是否在顶部 KPI grid 右侧显示形态切换 segmented control（默认 false） */
  showChartKindToggle?: boolean

  /** 计算模式：传入 tooltip formatter */
  tooltipFormatter?: (value: number, metricKey: K) => React.ReactNode
  /** 计算模式：传入 y 轴 formatter；不传则用 metric.format */
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
  chartKind = "auto",
  showChartKindToggle = false,
  tooltipFormatter,
  yAxisFormatter,
}: MetricSwitcherCardProps<K>) {
  const [selected, setSelected] = React.useState<K>(defaultMetric)
  // 用户手动 override 的 chart kind。null 表示跟随 chartKind / auto 模式
  const [overrideKind, setOverrideKind] = React.useState<ChartKind | null>(null)
  const metric = metrics.find((m) => m.key === selected) ?? metrics[0]

  // 解析当前实际渲染的 chart kind
  const effectiveKind: ChartKind = React.useMemo(() => {
    if (overrideKind) return overrideKind
    if (chartKind !== "auto") return chartKind
    return metric.preferredChart ?? "line"
  }, [overrideKind, chartKind, metric.preferredChart])

  // 用户切换 metric 时重置 override（避免切换到另一 metric 后还卡在手动选择上）
  React.useEffect(() => {
    setOverrideKind(null)
  }, [selected])

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

  const chartData = React.useMemo(() => {
    if (renderLine) return renderLine(selected)
    return data ?? []
  }, [renderLine, data, selected])

  const effectiveXKey = xKey ?? "date"

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

  const hasCompareData = chartData.some((row) => row.compareMetricValue != null)

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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 grow divide-y divide-r-0 divide-border/60">
          {metrics.map((m, idx) => {
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
            const totalInRow = metrics.length
            const isLastInRow = (idx + 1) % 6 === 0 || idx === totalInRow - 1
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setSelected(m.key)}
                className={cn(
                  // 上下边框：divide-y 自动处理
                  // 右侧边框：6 列布局里除最右列外都有；最后一行不满 6 时去掉最后一个 border-r
                  "cursor-pointer p-4 text-start transition-colors",
                  // 强制使用 fixed height 避免点击不同 metric 时卡片高度跳动 → y 轴偏移修复
                  "min-h-[112px]",
                  isActive && "bg-muted/50",
                )}
              >
                <div className="mb-2 flex items-center justify-between gap-1.5">
                  <span className="truncate text-sm text-muted-foreground">
                    {m.label}
                  </span>
                  {/* 所有 metric 都永远显示对比信息：active 显示变化百分比（无对比显示 --），
                      非 active 显示"对比 X"。避免 active 卡片凭空多出一个 Badge。 */}
                  <Badge
                    variant="secondary"
                    className={cn(
                      "shrink-0 gap-1 text-[10px]",
                      isActive
                        ? mChange === null
                          ? "bg-muted/40 text-muted-foreground"
                          : mIsPositive
                            ? "bg-secondary/10 text-secondary"
                            : "bg-destructive/10 text-destructive"
                        : "bg-transparent text-muted-foreground/70",
                    )}
                  >
                    {!isActive && mHasPrev && prev !== null
                      ? `对比 ${m.format(prev)}`
                      : mChange === null
                        ? "--"
                        : mIsPositive
                          ? (
                            <>
                              <ArrowUp className="size-3" />
                              {Math.abs(mChange).toFixed(1)}%
                            </>
                          )
                          : (
                            <>
                              <ArrowDown className="size-3" />
                              {Math.abs(mChange).toFixed(1)}%
                            </>
                          )}
                  </Badge>
                </div>
                <div className="truncate text-2xl font-bold tabular-nums">
                  {m.format(cur)}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {isActive
                    ? mHasPrev && prev !== null
                      ? `对比 ${m.format(prev)}`
                      : getDaysLabel()
                    : getDaysLabel()}
                </div>
              </button>
            )
          })}
        </div>

        {showChartKindToggle && (
          <div className="flex items-center justify-end gap-1 border-t border-border/60 px-3 py-2">
            <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              形态
            </span>
            <ChartKindToggle
              value={effectiveKind}
              onChange={setOverrideKind}
              disabled={chartKind !== "auto"}
            />
          </div>
        )}
      </CardHeader>

      <CardContent className="px-2.5 py-6">
        {/* 用 key={effectiveKind} 强制 remount：切换 chartKind 时整个图表重新挂载，
            保证 line ↔ bar 跨形态切换也有干净的 enter 动画（同形态切换靠 recharts 内部） */}
        <ChartContainer
          key={effectiveKind}
          config={config}
          className={cn("w-full", heightClass)}
        >
          {renderChart(
            effectiveKind,
            chartData,
            selected,
            metric,
            config,
            effectiveXKey,
            xTickFormatter,
            yAxisFormatter,
            tooltipFormatter,
            hasCompareData,
          )}
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* 形态切换 segmented control（仅在 showChartKindToggle=true 时渲染）        */
/* -------------------------------------------------------------------------- */

function ChartKindToggle({
  value,
  onChange,
  disabled,
}: {
  value: ChartKind
  onChange: (k: ChartKind) => void
  disabled: boolean
}) {
  const options: Array<{ kind: ChartKind; label: string; icon: React.ElementType }> = [
    { kind: "line", label: "折线", icon: LineIcon },
    { kind: "area", label: "面积", icon: Square },
    { kind: "bar", label: "柱状", icon: BarChart3 },
  ]
  return (
    <div
      className={cn(
        "inline-flex h-7 items-center rounded-full border border-border/70 bg-background/72 p-0.5 text-[11px]",
        disabled && "opacity-50",
      )}
    >
      {options.map((opt) => {
        const Icon = opt.icon
        const isActive = value === opt.kind
        return (
          <button
            key={opt.kind}
            type="button"
            onClick={() => onChange(opt.kind)}
            disabled={disabled}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors",
              isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={isActive}
          >
            <Icon className="size-3" />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Chart renderers — line / area / bar 共享 XAxis / YAxis / Tooltip            */
/* -------------------------------------------------------------------------- */

function renderChart<K extends string>(
  kind: ChartKind,
  data: Array<Record<string, unknown>>,
  selected: K,
  metric: MetricDef<K>,
  config: ChartConfig,
  xKey: string,
  xTickFormatter: ((value: string) => string) | undefined,
  yAxisFormatter: ((value: number, key: K) => string) | undefined,
  tooltipFormatter: ((value: number, key: K) => React.ReactNode) | undefined,
  hasCompareData: boolean,
) {
  // 共享 axes + tooltip：XAxis/YAxis/ChartTooltip 三件套所有形态共用，
  // 让 hover 时始终能看到横坐标日期 + 纵坐标数值 + tooltip 弹层。
  const sharedAxes = (
    <>
      <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.18)" />
      <XAxis
        dataKey={xKey}
        axisLine={false}
        tickLine={false}
        tickMargin={8}
        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
        tickFormatter={(value) => {
          if (xTickFormatter) return xTickFormatter(String(value))
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
            indicator={kind === "bar" ? "dot" : "line"}
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
    </>
  )

  if (kind === "bar") {
    return (
      <BarChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
        {sharedAxes}
        {hasCompareData && (
          <Bar
            dataKey="compareMetricValue"
            name="compareMetricValue"
            fill="rgba(148,163,184,0.42)"
            radius={[6, 6, 0, 0]}
            isAnimationActive
            animationDuration={320}
          />
        )}
        <Bar
          dataKey={selected}
          name={metric.label}
          fill={`var(--color-${selected})`}
          radius={[6, 6, 0, 0]}
          isAnimationActive
          animationDuration={360}
        />
      </BarChart>
    )
  }

  if (kind === "area") {
    return (
      <AreaChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
        <defs>
          <linearGradient id={`fill-${selected}`} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor={`var(--color-${selected})`}
              stopOpacity={0.5}
            />
            <stop
              offset="95%"
              stopColor={`var(--color-${selected})`}
              stopOpacity={0.05}
            />
          </linearGradient>
        </defs>
        {sharedAxes}
        {hasCompareData && (
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
        <Area
          type="monotone"
          dataKey={selected}
          name={metric.label}
          stroke={`var(--color-${selected})`}
          fill={`url(#fill-${selected})`}
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
      </AreaChart>
    )
  }

  // default: line
  return (
    <LineChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
      {sharedAxes}
      {hasCompareData && (
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
        name={metric.label}
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
  )
}

export default MetricSwitcherCard