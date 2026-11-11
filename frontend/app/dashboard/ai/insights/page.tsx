'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useSearchParams } from 'next/navigation'
import { DateRange } from 'react-day-picker'
import {
  Bot,
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
import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
  WarmSelect,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { InsightStreamPanel, type InsightChartBlock } from '@/components/insight'

import { ChartCodeBlock, LEGACY_CHART_LANGUAGES } from './_components/chart-code-block'
import { chartSvgRegistry } from './_components/chart-svg-registry'
import { LEGACY_SUB_STATUS_LABELS } from './_components/legacy-insight-compat'
import { GenerationProgress } from './_components/generation-progress'
import { LegacyReportCard } from './_components/legacy-report-card'
import { useLegacyInsightStream } from './_components/use-legacy-insight-stream'
import styles from './insights-warm.module.css'

import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  getTodayInTimezone,
} from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { parseResponseError } from '@/lib/error-utils'
import { pickSessionDisplayName } from '@/lib/auth/display-name'
import { ensureConfigLoaded } from '@/lib/api/ai-chat-config-store'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useConfirm } from '@/hooks/use-confirm'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'
import { readWarmLedgerColor } from '@/lib/warm-ledger-colors'

type ProjectOption = {
  id: number | null
  name: string
}

type InsightTab = 'insights' | 'schedules'

const INSIGHT_TABS: ReadonlyArray<InsightTab> = ['insights', 'schedules']

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

function insightStatusTone(status: string): WarmBadgeTone {
  if (status === 'completed') return 'positive'
  if (status === 'failed') return 'negative'
  if (status === 'pending' || status === 'generating') return 'accent'
  return 'neutral'
}

