'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { AlertCircle, CalendarRange, CheckCircle2, Download, Loader2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import {
  DateRangePicker,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SimpleDropzone } from '@/components/report-upload/simple-dropzone'
import { ReportStatusCard } from '@/components/report-upload/report-status-card'
import type {
  ReportCardConfig,
  ReportCardState,
  ReportType,
  RecognitionResponse,
  UploadQueueItem,
} from '@/components/report-upload/types'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'
import {
  exportProductAnalysisToExcel,
  type ExportCountryOption,
} from '@/lib/product-analysis-export'

// =============================================================================
// Types
// =============================================================================

type ProjectOption = {
  id?: number
  name: string
}

type CalculationPeriod = {
  report_start_date: string
  report_end_date: string
  summary: Record<string, unknown>
  details: Record<string, unknown>[]
  is_partial?: boolean
}

type CalculationRunResponse = {
  project_id: number
  project_name: string
  country: string
  total_periods: number
  periods: CalculationPeriod[]
}

// =============================================================================
// Constants
// =============================================================================

const API_BASE = '/api/backend'
const FILE_NAME_PREFIX = '月度SKU分析'

const COUNTRY_OPTIONS: Array<{ value: ExportCountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

// 与手动核算 tab 一致的三类报表
const PRODUCT_ANALYSIS_TYPES: ReportType[] = [
  'business_report',
  'ad_promoted_product_report',
  'payment_report',
]

const PRODUCT_ANALYSIS_CARD_CONFIGS: ReportCardConfig[] = [
  {
    type: 'business_report',
    title: '业务报告',
    subtitle: '流量、销量、会话数据',
    dateHint: '单日',
    projectHint: 'ASIN 匹配项目',
  },
  {
    type: 'ad_promoted_product_report',
    title: '广告报告',
    subtitle: '广告曝光、点击、花费',
    dateHint: '单日',
    projectHint: 'SKU 匹配项目',
  },
  {
    type: 'payment_report',
    title: '付款报告',
    subtitle: '佣金、FBA 费用、退款',
    dateHint: '周期',
    projectHint: 'SKU 匹配项目',
  },
]

// =============================================================================
// Helper functions
// =============================================================================

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

async function parseApiError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { detail?: unknown; message?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    const text = await response.text()
    if (text.trim()) return text
  }
  return fallback
}

function toDateInputValue(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getLastMonthRange() {
  const now = new Date()
  // 选上月 1 号 ~ 月末 — 「月度 SKU 分析」的默认 scope
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000)
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1)
  return {
    start: toDateInputValue(firstOfPrevMonth),
    end: toDateInputValue(lastOfPrevMonth),
  }
}

function emptyCardState(): ReportCardState {
  return {
    recognition: null,
    candidates: [],
    activeTempFileId: null,
    selectedProject: '',
    reportDate: '',
    reportStartDate: '',
    reportEndDate: '',
    commitStatus: 'idle',
    commitMessage: null,
  }
}

// =============================================================================
// Main Component
// =============================================================================

