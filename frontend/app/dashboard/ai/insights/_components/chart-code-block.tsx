'use client'

import { useCallback, useState } from 'react'
import { AlertTriangle, Check, Copy, Sparkles } from 'lucide-react'
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

import { chartSvgRegistry } from './chart-svg-registry'

function parseLineChart(content: string) {
  const lines = content.trim().split('\n')
  const result: Record<string, string[]> = {}

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const match = line.match(/^([^[\]]+)\[(.+)\]$/)
    if (match) {
      const currentKey = match[1].trim().toLowerCase()
      const rawValues = match[2].trim()
      const values = /[,;]/.test(rawValues)
        ? rawValues.split(/[,;]\s*/)
        : currentKey === 'x-axis' || currentKey === 'xaxis'
          ? rawValues.split(/\s+/)
          : [rawValues]

      result[currentKey] = values.map((v) => v.trim()).filter(Boolean)
    }
  }

  return result
}


function parsePieChart(content: string) {
  const lines = content.trim().split('\n')
  const result: Array<{ name: string; value: number }> = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.toLowerCase().startsWith('title')) continue

    const match = line.match(/^(.+?)\s*[:：]\s*(\d+(?:\.\d+)?)$/)
    if (match) {
      result.push({ name: match[1].trim(), value: parseFloat(match[2]) })
    }
  }

  return result
}

// CSS variables — used by live Recharts components (browser resolves them)

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

// Absolute hex — used by static SVG generation (SVG data URLs don't resolve CSS vars)
const CHART_COLORS_HEX = [
  '#3b82f6', // chart-1 blue
  '#10b981', // chart-2 green
  '#f59e0b', // chart-3 amber
  '#8b5cf6', // chart-4 violet
  '#ef4444', // chart-5 red
]

const CHART_CONFIG = {
  value: { label: '数值', color: 'hsl(var(--chart-1))' },
} satisfies ChartConfig

function FallbackCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [code])

  return (
    <div className="not-prose my-5 w-full overflow-hidden rounded-none border border-term-border bg-term-panel">
      <div className="flex items-center justify-between border-b border-term-border bg-term-raised px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--chart-1))]" />
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-term-faint">
            RAW BLOCK
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex h-7 items-center gap-1 rounded-none border border-term-border bg-term-bg px-2 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="break-words overflow-x-auto px-4 py-4 text-xs leading-6 text-foreground">
        <code className="whitespace-pre-wrap break-words">{code}</code>
      </pre>
    </div>
  )
}

export const LEGACY_CHART_LANGUAGES = [
  'chart',
  'line',
  'linechart',
  'lineChart',
  'pie',
  'piechart',
  'pieChart',
]

