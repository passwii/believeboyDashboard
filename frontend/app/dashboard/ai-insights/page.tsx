'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
  Bot,
  ChevronDown,
  Eye,
  Loader2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangePicker } from '@/components/ui/date-picker'
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

function parseLineChart(content: string) {
  const lines = content.trim().split('\n')
  const result: Record<string, string[]> = {}
  let currentKey = ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const match = line.match(/^(\w+)\[(.+)\]$/)
    if (match) {
      currentKey = match[1].toLowerCase()
      result[currentKey] = match[2].split(/[,;]\s*/).map((v) => v.trim())
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

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

function ChartCodeBlock({ chartType, code }: { chartType: string; code: string }) {
  if (chartType === 'linechart' || chartType === 'line') {
    const parsed = parseLineChart(code)
    const labels = parsed['x-axis'] || parsed['xaxis'] || []
    const seriesKey = Object.keys(parsed).find(
      (k) => k !== 'x-axis' && k !== 'xaxis' && k !== 'y-axis' && k !== 'yaxis' && parsed[k].length === labels.length
    )
    const seriesData = seriesKey ? parsed[seriesKey] : []

    if (labels.length === 0 || seriesData.length === 0) {
      return <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">{code}</pre>
    }

    const chartData = labels.map((label, i) => ({
      label,
      value: parseFloat(seriesData[i]) || 0,
    }))

    return (
      <div className="not-prose my-4 rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] p-4">
        <p className="mb-3 text-sm font-medium text-muted-foreground">{seriesKey?.toUpperCase() || '趋势'}</p>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/0.5)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickLine={false}
              axisLine={{ stroke: 'hsl(var(--border))' }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <RechartsTooltip
              contentStyle={{
                background: 'hsl(var(--surface-panel))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px',
                fontSize: 12,
              }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={{ r: 3, fill: 'hsl(var(--primary))' }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (chartType === 'piechart' || chartType === 'pie') {
    const parsed = parsePieChart(code)

    if (parsed.length === 0) {
      return <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">{code}</pre>
    }

    const total = parsed.reduce((sum, item) => sum + item.value, 0)
    const displayData = parsed.map((item) => ({
      ...item,
      pct: total > 0 ? ((item.value / total) * 100).toFixed(1) : '0.0',
    }))

    return (
      <div className="not-prose my-4 rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] p-4">
        <p className="mb-3 text-sm font-medium text-muted-foreground">分布占比</p>
        <div className="flex items-center gap-6">
          <ResponsiveContainer width={180} height={180}>
            <PieChart>
              <Pie
                data={displayData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                dataKey="value"
                stroke="hsl(var(--surface-soft))"
                strokeWidth={2}
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
                  borderRadius: '8px',
                  fontSize: 12,
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-1.5">
            {displayData.map((item, i) => (
              <div key={item.name} className="flex items-center gap-2 text-sm">
                <div
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                />
                <span className="text-muted-foreground">{item.name}</span>
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

  return <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">{code}</pre>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MarkdownContent = ({ content }: { content: string }) => {
  const Markdown = ReactMarkdown as React.FC<{ remarkPlugins?: unknown[]; children: string }>
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <Markdown remarkPlugins={[remarkGfm]}>
        {content}
      </Markdown>
    </div>
  )
}

export default function AIInsightsPage() {
  const { data: session } = useSession()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [selectedCountry, setSelectedCountry] = useState('US')
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
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

  // Live streaming content (shown in generation dialog)
  const [streamingContent, setStreamingContent] = useState('')
  const [currentSubStatus, setCurrentSubStatus] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const streamingRef = useRef<HTMLDivElement>(null)

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

  const handleViewInsight = useCallback(async (insightId: number) => {
    setIsLoadingDetail(true)
    setViewDialogOpen(true)
    setViewingInsight(null)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insightId}`)
      if (!res.ok) throw new Error(await parseResponseError(res, '加载失败'))
      const data: InsightItem = await res.json()
      setViewingInsight(data)
    } catch (e) {
      console.error('Failed to load insight detail', e)
      alert(`加载失败: ${e instanceof Error ? e.message : String(e)}`)
      setViewDialogOpen(false)
    } finally {
      setIsLoadingDetail(false)
    }
  }, [])

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
        date_range_start: dateRange.from.toISOString().split('T')[0],
        date_range_end: dateRange.to.toISOString().split('T')[0],
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
              />

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
                    className={cn(
                      insight.status !== 'generating' && 'cursor-pointer',
                      insight.status === 'generating' && 'opacity-60'
                    )}
                    onClick={() => {
                      if (insight.status !== 'generating') {
                        void handleViewInsight(insight.id)
                      }
                    }}
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
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              {viewingInsight?.title ?? '洞察详情'}
            </DialogTitle>
            {viewingInsight && (
              <p className="text-sm text-muted-foreground font-normal">
                {viewingInsight.project_name} · {COUNTRY_OPTIONS.find((c) => c.value === viewingInsight.country)?.label} ·{' '}
                {formatDate(viewingInsight.date_range_start)} ~ {formatDate(viewingInsight.date_range_end)} ·{' '}
                {INSIGHT_TYPE_OPTIONS.find((t) => t.value === viewingInsight.insight_type)?.label} ·{' '}
                {formatDate(viewingInsight.created_at)} 生成
              </p>
            )}
          </DialogHeader>
          <div className="mt-4">
            {isLoadingDetail ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-3 text-muted-foreground">正在加载洞察内容...</span>
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
