'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'next/navigation'
import { DateRange } from 'react-day-picker'
import {
  Bot,
  ChevronDown,
  Check,
  Eye,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Save,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { toPng } from 'html-to-image'
import { useSession } from 'next-auth/react'
import { Clock } from 'lucide-react'

import { ScheduleList, ScheduleDialog } from '@/components/dashboard/ai-insights'
import { InsightStreamPanel, type InsightChartBlock } from '@/components/insight'
import { TermPanel } from '@/components/terminal/term-panel'

import { ChartCodeBlock, LEGACY_CHART_LANGUAGES } from './_components/chart-code-block'
import { chartSvgRegistry } from './_components/chart-svg-registry'
import { LEGACY_SUB_STATUS_LABELS } from './_components/legacy-insight-compat'
import { GenerationProgress } from './_components/generation-progress'
import { LegacyReportCard } from './_components/legacy-report-card'
import { useLegacyInsightStream } from './_components/use-legacy-insight-stream'

import { Button } from '@/components/ui/button'
import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  getTodayInTimezone,
} from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { ensureConfigLoaded } from '@/lib/api/ai-chat-config-store'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useConfirm } from '@/hooks/use-confirm'
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

export default function AIInsightsPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
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
  // 生成弹窗当前订阅的旧 run id（null = 尚未拿到 id）
  const [generatingId, setGeneratingId] = useState<number | null>(null)

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

  const [isGenerating, setIsGenerating] = useState(false)
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')

  // Schedule-related state
  const [activeTab, setActiveTab] = useState<'insights' | 'schedules'>('insights')
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)
  const [scheduleRefreshTrigger, setScheduleRefreshTrigger] = useState(0)

  // 列表兜底刷新：旧 run 由后端继续跑，弹窗关掉后靠列表轮询反映终态
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isViewLive =
    viewingInsight?.status === 'generating' || viewingInsight?.status === 'pending'


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

  useHeaderRefresh(loadInsights, { loading: isLoadingInsights })

  // BEL-424：模型配置推迟到生成弹窗首次打开再拉，并复用 ai-chat 配置 store
  // （模块级缓存 + 在途去重，与 AI 聊天 / 客服页共享同一份配置，跨页不重复请求）。
  const modelConfigRequestedRef = useRef(false)
  useEffect(() => {
    if (!insightDialogOpen || modelConfigRequestedRef.current) return
    modelConfigRequestedRef.current = true
    let cancelled = false
    setIsLoadingModelConfig(true)
    ensureConfigLoaded()
      .then((config) => {
        if (cancelled) return
        const payload: AIModelConfig = {
          providerConfigured: config.providerConfigured,
          models: config.models,
          defaultModel: config.defaultModel,
          premiumModels: config.premiumModels,
          basicModels: config.basicModels,
        }
        setModelConfig(payload)
        setSelectedModel((prev) => {
          if (prev && payload.models.includes(prev)) {
            return prev
          }
          return payload.defaultModel || payload.models[0] || ''
        })
      })
      .catch((e) => {
        console.error('Failed to load AI model config', e)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingModelConfig(false)
      })
    return () => {
      cancelled = true
    }
  }, [insightDialogOpen])

  // 旧洞察兼容订阅（BLF-1017）：整页只有这两个订阅入口，页面不再自建 EventSource、
  // 不再累积正文、不再持有重连与终态收尾逻辑——全部收敛在 `useLegacyInsightStream` 内。
  // 生成弹窗：订阅刚创建的 run；关闭弹窗即断开（run 由后端继续跑），列表轮询兜底。
  // 旧正文里的 ```chart 语言块统一交给本页的 ChartCodeBlock 渲染（含 PNG 导出的静态 SVG 收集）
  const renderLegacyChartBlock = useCallback(
    (block: InsightChartBlock) => (
      <ChartCodeBlock
        chartType={block.language}
        code={block.code}
        collectChartSvgs={collectChartSvgs}
      />
    ),
    [collectChartSvgs]
  )

  const generationStream = useLegacyInsightStream({
    insightId: generatingId,
    enabled: insightDialogOpen && generatingId !== null,
    onFrame: (frame) => {
      if (frame.type === 'ping') return
      const sid = frame.type === 'chunk' ? null : (frame.insight_id ?? generatingId)
      if (frame.type === 'status') {
        setInsights((prev) =>
          prev.map((item) =>
            item.id === sid
              ? {
                  ...item,
                  status: frame.status,
                  sub_status:
                    frame.sub_status ?? (frame.status === 'pending' ? 'queued' : item.sub_status),
                  title: frame.title ?? item.title,
                }
              : item
          )
        )
        if (frame.status === 'failed') {
          notify({
            type: 'error',
            title: '生成失败',
            message: frame.error_message || '生成任务失败',
          })
          setInsights((prev) => prev.filter((i) => i.id !== sid))
        }
        return
      }
      if (frame.type === 'done') {
        if (frame.status === 'failed') {
          notify({
            type: 'error',
            title: '生成失败',
            message: frame.error_message || '生成任务失败',
          })
          setInsights((prev) => prev.filter((i) => i.id !== sid))
        } else {
          void loadInsights()
        }
        return
      }
      if (frame.type === 'error') {
        notify({ type: 'error', title: '生成失败', message: frame.error_message || frame.error })
        setInsights((prev) => prev.filter((i) => i.id !== sid))
      }
    },
  })

  // 详情弹窗：只在该 run 仍处于生成 / 排队时订阅，终态帧把权威内容写回详情与列表。
  const viewStream = useLegacyInsightStream({
    insightId: viewDialogOpen && viewingInsight ? viewingInsight.id : null,
    enabled: viewDialogOpen && isViewLive,
    onFrame: (frame) => {
      if (frame.type === 'status') {
        if (frame.status === 'failed') {
          setViewingInsight((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'failed',
                  error_message: frame.error_message ?? '生成任务失败',
                }
              : prev
          )
          void loadInsights()
          return
        }
        setViewingInsight((prev) =>
          prev
            ? { ...prev, status: frame.status, sub_status: frame.sub_status ?? prev.sub_status }
            : prev
        )
        return
      }
      if (frame.type === 'done') {
        setViewingInsight((prev) =>
          prev
            ? {
                ...prev,
                status: frame.status === 'failed' ? 'failed' : 'completed',
                title: frame.title || prev.title,
                content: frame.content || prev.content,
                error_message: frame.error_message ?? null,
              }
            : prev
        )
        void loadInsights()
        return
      }
      if (frame.type === 'error') {
        setViewingInsight((prev) =>
          prev
            ? { ...prev, status: 'failed', error_message: frame.error_message ?? frame.error }
            : prev
        )
        void loadInsights()
      }
    },
  })

  const handleViewInsight = useCallback(
    async (insightId: number) => {
      setIsLoadingDetail(true)
      setViewDialogOpen(true)
      setViewingInsight(null)
      setIsEditingDetail(false)
      setEditingContent('')
      try {
        const res = await fetch(`/api/backend/v1/ai-insights/${insightId}`)
        if (!res.ok) throw new Error(await parseResponseError(res, '加载失败'))
        const data: InsightItem = await res.json()
        setViewingInsight(data)
        setEditingContent(data.content || '')
        setIsLoadingDetail(false)
      } catch (e) {
        console.error('Failed to load insight detail', e)
        notify({
          type: 'error',
          title: '加载失败',
          message: e instanceof Error ? e.message : String(e),
        })
        setViewDialogOpen(false)
        setIsLoadingDetail(false)
      }
    },
    [notify]
  )

  const handleRetryInsight = useCallback(
    async (insightId: number) => {
      if (!(await confirm({ title: '确定要重试生成这条洞察吗？当前内容将被替换。' }))) return
      setIsLoadingDetail(true)
      setIsEditingDetail(false)
      try {
        const res = await fetch(`/api/backend/v1/ai-insights/${insightId}/retry`, {
          method: 'POST',
        })
        if (!res.ok) throw new Error(await parseResponseError(res, '重试失败'))
        // 重试后 run 回到生成态；详情轮询与 useLegacyInsightStream 会各自接管
        await handleViewInsight(insightId)
        // Refresh the list so the table shows "生成中" immediately
        void loadInsights()
      } catch (e) {
        console.error('Failed to retry insight', e)
        notify({
          type: 'error',
          title: '重试失败',
          message: e instanceof Error ? e.message : String(e),
        })
        setIsLoadingDetail(false)
      }
    },
    [handleViewInsight, loadInsights, confirm, notify]
  )

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
      notify({ type: 'warning', title: '报告内容不能为空' })
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
      notify({
        type: 'error',
        title: '保存失败',
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setIsSavingDetail(false)
    }
  }, [editingContent, viewingInsight, notify])

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
            const periodLabel =
              viewingInsight?.insight_type === 'monthly' ? '上个月总结' : '上周总结'
            const link = document.createElement('a')
            link.download = `${viewingInsight?.project_name}-${periodLabel}_${new Date().toISOString().slice(0, 10)}.png`
            link.href = url
            link.click()
          })
          .catch((err) => {
            console.error('Failed to export PNG', err)
            notify({ type: 'error', title: '导出失败，请重试' })
          })
          .finally(() => {
            setCollectChartSvgs(false)
            setIsExporting(false)
          })
      })
    })
  }, [collectChartSvgs, viewingInsight, notify])

  const handleExportPng = useCallback(() => {
    if (!document.getElementById('ai-insight-export-root')) return
    chartSvgRegistry.clear()
    setIsExporting(true)
    setCollectChartSvgs(true) // triggers chart components to render <img> tags
  }, [])

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
      const stillProcessing = insights.some(
        (i) => i.status === 'generating' || i.status === 'pending'
      )
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
    if (!selectedProjectId || selectedProjectId === 'all' || !dateRange?.from || !dateRange?.to)
      return

    setIsGenerating(true)
    setGeneratingId(null)
    setInsightDialogOpen(true)

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
      // 订阅由 useLegacyInsightStream 负责：generatingId 变化即重新订阅该 run
      setGeneratingId(insightId)
    } catch (e) {
      console.error('Failed to start insight generation', e)
      notify({
        type: 'error',
        title: '启动失败',
        message: e instanceof Error ? e.message : String(e),
      })
      setInsightDialogOpen(false)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDelete = async (insightId: number) => {
    if (!(await confirm({ title: '确定要删除这条洞察吗？', variant: 'destructive' }))) return
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insightId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await parseResponseError(res, '删除失败'))
      await loadInsights()
    } catch (e) {
      console.error('Failed to delete insight', e)
      notify({
        type: 'error',
        title: '删除失败',
        message: e instanceof Error ? e.message : String(e),
      })
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
      {/* Tab Bar: 洞察记录 / 定时生成 */}
      <div className="flex h-9 w-fit items-center gap-1 rounded-none border border-term-border bg-term-bg px-1">
        <button
          onClick={() => setActiveTab('insights')}
          className={cn(
            'flex h-7 items-center gap-2 rounded-none px-3 font-mono text-xs transition-colors',
            activeTab === 'insights'
              ? 'border border-term-border bg-term-raised text-term-text'
              : 'border border-transparent text-term-muted hover:bg-term-hover hover:text-term-text'
          )}
        >
          <Sparkles className="h-4 w-4" />
          洞察记录
        </button>
        <button
          onClick={() => setActiveTab('schedules')}
          className={cn(
            'flex h-7 items-center gap-2 rounded-none px-3 font-mono text-xs transition-colors',
            activeTab === 'schedules'
              ? 'border border-term-border bg-term-raised text-term-text'
              : 'border border-transparent text-term-muted hover:bg-term-hover hover:text-term-text'
          )}
        >
          <Clock className="h-4 w-4" />
          定时生成
        </button>
      </div>

      {/* Scheduled Generation Tab */}
      {activeTab === 'schedules' && (
        <div className="space-y-4">
          {/* Header with "New Schedule" button */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">定时任务管理</h2>
              <p className="text-sm text-muted-foreground">
                配置定时任务，自动在指定时间生成 AI Insight 报告
              </p>
            </div>
            <Button
              onClick={() => {
                setEditingSchedule(null)
                setScheduleDialogOpen(true)
              }}
              className="w-full sm:w-auto"
            >
              <Sparkles className="mr-2 h-4 w-4" />
              新建定时任务
            </Button>
          </div>

          {/* Schedule List */}
          <ScheduleList
            onEdit={(schedule) => {
              setEditingSchedule(schedule)
              setScheduleDialogOpen(true)
            }}
            onRefresh={() => setScheduleRefreshTrigger((n) => n + 1)}
            isRefreshing={scheduleRefreshTrigger > 0}
          />
        </div>
      )}

      {/* Insights Tab */}
      {activeTab === 'insights' && (
        <>
          <TermPanel title="生成 AI 洞察" bodyClassName="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-2.5 lg:flex lg:flex-wrap lg:items-center lg:gap-3">
                {isLoadingProjects ? (
                  <Skeleton className="h-10 w-[180px]" />
                ) : (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="h-8 w-full justify-between rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none lg:w-[180px]"
                        >
                          {selectedProjectId === 'all'
                            ? '全部项目'
                            : (projects.find((p) => p.id === selectedProjectId)?.name ??
                              '选择项目')}
                          <ChevronDown className="h-4 w-4 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-[180px]">
                        <DropdownMenuItem
                          key="all"
                          onClick={() => setSelectedProjectId('all')}
                          className={cn(selectedProjectId === 'all' && 'bg-term-hover text-term-text')}
                        >
                          全部项目
                        </DropdownMenuItem>
                        {projects.map((p) => (
                          <DropdownMenuItem
                            key={p.id}
                            onClick={() => p.id !== null && setSelectedProjectId(p.id)}
                            className={cn(selectedProjectId === p.id && 'bg-term-hover text-term-text')}
                          >
                            {p.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {selectedProjectId !== 'all' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-fit rounded-none px-2 font-mono text-xs text-term-muted hover:text-term-text"
                        onClick={() => {
                          window.location.href = `/dashboard/system/project-info?configure=${selectedProjectId}`
                        }}
                        title="配置项目背景"
                      >
                        <Settings className="h-4 w-4 mr-1.5" />
                        配置背景
                      </Button>
                    )}
                  </>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-8 w-full justify-between rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none lg:w-[140px]"
                    >
                      {COUNTRY_OPTIONS.find((c) => c.value === selectedCountry)?.label ||
                        '国家站点'}
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[140px]">
                    {COUNTRY_OPTIONS.map((c) => (
                      <DropdownMenuItem
                        key={c.value}
                        onClick={() => setSelectedCountry(c.value)}
                        className={cn(selectedCountry === c.value && 'bg-term-hover text-term-text')}
                      >
                        {c.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-8 w-full justify-between rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none lg:w-[120px]"
                    >
                      {INSIGHT_TYPE_OPTIONS.find((t) => t.value === insightType)?.label || '类型'}
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[120px]">
                    {INSIGHT_TYPE_OPTIONS.map((t) => (
                      <DropdownMenuItem
                        key={t.value}
                        onClick={() => setInsightType(t.value)}
                        className={cn(insightType === t.value && 'bg-term-hover text-term-text')}
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
                  <SelectTrigger className="h-8 w-full rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none lg:w-[220px]">
                    <SelectValue
                      placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'}
                    />
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
                      .filter(
                        (model) =>
                          !modelConfig.premiumModels.includes(model) &&
                          !modelConfig.basicModels.includes(model)
                      )
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
                  className="h-8 w-full lg:w-[240px]"
                  timezone={COUNTRY_TIMEZONE_MAP[selectedCountry]}
                />
                <Button
                  onClick={() => void handleGenerate()}
                  disabled={
                    !selectedProjectId ||
                    selectedProjectId === 'all' ||
                    !dateRange?.from ||
                    !dateRange?.to ||
                    isGenerating
                  }
                  className="h-8 col-span-2 gap-2 w-full rounded-none font-mono text-xs lg:col-span-1 lg:w-auto"
                >
                  {isGenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Bot className="h-4 w-4" />
                  )}
                  {isGenerating ? '生成中...' : '生成洞察'}
                </Button>
              </div>

              <p className="text-sm text-term-muted">
                选择项目、日期范围和洞察类型，系统将基于该时间段内的销售、广告、库存等数据生成 AI
                经营洞察报告。 生成任务在后台运行，可以切换到其他页面，稍后再来查看结果。
              </p>
          </TermPanel>

          <TermPanel title="洞察记录" bodyClassName="p-4">
              {isLoadingInsights ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : insights.length === 0 ? (
                <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-none border border-dashed border-term-border bg-term-bg text-center">
                  <p className="text-sm text-term-faint">
                    在左侧选择项目和时间范围，然后点击「生成洞察」按钮
                  </p>
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
                        className={cn(
                          'cursor-pointer',
                          insight.status === 'generating' && 'opacity-70'
                        )}
                        onClick={() => void handleViewInsight(insight.id)}
                      >
                        <TableCell className="font-medium whitespace-nowrap max-w-[300px] truncate">
                          {insight.status === 'generating' || insight.status === 'pending' ? (
                            <span className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-none bg-term-warn animate-pulse" />
                              <span className="text-muted-foreground">
                                {LEGACY_SUB_STATUS_LABELS[insight.sub_status ?? ''] ?? '生成中'}
                              </span>
                            </span>
                          ) : (
                            insight.title
                          )}
                        </TableCell>
                        <TableCell>{insight.project_name}</TableCell>
                        <TableCell>{insight.country}</TableCell>
                        <TableCell>
                          <span className="rounded-none border border-term-border px-1.5 py-0.5 font-mono text-[11px] text-term-muted">
                            {INSIGHT_TYPE_OPTIONS.find((t) => t.value === insight.insight_type)
                              ?.label || insight.insight_type}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {formatDate(insight.date_range_start)} ~{' '}
                          {formatDate(insight.date_range_end)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              'rounded-none border px-1.5 py-0.5 font-mono text-[11px]',
                              insight.status === 'completed'
                                ? 'border-term-pos/40 text-term-pos'
                                : insight.status === 'failed'
                                  ? 'border-term-neg/40 text-term-neg'
                                  : insight.status === 'pending'
                                    ? 'border-term-accent/40 text-term-accent animate-pulse'
                                    : 'border-term-warn/40 text-term-warn animate-pulse'
                            )}
                          >
                            {insight.status === 'completed'
                              ? '已完成'
                              : insight.status === 'failed'
                                ? '失败'
                                : insight.status === 'pending'
                                  ? '排队中'
                                  : (LEGACY_SUB_STATUS_LABELS[insight.sub_status ?? ''] ?? '生成中')}
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
                              className="h-9 w-9 sm:h-8 sm:w-8"
                              disabled={insight.status === 'generating'}
                              onClick={() => void handleViewInsight(insight.id)}
                            >
                              <Eye className="h-4 w-4 text-muted-foreground" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 sm:h-8 sm:w-8"
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
          </TermPanel>

          {/* Live generation progress dialog */}
          {/* Use suppressHydrationWarning to handle SSR/CSR mismatch from Radix UI Dialog */}
          <Dialog
            open={insightDialogOpen}
            onOpenChange={(open) => {
              setInsightDialogOpen(open)
            }}
          >
            <DialogContent
              aria-describedby="insight-generation-dialog-description"
              suppressHydrationWarning
              className="max-h-[80vh] max-w-4xl overflow-y-auto"
            >
              <span id="insight-generation-dialog-description" className="sr-only">
                AI洞察报告生成进度对话框
              </span>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5" />
                  {selectedProjectName} - AI 洞察报告
                </DialogTitle>
              </DialogHeader>
              <div className="mt-4">
                <InsightStreamPanel
                  status={generationStream.state.status}
                  statusLabel={generationStream.state.label}
                  error={generationStream.error}
                  content={generationStream.content}
                  contentState={generationStream.state.contentState}
                  isStreaming={generationStream.state.isStreaming}
                  exportFileName={`${selectedProjectName || '洞察报告'}-AI洞察.md`}
                  chartLanguages={LEGACY_CHART_LANGUAGES}
                  renderChartBlock={renderLegacyChartBlock}
                  slots={{
                    beforeContent: (
                      <GenerationProgress currentSubStatus={generationStream.subStatus} />
                    ),
                    afterContent:
                      generationStream.finished && generationStream.content.trim() ? (
                        <div className="flex items-center justify-end gap-2 border-t pt-4">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setInsightDialogOpen(false)
                              if (generatingId !== null) void handleViewInsight(generatingId)
                            }}
                          >
                            <Pencil className="mr-1.5 h-4 w-4" />
                            查看并编辑
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              setInsightDialogOpen(false)
                              void loadInsights()
                            }}
                          >
                            <Check className="mr-1.5 h-4 w-4" />
                            完成
                          </Button>
                        </div>
                      ) : null,
                  }}
                />
              </div>
            </DialogContent>
          </Dialog>

          {/* View historical insight dialog */}
          <Dialog
            open={viewDialogOpen}
            onOpenChange={(open) => {
              setViewDialogOpen(open)
              if (!open) {
                setIsEditingDetail(false)
                setEditingContent('')
              }
            }}
          >
            <DialogContent
              aria-describedby="insight-view-dialog-description"
              suppressHydrationWarning
              className={cn(
                'max-h-[80vh] overflow-y-auto overflow-x-auto',
                isEditingDetail ? 'max-w-[1350px]' : isViewLive ? 'max-w-6xl' : 'max-w-[675px]'
              )}
            >
              <span id="insight-view-dialog-description" className="sr-only">
                洞察详情查看对话框
              </span>
              <DialogHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div>
                    <DialogTitle className="flex items-center gap-2">
                      {isViewLive ? (
                        <>
                          <Loader2 className="h-5 w-5 animate-spin text-term-accent" />
                          {viewingInsight?.sub_status === 'queued'
                            ? '排队中...'
                            : '正在生成洞察...'}
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
                        {viewingInsight.project_name} ·{' '}
                        {COUNTRY_OPTIONS.find((c) => c.value === viewingInsight.country)?.label} ·{' '}
                        {formatDate(viewingInsight.date_range_start)} ~{' '}
                        {formatDate(viewingInsight.date_range_end)} ·{' '}
                        {
                          INSIGHT_TYPE_OPTIONS.find((t) => t.value === viewingInsight.insight_type)
                            ?.label
                        }{' '}
                        · {formatDateTime(viewingInsight.created_at)} 生成
                      </p>
                    )}
                  </div>

                  {/* Live / Retry button */}
                  {isViewLive && (
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex items-center gap-1.5 rounded-none border border-term-accent/40 px-1.5 py-0.5 font-mono text-xs text-term-accent">
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
                  {!isLoadingDetail &&
                  viewingInsight?.status === 'completed' &&
                  viewingInsight?.content &&
                  !isEditingDetail ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" onClick={handleStartEditingDetail}>
                        <Pencil className="mr-1.5 h-4 w-4" />
                        手动编辑
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleExportPng()}
                        disabled={isExporting}
                      >
                        {isExporting ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <ImageIcon className="mr-1.5 h-4 w-4" />
                        )}
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
                    <Loader2 className="h-8 w-8 animate-spin text-term-accent" />
                    <span className="ml-3 text-muted-foreground">正在加载洞察内容...</span>
                  </div>
                ) : isEditingDetail ? (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" style={{ height: '70vh' }}>
                    <div className="flex flex-col overflow-y-auto rounded-none border border-term-border bg-term-bg">
                      <div className="sticky top-0 z-10 border-b border-term-border bg-term-bg px-4 py-2.5">
                        <p className="text-xs font-semibold uppercase tracking-wider text-term-faint">
                          预览
                        </p>
                      </div>
                      <div className="flex-1 overflow-y-auto px-4 py-4">
                        <LegacyReportCard
                          content={editingContent}
                          collectChartSvgs={collectChartSvgs}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-3 min-h-0">
                      <div className="shrink-0 flex flex-col gap-3 rounded-none border border-term-border bg-term-bg px-4 py-3 text-sm text-term-muted sm:flex-row sm:items-center sm:justify-between">
                        <span>
                          直接编辑 Markdown 内容，支持表格、
                          <code className="text-foreground">lineChart</code> /
                          <code className="text-foreground">pieChart</code> 代码块实时预览。
                        </span>
                        <div className="flex items-center gap-2 sm:ml-4 shrink-0">
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
                            {isSavingDetail ? (
                              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            ) : (
                              <Save className="mr-1.5 h-4 w-4" />
                            )}
                            保存
                          </Button>
                        </div>
                      </div>
                      <textarea
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        spellCheck={false}
                        className="flex-1 w-full resize-none rounded-none border border-term-border bg-term-panel px-4 py-4 font-mono text-sm leading-6 text-term-text outline-none transition focus:border-term-border-strong"
                        placeholder="在此编辑 Markdown 内容..."
                      />
                    </div>
                  </div>
                ) : isViewLive ? (
                  <InsightStreamPanel
                    status={viewStream.state.status}
                    statusLabel={viewStream.state.label}
                    error={viewStream.error}
                    content={viewStream.content}
                    contentState={viewStream.state.contentState}
                    isStreaming={viewStream.state.isStreaming}
                    exportFileName={`${viewingInsight.project_name}-洞察报告.md`}
                    chartLanguages={LEGACY_CHART_LANGUAGES}
                    renderChartBlock={renderLegacyChartBlock}
                    onRetry={
                      viewStream.state.status === 'failed'
                        ? () => void handleRetryInsight(viewingInsight.id)
                        : undefined
                    }
                    slots={{
                      beforeContent: <GenerationProgress currentSubStatus={viewStream.subStatus} />,
                    }}
                  />
                ) : viewingInsight?.content ? (
                  <LegacyReportCard
                    content={viewingInsight.content}
                    collectChartSvgs={collectChartSvgs}
                    exportFileName={`${viewingInsight.project_name}-洞察报告.md`}
                  />
                ) : viewingInsight?.error_message ? (
                  <div className="rounded-none border border-term-neg/40 bg-term-neg/5 px-4 py-3 text-sm text-term-neg">
                    生成失败：{viewingInsight.error_message}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-center py-8">暂无内容</p>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Schedule Dialog - rendered outside tab conditionals so it works from any tab */}
      <ScheduleDialog
        open={scheduleDialogOpen}
        onOpenChange={(open) => {
          setScheduleDialogOpen(open)
          if (!open) setEditingSchedule(null)
        }}
        schedule={editingSchedule}
        onSave={async (data) => {
          const res = editingSchedule
            ? await fetch(`/api/backend/v1/ai-insights/schedules/${editingSchedule.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
              })
            : await fetch('/api/backend/v1/ai-insights/schedules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
              })
          if (!res.ok) {
            const err = await res.text()
            throw new Error(err || '保存失败')
          }
          setScheduleRefreshTrigger((n) => n + 1)
        }}
      />
    </div>
  )
}