export function ChartCodeBlock({
  chartType,
  code,
  collectChartSvgs,
}: {
  chartType: string
  code: string
  collectChartSvgs?: boolean
}) {
  const normalizedType = chartType.trim().toLowerCase()

  if (normalizedType === 'linechart' || normalizedType === 'line') {
    const parsed = parseLineChart(code)
    const labels = parsed['x-axis'] || parsed['xaxis'] || []
    const seriesKey = Object.keys(parsed).find(
      (k) =>
        k !== 'x-axis' &&
        k !== 'xaxis' &&
        k !== 'y-axis' &&
        k !== 'yaxis' &&
        parsed[k].length === labels.length
    )
    const seriesData = seriesKey ? parsed[seriesKey] : []

    if (labels.length === 0 || seriesData.length === 0) {
      return <FallbackCodeBlock code={code} />
    }

    const chartData = labels.map((label, i) => ({
      label,
      value: parseFloat(seriesData[i]) || 0,
    }))

    const chartId = `line-${code.slice(0, 20)}`

    // During PNG export: render a self-contained static SVG so toPng captures it reliably.
    if (collectChartSvgs) {
      const W = 600
      const H = 220
      const padL = 52,
        padR = 16,
        padT = 12,
        padB = 28
      const vw = W - padL - padR
      const vh = H - padT - padB
      const values = chartData.map((d) => d.value)
      const minV = Math.min(...values)
      const maxV = Math.max(...values)
      const range = maxV - minV || 1
      const xStep = vw / Math.max(labels.length - 1, 1)
      const toX = (i: number) => padL + i * xStep
      const toY = (v: number) => padT + vh - ((v - minV) / range) * vh

      const pts = chartData.map((d, i) => `${toX(i)},${toY(d.value)}`).join(' ')
      const polyline = chartData.map((d, i) => `${toX(i)} ${toY(d.value)}`).join(' ')

      const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => padT + t * vh)
      const yLabels = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(maxV - t * range))

      // Area polygon under the line
      const area =
        `${toX(0)},${padT + vh} ` +
        chartData.map((d, i) => `${toX(i)},${toY(d.value)}`).join(' ') +
        ` ${toX(chartData.length - 1)},${padT + vh}`

      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" text-anchor="middle">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.32"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0.03"/></linearGradient></defs>
  ${gridYs.map((y) => `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="4 4"/>`).join('\n  ')}
  ${yLabels.map((label, i) => `<text x="${padL - 6}" y="${gridYs[i] + 4}" text-anchor="end" fill="#94a3b8">${label}</text>`).join('\n  ')}
  ${labels
    .filter((_, i) => i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1)
    .map((l, _, arr) => {
      const idx = labels.indexOf(l)
      return `<text x="${toX(idx)}" y="${H - 6}" fill="#94a3b8">${l}</text>`
    })
    .join('\n  ')}
  <polygon points="${area}" fill="url(#lg)"/>
  <polyline points="${polyline}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="${pts}" fill="none" stroke="transparent" stroke-width="8"/>
</svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
      chartSvgRegistry.set(chartId, url)
      return (
        <div className="not-prose my-6 w-full overflow-hidden rounded-none border border-term-border bg-term-panel">
          <div className="border-b border-border/60 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-none border border-term-border bg-term-raised text-term-accent">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-term-faint">
                  Trend Chart
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {seriesKey?.toUpperCase() || '趋势变化'}
                </p>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 pt-4">
            {/* Recharts needs one frame to register its SVG; use the pre-generated static SVG as the img src */}
            <div className="h-[260px] w-full">
              {/* Use url directly like PieChart does — avoids timing issues with chartSvgRegistry */}
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URLs can't use next/image */}
              <img src={url} alt="趋势图表" className="h-full w-full object-contain" />
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="not-prose my-6 w-full overflow-hidden rounded-none border border-term-border bg-term-panel">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-none border border-term-border bg-term-raised text-term-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-term-faint">
                Trend Chart
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {seriesKey?.toUpperCase() || '趋势变化'}
              </p>
            </div>
          </div>
        </div>
        <div className="px-4 pb-3 pt-4">
          <ChartContainer config={CHART_CONFIG} className="h-[260px] w-full">
            <LineChart data={chartData} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="ai-insight-line-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="4 4" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={44} />
              <ChartTooltip
                cursor={{ stroke: 'hsl(var(--border))', strokeDasharray: '4 4' }}
                content={<ChartTooltipContent indicator="line" />}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-value)"
                strokeWidth={3}
                dot={{ r: 0 }}
                activeDot={{
                  r: 5,
                  fill: 'var(--color-value)',
                  stroke: 'hsl(var(--surface-panel))',
                  strokeWidth: 2,
                }}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </div>
    )
  }

  if (normalizedType === 'piechart' || normalizedType === 'pie') {
    const parsed = parsePieChart(code)

    if (parsed.length === 0) {
      return <FallbackCodeBlock code={code} />
    }

    const total = parsed.reduce((sum, item) => sum + item.value, 0)
    const displayData = parsed.map((item) => ({
      ...item,
      pct: total > 0 ? ((item.value / total) * 100).toFixed(1) : '0.0',
    }))

    // Static SVG donut chart for PNG export — no Recharts SVG dependency.
    if (collectChartSvgs) {
      const size = 220
      const cx = size / 2
      const cy = size / 2
      const outerR = 88
      const innerR = 56
      const strokeW = outerR - innerR

      let angle = -Math.PI / 2 // start at 12 o'clock
      const wedges = displayData.map((item, i) => {
        const slice = (item.value / total) * 2 * Math.PI
        const startA = angle
        const endA = angle + slice
        angle = endA

        const x1 = cx + outerR * Math.cos(startA)
        const y1 = cy + outerR * Math.sin(startA)
        const x2 = cx + outerR * Math.cos(endA)
        const y2 = cy + outerR * Math.sin(endA)
        const x3 = cx + innerR * Math.cos(endA)
        const y3 = cy + innerR * Math.sin(endA)
        const x4 = cx + innerR * Math.cos(startA)
        const y4 = cy + innerR * Math.sin(startA)
        const large = slice > Math.PI ? 1 : 0

        const color = CHART_COLORS_HEX[i % CHART_COLORS_HEX.length]
        const path = `M${x1},${y1} A${outerR},${outerR} 0 ${large},1 ${x2},${y2} L${x3},${y3} A${innerR},${innerR} 0 ${large},0 ${x4},${y4} Z`
        return { path, color }
      })

      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" font-family="ui-sans-serif,system-ui,sans-serif">
        ${wedges.map((w) => `<path d="${w.path}" fill="${w.color}" stroke="white" stroke-width="2"/>`).join('\n        ')}
      </svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
      const pieId = `pie-${code.slice(0, 20)}`
      chartSvgRegistry.set(pieId, url)

      return (
        <div className="not-prose my-6 w-full overflow-hidden rounded-none border border-term-border bg-term-panel">
          <div className="border-b border-border/60 px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-term-faint">
              Composition
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">分布占比</p>
          </div>
          <div className="flex flex-col gap-6 px-5 py-5 md:flex-row md:items-center">
            <div className="h-[220px] w-full md:w-[220px]">
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URLs can't use next/image */}
              <img src={url} alt="饼图" className="h-full w-full object-contain" />
            </div>
            <div className="flex-1 space-y-2.5">
              {displayData.map((item, i) => (
                <div
                  key={item.name}
                  className="flex items-center gap-3 rounded-none border border-term-border bg-term-bg px-3 py-2 text-sm"
                >
                  <div
                    className="h-3 w-3 shrink-0 rounded-none"
                    style={{ backgroundColor: CHART_COLORS_HEX[i % CHART_COLORS_HEX.length] }}
                  />
                  <span className="break-words text-muted-foreground">{item.name}</span>
                  <span className="ml-auto font-medium tabular-nums">
                    {item.value}{' '}
                    <span className="text-xs text-muted-foreground">({item.pct}%)</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="not-prose my-6 w-full overflow-hidden rounded-none border border-term-border bg-term-panel">
        <div className="border-b border-border/60 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-term-faint">
            Composition
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">分布占比</p>
        </div>
        <div className="flex flex-col gap-6 px-5 py-5 md:flex-row md:items-center">
          <div className="h-[220px] w-full md:w-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={displayData}
                  cx="50%"
                  cy="50%"
                  innerRadius={56}
                  outerRadius={88}
                  paddingAngle={3}
                  dataKey="value"
                  stroke="hsl(var(--surface-soft))"
                  strokeWidth={3}
                >
                  {displayData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(value: number) => [value, '']}
                  contentStyle={{
                    background: 'hsl(var(--surface-panel))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '12px',
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex-1 space-y-2.5">
            {displayData.map((item, i) => (
              <div
                key={item.name}
                className="flex items-center gap-3 rounded-none border border-term-border bg-term-bg px-3 py-2 text-sm"
              >
                <div
                  className="h-3 w-3 shrink-0 rounded-none"
                  style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                />
                <span className="break-words text-muted-foreground">{item.name}</span>
                <span className="ml-auto font-medium tabular-nums">
                  {item.value} <span className="text-xs text-muted-foreground">({item.pct}%)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // 其它 ```chart 语言（如 barchart/column）不做专用渲染，按普通代码块展示；
  // 新增图表类型时按 line / pie 分支的两步模式补：先出静态 SVG，再退回 Recharts。
  return <FallbackCodeBlock code={code} />
}