function insightStatusLabel(insight: InsightItem): string {
  if (insight.status === 'completed') return '已完成'
  if (insight.status === 'failed') return '失败'
  if (insight.status === 'pending') return '排队中'
  return LEGACY_SUB_STATUS_LABELS[insight.sub_status ?? ''] ?? '生成中'
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
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [isLoadingInsights, setIsLoadingInsights] = useState(true)
  const [insightLoadError, setInsightLoadError] = useState<string | null>(null)
  const [projectLoadAttempt, setProjectLoadAttempt] = useState(0)
  const insightRequestIdRef = useRef(0)
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
  const [activeTab, setActiveTab] = useState<InsightTab>('insights')
  const tabRefs = useRef<Record<InsightTab, HTMLButtonElement | null>>({
    insights: null,
    schedules: null,
  })
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)
  const [scheduleRefreshTrigger, setScheduleRefreshTrigger] = useState(0)

  // 列表兜底刷新：旧 run 由后端继续跑，弹窗关掉后靠列表轮询反映终态
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isViewLive =
    viewingInsight?.status === 'generating' || viewingInsight?.status === 'pending'


  useEffect(() => {
    let cancelled = false
    async function loadProjects() {
      setIsLoadingProjects(true)
      setProjectLoadError(null)
      if (!session) {
        setIsLoadingProjects(false)
        return
      }
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (cancelled) return
        setProjects(rows || [])
        if (rows && rows.length > 0) {
          const paramProjectId = searchParams.get('project_id')
          if (paramProjectId) {
            setSelectedProjectId(Number(paramProjectId))
          }
          // Default to 'all' — no need to set explicitly since that is already the initial state
        }
      } catch (e) {
        if (cancelled) return
        setProjectLoadError(e instanceof Error ? e.message : '项目列表加载失败')
        console.error('Failed to load projects', e)
      } finally {
        if (!cancelled) setIsLoadingProjects(false)
      }
    }
    void loadProjects()
    return () => {
      cancelled = true
    }
  }, [session, searchParams, projectLoadAttempt])

  // When country changes, reset dateRange to "last 7 days in that country's timezone".
  useEffect(() => {
    setDateRange(defaultRange)
  }, [selectedCountry, defaultRange])

  const loadInsights = useCallback(async () => {
    if (!selectedProjectId) return
    const requestId = ++insightRequestIdRef.current
    setIsLoadingInsights(true)
    setInsightLoadError(null)
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (selectedProjectId !== 'all') {
        params.set('project_id', String(selectedProjectId))
      }
      const res = await fetch(`/api/backend/v1/ai-insights?${params}`)
      if (!res.ok) throw new Error(await parseResponseError(res, '加载失败'))
      const data = await res.json()
      if (requestId === insightRequestIdRef.current) {
        setInsights(data.items || [])
      }
    } catch (e) {
      if (requestId === insightRequestIdRef.current) {
        setInsights([])
        setInsightLoadError(e instanceof Error ? e.message : '加载洞察失败')
        console.error('Failed to load insights', e)
      }
    } finally {
      if (requestId === insightRequestIdRef.current) setIsLoadingInsights(false)
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

        toPng(dataUrl, {
          backgroundColor: readWarmLedgerColor('window'),
          pixelRatio: 2,
          cacheBust: true,
        })
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
        // BLF-1441：乐观态创建人与后端写入同源（full_name）；无姓名时留空，
        // 等刷新后用后端快照，不拿登录名冒充。
        created_by: pickSessionDisplayName(session?.user) ?? '',
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
  const projectOptions = [
    { value: 'all', label: '全部项目' },
    ...projects
      .filter((project): project is ProjectOption & { id: number } => project.id !== null)
      .map((project) => ({ value: String(project.id), label: project.name })),
  ]
  const modelOptions = Array.from(new Set(modelConfig?.models ?? [])).map((model) => ({
    value: model,
    label: model,
  }))

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = INSIGHT_TABS.indexOf(activeTab)
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % INSIGHT_TABS.length
    else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + INSIGHT_TABS.length) % INSIGHT_TABS.length
    } else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = INSIGHT_TABS.length - 1

    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = INSIGHT_TABS[nextIndex]
    setActiveTab(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  return (
    <div className={styles.page} data-warm-insights>
      {/* Tab Bar: 洞察记录 / 定时生成 */}
      <div className={styles.tabs} role="tablist" aria-label="洞察视图">
        <button
          ref={(node) => {
            tabRefs.current.insights = node
          }}
          id="insights-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === 'insights'}
          aria-controls="insights-panel"
          tabIndex={activeTab === 'insights' ? 0 : -1}
          data-active={activeTab === 'insights'}
          onClick={() => setActiveTab('insights')}
          onKeyDown={handleTabKeyDown}
          className={styles.tab}
        >
          <Sparkles aria-hidden />
          洞察记录
        </button>
        <button
          ref={(node) => {
            tabRefs.current.schedules = node
          }}
          id="schedules-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === 'schedules'}
          aria-controls="schedules-panel"
          tabIndex={activeTab === 'schedules' ? 0 : -1}
          data-active={activeTab === 'schedules'}
          onClick={() => setActiveTab('schedules')}
          onKeyDown={handleTabKeyDown}
          className={styles.tab}
        >
          <Clock aria-hidden />
          定时生成
        </button>
      </div>

      {/* Scheduled Generation Tab */}
      {activeTab === 'schedules' ? (
        <section
          id="schedules-panel"
          role="tabpanel"
          aria-labelledby="schedules-tab"
          className={styles.panel}
        >
          <header className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>定时任务管理</h2>
            <div className={styles.panelActions}>
              <WarmButton
                type="button"
                variant="primary"
                onClick={() => {
                  setEditingSchedule(null)
                  setScheduleDialogOpen(true)
                }}
              >
                <Sparkles aria-hidden />
                新建定时任务
              </WarmButton>
            </div>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.scheduleSurface}>
              <ScheduleList
                onEdit={(schedule) => {
                  setEditingSchedule(schedule)
                  setScheduleDialogOpen(true)
                }}
                onRefresh={() => setScheduleRefreshTrigger((n) => n + 1)}
                isRefreshing={scheduleRefreshTrigger > 0}
              />
            </div>
          </div>
        </section>
      ) : (
        <section
          id="schedules-panel"
          role="tabpanel"
          aria-labelledby="schedules-tab"
          hidden
        />
      )}

      {/* Insights Tab */}
      {activeTab === 'insights' ? (
        <div
          id="insights-panel"
          role="tabpanel"
          aria-labelledby="insights-tab"
          className={styles.stack}
        >
          <section className={styles.panel}>
            <header className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>生成 AI 洞察</h2>
            </header>
            <div className={styles.panelBody}>
              <div className={styles.filters}>
                <div className={styles.projectField}>
                  {isLoadingProjects ? (
                    <div className={styles.skeletonBlock} aria-label="正在加载项目" />
                  ) : (
                    <WarmSelect
                      id="insight-project"
                      label="项目"
                      value={String(selectedProjectId)}
                      options={projectOptions}
                      onChange={(value) =>
                        setSelectedProjectId(value === 'all' ? 'all' : Number(value))
                      }
                      placeholder={projectLoadError ? '项目加载失败' : '选择项目'}
                      disabled={!!projectLoadError}
                      error={projectLoadError ? '项目列表加载失败，请重试' : null}
                    />
                  )}
                  {projectLoadError ? (
                    <WarmButton
                      type="button"
                      variant="quiet"
                      onClick={() => setProjectLoadAttempt((attempt) => attempt + 1)}
                      loading={isLoadingProjects}
                      loadingLabel="正在加载项目"
                    >
                      重试
                    </WarmButton>
                  ) : selectedProjectId !== 'all' && (
                    <WarmButton
                      type="button"
                      variant="quiet"
                      onClick={() => {
                        window.location.href = `/dashboard/system/project-info?configure=${selectedProjectId}`
                      }}
                      title="配置项目背景"
                    >
                      <Settings aria-hidden />
                      配置背景
                    </WarmButton>
                  )}
                </div>

                <WarmSelect
                  id="insight-country"
                  label="国家站点"
                  value={selectedCountry}
                  options={COUNTRY_OPTIONS}
                  onChange={setSelectedCountry}
                />

                <WarmSelect
                  id="insight-type"
                  label="洞察类型"
                  value={insightType}
                  options={INSIGHT_TYPE_OPTIONS}
                  onChange={setInsightType}
                />

                <div className={styles.field}>
                  <span className={styles.fieldLabel}>日期范围</span>
                  <DateRangePicker
                    value={dateRange}
                    onChange={setDateRange}
                    className={styles.dateTrigger}
                    popoverClassName={styles.datePopover}
                    timezone={COUNTRY_TIMEZONE_MAP[selectedCountry]}
                  />
                </div>

                <WarmSelect
                  id="insight-model"
                  label="模型"
                  value={selectedModel}
                  options={modelOptions}
                  onChange={setSelectedModel}
                  placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'}
                  disabled={
                    isLoadingModelConfig || isGenerating || !modelConfig?.models.length
                  }
                />

                <div className={styles.generateAction}>
                  <WarmButton
                    type="button"
                    variant="primary"
                    loading={isGenerating}
                    loadingLabel="正在生成洞察"
                    onClick={() => void handleGenerate()}
                    disabled={
                      !selectedProjectId ||
                      selectedProjectId === 'all' ||
                      !dateRange?.from ||
                      !dateRange?.to
                    }
                  >
                    {isGenerating ? null : <Bot aria-hidden />}
                    {isGenerating ? '生成中...' : '生成洞察'}
                  </WarmButton>
                </div>
              </div>

              <p className={styles.helperText}>
                选择项目、日期范围和洞察类型，系统将基于该时间段内的销售、广告、库存等数据生成 AI
                经营洞察报告。 生成任务在后台运行，可以切换到其他页面，稍后再来查看结果。
              </p>
            </div>
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>洞察记录</h2>
            </header>
            <div className={cn(styles.panelBody, styles.panelBodyFlush)}>
              {isLoadingInsights ? (
                <div className={styles.loadingRows} aria-busy="true" aria-label="正在加载洞察记录">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className={styles.loadingRow} />
                  ))}
                </div>
              ) : insights.length === 0 ? (
                insightLoadError ? (
                  <div className={styles.emptyState} role="alert">
                    <span>加载洞察记录失败：{insightLoadError}。</span>
                    <WarmButton type="button" variant="quiet" onClick={() => void loadInsights()}>
                      重试
                    </WarmButton>
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    在左侧选择项目和时间范围，然后点击「生成洞察」按钮
                  </div>
                )
              ) : (
                <div className={styles.tableScroller}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>标题</th>
                        <th>项目</th>
                        <th>国家</th>
                        <th>类型</th>
                        <th>日期范围</th>
                        <th>状态</th>
                        <th>生成时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.map((insight) => (
                        <tr
                          key={insight.id}
                          data-clickable="true"
                          onClick={() => void handleViewInsight(insight.id)}
                        >
                          <td className={styles.titleCell}>
                            {insight.status === 'generating' || insight.status === 'pending' ? (
                              <span className={styles.busyTitle}>
                                <span className={styles.busyDot} aria-hidden />
                                {LEGACY_SUB_STATUS_LABELS[insight.sub_status ?? ''] ?? '生成中'}
                              </span>
                            ) : (
                              <span className={styles.titleText}>{insight.title}</span>
                            )}
                          </td>
                          <td className={styles.projectCell}>{insight.project_name}</td>
                          <td>{insight.country}</td>
                          <td>
                            <WarmBadge tone="neutral">
                              {INSIGHT_TYPE_OPTIONS.find((t) => t.value === insight.insight_type)
                                ?.label || insight.insight_type}
                            </WarmBadge>
                          </td>
                          <td className={styles.numericCell}>
                            {formatDate(insight.date_range_start)} ~{' '}
                            {formatDate(insight.date_range_end)}
                          </td>
                          <td>
                            <WarmBadge tone={insightStatusTone(insight.status)}>
                              {insightStatusLabel(insight)}
                            </WarmBadge>
                          </td>
                          <td className={styles.numericCell}>
                            {formatDateTime(insight.created_at)}
                          </td>
                          <td onClick={(event) => event.stopPropagation()}>
                            <div className={styles.actions}>
                              <WarmIconButton
                                type="button"
                                aria-label="查看洞察"
                                disabled={insight.status === 'generating'}
                                onClick={() => void handleViewInsight(insight.id)}
                              >
                                <Eye />
                              </WarmIconButton>
                              <WarmIconButton
                                type="button"
                                aria-label="删除洞察"
                                onClick={() => void handleDelete(insight.id)}
                              >
                                <Trash2 />
                              </WarmIconButton>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

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
              className={cn(styles.dialogContent, styles.dialogContentMedium)}
            >
              <span id="insight-generation-dialog-description" className={styles.srOnly}>
                AI洞察报告生成进度对话框
              </span>
              <DialogHeader className={styles.dialogHeader}>
                <DialogTitle className={styles.dialogTitle}>
                  <Bot aria-hidden />
                  {selectedProjectName} - AI 洞察报告
                </DialogTitle>
              </DialogHeader>
              <div className="mt-4">
                <InsightStreamPanel
                  appearance="warm"
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
                        <div className={styles.dialogActions}>
                          <WarmButton
                            type="button"
                            variant="secondary"
                            onClick={() => {
                              setInsightDialogOpen(false)
                              if (generatingId !== null) void handleViewInsight(generatingId)
                            }}
                          >
                            <Pencil aria-hidden />
                            查看并编辑
                          </WarmButton>
                          <WarmButton
                            type="button"
                            variant="primary"
                            onClick={() => {
                              setInsightDialogOpen(false)
                              void loadInsights()
                            }}
                          >
                            <Check aria-hidden />
                            完成
                          </WarmButton>
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
                styles.dialogContent,
                isEditingDetail ? styles.dialogContentWide : styles.dialogContentMedium
              )}
            >
              <span id="insight-view-dialog-description" className={styles.srOnly}>
                洞察详情查看对话框
              </span>
              <DialogHeader className={styles.dialogHeader}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <DialogTitle className={styles.dialogTitle}>
                      {isViewLive ? (
                        <>
                          <Loader2 className="animate-spin" aria-hidden />
                          {viewingInsight?.sub_status === 'queued'
                            ? '排队中...'
                            : '正在生成洞察...'}
                        </>
                      ) : (
                        <>
                          <Eye aria-hidden />
                          {viewingInsight?.title ?? '洞察详情'}
                        </>
                      )}
                    </DialogTitle>
                    {viewingInsight && (
                      <p className={styles.dialogMeta}>
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
                    <div className={styles.dialogActions}>
                      <div className={styles.liveState}>
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        实时生成中
                      </div>
                      <WarmButton
                        type="button"
                        variant="secondary"
                        onClick={() => viewingInsight && void handleRetryInsight(viewingInsight.id)}
                      >
                        <Sparkles aria-hidden />
                        重试
                      </WarmButton>
                    </div>
                  )}

                  {/* Completed insight actions */}
                  {!isLoadingDetail &&
                  viewingInsight?.status === 'completed' &&
                  viewingInsight?.content &&
                  !isEditingDetail ? (
                    <div className={styles.dialogActions}>
                      <WarmButton
                        type="button"
                        variant="secondary"
                        onClick={handleStartEditingDetail}
                      >
                        <Pencil aria-hidden />
                        手动编辑
                      </WarmButton>
                      <WarmButton
                        type="button"
                        variant="secondary"
                        loading={isExporting}
                        loadingLabel="正在导出图片"
                        onClick={() => void handleExportPng()}
                      >
                        {!isExporting && <ImageIcon aria-hidden />}
                        导出图片
                      </WarmButton>
                    </div>
                  ) : null}

                  {/* Failed insight — retry */}
                  {!isLoadingDetail && viewingInsight?.status === 'failed' ? (
                    <div className={styles.dialogActions}>
                      <WarmButton
                        type="button"
                        variant="secondary"
                        onClick={() => viewingInsight && void handleRetryInsight(viewingInsight.id)}
                      >
                        <Sparkles aria-hidden />
                        重新生成
                      </WarmButton>
                    </div>
                  ) : null}
                </div>
              </DialogHeader>
              <div className="mt-4">
                {isLoadingDetail ? (
                  <div className={styles.loadingState} role="status">
                    <Loader2 className="animate-spin" aria-hidden />
                    <span>正在加载洞察内容...</span>
                  </div>
                ) : isEditingDetail ? (
                  <div className={styles.editorGrid} style={{ height: '70vh' }}>
                    <div className={styles.editorPane}>
                      <div className={styles.editorPaneHeader}>
                        <p className={styles.fieldLabel}>预览</p>
                      </div>
                      <div className={styles.editorPaneBody}>
                        <LegacyReportCard
                          content={editingContent}
                          collectChartSvgs={collectChartSvgs}
                        />
                      </div>
                    </div>
                    <div className={styles.editorPane}>
                      <div className={styles.editorToolbar}>
                        <span>
                          直接编辑 Markdown 内容，支持表格、
                          <code>lineChart</code> / <code>pieChart</code> 代码块实时预览。
                        </span>
                        <div className={styles.dialogActions}>
                          <WarmButton
                            type="button"
                            variant="secondary"
                            onClick={handleCancelEditingDetail}
                            disabled={isSavingDetail}
                          >
                            <X aria-hidden />
                            取消
                          </WarmButton>
                          <WarmButton
                            type="button"
                            variant="primary"
                            loading={isSavingDetail}
                            loadingLabel="正在保存洞察"
                            onClick={() => void handleSaveDetail()}
                          >
                            {!isSavingDetail && <Save aria-hidden />}
                            保存
                          </WarmButton>
                        </div>
                      </div>
                      <textarea
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        spellCheck={false}
                        className={styles.editorInput}
                        placeholder="在此编辑 Markdown 内容..."
                      />
                    </div>
                  </div>
                ) : isViewLive ? (
                  <InsightStreamPanel
                    appearance="warm"
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
                  <div className={styles.errorState} role="alert">
                    <span>生成失败</span>
                    <span>{viewingInsight.error_message}</span>
                  </div>
                ) : (
                  <p className={styles.emptyState}>暂无内容</p>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : (
        <div id="insights-panel" role="tabpanel" aria-labelledby="insights-tab" hidden />
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
