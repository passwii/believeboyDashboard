"use client"

import * as React from "react"
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
} from "framer-motion"
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
  type ChartConfig,
} from "@/components/ui/line-charts-6"

/**
 * Project-standard motion easing. Mirrors `--motion-ease-out` in
 * `app/globals.css` and the easing used in `components/ui/tab-motion.tsx`.
 */
const MOTION_EASE_OUT = [0.22, 1, 0.36, 1] as const

/**
 * MetricSwitcherCard
 *
 * 单 chart + 顶部 metric 切换的通用卡片，包装 `line-charts-6`。
 * 支持 line / area / bar 三种 chart 形态，通过 `chartKind` prop 切换：
 *   - `'auto'`（默认）：按 metric.preferredChart 自动选
 *   - `'line' / 'area' / 'bar'`：手动指定
 *
 * 形态自适应规则（auto 模式）：
 *   - 业务侧在 MetricDef.preferredChart 里标注
 *   - 量级类指标（订单量/销售额/曝光量）→ bar
 *   - 趋势连续类指标（转化率/CPC/百分比）→ line
 *   - 累计/堆叠类（如果未来需要）→ area
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
  const prefersReducedMotion = useReducedMotion()
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
    <Card className="hover-lift animate-enter overflow-hidden transition-shadow duration-200">
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
        <div className="relative grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 grow divide-y divide-r-0 divide-border/60">
          {metrics.map((m) => {
            return (
              <MetricCell<K>
                key={m.key}
                metric={m}
                isActive={m.key === selected}
                currentValue={getCurrentForCard(m.key)}
                previousValue={getPrevious?.(m.key) ?? null}
                daysLabel={getDaysLabel()}
                onSelect={() => setSelected(m.key)}
              />
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
            保证 line ↔ bar 跨形态切换也有干净的 enter 动画（同形态切换靠 recharts 内部）。
            外层 motion.div 用来掩盖 remount 之间的视觉空隙 —— 不做 morph
            （recharts 的 findChildByType 依赖直接 children 关系，wrap 会破坏），
            只做 fade-in + 轻微上推。 */}
        <motion.div
          key={`chart-${effectiveKind}`}
          initial={
            prefersReducedMotion
              ? { opacity: 1, y: 0 }
              : { opacity: 0, y: 6 }
          }
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: MOTION_EASE_OUT }}
          className={cn("w-full", heightClass)}
        >
          <ChartContainer
            config={config}
            className={cn("w-full", heightClass)}
          >
            {renderChart(
              effectiveKind,
              chartData,
              selected,
              metric,
              metrics,
              config,
              effectiveXKey,
              xTickFormatter,
              yAxisFormatter,
              tooltipFormatter,
              hasCompareData,
            )}
          </ChartContainer>
        </motion.div>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* MetricCell — single KPI tile inside the metric grid                        */
/*                                                                             */
/* Owns three polish behaviours:                                              */
/*   1. Active-cell count-up: only the active cell mounts ActiveMetricCell,    */
/*      which runs a useSpring on raw `currentValue` and re-applies           */
/*      `metric.format` each frame so currency / percent / unit suffixes      */
/*      stay correct as the number rolls. Inactive cells render a plain       */
/*      string with no spring — six idle springs would tick every frame       */
/*      for no visible benefit.                                               */
/*   2. Sliding bottom accent indicator via `layoutId="metric-cell-indicator"`:*/
/*      only the active cell renders the indicator span; framer-motion         */
/*      tweens it between cells when the user picks a different metric.       */
/*   3. Active-state visual: bg-primary/[0.04] tint + foreground-colored      */
/*      digit + change Badge in success/destructive colors. Inactive cells    */
/*      stay muted (text-muted-foreground/80) and dim their change Badge.     */
/* -------------------------------------------------------------------------- */

interface MetricCellProps<K extends string> {
  metric: MetricDef<K>
  isActive: boolean
  currentValue: number
  previousValue: number | null
  daysLabel: string
  onSelect: () => void
}

