'use client'

import { type ComponentPropsWithoutRef, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { DateRange } from 'react-day-picker'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Copy,
  Check,
  Eye,
  Image,
  Loader2,
  Pencil,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { toPng } from 'html-to-image'
import { useSession } from 'next-auth/react'

// Module-level registry: chartId → SVG data URL (used during PNG export)
const chartSvgRegistry = new Map<string, string>()

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangePicker, COUNTRY_TIMEZONE_MAP, getTodayInTimezone } from '@/components/ui/date-picker'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { parseResponseError } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'

type ProjectOption = {
  id: number | null
  name: string
}

type InsightItem = {
  id: number
  project_id: number
  project_name: string
  country: string
  title: string
  insight_type: string
  date_range_start: string
  date_range_end: string
  status: string
  sub_status: string | null
  error_message?: string | null
  created_by: string
  created_at: string
  updated_at: string
  content?: string
}

type SseEvent =
  | { type: 'status'; status: string; sub_status?: string | null; insight_id?: number; title?: string; content?: string; error_message?: string | null }
  | { type: 'chunk'; delta: string }
  | { type: 'done'; insight_id: number; title: string; content?: string; status?: string; error_message?: string | null }
  | { type: 'error'; error: string; insight_id?: number | null; status?: string; error_message?: string | null }
  | { type: 'ping' }

type AIModelConfig = {
  providerConfigured: boolean
  models: string[]
  defaultModel: string
  premiumModels: string[]
  basicModels: string[]
  message?: string
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

const INSIGHT_TYPE_OPTIONS = [
  { value: 'daily', label: '日报' },
  { value: 'weekly', label: '周报' },
  { value: 'monthly', label: '月报' },
  { value: 'custom', label: '自定义' },
]

const SUB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中...',
  data_aggregating: '正在聚合数据...',
  data_aggregating_sales: '抓取销售数据...',
  data_aggregating_ad: '抓取广告数据...',
  data_aggregating_inventory: '抓取库存数据...',
  data_aggregating_comparison_sales: '抓取对比期销售...',
  data_aggregating_comparison_ad: '抓取对比期广告...',
  data_aggregating_top_skus: '抓取 Top SKU...',
  data_aggregating_ad_campaigns: '抓取广告活动...',
  ai_generating: '正在生成洞察...',
  title_generating: '正在生成标题...',
}

const GENERATION_STEPS = [
  { key: 'data_aggregating', label: '聚合数据', description: '从数据库获取销售、广告、库存等数据' },
  { key: 'ai_generating', label: '生成洞察', description: 'AI 分析数据并生成洞察内容' },
  { key: 'title_generating', label: '生成标题', description: '为洞察报告生成标题' },
]

const DATA_STEPS = [
  { key: 'data_aggregating_sales', label: '销售数据' },
  { key: 'data_aggregating_ad', label: '广告数据' },
  { key: 'data_aggregating_inventory', label: '库存快照' },
  { key: 'data_aggregating_comparison_sales', label: '对比期销售' },
  { key: 'data_aggregating_comparison_ad', label: '对比期广告' },
  { key: 'data_aggregating_top_skus', label: 'Top SKU' },
  { key: 'data_aggregating_ad_campaigns', label: '广告活动' },
]

