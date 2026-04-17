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
  | { type: 'done'; insight_id: number; title: string; content?: string }
  | { type: 'error'; error: string; insight_id?: number | null }
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

function formatYMD(date: Date, country: string): string {
  const tz = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  return formatter.format(date)
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

function getYesterdayRange(country: string) {
  const today = getTodayInTimezone(COUNTRY_TIMEZONE_MAP[country] ?? 'UTC')
  const yesterday = addDays(today, -1)
  return { from: yesterday, to: yesterday }
}

function GenerationProgress({ currentSubStatus }: { currentSubStatus: string | null }) {
  // Top-level step (data_aggregating, ai_generating, title_generating)
  const topLevelIndex = currentSubStatus
    ? GENERATION_STEPS.findIndex((s) => s.key === currentSubStatus)
    : -1

  // Whether we're inside the data aggregation phase
  const isInDataAggregation = currentSubStatus?.startsWith('data_aggregating') && currentSubStatus !== 'data_aggregating'
  const activeDataStepIndex = currentSubStatus
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
          const isCompleted = index < topLevelIndex || (index === topLevelIndex && currentSubStatus === 'ai_generating' && topLevelIndex === 1)

          return (
            <div key={step.key} className="flex items-start gap-4">
              {/* Connector line (except for first step) */}
              {index > 0 && (
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      'w-0.5 h-4 transition-colors duration-300',
                      index <= topLevelIndex ? 'bg-primary' : 'bg-border'
                    )}
                  />
                </div>
              )}
              {index === 0 && <div className="w-5" />}

              {/* Step indicator */}
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all duration-300 shrink-0',
                    isCompleted
                      ? 'border-primary bg-primary text-white'
                      : isActive
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground'
                  )}
                >
                  {isCompleted ? (
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isActive ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
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

                {/* Nested data sub-steps when in data_aggregating */}
                {step.key === 'data_aggregating' && (
                  <div className="mt-2 pl-2 border-l-2 border-primary/20 space-y-1">
                    {DATA_STEPS.map((ds) => {
                      const di = DATA_STEPS.findIndex((d) => d.key === ds.key)
                      const isDCompleted = currentSubStatus ? DATA_STEPS.findIndex((d) => d.key === currentSubStatus) > di : false
                      const isDActive = currentSubStatus === ds.key
                      return (
                        <div key={ds.key} className="flex items-center gap-2">
                          <div className={cn('h-1.5 w-1.5 rounded-full', isDCompleted || isDActive ? 'bg-primary' : 'bg-border')} />
                          <span className={cn('text-xs', isDActive ? 'text-primary font-medium' : isDCompleted ? 'text-foreground' : 'text-muted-foreground')}>
                            {ds.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Animated dots for active step */}
                {isActive && !isInDataAggregation && (
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

  if (
    lines.length < 3 ||
    !lines.some((line) => /[┌┐└┘│─]/.test(line)) ||
    !lines.some((line) => /⚠️|警告|异常|提醒/.test(line))
  ) {
    return null
  }

  const contentLines = lines
    .map((line) => line.replace(/^[┌└├│]\s*/, '').replace(/\s*[┐┘┤│]$/, '').trim())
    .filter((line) => line && !/^[─┬┴┼]+$/.test(line))

  if (contentLines.length === 0) {
    return null
  }

  const title = contentLines[0].replace(/^⚠️\s*/, '').trim()
  const body = contentLines.slice(1)

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

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
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

function ChartCodeBlock({ chartType, code }: { chartType: string; code: string }) {
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

const MarkdownContent = ({ content }: { content: string }) => {
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
                  return <ChartCodeBlock chartType={language} code={code} />
                }

                if (language === 'alert' || language === 'warning' || isAsciiWarningBlock) {
                  return <AsciiCalloutBlock code={code} />
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
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
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
          } else {
            setSelectedProjectId(rows[0].id)
          }
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
      const params = new URLSearchParams({
        project_id: String(selectedProjectId),
        limit: '20',
      })
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
          if (event.content) setViewLiveContent(event.content)
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
          setViewLiveContent(event.content || viewLiveContent)
          setViewLiveSubStatus(null)
          _closeViewSse()
          setViewingInsight((prev) => prev ? {
            ...prev,
            status: 'completed',
            title: event.title || prev.title,
            content: event.content || '',
            error_message: null,
          } : prev)
          void loadInsights()
        } else if (event.type === 'error') {
          setViewLiveRefreshing(false)
          _closeViewSse()
          setViewingInsight((prev) => prev ? {
            ...prev,
            status: 'failed',
            error_message: event.error ?? '生成任务失败',
            content: '',
          } : prev)
          void loadInsights()
        }
      } catch (parseErr) {
        console.warn('Failed to parse SSE event', parseErr)
      }
    }

    es.onerror = () => {
      setViewLiveRefreshing(false)
      _closeViewSse()
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
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insightId}`)
      if (!res.ok) throw new Error(await parseResponseError(res, '加载失败'))
      const data: InsightItem = await res.json()
      setViewingInsight(data)
      if (data.status === 'generating') {
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

  const handleExportPng = useCallback(async () => {
    const node = document.getElementById('ai-insight-export-root')
    if (!node) return

    setIsExporting(true)
    try {
      // Wait for recharts charts to fully render
      await new Promise((resolve) => requestAnimationFrame(resolve))

      const dataUrl = await toPng(node, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
        cacheBust: true,
      })

      const link = document.createElement('a')
      link.download = `AI洞察_${viewingInsight?.title ?? '报告'}_${new Date().toISOString().slice(0, 10)}.png`
      link.href = dataUrl
      link.click()
    } catch (err) {
      console.error('Failed to export PNG', err)
      alert('导出失败，请重试')
    } finally {
      setIsExporting(false)
    }
  }, [viewingInsight])

  const _closeSse = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  const handleGenerate = async () => {
    if (!selectedProjectId || !dateRange?.from || !dateRange?.to) return

    setIsGenerating(true)
    setStreamingContent('')
    setInsightDialogOpen(true)
    currentInsightId.current = null

    try {
      const body = {
        project_id: selectedProjectId,
        country: selectedCountry,
        date_range_start: formatYMD(dateRange.from, selectedCountry),
        date_range_end: formatYMD(dateRange.to, selectedCountry),
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

      // Open SSE connection for real-time updates
      const es = new EventSource(
        `/api/backend/v1/ai-insights/${insightId}/stream`
      )
      eventSourceRef.current = es

      es.onmessage = (e) => {
        if (!e.data || e.data.trim() === '') return
        try {
          const event: SseEvent = JSON.parse(e.data)

          if (event.type === 'ping') return

          if (event.type === 'status') {
            currentInsightId.current = event.insight_id ?? insightId
            setCurrentSubStatus(event.sub_status ?? null)
            if (event.status === 'failed') {
              alert(`生成失败: ${event.error_message || '生成任务失败'}`)
              _closeSse()
              setInsightDialogOpen(false)
              return
            }
            if (event.content) {
              setStreamingContent(event.content)
            }
          } else if (event.type === 'chunk') {
            setStreamingContent((prev) => prev + (event.delta || ''))
            setTimeout(() => {
              streamingRef.current?.scrollIntoView({ behavior: 'smooth' })
            }, 50)
          } else if (event.type === 'done') {
            setStreamingContent(event.content || streamingContent)
            setCurrentSubStatus(null)
            _closeSse()
            // Close the dialog after a short delay so user sees the result
            setTimeout(() => {
              setInsightDialogOpen(false)
              void loadInsights()
            }, 1500)
          } else if (event.type === 'error') {
            alert(`生成失败: ${event.error}`)
            _closeSse()
            setInsightDialogOpen(false)
            setCurrentSubStatus(null)
          }
        } catch (parseErr) {
          console.warn('Failed to parse SSE event', parseErr)
        }
      }

      es.onerror = () => {
        console.warn('SSE connection error, will refresh list on close')
        _closeSse()
        void loadInsights()
      }

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
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }
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
    const d = new Date(dateStr)
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
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
                      {selectedProjectId
                        ? projects.find((p) => p.id === selectedProjectId)?.name
                        : '选择项目'}
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[180px]">
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() => setSelectedProjectId(p.id)}
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
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-10 px-3"
                  onClick={() => setDateRange(getYesterdayRange(selectedCountry))}
                >
                  昨天
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-10 px-3"
                  onClick={() => setDateRange(lastSevenDaysRange(selectedCountry))}
                >
                  近7天
                </Button>
              </div>

              <Button
                onClick={() => void handleGenerate()}
                disabled={!selectedProjectId || !dateRange?.from || !dateRange?.to || isGenerating}
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
                  <TableHead>标题</TableHead>
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
                    <TableCell className="font-medium">
                      {insight.status === 'generating' ? (
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                          <span className="text-muted-foreground">
                            {SUB_STATUS_LABELS[currentSubStatus ?? insight.sub_status ?? ''] ?? '生成中'}
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
                              : 'bg-amber-500/10 text-amber-600 animate-pulse'
                        )}
                      >
                        {insight.status === 'completed'
                          ? '已完成'
                          : insight.status === 'failed'
                            ? '失败'
                            : SUB_STATUS_LABELS[currentSubStatus ?? insight.sub_status ?? ''] ?? '生成中'}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(insight.created_at)}
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
        if (!open) {
          // Closing dialog does NOT cancel the generation — it keeps running in background
          _closeSse()
        }
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
                <MarkdownContent content={streamingContent} />
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
                  {viewingInsight?.status === 'generating' || viewLiveRefreshing ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      正在生成洞察...
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
                    {formatDate(viewingInsight.created_at)} 生成
                  </p>
                )}
              </div>

              {/* Live / Retry button */}
              {(viewingInsight?.status === 'generating' || viewLiveRefreshing) && (
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
                    <MarkdownContent content={editingContent} />
                  </div>
                </div>
                <div className="flex flex-col gap-3 min-h-0">
                  <div className="shrink-0 rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] px-4 py-3 text-sm text-muted-foreground">
                    直接编辑 Markdown 内容，支持表格、<code className="text-foreground">lineChart</code> /
                    <code className="text-foreground">pieChart</code> 代码块实时预览。
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
            ) : viewingInsight?.status === 'generating' || viewLiveRefreshing ? (
              /* Live generation view — stepper + streaming content */
              <div ref={streamingRef} className="space-y-6">
                <GenerationProgress currentSubStatus={viewLiveSubStatus} />
                {viewLiveContent && (
                  <div className="border-t border-border/40 pt-6">
                    <MarkdownContent content={viewLiveContent} />
                  </div>
                )}
              </div>
            ) : viewingInsight?.content ? (
              <MarkdownContent content={viewingInsight.content} />
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