function MetricCell<K extends string>({
  metric,
  isActive,
  currentValue,
  previousValue,
  daysLabel,
  onSelect,
}: MetricCellProps<K>) {
  // Display math (shared with the legacy inline version)
  const prev = previousValue
  const hasPrev = prev !== null && prev > 0
  const change =
    hasPrev && prev !== null ? ((currentValue - prev) / prev) * 100 : null
  const isPositive =
    change === null
      ? true
      : metric.isNegativeBetter
        ? change < 0
        : change > 0

  // Spring-driven count-up only for the active cell — six idle springs would
  // tick every frame for no visible benefit. ActiveMetricCell mounts fresh on
  // each activation, giving the user a count-up from the new cell's value.
  const subLabel = isActive
    ? hasPrev && prev !== null
      ? `对比 ${metric.format(prev)}`
      : daysLabel
    : daysLabel

  if (isActive) {
    return (
      <ActiveMetricCell
        metric={metric}
        currentValue={currentValue}
        subLabel={subLabel}
        change={change}
        isPositive={isPositive}
        onSelect={onSelect}
      />
    )
  }
  // Inactive cell — plain render, no spring. The shared accent indicator is
  // handled here too (only the active cell renders it via layoutId).
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={false}
      className={cn(
        "relative cursor-pointer p-4 text-start transition-colors duration-150",
        "min-h-[112px]",
        "hover:bg-muted/40",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-1.5">
        <span className="truncate text-sm text-muted-foreground">
          {metric.label}
        </span>
        <Badge
          variant="secondary"
          className={cn(
            "shrink-0 gap-1 text-[10px]",
            "bg-transparent text-muted-foreground/70",
          )}
        >
          {hasPrev && previousValue !== null
            ? `对比 ${metric.format(previousValue)}`
            : "--"}
        </Badge>
      </div>
      <div className="truncate text-2xl font-bold tabular-nums text-muted-foreground/80">
        {metric.format(currentValue)}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {subLabel}
      </div>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* ActiveMetricCell — same as MetricCell but owns the spring count-up. Only    */
/* mounted for the active cell, so we only ever run one spring at a time.    */
/* -------------------------------------------------------------------------- */

interface ActiveMetricCellProps<K extends string> {
  metric: MetricDef<K>
  currentValue: number
  subLabel: string
  change: number | null
  isPositive: boolean
  onSelect: () => void
}

function ActiveMetricCell<K extends string>({
  metric,
  currentValue,
  subLabel,
  change,
  isPositive,
  onSelect,
}: ActiveMetricCellProps<K>) {
  // useReducedMotion is required at the top of every framer-motion consumer
  // that respects the OS preference, even if we don't branch on its value
  // here — keeps the rules-of-hooks invariant intact.
  useReducedMotion()
  const springValue = useSpring(currentValue, {
    stiffness: 220,
    damping: 28,
    mass: 0.6,
  })
  // Push new targets into the spring whenever upstream value changes.
  // Without this, the spring would freeze on its initial target forever.
  React.useEffect(() => {
    springValue.set(currentValue)
  }, [springValue, currentValue])
  const [displayValue, setDisplayValue] = React.useState(() =>
    metric.format(currentValue),
  )
  useMotionValueEvent(springValue, "change", (latest) => {
    setDisplayValue(metric.format(latest))
  })

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={true}
      className={cn(
        "relative cursor-pointer p-4 text-start transition-colors duration-150",
        "min-h-[112px]",
        "bg-primary/[0.04]",
      )}
    >
      <motion.span
        layoutId="metric-cell-indicator"
        aria-hidden
        className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
      />
      <div className="mb-2 flex items-center justify-between gap-1.5">
        <span className="truncate text-sm text-muted-foreground">
          {metric.label}
        </span>
        <Badge
          variant="secondary"
          className={cn(
            "shrink-0 gap-1 text-[10px]",
            change === null
              ? "bg-muted/40 text-muted-foreground"
              : isPositive
                ? "bg-secondary/10 text-secondary"
                : "bg-destructive/10 text-destructive",
          )}
        >
          {change === null
            ? "--"
            : isPositive
              ? (
                <>
                  <ArrowUp className="size-3" />
                  {Math.abs(change).toFixed(1)}%
                </>
              )
              : (
                <>
                  <ArrowDown className="size-3" />
                  {Math.abs(change).toFixed(1)}%
                </>
              )}
        </Badge>
      </div>
      <div className="truncate text-2xl font-bold tabular-nums text-foreground">
        {displayValue}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {subLabel}
      </div>
    </button>
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
  const prefersReducedMotion = useReducedMotion()
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
            aria-pressed={isActive}
            className={cn(
              "relative inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors",
              // When reduced motion is on we skip the layoutId pill and fall
              // back to Tailwind classes on the button itself.
              isActive && prefersReducedMotion && "bg-primary text-primary-foreground shadow-sm",
            )}
          >
            {/* Sliding pill — only the active option renders it; layoutId
                makes framer-motion tween it between buttons. */}
            {isActive && !prefersReducedMotion && (
              <motion.span
                layoutId="chart-kind-pill"
                aria-hidden
                className="absolute inset-0 -z-10 rounded-full bg-primary shadow-sm"
                transition={{
                  type: "spring",
                  stiffness: 380,
                  damping: 30,
                }}
              />
            )}
            <span
              className={cn(
                "relative z-10 inline-flex items-center gap-1 transition-colors",
                isActive
                  ? prefersReducedMotion
                    ? "text-primary-foreground"
                    : "text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3" />
              <span>{opt.label}</span>
            </span>
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
  metrics: MetricDef<K>[],
  config: ChartConfig,
  xKey: string,
  xTickFormatter: ((value: string) => string) | undefined,
  yAxisFormatter: ((value: number, key: K) => string) | undefined,
  tooltipFormatter: ((value: number, key: K) => React.ReactNode) | undefined,
  hasCompareData: boolean,
) {
  // 共享 axes + tooltip：XAxis/YAxis/CartesianGrid/Tooltip 几件套所有形态共用。
  // 关键：recharts 内部用 findChildByType(children, XAxis/YAxis/Tooltip) 在 LineChart
  // props.children 上直接遍历查找类型 — 一旦放在 Fragment 里，有些 recharts 版本
  // 的查找会被 Fragment 切断，导致 XAxis/YAxis/Tooltip 都不挂载到 DOM。
  // 这里把每件组件都做成独立的 React element 放进数组，三种 chart 都用 spread
  // 展开，作为 LineChart/AreaChart/BarChart 的直接 children。
  //
  // 另外：recharts 在 BarChart 模式下，cursor 默认渲染为 Rectangle（覆盖整个柱宽）
  // 遮住柱状图。这里 kind="bar" 时用 cursor={false} 完全禁用 cursor，
  // kind="line"/"area" 时用虚线 vertical line cursor。
  const tooltipProps =
    kind === "bar"
      ? { cursor: false as const }
      : {
          cursor: {
            stroke: "hsl(var(--muted-foreground))",
            strokeDasharray: "4 4",
          },
        }
  const sharedAxes = [
    <CartesianGrid key="grid" vertical={false} stroke="rgba(148,163,184,0.18)" />,
    <XAxis
      key="xaxis"
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
    />,
    <YAxis
      key="yaxis"
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
    />,
    <ChartTooltip
      key="tooltip"
      {...tooltipProps}
      content={
        <MetricSwitcherTooltip<K>
          kind={kind}
          metrics={metrics}
          selected={selected}
          tooltipFormatter={tooltipFormatter}
        />
      }
    />,
  ]

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

/* -------------------------------------------------------------------------- */
/* 自定义 Tooltip — 直接消费 recharts 注入的 active/payload，               */
/* 不依赖 ChartTooltipContent 的 formatter 路径（之前因为 item.name 是中文    */
/* label、item.value=0 时不渲染、payload 为空时直接 return null 等原因       */
/* 多个 corner case 让 hover 数值显示异常）。                                */
/* -------------------------------------------------------------------------- */

interface MetricSwitcherTooltipProps<K extends string> {
  kind: ChartKind
  metrics: MetricDef<K>[]
  selected: K
  tooltipFormatter?: (value: number, key: K) => React.ReactNode
  active?: boolean
  payload?: Array<{
    dataKey?: string | number
    name?: string | number
    value?: number | string | Array<number | string>
    color?: string
    payload?: Record<string, unknown>
  }>
  label?: string | number
}

function MetricSwitcherTooltip<K extends string>({
  kind,
  metrics,
  selected,
  tooltipFormatter,
  active,
  payload,
  label,
}: MetricSwitcherTooltipProps<K>) {
  const prefersReducedMotion = useReducedMotion()
  if (!active || !payload || payload.length === 0) return null

  // BarChart 下第一个 payload 项可能是底层画上去的辅助图元（value=null），
  // 过滤掉无效项，保留有 value 的项。
  const items = payload.filter(
    (item) => item.value !== undefined && item.value !== null,
  )
  if (items.length === 0) return null

  return (
    <motion.div
      initial={
        prefersReducedMotion
          ? { opacity: 1, y: 0 }
          : { opacity: 0, y: 4 }
      }
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: MOTION_EASE_OUT }}
      className="grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl dark:border-border/95 dark:bg-[hsl(var(--surface-panel))] dark:shadow-[0_24px_48px_-28px_rgba(0,0,0,0.82)]"
    >
      {label !== undefined && label !== null && (
        <div className="font-medium text-foreground">{String(label)}</div>
      )}
      <div className="grid gap-1.5">
        {items.map((item, index) => {
          const rawKey = String(item.dataKey ?? "")
          const itemMetric =
            metrics.find((m) => m.key === rawKey) ??
            metrics.find((m) => m.key === selected) ??
            metrics[0]
          if (!itemMetric) return null
          const numVal = Number(item.value)
          const indicatorColor = item.color ?? "hsl(var(--chart-1))"
          const displayValue = tooltipFormatter
            ? tooltipFormatter(numVal, itemMetric.key)
            : itemMetric.format(numVal)
          const isCompare = rawKey === "compareMetricValue"
          return (
            <div
              key={`${rawKey}-${index}`}
              className="flex w-full items-center justify-between gap-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                {kind === "bar" ? (
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: indicatorColor }}
                  />
                ) : (
                  <span
                    className="inline-block h-0.5 w-3 shrink-0"
                    style={{ backgroundColor: indicatorColor }}
                  />
                )}
                <span className="truncate text-muted-foreground">
                  {isCompare ? "上一周期" : itemMetric.label}
                </span>
              </div>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {displayValue}
              </span>
            </div>
          )
        })}
      </div>
    </motion.div>
  )
}

export default MetricSwitcherCard