export default function MonthlySkuAnalysisPanel() {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const initialDateRange = getLastMonthRange()

  // ── Parameter state ──
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [country, setCountry] = useState<ExportCountryOption>('US')
  const [startDate, setStartDate] = useState(initialDateRange.start)
  const [endDate, setEndDate] = useState(initialDateRange.end)

  // ── Upload state ──
  const [items, setItems] = useState<UploadQueueItem[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)

  // ── Card state (per report type) ──
  const [cards, setCards] = useState<Record<string, ReportCardState>>({
    business_report: emptyCardState(),
    ad_promoted_product_report: emptyCardState(),
    payment_report: emptyCardState(),
  })

  // ── Run state ──
  const [runState, setRunState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [runError, setRunError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const selectedProject = useMemo(
    () => projects.find((p) => p.name === projectName),
    [projects, projectName]
  )

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate
  const periodLabel = startDate && endDate ? `${startDate} ~ ${endDate}` : ''
  const committedTypes = useMemo(
    () => PRODUCT_ANALYSIS_TYPES.filter((t) => cards[t]?.commitStatus === 'success'),
    [cards]
  )
  const allRequiredCommitted = committedTypes.length >= 3
  const canCalculate = useMemo(
    () =>
      Boolean(selectedProject?.id) &&
      dateRangeValid &&
      allRequiredCommitted &&
      runState !== 'running',
    [selectedProject, dateRangeValid, allRequiredCommitted, runState]
  )

  // ── Load projects ──
  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(data)
      } catch (error) {
        setProjectLoadError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  // ── File recognition via backend ──
  // 与手动核算 tab 一致的扩展名分流：.xlsx/.xls 走 ad-upload（广告 C 表），
  // 其他走 report-upload（业务/付款 A 表）。
  const recognizeFile = useCallback(
    async (file: File): Promise<RecognitionResponse | null> => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('country', country)

      const lowerName = file.name.toLowerCase()
      const isAdExcel = lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')
      const endpoint = isAdExcel ? '/api/v1/ad-upload/recognize' : '/api/v1/report-upload/recognize'

      try {
        const res = await fetch(resolveApiUrl(endpoint), {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const msg = await parseApiError(res, '识别失败')
          console.warn(`识别失败 (${file.name}): ${msg}`)
          return null
        }
        return (await res.json()) as RecognitionResponse
      } catch (err) {
        console.warn(`识别异常 (${file.name}):`, err)
        return null
      }
    },
    [country]
  )

  // ── Handle file drop/pick ──
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setRecognizing(true)

      const results = await Promise.all(
        files.map(async (file) => ({
          file,
          recognition: await recognizeFile(file),
        }))
      )

      setItems((prev) => {
        const next = [...prev]
        for (const { file, recognition } of results) {
          if (!recognition) {
            next.push({
              localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              originalFileName: file.name,
              reportType: 'unknown',
              recognitionStatus: 'error',
              recognizedProject: null,
              userSelectedProject: null,
              detectedDate: null,
              detectedStartDate: null,
              detectedEndDate: null,
              detectedCountry: null,
              detectedCountries: [],
              isMultiCountry: false,
              userReportDate: null,
              userReportStartDate: null,
              userReportEndDate: null,
              fileCommitStatus: 'idle',
              commitError: null,
              error: '识别失败',
              rowsIngested: null,
            })
            continue
          }

          const rType = recognition.report_type as ReportType
          if (!PRODUCT_ANALYSIS_TYPES.includes(rType)) {
            next.push({
              localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              originalFileName: file.name,
              tempFileId: recognition.temp_file_id,
              reportType: rType,
              recognitionStatus: 'recognized',
              recognizedProject: recognition.project_match?.project_name ?? null,
              userSelectedProject: null,
              detectedDate: recognition.detected_date,
              detectedStartDate: recognition.detected_start_date,
              detectedEndDate: recognition.detected_end_date,
              detectedCountry: recognition.country,
              detectedCountries: recognition.detected_countries ?? [],
              isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
              userReportDate: null,
              userReportStartDate: null,
              userReportEndDate: null,
              fileCommitStatus: 'idle',
              commitError: null,
              error: `产品分析不需要此类型 (${rType})，已忽略`,
              rowsIngested: null,
            })
            continue
          }

          const item: UploadQueueItem = {
            localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            originalFileName: file.name,
            tempFileId: recognition.temp_file_id,
            reportType: rType,
            recognitionStatus: recognition.status === 'recognized' ? 'recognized' : 'error',
            recognizedProject: recognition.project_match?.project_name ?? null,
            userSelectedProject: null,
            detectedDate: recognition.detected_date,
            detectedStartDate: recognition.detected_start_date,
            detectedEndDate: recognition.detected_end_date,
            detectedCountry: recognition.country,
            detectedCountries: recognition.detected_countries ?? [],
            isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
            userReportDate: null,
            userReportStartDate: null,
            userReportEndDate: null,
            fileCommitStatus: 'idle',
            commitError: null,
            error: recognition.status !== 'recognized' ? recognition.reason : null,
            rowsIngested: null,
          }
          next.push(item)

          if (recognition.status === 'recognized' && PRODUCT_ANALYSIS_TYPES.includes(rType)) {
            setCards((prev) => ({
              ...prev,
              [rType]: {
                ...prev[rType],
                recognition,
                candidates: [...(prev[rType]?.candidates ?? []), recognition],
                activeTempFileId: recognition.temp_file_id,
                selectedProject: projectName || recognition.project_match?.project_name || '',
                reportDate: recognition.detected_date || '',
                reportStartDate: recognition.detected_start_date || '',
                reportEndDate: recognition.detected_end_date || '',
                commitStatus: 'idle',
                commitMessage: null,
              },
            }))
          }
        }
        return next
      })

      setRecognizing(false)
    },
    [recognizeFile, projectName]
  )

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragActive(false)
      await addFiles(Array.from(event.dataTransfer.files ?? []))
    },
    [addFiles]
  )

  const onPickFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void addFiles(Array.from(event.target.files ?? []))
      event.target.value = ''
    },
    [addFiles]
  )

  // ── Commit a card with dry_run=true (NO DB write) ──
  // 业务/付款 → /api/v1/report-upload/commit  + dry_run
  // 广告      → /api/v1/ad-upload/commit        + dry_run
  // 两条路径都已支持 dry_run，三类报表全部不落 analysis_source_files /
  // ad_upload_files / ReportUploadLog。
  const commitCard = useCallback(
    async (reportType: ReportType) => {
      const card = cards[reportType]
      if (!card?.activeTempFileId) return

      setCards((prev) => ({
        ...prev,
        [reportType]: { ...prev[reportType], commitStatus: 'saving', commitMessage: null },
      }))

      try {
        const isAdReport = String(reportType).startsWith('ad_')
        const body: Record<string, unknown> = {
          temp_file_id: card.activeTempFileId,
          report_type: reportType,
          project_name: projectName,
          country,
          report_start_date: startDate,
          report_end_date: endDate,
          dry_run: true,
        }
        const endpoint = isAdReport ? '/api/v1/ad-upload/commit' : '/api/v1/report-upload/commit'

        const res = await fetch(resolveApiUrl(endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const msg = await parseApiError(res, '提交失败')
          throw new Error(msg)
        }

        setCards((prev) => ({
          ...prev,
          [reportType]: {
            ...prev[reportType],
            commitStatus: 'success',
            commitMessage: null,
          },
        }))

        setItems((prev) =>
          prev.map((item) =>
            item.tempFileId === card.activeTempFileId
              ? { ...item, fileCommitStatus: 'success' as const }
              : item
          )
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : '提交失败'
        setCards((prev) => ({
          ...prev,
          [reportType]: {
            ...prev[reportType],
            commitStatus: 'error',
            commitMessage: msg,
          },
        }))
      }
    },
    [cards, projectName, country, startDate, endDate]
  )

  const uploadAllReady = useCallback(async () => {
    for (const rt of PRODUCT_ANALYSIS_TYPES) {
      const card = cards[rt]
      if (card?.activeTempFileId && card.commitStatus !== 'success') {
        // eslint-disable-next-line no-await-in-loop
        await commitCard(rt)
      }
    }
  }, [cards, commitCard])

  // ── 核心动作：核算 + 直接导出 Excel ──
  // 不展示核算结果在页面。preview 端点直接读 temp file 跑核算，**永不入库**。
  // 三类报告都通过 dry_run commit 拿到 ingest_status='skipped'，temp_file_id 仍可用。
  const handleCalculateAndExport = useCallback(async () => {
    if (!selectedProject?.id) return
    setRunState('running')
    setRunError(null)

    // 收集 3 类报告的 activeTempFileId
    const businessTempId = cards.business_report?.activeTempFileId
    const paymentTempId = cards.payment_report?.activeTempFileId
    const adTempId = cards.ad_promoted_product_report?.activeTempFileId

    if (!businessTempId || !paymentTempId || !adTempId) {
      const msg = '请先完成三类报告的「提交」按钮'
      setRunError(msg)
      setRunState('error')
      notify({ type: 'error', title: msg })
      return
    }

    try {
      const res = await fetch(resolveApiUrl('/api/v1/product-analysis/calculation/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
          business_temp_file_id: businessTempId,
          payment_temp_file_id: paymentTempId,
          ad_temp_file_id: adTempId,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '执行核算失败' }))
        const detail = typeof err.detail === 'string' ? err.detail : '执行核算失败'
        throw new Error(detail)
      }

      const data: CalculationRunResponse = await res.json()
      const periods = data.periods ?? []
      if (periods.length === 0) {
        notify({
          type: 'warning',
          title: '核算结果为空',
          message: '当前日期范围没有可用的核算数据',
        })
        setRunState('done')
        return
      }

      await exportProductAnalysisToExcel({
        periods,
        projectName: projectName || '未知项目',
        country,
        startDate,
        endDate,
        fileNamePrefix: FILE_NAME_PREFIX,
      })

      notify({ type: 'success', title: 'Excel 已下载', message: `共 ${periods.length} 个周期` })
      setRunState('done')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '核算并导出失败'
      setRunError(msg)
      setRunState('error')
      notify({ type: 'error', title: '核算并导出失败', message: msg })
    }
  }, [selectedProject, projectName, country, startDate, endDate, notify, cards])

  return (
    <div className="space-y-3">
      {/* ═══ Panel 1: Parameters ═══ */}
      <TermPanel
        title="核算参数"
        bodyClassName="p-3 space-y-3 [&_label]:font-mono [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wider [&_label]:text-term-muted"
      >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {/* Project */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                项目
              </label>
              <Select
                value={projectName}
                onValueChange={(value) => {
                  setProjectName(value)
                  setCards((prev) => {
                    const next = { ...prev }
                    for (const key of PRODUCT_ANALYSIS_TYPES) {
                      if (next[key]) next[key] = { ...next[key], selectedProject: value }
                    }
                    return next
                  })
                }}
                disabled={projectsLoading || projects.length === 0}
              >
                <SelectTrigger className="h-8 max-w-full">
                  <SelectValue
                    placeholder={
                      projectsLoading
                        ? '项目加载中...'
                        : projects.length
                          ? '请选择项目名称'
                          : '暂无可选项目'
                    }
                  />
                </SelectTrigger>
                <SelectContent className="max-h-64 overflow-y-auto">
                  {projects.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Country */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                站点
              </label>
              <Select
                value={country}
                onValueChange={(value) => setCountry(value as ExportCountryOption)}
              >
                <SelectTrigger className="h-8 max-w-full">
                  <SelectValue placeholder="请选择国家站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date Range */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                日期范围
              </label>
              <DateRangePicker
                value={parseDateRangeInputValue(startDate, endDate)}
                onChange={(range) => {
                  setStartDate(formatDateInputValue(range?.from) ?? startDate)
                  setEndDate(formatDateInputValue(range?.to) ?? endDate)
                }}
                className="h-8"
              />
              {startDate && endDate && startDate > endDate && (
                <p className="text-xs text-destructive">开始日期不能晚于结束日期</p>
              )}
            </div>

            {/* Quick action */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                快捷
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const range = getLastMonthRange()
                  setStartDate(range.start)
                  setEndDate(range.end)
                }}
                className="w-full h-8"
              >
                <CalendarRange className="mr-1 h-4 w-4" />
                上月
              </Button>
            </div>
          </div>

          {/* Status indicators */}
          <div className="grid gap-2 sm:grid-cols-3">
            {PRODUCT_ANALYSIS_CARD_CONFIGS.map((config) => {
              const card = cards[config.type]
              const status = card?.commitStatus ?? 'idle'
              return (
                <div
                  key={config.type}
                  className="rounded-none border border-term-border bg-term-raised px-2 py-1.5"
                >
                  <p className="font-mono text-[10px] uppercase tracking-wider text-term-faint">{config.title}</p>
                  <p
                    className={cn(
                      'mt-1 font-mono text-sm font-semibold tabular-nums',
                      status === 'success'
                        ? 'text-term-pos'
                        : status === 'saving'
                          ? 'text-term-accent'
                          : status === 'error'
                            ? 'text-term-neg'
                            : 'text-term-muted'
                    )}
                  >
                    {status === 'success'
                      ? '已识别（不入库）'
                      : status === 'saving'
                        ? '提交中'
                        : status === 'error'
                          ? '提交失败'
                          : '未提交'}
                  </p>
                </div>
              )
            })}
          </div>

          {formError && (
            <div className="flex items-center gap-2 rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              {formError}
            </div>
          )}
      </TermPanel>

      {/* ═══ Panel 2: File Upload & Recognition ═══ */}
      <TermPanel title="文件上传与识别" bodyClassName="p-3 space-y-4">
          <SimpleDropzone
            dragActive={dragActive}
            recognizing={recognizing}
            onDrop={onDrop}
            onDragOver={(e) => {
              e.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragActive(false)
            }}
            onPickFiles={onPickFiles}
          />

          {/* Report Status Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            {PRODUCT_ANALYSIS_CARD_CONFIGS.map((config) => {
              const cardState = cards[config.type] ?? emptyCardState()
              return (
                <ReportStatusCard
                  key={config.type}
                  config={config}
                  state={cardState}
                  projects={projectName ? [projectName] : []}
                  onPickCandidate={(tempFileId) => {
                    setCards((prev) => ({
                      ...prev,
                      [config.type]: {
                        ...prev[config.type],
                        activeTempFileId: tempFileId,
                        recognition:
                          prev[config.type]?.candidates.find(
                            (c) => c.temp_file_id === tempFileId
                          ) ?? null,
                        commitStatus: 'idle',
                        commitMessage: null,
                      },
                    }))
                  }}
                  onProjectChange={() => {}}
                  onDateChange={() => {}}
                  onCommit={() => void commitCard(config.type)}
                  canCommit={Boolean(
                    cardState.activeTempFileId &&
                      projectName &&
                      cardState.commitStatus !== 'saving' &&
                      cardState.commitStatus !== 'success'
                  )}
                  projectLocked
                  datesLocked
                  periodLabel={periodLabel}
                />
              )
            })}
          </div>

          {/* Action: 一次提交所有未提交 + 核算导出 */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void uploadAllReady()}
              disabled={
                recognizing ||
                !selectedProject?.id ||
                !dateRangeValid ||
                PRODUCT_ANALYSIS_TYPES.every(
                  (t) => cards[t]?.commitStatus === 'success' || !cards[t]?.activeTempFileId
                )
              }
            >
              <CheckCircle2 className="mr-1 h-4 w-4" />
              一键识别并提交（不入库）
            </Button>

            <Button
              type="button"
              onClick={() => void handleCalculateAndExport()}
              disabled={!canCalculate}
            >
              {runState === 'running' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1 h-4 w-4" />
              )}
              核算并导出 Excel
            </Button>
          </div>

          {runError && (
            <div className="flex items-center gap-2 rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {runError}
            </div>
          )}
      </TermPanel>
    </div>
  )
}
