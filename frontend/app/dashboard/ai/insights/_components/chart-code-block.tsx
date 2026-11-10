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
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

import styles from '../insights-warm.module.css'
import { chartSvgRegistry } from './chart-svg-registry'
import { readWarmLedgerColor } from '@/lib/warm-ledger-colors'

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

// Warm data accents for live Recharts components (browser resolves the tokens).

const CHART_COLORS = [
  'var(--warm-ledger-color-accent-strong)',
  'var(--warm-ledger-color-accent)',
  'var(--warm-ledger-color-text-soft)',
  'var(--warm-ledger-color-text-muted)',
  'var(--warm-ledger-color-text-faint)',
]

/** 静态 SVG data URL 不能解析 CSS 变量；导出时按当前主题读取已解析值（渲染时解析，跟随主题切换）。 */
const CHART_COLOR_ROLES = ['accentStrong', 'accent', 'textSoft', 'textMuted', 'textFaint'] as const

const CHART_CONFIG = {
  value: { label: '数值', color: 'var(--warm-ledger-color-accent-strong)' },
} satisfies ChartConfig

function FallbackCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [code])

  return (
    <div className={styles.rawBlock}>
      <div className={styles.rawHeader}>
        <div className={styles.chartHeading}>
          <span className={styles.rawDot} />
          <span className={styles.chartEyebrow}>
            RAW BLOCK
          </span>
        </div>
        <WarmButton
          type="button"
          onClick={() => void handleCopy()}
          variant="quiet"
          className={styles.rawCopy}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? '已复制' : '复制'}
        </WarmButton>
      </div>
      <pre className={styles.rawPre}>
        <code>{code}</code>
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
  <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${readWarmLedgerColor('accent')}" stop-opacity="0.32"/><stop offset="100%" stop-color="${readWarmLedgerColor('accent')}" stop-opacity="0.03"/></linearGradient></defs>
  ${gridYs.map((y) => `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${readWarmLedgerColor('chartAxis')}" stroke-dasharray="4 4"/>`).join('\n  ')}
  ${yLabels.map((label, i) => `<text x="${padL - 6}" y="${gridYs[i] + 4}" text-anchor="end" fill="${readWarmLedgerColor('textMuted')}">${label}</text>`).join('\n  ')}
  ${labels
    .filter((_, i) => i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1)
    .map((l, _, arr) => {
      const idx = labels.indexOf(l)
      return `<text x="${toX(idx)}" y="${H - 6}" fill="${readWarmLedgerColor('textMuted')}">${l}</text>`
    })
    .join('\n  ')}
  <polygon points="${area}" fill="url(#lg)"/>
  <polyline points="${polyline}" fill="none" stroke="${readWarmLedgerColor('accent')}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="${pts}" fill="none" stroke="transparent" stroke-width="8"/>
</svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
      chartSvgRegistry.set(chartId, url)
      return (
        <div className={styles.chartPanel}>
          <div className={styles.chartHeader}>
            <div className={styles.chartHeading}>
              <div className={styles.chartIcon}>
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className={styles.chartEyebrow}>Trend Chart</p>
                <p className={styles.chartTitle}>
                  {seriesKey?.toUpperCase() || '趋势变化'}
                </p>
              </div>
            </div>
          </div>
          <div className={styles.chartBody}>
            {/* Recharts needs one frame to register its SVG; use the pre-generated static SVG as the img src */}
            <div className={styles.chartImageWrap}>
              {/* Use url directly like PieChart does — avoids timing issues with chartSvgRegistry */}
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URLs can't use next/image */}
              <img src={url} alt="趋势图表" className={styles.chartImage} />
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.chartPanel}>
        <div className={styles.chartHeader}>
          <div className={styles.chartHeading}>
            <div className={styles.chartIcon}>
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <p className={styles.chartEyebrow}>Trend Chart</p>
              <p className={styles.chartTitle}>
                {seriesKey?.toUpperCase() || '趋势变化'}
              </p>
            </div>
          </div>
        </div>
        <div className={styles.chartBody}>
          <ChartContainer config={CHART_CONFIG} className="h-[260px] w-full">
            <LineChart data={chartData} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="ai-insight-line-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--warm-ledger-color-accent)"
                    stopOpacity={0.32}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--warm-ledger-color-accent)"
                    stopOpacity={0.03}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="4 4" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} width={44} />
              <ChartTooltip
                cursor={{
                  stroke: 'var(--warm-ledger-color-hairline-strong)',
                  strokeDasharray: '4 4',
                }}
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
                  stroke: 'var(--warm-ledger-color-panel)',
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
      const exportColors = CHART_COLOR_ROLES.map((role) => readWarmLedgerColor(role))
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

        const color = exportColors[i % exportColors.length]
        const path = `M${x1},${y1} A${outerR},${outerR} 0 ${large},1 ${x2},${y2} L${x3},${y3} A${innerR},${innerR} 0 ${large},0 ${x4},${y4} Z`
        return { path, color }
      })

      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" font-family="ui-sans-serif,system-ui,sans-serif">
        ${wedges.map((w) => `<path d="${w.path}" fill="${w.color}" stroke="${readWarmLedgerColor('window')}" stroke-width="2"/>`).join('\n        ')}
      </svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
      const pieId = `pie-${code.slice(0, 20)}`
      chartSvgRegistry.set(pieId, url)

      return (
        <div className={styles.chartPanel}>
          <div className={styles.chartHeader}>
            <div>
              <p className={styles.chartEyebrow}>Composition</p>
              <p className={styles.chartTitle}>分布占比</p>
            </div>
          </div>
          <div className={styles.pieLayout}>
            <div className={styles.pieImageWrap}>
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URLs can't use next/image */}
              <img src={url} alt="饼图" className={styles.chartImage} />
            </div>
            <div className={styles.legend}>
              {displayData.map((item, i) => (
                <div
                  key={item.name}
                  className={styles.legendItem}
                >
                  <div
                    className={styles.legendSwatch}
                    style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                  />
                  <span className={styles.legendName}>{item.name}</span>
                  <span className={styles.legendValue}>
                    {item.value}{' '}
                    <span className={styles.legendMeta}>({item.pct}%)</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.chartPanel}>
        <div className={styles.chartHeader}>
          <div>
            <p className={styles.chartEyebrow}>Composition</p>
            <p className={styles.chartTitle}>分布占比</p>
          </div>
        </div>
        <div className={styles.pieLayout}>
          <div className={styles.pieImageWrap}>
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
                  stroke="var(--warm-ledger-color-panel)"
                  strokeWidth={3}
                >
                  {displayData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(value: number) => [value, '']}
                  contentStyle={{
                    background: 'var(--warm-ledger-color-panel-strong)',
                    border: '1px solid var(--warm-ledger-color-hairline-strong)',
                    borderRadius: '10px',
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className={styles.legend}>
            {displayData.map((item, i) => (
              <div
                key={item.name}
                className={styles.legendItem}
              >
                <div
                  className={styles.legendSwatch}
                  style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                />
                <span className={styles.legendName}>{item.name}</span>
                <span className={styles.legendValue}>
                  {item.value} <span className={styles.legendMeta}>({item.pct}%)</span>
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