function formatYMD(date: Date): string {
  // Preserve the exact calendar date chosen in the picker.
  // This page treats dates as raw local YYYY-MM-DD values, not instants in time.
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: Date, amount: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function lastSevenDaysRange(country: string) {
  const today = getTodayInTimezone(COUNTRY_TIMEZONE_MAP[country] ?? 'UTC')
  const end = today
  const start = addDays(end, -6)
  return { from: start, to: end }
}

function GenerationProgress({ currentSubStatus }: { currentSubStatus: string | null }) {
  // Top-level step (data_aggregating, ai_generating, title_generating)
  const topLevelIndex = currentSubStatus
    ? GENERATION_STEPS.findIndex((s) => s.key === currentSubStatus)
    : -1

  // True when we're inside data aggregation sub-steps (e.g. data_aggregating_sales)
  const isInSubSteps = currentSubStatus?.startsWith('data_aggregating') && currentSubStatus !== 'data_aggregating'
  // The active sub-step index
  const activeSubStepIndex = currentSubStatus
    ? DATA_STEPS.findIndex((s) => s.key === currentSubStatus)
    : -1

  return (
    <div className="space-y-6">
      {/* Status header */}
      {currentSubStatus && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
          <span className="text-sm text-primary font-medium">
            {SUB_STATUS_LABELS[currentSubStatus] ?? '处理中...'}
          </span>
        </div>
      )}

      {/* Stepper */}
      <div className="space-y-0">
        {GENERATION_STEPS.map((step, index) => {
          const isActive = index === topLevelIndex
          // Completed if we've moved past this step, OR we've entered a sub-step of this step
          const isCompleted = index < topLevelIndex
            || (topLevelIndex === index && isInSubSteps)
            || (topLevelIndex === 1 && currentSubStatus === 'ai_generating' && index === 0)
          const isPending = !isActive && !isCompleted

          // Determine connector fill: step 1 needs topLevelIndex >= 1; step 2 needs >= 2
          const connectorFilled = index === 1
            ? topLevelIndex >= 1
            : topLevelIndex >= 2

          return (
            <div key={step.key} className="flex items-start gap-4">
              {/* Connector line */}
              {index > 0 && (
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      'w-0.5 h-4 transition-colors duration-500',
                      connectorFilled ? 'bg-primary' : 'bg-border'
                    )}
                  />
                </div>
              )}
              {index === 0 && <div className="w-5" />}

              {/* Step indicator */}
              <div className="relative flex flex-col items-center shrink-0">
                {/* Pulsing glow ring when this step is active (matches Loader2 spinner above) */}
                {isActive && !isInSubSteps && (
                  <div
                    className="absolute rounded-full bg-primary/20 animate-ping"
                    style={{ width: 20, height: 20, top: -7, left: -7 }}
                  />
                )}
                <div
                  className={cn(
                    'flex items-center justify-center rounded-full border-2 transition-all duration-300',
                    isCompleted
                      ? 'border-primary bg-primary text-white'
                      : isActive
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground',
                    isActive ? 'h-5 w-5' : 'h-5 w-5'
                  )}
                >
                  {isCompleted ? (
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isActive ? (
                    isInSubSteps ? (
                      <span className="text-xs font-bold">{index + 1}</span>
                    ) : (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )
                  ) : (
                    <span className="text-xs font-medium">{index + 1}</span>
                  )}
                </div>
              </div>

              {/* Step content */}
              <div className="flex-1 pb-6">
                <p
                  className={cn(
                    'text-sm font-medium transition-colors duration-300',
                    isActive ? 'text-primary' : isCompleted ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>

                {/* Nested data sub-steps when in data_aggregating phase */}
                {step.key === 'data_aggregating' && (
                  <div className="mt-2 pl-2 border-l-2 border-primary/20 space-y-1.5">
                    {DATA_STEPS.map((ds, di) => {
                      const isDCompleted = activeSubStepIndex > di || topLevelIndex > 0
                      const isDActive = currentSubStatus === ds.key
                      return (
                        <div key={ds.key} className={cn(
                          'flex items-center gap-2 transition-all duration-300',
                          isDActive ? 'translate-x-1' : ''
                        )}>
                          <div className="relative flex items-center justify-center w-3 h-3">
                            {/* Running dot for active step */}
                            {isDActive && (
                              <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
                            )}
                            <div className={cn(
                              'h-1.5 w-1.5 rounded-full transition-colors duration-300',
                              isDActive ? 'bg-primary' : isDCompleted ? 'bg-primary' : 'bg-border'
                            )} />
                          </div>
                          <span className={cn(
                            'text-xs transition-colors duration-300',
                            isDActive ? 'text-primary font-semibold' : isDCompleted ? 'text-foreground' : 'text-muted-foreground'
                          )}>
                            {ds.label}
                          </span>
                          {/* Animated indicator for active sub-step */}
                          {isDActive && (
                            <div className="ml-auto flex gap-0.5">
                              {[0, 1, 2].map((i) => (
                                <div
                                  key={i}
                                  className="h-1 w-1 rounded-full bg-primary animate-bounce"
                                  style={{ animationDelay: `${i * 120}ms` }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Animated dots for active top-level step (AI generating / title generating) */}
                {isActive && !isInSubSteps && (
                  <div className="flex gap-1 mt-2">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Info note */}
      <p className="text-xs text-muted-foreground border-t pt-4">
        生成任务在后台运行，可以切换到其他页面，稍后再来查看结果。完成后可在下方查看完整的洞察报告。
      </p>
    </div>
  )
}

// --- Helper functions for parsing AI-generated mermaid chart blocks ---

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

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

function parseAsciiCallout(code: string) {
  const lines = code
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())

  if (lines.length === 0) return null

  const hasBoxChars = lines.some((line) => /[┌┐└┘│─]/.test(line))
  const hasWarningKeyword = lines.some((line) => /⚠️|警告|异常|提醒/.test(line))

  if (!hasWarningKeyword) return null

  // ASCII box style: requires ≥3 lines and box-drawing characters
  if (hasBoxChars) {
    if (lines.length < 3) return null

    const contentLines = lines
      .map((line) => line.replace(/^[┌└├│]\s*/, '').replace(/\s*[┐┘┤│]$/, '').trim())
      .filter((line) => line && !/^[─┬┴┼]+$/.test(line))

    if (contentLines.length === 0) return null

    return {
      title: contentLines[0].replace(/^⚠️\s*/, '').trim(),
      body: contentLines.slice(1),
    }
  }

  // Plain style (e.g. ```alert\n⚠️ Title\nBody line\n```): 1–2 lines, no box chars needed
  const title = lines[0].replace(/^⚠️\s*/, '').trim()
  const body = lines.slice(1).filter((line) => line.trim())

  if (!title) return null

  return { title, body }
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
    <div className="not-prose my-5 w-full overflow-hidden rounded-[22px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_18px_60px_-40px_rgba(15,23,42,0.45)]">
      <div className="flex items-center justify-between border-b border-border/60 bg-[hsl(var(--surface-overlay)/0.82)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--chart-1))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            RAW BLOCK
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="break-words overflow-x-auto px-4 py-4 text-xs leading-6 text-foreground">
        <code className="whitespace-pre-wrap break-words">{code}</code>
      </pre>
    </div>
  )
}

function AsciiCalloutBlock({ code }: { code: string }) {
  const parsed = parseAsciiCallout(code)

  if (!parsed) {
    return <FallbackCodeBlock code={code} />
  }

  return (
    <div className="not-prose my-6 overflow-hidden rounded-[24px] border border-[hsl(var(--warning)/0.28)] bg-[linear-gradient(180deg,hsl(var(--warning)/0.12),hsl(var(--surface-panel)))] shadow-[0_24px_80px_-48px_rgba(245,158,11,0.35)]">
      <div className="flex items-start gap-3 px-5 py-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[hsl(var(--warning)/0.18)] text-[hsl(var(--warning))]">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[hsl(var(--warning))]">Warning</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{parsed.title}</p>
          <div className="mt-3 space-y-2 text-sm leading-6 text-foreground/88">
            {parsed.body.map((line, index) => (
              <p key={`${index}-${line}`}>{line}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ChartCodeBlock({ chartType, code, collectChartSvgs }: { chartType: string; code: string; collectChartSvgs?: boolean }) {
  const normalizedType = chartType.trim().toLowerCase()

  if (normalizedType === 'linechart' || normalizedType === 'line') {
    const parsed = parseLineChart(code)
    const labels = parsed['x-axis'] || parsed['xaxis'] || []
    const seriesKey = Object.keys(parsed).find(
      (k) => k !== 'x-axis' && k !== 'xaxis' && k !== 'y-axis' && k !== 'yaxis' && parsed[k].length === labels.length
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
    const svgUrl = chartSvgRegistry.get(chartId)

    // During PNG export: render a self-contained static SVG so toPng captures it reliably.
    if (collectChartSvgs) {
      const W = 600
      const H = 220
      const padL = 52, padR = 16, padT = 12, padB = 28
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
      const area = `${toX(0)},${padT + vh} ` + chartData.map((d, i) => `${toX(i)},${toY(d.value)}`).join(' ') + ` ${toX(chartData.length - 1)},${padT + vh}`

      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" text-anchor="middle">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.32"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0.03"/></linearGradient></defs>
  ${gridYs.map((y) => `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="4 4"/>`).join('\n  ')}
  ${yLabels.map((label, i) => `<text x="${padL - 6}" y="${gridYs[i] + 4}" text-anchor="end" fill="#94a3b8">${label}</text>`).join('\n  ')}
  ${labels.filter((_, i) => i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1).map((l, _, arr) => {
    const idx = labels.indexOf(l)
    return `<text x="${toX(idx)}" y="${H - 6}" fill="#94a3b8">${l}</text>`
  }).join('\n  ')}
  <polygon points="${area}" fill="url(#lg)"/>
  <polyline points="${polyline}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="${pts}" fill="none" stroke="transparent" stroke-width="8"/>
</svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
      chartSvgRegistry.set(chartId, url)
      return (
        <div className="not-prose my-6 w-full overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.55)]">
          <div className="border-b border-border/60 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[hsl(var(--chart-1)/0.14)] text-[hsl(var(--chart-1))]">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Trend Chart</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{seriesKey?.toUpperCase() || '趋势变化'}</p>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 pt-4">
            {/* Recharts needs one frame to register its SVG; use the pre-generated static SVG as the img src */}
            <div className="h-[260px] w-full">
              {svgUrl ? (
                // Already generated this cycle — show it immediately
                // eslint-disable-next-line @next/next/no-img-element -- SVG data URLs can't use next/image
                <img src={svgUrl} alt="趋势图表" className="h-full w-full object-contain" />
              ) : (
                // First render of this cycle — show placeholder, will be replaced on next frame
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <Sparkles className="h-5 w-5 animate-pulse" />
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="not-prose my-6 w-full overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.55)]">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[hsl(var(--chart-1)/0.14)] text-[hsl(var(--chart-1))]">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Trend Chart</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{seriesKey?.toUpperCase() || '趋势变化'}</p>
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
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={18}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={44}
              />
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
                activeDot={{ r: 5, fill: 'var(--color-value)', stroke: 'hsl(var(--surface-panel))', strokeWidth: 2 }}
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
        <div className="not-prose my-6 w-full overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.55)]">
          <div className="border-b border-border/60 px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Composition</p>
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
                  className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/60 px-3 py-2.5 text-sm"
                >
                  <div
                    className="h-3 w-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: CHART_COLORS_HEX[i % CHART_COLORS_HEX.length] }}
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

    return (
      <div className="not-prose my-6 w-full overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.55)]">
        <div className="border-b border-border/60 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Composition</p>
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
                className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/60 px-3 py-2.5 text-sm"
              >
                <div
                  className="h-3 w-3 shrink-0 rounded-sm"
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

  // ─── Adding new chart types? ───────────────────────────────────────────────
  // Follow this two-step pattern for each new chart:
  //
  // Step 1 — Static SVG for PNG export:
  //   if (collectChartSvgs) {
  //     const chartId = `bar-${code.slice(0, 20)}`
  //     const svgUrl = chartSvgRegistry.get(chartId)
  //     // Generate a self-contained SVG string; store it; render <img>.
  //     // Use absolute color values (e.g. "#3b82f6") instead of CSS variables.
  //     // Return the full styled card markup with the <img> in place of the chart.
  //   }
  //
  // Step 2 — Live Recharts fallback:
  //   return (
  //     <div className="not-prose my-6 ...">  ← same card shell
  //       … <ResponsiveContainer><BarChart>…</ResponsiveContainer> …
  //     </div>
  //   )
  //
  // The export state machine (collectChartSvgs → rAF → toPng) works
  // automatically; only the chart body needs updating per type.
  // ───────────────────────────────────────────────────────────────────────────

  // TODO: implement bar chart static SVG export
  if (
    normalizedType === 'barchart' ||
    normalizedType === 'bar' ||
    normalizedType === 'columnchart' ||
    normalizedType === 'column'
  ) {
    const parsed = parseLineChart(code) // bar charts use the same key-value format
    const labels = parsed['x-axis'] || parsed['xaxis'] || []
    const seriesKey = Object.keys(parsed).find(
      (k) => !['x-axis', 'xaxis', 'y-axis', 'yaxis'].includes(k) && parsed[k].length === labels.length
    )
    const seriesData = seriesKey ? parsed[seriesKey] : []

    if (labels.length === 0 || seriesData.length === 0) {
      return <FallbackCodeBlock code={code} />
    }

    if (collectChartSvgs) {
      const barW = 600
      const barH = 220
      const padL = 52, padR = 16, padT = 12, padB = 28
      const vw = barW - padL - padR
      const vh = barH - padT - padB
      const values = seriesData.map((v: string) => parseFloat(v) || 0)
      const maxV = Math.max(...values, 1)
      const barCount = labels.length
      const slotW = vw / barCount
      const barW2 = Math.max(8, slotW * 0.6)
      const barGap = (slotW - barW2) / 2

      const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => padT + t * vh)
      const yLabels = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(maxV - t * maxV))

      const bars = labels.map((label: string, i: number) => {
        const h = (values[i] / maxV) * vh
        const x = padL + i * slotW + barGap
        const y = padT + vh - h
        return `<rect x="${x}" y="${y}" width="${barW2}" height="${h}" rx="4" fill="#3b82f6" opacity="0.85"/>`
      })

      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${barW}" height="${barH}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" text-anchor="middle">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.18"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0.04"/></linearGradient></defs>
  ${gridYs.map((y, i) => `<line x1="${padL}" y1="${y}" x2="${barW - padR}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="4 4"/>`).join('\n  ')}
  ${yLabels.map((label, i) => `<text x="${padL - 6}" y="${gridYs[i] + 4}" text-anchor="end" fill="#94a3b8">${label}</text>`).join('\n  ')}
  ${labels.filter((_: string, i: number) => i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1).map((l: string) => {
    const idx = labels.indexOf(l)
    return `<text x="${padL + idx * slotW + slotW / 2}" y="${barH - 6}" fill="#94a3b8">${l}</text>`
  }).join('\n  ')}
  ${bars.join('\n  ')}
</svg>`
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`
      const barId = `bar-${code.slice(0, 20)}`
      chartSvgRegistry.set(barId, url)

      return (
        <div className="not-prose my-6 w-full overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.55)]">
          <div className="border-b border-border/60 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[hsl(var(--chart-1)/0.14)] text-[hsl(var(--chart-1))]">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Bar Chart</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{seriesKey?.toUpperCase() || '柱状图'}</p>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 pt-4">
            <div className="h-[260px] w-full">
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URLs can't use next/image */}
              <img src={url} alt="柱状图" className="h-full w-full object-contain" />
            </div>
          </div>
        </div>
      )
    }

    // Live Recharts fallback (replace with dedicated BarChart component if needed)
    const chartData = labels.map((label: string, i: number) => ({
      label,
      value: parseFloat(seriesData[i]) || 0,
    }))

    return (
      <div className="not-prose my-6 w-full overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.55)]">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[hsl(var(--chart-1)/0.14)] text-[hsl(var(--chart-1))]">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Bar Chart</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{seriesKey?.toUpperCase() || '柱状图'}</p>
            </div>
          </div>
        </div>
        <div className="px-4 pb-3 pt-4">
          <ChartContainer config={CHART_CONFIG} className="h-[260px] w-full">
            {/* Replace with BarChart if recharts Bar is imported */}
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
                activeDot={{ r: 5, fill: 'var(--color-value)', stroke: 'hsl(var(--surface-panel))', strokeWidth: 2 }}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </div>
    )
  }

  return <FallbackCodeBlock code={code} />
}

function ReportSectionTitle({ children, className, ...props }: ComponentPropsWithoutRef<'h2'>) {
  return (
    <h2
      className={cn(
        'mt-10 flex items-center gap-3 border-b border-border/70 pb-3 text-[1.02rem] font-semibold tracking-[0.02em] text-foreground first:mt-0',
        className
      )}
      {...props}
    >
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-[hsl(var(--chart-1)/0.12)] text-[0.72rem] font-bold text-[hsl(var(--chart-1))]">
        {typeof children === 'string' ? children.slice(0, 1) : '章'}
      </span>
      <span>{children}</span>
    </h2>
  )
}

const MarkdownContent = ({ content, collectChartSvgs }: { content: string; collectChartSvgs?: boolean }) => {
  const Markdown = ReactMarkdown as React.FC<{
    remarkPlugins?: unknown[]
    children: string
    components?: Record<string, any>
  }>

  return (
        <div id="ai-insight-export-root" className="dashboard-surface max-w-full min-w-0 overflow-hidden rounded-[28px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] shadow-[0_28px_90px_-56px_rgba(15,23,42,0.55)]">
      <div className="border-b border-border/60 bg-[linear-gradient(135deg,hsl(var(--surface-overlay)/0.96),hsl(var(--surface-soft)/0.7))] px-6 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.26em] text-muted-foreground">
            AI Insight Report
          </span>
        </div>
      </div>
      <div className="px-6 py-6 sm:px-8">
        <div
          className={cn(
            'max-w-full min-w-0 text-[15px] leading-7 text-foreground',
            '[&_a]:font-medium [&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline',
            '[&_hr]:my-8 [&_hr]:border-border/70'
          )}
        >
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1({ className, ...props }: ComponentPropsWithoutRef<'h1'>) {
                return <h1 className={cn('text-2xl font-semibold tracking-tight text-foreground', className)} {...props} />
              },
              h2({ className, children, ...props }: ComponentPropsWithoutRef<'h2'> & { children?: ReactNode }) {
                return <ReportSectionTitle className={className} {...props}>{children}</ReportSectionTitle>
              },
              h3({ className, ...props }: ComponentPropsWithoutRef<'h3'>) {
                return (
                  <h3
                    className={cn('mt-6 text-base font-semibold text-foreground', className)}
                    {...props}
                  />
                )
              },
              p({ className, ...props }: ComponentPropsWithoutRef<'p'>) {
                return <p className={cn('mt-4 whitespace-pre-wrap text-[15px] leading-7 text-foreground/92', className)} {...props} />
              },
              strong({ className, ...props }: ComponentPropsWithoutRef<'strong'>) {
                return <strong className={cn('font-semibold text-foreground', className)} {...props} />
              },
              ul({ className, ...props }: ComponentPropsWithoutRef<'ul'>) {
                return <ul className={cn('mt-4 space-y-2 pl-6', className)} {...props} />
              },
              ol({ className, ...props }: ComponentPropsWithoutRef<'ol'>) {
                return <ol className={cn('mt-4 space-y-2 pl-6', className)} {...props} />
              },
              li({ className, ...props }: ComponentPropsWithoutRef<'li'>) {
                return <li className={cn('marker:text-[hsl(var(--chart-1))]', className)} {...props} />
              },
              blockquote({ className, ...props }: ComponentPropsWithoutRef<'blockquote'>) {
                return (
                  <blockquote
                    className={cn(
                      'my-5 rounded-r-2xl border-l-4 border-[hsl(var(--chart-3))] bg-[hsl(var(--chart-3)/0.08)] px-4 py-3 text-muted-foreground',
                      className
                    )}
                    {...props}
                  />
                )
              },
              table({ className, ...props }: ComponentPropsWithoutRef<'table'>) {
                return (
                  <div className="my-6 overflow-x-auto rounded-[22px] border border-border/70 bg-[hsl(var(--surface-overlay)/0.72)]">
                    <table className={cn('min-w-full border-collapse text-sm', className)} {...props} />
                  </div>
                )
              },
              thead({ className, ...props }: ComponentPropsWithoutRef<'thead'>) {
                return <thead className={cn('bg-[hsl(var(--surface-soft))]', className)} {...props} />
              },
              tbody({ className, ...props }: ComponentPropsWithoutRef<'tbody'>) {
                return <tbody className={cn('[&_tr:last-child]:border-b-0', className)} {...props} />
              },
              tr({ className, ...props }: ComponentPropsWithoutRef<'tr'>) {
                return <tr className={cn('border-b border-border/60', className)} {...props} />
              },
              th({ className, ...props }: ComponentPropsWithoutRef<'th'>) {
                return (
                  <th
                    className={cn(
                      'border-r border-border/60 px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground last:border-r-0 break-words',
                      className
                    )}
                    {...props}
                  />
                )
              },
              td({ className, ...props }: ComponentPropsWithoutRef<'td'>) {
                return (
                  <td
                    className={cn(
                      'border-r border-border/60 px-4 py-3 align-top text-sm text-foreground/92 last:border-r-0 break-words',
                      className
                    )}
                    {...props}
                  />
                )
              },
              code({ className, children, ...props }: ComponentPropsWithoutRef<'code'> & { children?: ReactNode }) {
                const match = /language-([\w-]+)/.exec(className || '')
                // react-markdown v10 HTML-encodes code block content; decode it so our
                // chart parsers and block-detection logic work correctly.
                let code = decodeHtmlEntities(String(children)).replace(/\n$/, '')
                const language = match?.[1]?.toLowerCase() || ''
                const isAsciiWarningBlock = /[┌┐└┘│─]/.test(code) && /⚠️|警告|异常|提醒/.test(code)

                // AI sometimes wraps ASCII art / code blocks in single backticks instead of
                // triple backticks. Detect this by checking for inner backticks or newlines
                // that indicate block-level content masquerading as inline code.
                const looksLikeBlock =
                  code.includes('\n') ||
                  /[┌─┐│└┘├┤┬┴┼]/.test(code) ||
                  (code.startsWith('`') && code.endsWith('`') && code.length > 2)

                if (looksLikeBlock && !match) {
                  // Strip outer backticks if the whole content is backtick-wrapped
                  if (/^`[\s\S]*`$/.test(code)) {
                    code = code.slice(1, -1)
                  }
                  if (isAsciiWarningBlock) {
                    return <AsciiCalloutBlock code={code} />
                  }
                  return <FallbackCodeBlock code={code} />
                }

                const isInline = !match && !code.includes('\n')

                if (isInline) {
                  return (
                    <code
                      className={cn('rounded-md bg-[hsl(var(--surface-soft))] px-1.5 py-0.5 font-mono text-[0.85em]', className)}
                      {...props}
                    >
                      {children}
                    </code>
                  )
                }

                if (language === 'linechart' || language === 'line' || language === 'piechart' || language === 'pie') {
                  return <ChartCodeBlock chartType={language} code={code} collectChartSvgs={collectChartSvgs} />
                }

                if (language === 'alert' || language === 'warning' || isAsciiWarningBlock) {
                  // Strip leading "alert" / "warning" language tag so the parser only sees the content
                  const codeLines = code.split('\n')
                  const firstLine = codeLines[0]?.trim().toLowerCase() ?? ''
                  const cleanCode =
                    (firstLine === 'alert' || firstLine === 'warning') && codeLines.length > 1
                      ? codeLines.slice(1).join('\n')
                      : code
                  return <AsciiCalloutBlock code={cleanCode} />
                }

                return <FallbackCodeBlock code={code} />
              },
              pre({ children }: ComponentPropsWithoutRef<'pre'> & { children?: ReactNode }) {
                return <>{children}</>
              },
            }}
          >
            {content}
          </Markdown>
        </div>
      </div>
    </div>
  )
}

export default function AIInsightsPage() {
  const { data: session } = useSession()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  // 'all' means show all managed projects; a number means filter by that project
  const [selectedProjectId, setSelectedProjectId] = useState<number | 'all'>('all')
  const [selectedCountry, setSelectedCountry] = useState('US')
  const defaultRange = useMemo(() => lastSevenDaysRange(selectedCountry), [selectedCountry])
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultRange)
  const [insightType, setInsightType] = useState('custom')
  const [insights, setInsights] = useState<InsightItem[]>([])
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [isLoadingInsights, setIsLoadingInsights] = useState(true)
  const [insightDialogOpen, setInsightDialogOpen] = useState(false)
  const currentInsightId = useRef<number | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  // View historical insight
  const [viewingInsight, setViewingInsight] = useState<InsightItem | null>(null)
  const [viewDialogOpen, setViewDialogOpen] = useState(false)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isEditingDetail, setIsEditingDetail] = useState(false)
  const [editingContent, setEditingContent] = useState('')
  const [isSavingDetail, setIsSavingDetail] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  // State machine: triggers charts to render <img> with SVG data URL → effect captures PNG
  const [collectChartSvgs, setCollectChartSvgs] = useState(false)
  const pendingExportRef = useRef(false)

  // Live streaming content (shown in generation dialog)
  const [streamingContent, setStreamingContent] = useState('')
  const [currentSubStatus, setCurrentSubStatus] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const streamingRef = useRef<HTMLDivElement>(null)

  // SSE state for the "view live generation" mode
  const viewEventSourceRef = useRef<EventSource | null>(null)
  const [viewLiveContent, setViewLiveContent] = useState('')
  const [viewLiveSubStatus, setViewLiveSubStatus] = useState<string | null>(null)
  const [viewLiveRefreshing, setViewLiveRefreshing] = useState(false)
  const [viewLiveError, setViewLiveError] = useState<string | null>(null)
  // Track sub_status per insight — key is insight ID, value is sub_status string
  const insightSubStatusRef = useRef<Record<number, string | null>>({})
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Track which EventSource instances this effect has already attached listeners to
  const _attachedEses = useRef<Set<EventSource>>(new Set())

  useEffect(() => {
    async function loadProjects() {
      if (!session) return
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(rows || [])
        if (rows && rows.length > 0) {
          const paramProjectId = searchParams.get('project_id')
          if (paramProjectId) {
            setSelectedProjectId(Number(paramProjectId))
          }
          // Default to 'all' — no need to set explicitly since that is already the initial state
        }
      } catch (e) {
        console.error('Failed to load projects', e)
      } finally {
        setIsLoadingProjects(false)
      }
    }
    void loadProjects()
  }, [session, searchParams])

  // When country changes, reset dateRange to "last 7 days in that country's timezone".
  useEffect(() => {
    setDateRange(defaultRange)
  }, [selectedCountry, defaultRange])

  const loadInsights = useCallback(async () => {
    if (!selectedProjectId) return
    setIsLoadingInsights(true)
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (selectedProjectId !== 'all') {
        params.set('project_id', String(selectedProjectId))
      }
      const res = await fetch(`/api/backend/v1/ai-insights?${params}`)
      if (!res.ok) throw new Error(await parseResponseError(res, '加载失败'))
      const data = await res.json()
      setInsights(data.items || [])
    } catch (e) {
      console.error('Failed to load insights', e)
    } finally {
      setIsLoadingInsights(false)
    }
  }, [selectedProjectId])

  useEffect(() => {
    if (selectedProjectId) {
      void loadInsights()
    }
  }, [selectedProjectId, loadInsights])

  useEffect(() => {
    async function loadModelConfig() {
      setIsLoadingModelConfig(true)
      try {
        const res = await fetch('/api/ai-chat/config', {
          method: 'GET',
          cache: 'no-store',
        })
        const payload = await res.json() as AIModelConfig
        if (!res.ok) {
          throw new Error(payload.message || `加载模型失败 (${res.status})`)
        }

        setModelConfig(payload)
        setSelectedModel((prev) => {
          if (prev && payload.models.includes(prev)) {
            return prev
          }
          return payload.defaultModel || payload.models[0] || ''
        })
      } catch (e) {
        console.error('Failed to load AI model config', e)
      } finally {
        setIsLoadingModelConfig(false)
      }
    }

    void loadModelConfig()
  }, [])

  const _closeViewSse = useCallback(() => {
    if (viewEventSourceRef.current) {
      viewEventSourceRef.current.close()
      viewEventSourceRef.current = null
    }
  }, [])

  const _attachViewSse = useCallback((insightId: number) => {
    _closeViewSse()
    const es = new EventSource(`/api/backend/v1/ai-insights/${insightId}/stream`)
    viewEventSourceRef.current = es

    es.onmessage = (e) => {
      if (!e.data || e.data.trim() === '') return
      try {
        const event: SseEvent = JSON.parse(e.data)

        if (event.type === 'ping') return

        if (event.type === 'status') {
          setViewLiveSubStatus(event.sub_status ?? null)
          // Keep viewingInsight.sub_status in sync so dialog conditions stay satisfied
          setViewingInsight((prev) => prev ? { ...prev, sub_status: event.sub_status ?? prev.sub_status } : prev)
          if (event.status === 'failed') {
            setViewLiveRefreshing(false)
            _closeViewSse()
            // Update viewingInsight to reflect the failure state
            setViewingInsight((prev) => prev ? {
              ...prev,
              status: 'failed',
              error_message: event.error_message ?? '生成任务失败',
              content: '',
            } : prev)
            void loadInsights()
            return
          }
        } else if (event.type === 'chunk') {
          setViewLiveContent((prev) => prev + (event.delta || ''))
          setTimeout(() => {
            streamingRef.current?.scrollIntoView({ behavior: 'smooth' })
          }, 50)
        } else if (event.type === 'done') {
          setViewLiveContent((prev) => event.content ?? prev)
          setViewLiveSubStatus(null)
          setViewLiveRefreshing(false)
          _closeViewSse()
          setViewingInsight((prev) => prev ? {
            ...prev,
            status: event.status === 'failed' ? 'failed' : 'completed',
            title: event.title || prev.title,
            content: event.content || prev.content,
            error_message: event.error_message ?? null,
          } : prev)
          void loadInsights()
        } else if (event.type === 'error') {
          setViewLiveRefreshing(false)
          setViewLiveError(event.error_message ?? event.error ?? '无法连接到生成任务')
          _closeViewSse()
          setViewingInsight((prev) => prev ? {
            ...prev,
            status: 'failed',
            error_message: event.error_message ?? event.error ?? '无法连接到生成任务',
            content: '',
          } : prev)
          void loadInsights()
        }
      } catch (parseErr) {
        console.warn('Failed to parse SSE event', parseErr)
      }
    }

    es.onerror = () => {
      const errMsg = 'SSE 连接中断，请关闭窗口后重试'
      setViewLiveRefreshing(false)
      setViewLiveError(errMsg)
      _closeViewSse()
      setViewingInsight((prev) => prev ? { ...prev, status: 'failed', error_message: errMsg, content: '' } : prev)
      void loadInsights()
    }
  }, [_closeViewSse, loadInsights, viewLiveContent])

  const handleViewInsight = useCallback(async (insightId: number) => {
    setIsLoadingDetail(true)
    setViewDialogOpen(true)
    setViewingInsight(null)
    setIsEditingDetail(false)
    setEditingContent('')
    setViewLiveContent('')
    setViewLiveSubStatus(null)
    setViewLiveError(null)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insightId}`)
      if (!res.ok) throw new Error(await parseResponseError(res, '加载失败'))
      const data: InsightItem = await res.json()
      // Sync SSE current state into view state immediately so stepper is visible before first event
      const liveStatus = insightSubStatusRef.current[insightId] ?? data.sub_status
      setViewLiveSubStatus(liveStatus)
      setViewingInsight(data)
      if (data.status === 'generating' || data.status === 'pending') {
        // Immediately show "live" mode so stepper appears before SSE's first event fires
        setViewLiveRefreshing(true)
        // Live mode: attach SSE to watch generation progress in the dialog
        _attachViewSse(insightId)
        setIsLoadingDetail(false)
      } else {
        // Completed, failed, or pending — show static content / error
        setEditingContent(data.content || '')
        setIsLoadingDetail(false)
      }
    } catch (e) {
      console.error('Failed to load insight detail', e)
      alert(`加载失败: ${e instanceof Error ? e.message : String(e)}`)
      setViewDialogOpen(false)
      setIsLoadingDetail(false)
    }
  }, [_attachViewSse])

  const handleRetryInsight = useCallback(async (insightId: number) => {
    if (!confirm('确定要重试生成这条洞察吗？当前内容将被替换。')) return
    setViewLiveRefreshing(true)
    setViewLiveContent('')
    setViewLiveSubStatus(null)
    setViewLiveError(null)
    // Mark as loading so the dialog shows a clean state while SSE connects
    setIsLoadingDetail(true)
    setIsEditingDetail(false)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insightId}/retry`, { method: 'POST' })
      if (!res.ok) throw new Error(await parseResponseError(res, '重试失败'))
      // Immediately open the live view — SSE will update viewingInsight on first event
      _attachViewSse(insightId)
      // Refresh the list so the table shows "生成中" immediately
      void loadInsights()
    } catch (e) {
      console.error('Failed to retry insight', e)
      alert(`重试失败: ${e instanceof Error ? e.message : String(e)}`)
      setViewLiveRefreshing(false)
      setIsLoadingDetail(false)
    }
  }, [_attachViewSse, loadInsights])

  const handleStartEditingDetail = useCallback(() => {
    setEditingContent(viewingInsight?.content || '')
    setIsEditingDetail(true)
  }, [viewingInsight])

  const handleCancelEditingDetail = useCallback(() => {
    setEditingContent(viewingInsight?.content || '')
    setIsEditingDetail(false)
  }, [viewingInsight])

  const handleSaveDetail = useCallback(async () => {
    if (!viewingInsight) return

    const nextContent = editingContent.trim()
    if (!nextContent) {
      alert('报告内容不能为空')
      return
    }

    setIsSavingDetail(true)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${viewingInsight.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      })
      if (!res.ok) throw new Error(await parseResponseError(res, '保存失败'))

      const updated: InsightItem = await res.json()
      setViewingInsight(updated)
      setEditingContent(updated.content || '')
      setIsEditingDetail(false)
      setInsights((current) =>
        current.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                title: updated.title,
                status: updated.status,
                error_message: updated.error_message,
                updated_at: updated.updated_at,
              }
            : item
        )
      )
    } catch (e) {
      console.error('Failed to save insight detail', e)
      alert(`保存失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setIsSavingDetail(false)
    }
  }, [editingContent, viewingInsight])

  // Phase 1: charts register SVG data URLs; Phase 2: we capture PNG.
  // Using a state machine so React batches the render before toPng fires.
  useEffect(() => {
    if (!collectChartSvgs) return
    const node = document.getElementById('ai-insight-export-root')
    if (!node) {
      setCollectChartSvgs(false)
      return
    }
    // Two frames: first for chart components to fill chartSvgRegistry,
    // second for their <img> src attributes to be painted by the browser.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const dataUrl = document.getElementById('ai-insight-export-root')
        if (!dataUrl) {
          setCollectChartSvgs(false)
          return
        }

        toPng(dataUrl, { backgroundColor: '#ffffff', pixelRatio: 2, cacheBust: true })
          .then((url) => {
            const link = document.createElement('a')
            link.download = `AI洞察_${viewingInsight?.title ?? '报告'}_${new Date().toISOString().slice(0, 10)}.png`
            link.href = url
            link.click()
          })
          .catch((err) => {
            console.error('Failed to export PNG', err)
            alert('导出失败，请重试')
          })
          .finally(() => {
            setCollectChartSvgs(false)
            setIsExporting(false)
          })
      })
    })
  }, [collectChartSvgs, viewingInsight])

  const handleExportPng = useCallback(() => {
    if (!document.getElementById('ai-insight-export-root')) return
    chartSvgRegistry.clear()
    setIsExporting(true)
    setCollectChartSvgs(true) // triggers chart components to render <img> tags
  }, [])

  const _closeSse = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
  }, [])

  // Top-level SSE handler — runs whenever eventSourceRef.current changes.
  // Uses a Set to safely handle re-runs without duplicate listener attachment.
  useEffect(() => {
    const es = eventSourceRef.current
    if (!es) return

    // Guard: don't double-attach if this EventSource already has handlers
    if (_attachedEses.current.has(es)) return
    _attachedEses.current.add(es)

    const onMessage = (e: MessageEvent) => {
      if (!e.data || e.data.trim() === '') return
      try {
        const event: SseEvent = JSON.parse(e.data)

        if (event.type === 'ping') return

        if (event.type === 'status') {
          const sid = event.insight_id ?? currentInsightId.current
          if (sid) insightSubStatusRef.current[sid] = event.sub_status ?? null
          setCurrentSubStatus(event.sub_status ?? null)
          if (event.status === 'failed') {
            alert(`生成失败: ${event.error_message || '生成任务失败'}`)
            _closeSse()
            setInsightDialogOpen(false)
            setInsights((prev) => prev.filter((i) => i.id !== sid))
            return
          }
          // Update the optimistic record's sub_status in the list — works even if dialog is closed
          setInsights((prev) =>
            prev.map((item) =>
              item.id === sid
                ? {
                    ...item,
                    status: event.status,
                    sub_status: event.sub_status ?? item.sub_status,
                    title: event.title ? `${event.title}` : item.title,
                  }
                : item
            )
          )
        } else if (event.type === 'chunk') {
          setStreamingContent((prev) => prev + (event.delta || ''))
          setTimeout(() => {
            streamingRef.current?.scrollIntoView({ behavior: 'smooth' })
          }, 50)
        } else if (event.type === 'done') {
          const sid = event.insight_id ?? currentInsightId.current
          if (event.status === 'failed') {
            alert(`生成失败: ${event.error_message || '生成任务失败'}`)
            setInsights((prev) => prev.filter((i) => i.id !== sid))
          } else {
            setInsightDialogOpen(false)
          }
          // content 只从 done 事件获取，不再从 status 中途获取
          if (event.content) setStreamingContent(event.content)
          setCurrentSubStatus(null)
          _closeSse()
          void loadInsights()
        } else if (event.type === 'error') {
          const sid = event.insight_id ?? currentInsightId.current
          alert(`生成失败: ${event.error}`)
          _closeSse()
          setInsightDialogOpen(false)
          setCurrentSubStatus(null)
          setInsights((prev) => prev.filter((i) => i.id !== sid))
        }
      } catch (parseErr) {
        console.warn('Failed to parse SSE event', parseErr)
      }
    }

    const onError = () => {
      _closeSse()
      setInsightDialogOpen(false)
      alert('SSE 连接中断，生成任务可能仍在后台运行，请稍后在列表中查看结果')
      void loadInsights()
    }

    es.addEventListener('message', onMessage)
    es.onerror = onError

    return () => {
      es.removeEventListener('message', onMessage)
      es.onerror = null
      _attachedEses.current.delete(es)
    }
  }, [_closeSse, eventSourceRef.current])

  // Polling fallback: refresh processing insights every 10s in case SSE missed the done event
  useEffect(() => {
    const hasProcessing = insights.some((i) => i.status === 'generating' || i.status === 'pending')
    if (!hasProcessing) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      return
    }
    if (pollingIntervalRef.current) return // already polling
    pollingIntervalRef.current = setInterval(() => {
      const stillProcessing = insights.some((i) => i.status === 'generating' || i.status === 'pending')
      if (stillProcessing) void loadInsights()
    }, 10_000)
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
  }, [insights, loadInsights])

  const handleGenerate = async () => {
    if (!selectedProjectId || selectedProjectId === 'all' || !dateRange?.from || !dateRange?.to) return

    setIsGenerating(true)
    setStreamingContent('')
    setCurrentSubStatus('data_aggregating')  // Immediately show step 1 as active
    setInsightDialogOpen(true)
    currentInsightId.current = null

    try {
      const body = {
        project_id: selectedProjectId,
        country: selectedCountry,
        date_range_start: formatYMD(dateRange.from),
        date_range_end: formatYMD(dateRange.to),
        insight_type: insightType,
        model: selectedModel || undefined,
      }

      const response = await fetch('/api/backend/v1/ai-insights/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        throw new Error(await parseResponseError(response, '请求失败'))
      }

      const result = await response.json()
      const insightId: number = result.insight_id
      currentInsightId.current = insightId

      // Optimistically add a "processing" record to the list so it shows immediately without a refresh
      const optimisticRecord: InsightItem = {
        id: insightId,
        project_id: selectedProjectId,
        project_name: selectedProjectName || '',
        country: selectedCountry,
        title: '洞察报告生成中...',
        insight_type: insightType,
        date_range_start: formatYMD(dateRange.from!),
        date_range_end: formatYMD(dateRange.to!),
        status: 'generating',
        sub_status: 'queued',
        created_by: session?.user?.name || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      setInsights((prev) => [optimisticRecord, ...prev])

      // SSE is attached by the top-level useEffect — do NOT close it when dialog closes
      const es = new EventSource(
        `/api/backend/v1/ai-insights/${insightId}/stream`
      )
      eventSourceRef.current = es

    } catch (e) {
      console.error('Failed to start insight generation', e)
      alert(`启动失败: ${e instanceof Error ? e.message : String(e)}`)
      setInsightDialogOpen(false)
    } finally {
      setIsGenerating(false)
    }
  }

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      _closeSse()
    }
  }, [_closeSse])

  const handleDelete = async (insightId: number) => {
    if (!confirm('确定要删除这条洞察吗？')) return
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insightId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await parseResponseError(res, '删除失败'))
      await loadInsights()
    } catch (e) {
      console.error('Failed to delete insight', e)
      alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const formatDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-')
    if (!year || !month || !day) return dateStr
    return `${year}-${month}-${day}`
  }

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
  }

  const selectedProjectName = projects.find((p) => p.id === selectedProjectId)?.name || ''

  return (
    <div className="space-y-6">
      <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="h-5 w-5 text-primary" />
              生成 AI 洞察
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {isLoadingProjects ? (
                <Skeleton className="h-10 w-[180px]" />
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="h-10 w-[180px] justify-between border-border/70 bg-[hsl(var(--surface-soft))] shadow-none">
                      {selectedProjectId === 'all'
                        ? '全部项目'
                        : projects.find((p) => p.id === selectedProjectId)?.name ?? '选择项目'}
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[180px]">
                    <DropdownMenuItem
                      key="all"
                      onClick={() => setSelectedProjectId('all')}
                      className={cn(selectedProjectId === 'all' && 'bg-primary/10')}
                    >
                      全部项目
                    </DropdownMenuItem>
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() => p.id !== null && setSelectedProjectId(p.id)}
                        className={cn(selectedProjectId === p.id && 'bg-primary/10')}
                      >
                        {p.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="h-10 w-[140px] justify-between border-border/70 bg-[hsl(var(--surface-soft))] shadow-none">
                    {COUNTRY_OPTIONS.find((c) => c.value === selectedCountry)?.label || '国家站点'}
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[140px]">
                  {COUNTRY_OPTIONS.map((c) => (
                    <DropdownMenuItem
                      key={c.value}
                      onClick={() => setSelectedCountry(c.value)}
                      className={cn(selectedCountry === c.value && 'bg-primary/10')}
                    >
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="h-10 w-[120px] justify-between border-border/70 bg-[hsl(var(--surface-soft))] shadow-none">
                    {INSIGHT_TYPE_OPTIONS.find((t) => t.value === insightType)?.label || '类型'}
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[120px]">
                  {INSIGHT_TYPE_OPTIONS.map((t) => (
                    <DropdownMenuItem
                      key={t.value}
                      onClick={() => setInsightType(t.value)}
                      className={cn(insightType === t.value && 'bg-primary/10')}
                    >
                      {t.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Select
                value={selectedModel}
                onValueChange={setSelectedModel}
                disabled={isLoadingModelConfig || isGenerating || !modelConfig?.models.length}
              >
                <SelectTrigger className="h-10 w-[220px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none">
                  <SelectValue placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'} />
                </SelectTrigger>
                <SelectContent>
                  {(modelConfig?.premiumModels.length || 0) > 0 && (
                    <SelectGroup>
                      <SelectLabel>高级模型</SelectLabel>
                      {modelConfig?.premiumModels.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {(modelConfig?.basicModels.length || 0) > 0 && (
                    <SelectGroup>
                      <SelectLabel>基础模型</SelectLabel>
                      {modelConfig?.basicModels.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {modelConfig?.models
                    .filter((model) => !modelConfig.premiumModels.includes(model) && !modelConfig.basicModels.includes(model))
                    .map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>

              <DateRangePicker
                value={dateRange}
                onChange={setDateRange}
                className="h-10 w-[240px]"
                timezone={COUNTRY_TIMEZONE_MAP[selectedCountry]}
              />
              <Button
                onClick={() => void handleGenerate()}
                disabled={!selectedProjectId || selectedProjectId === 'all' || !dateRange?.from || !dateRange?.to || isGenerating}
                className="h-10 gap-2"
              >
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
                {isGenerating ? '生成中...' : '生成洞察'}
              </Button>
            </div>

            <p className="text-sm text-muted-foreground">
              选择项目、日期范围和洞察类型，系统将基于该时间段内的销售、广告、库存等数据生成 AI 经营洞察报告。
              生成任务在后台运行，可以切换到其他页面，稍后再来查看结果。
            </p>
          </CardContent>
        </Card>

      <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            洞察记录
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingInsights ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : insights.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/10 h-24 text-center">
              <p className="text-sm text-muted-foreground">在左侧选择项目和时间范围，然后点击「生成洞察」按钮</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">标题</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>国家</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>日期范围</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>生成时间</TableHead>
                  <TableHead className="w-[100px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {insights.map((insight) => (
                  <TableRow
                    key={insight.id}
                    className={cn('cursor-pointer', insight.status === 'generating' && 'opacity-70')}
                    onClick={() => void handleViewInsight(insight.id)}
                  >
                    <TableCell className="font-medium whitespace-normal break-words">
                      {insight.status === 'generating' || insight.status === 'pending' ? (
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                          <span className="text-muted-foreground">
                            {SUB_STATUS_LABELS[insightSubStatusRef.current[insight.id] ?? insight.sub_status ?? ''] ?? '生成中'}
                          </span>
                        </span>
                      ) : (
                        insight.title
                      )}
                    </TableCell>
                    <TableCell>{insight.project_name}</TableCell>
                    <TableCell>{insight.country}</TableCell>
                    <TableCell>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs">
                        {INSIGHT_TYPE_OPTIONS.find((t) => t.value === insight.insight_type)?.label || insight.insight_type}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(insight.date_range_start)} ~ {formatDate(insight.date_range_end)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs',
                          insight.status === 'completed'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : insight.status === 'failed'
                              ? 'bg-red-500/10 text-red-600'
                              : insight.status === 'pending'
                                ? 'bg-blue-500/10 text-blue-600 animate-pulse'
                                : 'bg-amber-500/10 text-amber-600 animate-pulse'
                        )}
                      >
                        {insight.status === 'completed'
                          ? '已完成'
                          : insight.status === 'failed'
                            ? '失败'
                            : insight.status === 'pending'
                              ? '排队中'
                              : SUB_STATUS_LABELS[insightSubStatusRef.current[insight.id] ?? insight.sub_status ?? ''] ?? '生成中'}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(insight.created_at)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={insight.status === 'generating'}
                          onClick={() => void handleViewInsight(insight.id)}
                        >
                          <Eye className="h-4 w-4 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => void handleDelete(insight.id)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Live generation progress dialog */}
      <Dialog open={insightDialogOpen} onOpenChange={(open) => {
        // SSE stays alive even when dialog closes — it continues updating the list
        if (!open) setCurrentSubStatus(null)
        setInsightDialogOpen(open)
      }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {selectedProjectName} - AI 洞察报告
            </DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            {streamingContent === '' ? (
              <GenerationProgress currentSubStatus={currentSubStatus} />
            ) : (
              <div ref={streamingRef}>
                <MarkdownContent content={streamingContent} collectChartSvgs={collectChartSvgs} />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* View historical insight dialog */}
      <Dialog
        open={viewDialogOpen}
        onOpenChange={(open) => {
          if (!open) _closeViewSse()
          setViewDialogOpen(open)
          if (!open) {
            setIsEditingDetail(false)
            setEditingContent('')
            setViewLiveContent('')
            setViewLiveSubStatus(null)
            setViewLiveError(null)
          }
        }}
      >
        <DialogContent className={cn(
          'max-h-[80vh] overflow-y-auto overflow-x-auto',
          isEditingDetail ? 'max-w-[1350px]' : 'max-w-[675px]'
        )}>
          <DialogHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  {viewingInsight?.status === 'generating' || viewingInsight?.sub_status === 'queued' || viewLiveRefreshing ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      {viewingInsight?.sub_status === 'queued' ? '排队中...' : '正在生成洞察...'}
                    </>
                  ) : (
                    <>
                      <Eye className="h-5 w-5" />
                      {viewingInsight?.title ?? '洞察详情'}
                    </>
                  )}
                </DialogTitle>
                {viewingInsight && (
                  <p className="text-sm text-muted-foreground font-normal">
                    {viewingInsight.project_name} · {COUNTRY_OPTIONS.find((c) => c.value === viewingInsight.country)?.label} ·{' '}
                    {formatDate(viewingInsight.date_range_start)} ~ {formatDate(viewingInsight.date_range_end)} ·{' '}
                    {INSIGHT_TYPE_OPTIONS.find((t) => t.value === viewingInsight.insight_type)?.label} ·{' '}
                    {formatDateTime(viewingInsight.created_at)} 生成
                  </p>
                )}
              </div>

              {/* Live / Retry button */}
              {(viewingInsight?.status === 'generating' || viewingInsight?.sub_status === 'queued' || viewLiveRefreshing) && (
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    实时生成中
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => viewingInsight && void handleRetryInsight(viewingInsight.id)}
                  >
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    重试
                  </Button>
                </div>
              )}

              {/* Completed insight actions */}
              {!isLoadingDetail && viewingInsight?.status === 'completed' && viewingInsight?.content && !isEditingDetail ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleStartEditingDetail}>
                    <Pencil className="mr-1.5 h-4 w-4" />
                    手动编辑
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void handleExportPng()} disabled={isExporting}>
                    {isExporting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Image className="mr-1.5 h-4 w-4" />}
                    导出图片
                  </Button>
                </div>
              ) : null}

              {/* Failed insight — retry */}
              {!isLoadingDetail && viewingInsight?.status === 'failed' ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => viewingInsight && void handleRetryInsight(viewingInsight.id)}
                  >
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    重新生成
                  </Button>
                </div>
              ) : null}
            </div>
          </DialogHeader>
          <div className="mt-4">
            {isLoadingDetail ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-3 text-muted-foreground">正在加载洞察内容...</span>
              </div>
            ) : isEditingDetail ? (
              <div className="grid grid-cols-2 gap-4" style={{ height: '70vh' }}>
                <div className="flex flex-col overflow-y-auto rounded-2xl border border-border/70 bg-background/60">
                  <div className="sticky top-0 z-10 border-b border-border/40 bg-background/90 px-4 py-2.5 backdrop-blur-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">预览</p>
                  </div>
                  <div className="flex-1 overflow-y-auto px-4 py-4">
                    <MarkdownContent content={editingContent} collectChartSvgs={collectChartSvgs} />
                  </div>
                </div>
                <div className="flex flex-col gap-3 min-h-0">
                  <div className="shrink-0 flex items-center justify-between rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] px-4 py-3 text-sm text-muted-foreground">
                    <span>
                      直接编辑 Markdown 内容，支持表格、<code className="text-foreground">lineChart</code> /
                      <code className="text-foreground">pieChart</code> 代码块实时预览。
                    </span>
                    <div className="flex items-center gap-2 ml-4 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCancelEditingDetail}
                        disabled={isSavingDetail}
                      >
                        <X className="mr-1.5 h-4 w-4" />
                        取消
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleSaveDetail()}
                        disabled={isSavingDetail}
                      >
                        {isSavingDetail ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                        保存
                      </Button>
                    </div>
                  </div>
                  <textarea
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    spellCheck={false}
                    className="flex-1 w-full rounded-2xl border border-border/70 bg-[hsl(var(--surface-panel))] px-4 py-4 font-mono text-sm leading-6 text-foreground shadow-sm outline-none transition focus:border-primary resize-none"
                    placeholder="在此编辑 Markdown 内容..."
                  />
                </div>
              </div>
            ) : (viewingInsight?.status === 'generating' || viewingInsight?.sub_status === 'queued' || viewLiveRefreshing) ? (
              /* Live generation view — stepper + streaming content */
              <div ref={streamingRef} className="space-y-6">
                <GenerationProgress currentSubStatus={viewLiveSubStatus} />
                {viewLiveContent && (
                  <div className="border-t border-border/40 pt-6">
                    <MarkdownContent content={viewLiveContent} collectChartSvgs={collectChartSvgs} />
                  </div>
                )}
              </div>
            ) : viewingInsight?.content ? (
              <MarkdownContent content={viewingInsight.content} collectChartSvgs={collectChartSvgs} />
            ) : viewingInsight?.error_message ? (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600">
                生成失败：{viewingInsight.error_message}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">暂无内容</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
