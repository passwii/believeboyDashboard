'use client'

import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from 'react'
import { useSession } from 'next-auth/react'
import { CheckCircle2, ChevronLeft, ChevronRight, CircleX, LayoutTemplate } from 'lucide-react'

import { ReportUploadDropzone } from '@/components/report-upload/report-upload-dropzone'
import { ReportStatusCard } from '@/components/report-upload/report-status-card'
import {
  DEFAULT_REPORT_UPLOAD_COUNTRY,
  getReportUploadCountryLabel,
  REPORT_UPLOAD_COUNTRY_OPTIONS,
} from '@/components/report-upload/types'
import type {
  RecognitionResponse,
  ReportCardConfig,
  ReportCardState,
  ReportType,
  ReportUploadCountry,
  UploadQueueItem,
} from '@/components/report-upload/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SingleDatePicker, formatDateInputValue, parseDateInputValue } from '@/components/ui/date-picker'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

const API_BASE = '/api/backend'

const REPORT_CARD_CONFIGS: ReportCardConfig[] = [
  {
    type: 'inventory_report',
    title: '亚马逊物流库存',
    subtitle: '识别字段：snapshot-date / sku / asin',
    dateHint: '默认自动识别 snapshot-date，必要时可手动调整。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
  {
    type: 'business_report',
    title: '业务报告',
    subtitle: '识别字段：（子）ASIN',
    dateHint: '该报表日期需手动选择单日期。',
    projectHint: '默认根据（子）ASIN 自动匹配项目。',
  },
  {
    type: 'ad_product_report',
    title: '广告 - 已推广商品',
    subtitle: '识别字段：开始日期 / 结束日期 / 广告SKU / 广告ASIN',
    dateHint: '默认取识别到的结束日期作为报表日期。',
    projectHint: '默认根据广告SKU 自动匹配项目。',
  },
  {
    type: 'sales_report',
    title: '销售报表 - 所有订单',
    subtitle: '识别字段：purchase-date / sku / asin',
    dateHint: '单日文件会自动带出识别日期；周期文件会锁定日期范围并可直接上传。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
  {
    type: 'payment_report',
    title: '付款报告',
    subtitle: '识别字段：sku',
    dateHint: '该报表默认使用日期范围，请直接选择开始日期与结束日期。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
]

const REPORT_TYPES = REPORT_CARD_CONFIGS.map((item) => item.type)

type StatusCell = {
  report_type: ReportType | 'unknown'
  status: 'available' | 'missing' | 'saved_only'
  display_date: string | null
  report_start_date: string | null
  report_end_date: string | null
  source_table: string | null
  updated_at: string | null
  original_filename: string | null
  message: string | null
}

type StatusProjectRow = {
  project_id: number
  project_name: string
  statuses: Record<string, StatusCell>
}

function toLocalDateInputValue(input?: Date): string {
  const date = input ?? new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDateString(value: string, offsetDays: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  date.setDate(date.getDate() + offsetDays)
  return toLocalDateInputValue(date)
}

function createEmptyCardState(): Record<ReportType, ReportCardState> {
  return {
    inventory_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    business_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    ad_product_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    ad_search_term_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    sales_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    payment_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
  }
}

function updateCardFromCandidates(
  state: ReportCardState,
  candidates: RecognitionResponse[],
  preferredTempFileId?: string | null
): ReportCardState {
  const active = candidates.find((item) => item.temp_file_id === preferredTempFileId) || candidates[candidates.length - 1] || null
  const nextProject =
    state.selectedProject ||
    (active?.project_match.status === 'matched' ? active.project_match.project_name || '' : '')
  const nextDate =
    state.reportDate ||
    (active?.date_input_mode === 'single_detected' ? active.detected_date || active.detected_end_date || '' : '')
  const nextStartDate = state.reportStartDate || active?.detected_start_date || ''
  const nextEndDate = state.reportEndDate || active?.detected_end_date || ''

  return {
    ...state,
    candidates,
    recognition: active,
    activeTempFileId: active?.temp_file_id || null,
    selectedProject: nextProject,
    reportDate: nextDate,
    reportStartDate: nextStartDate,
    reportEndDate: nextEndDate,
    commitStatus: candidates.length === 0 ? 'idle' : state.commitStatus,
    commitMessage: candidates.length === 0 ? null : state.commitMessage,
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return `请求失败 (${response.status})`
  }
}

export default function ReportUploadPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([])
  const [cards, setCards] = useState<Record<ReportType, ReportCardState>>(createEmptyCardState)
  const [statusRows, setStatusRows] = useState<StatusProjectRow[]>([])
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusDate, setStatusDate] = useState(() => toLocalDateInputValue())
  const [selectedCountry, setSelectedCountry] = useState<ReportUploadCountry>(DEFAULT_REPORT_UPLOAD_COUNTRY)

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const payload = await fetchManagedProjectsCached<Array<{ name: string }>>(session)
        setProjects(payload.map((item) => item.name).filter(Boolean))
      } catch (error) {
        setProjectLoadError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  useEffect(() => {
    const loadStatus = async () => {
      setStatusLoading(true)
      setStatusError(null)
      try {
        const query = new URLSearchParams({ report_date: statusDate, country: selectedCountry })
        const response = await fetch(`${API_BASE}/api/v1/report-upload/status?${query.toString()}`, { cache: 'no-store' })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const payload = (await response.json()) as { items: StatusProjectRow[] }
        setStatusRows(payload.items || [])
      } catch (error) {
        setStatusError(error instanceof Error ? error.message : '报表状态加载失败')
      } finally {
        setStatusLoading(false)
      }
    }
    void loadStatus()
  }, [statusDate, selectedCountry])

  const readyCount = useMemo(() => {
    return REPORT_TYPES.filter((type) => {
      const state = cards[type]
      if (!state.recognition || state.commitStatus === 'success' || state.commitStatus === 'saving') return false
      if (state.candidates.length > 1) return false
      if (!state.selectedProject) return false
      if (state.recognition.date_input_mode === 'range_manual') {
        return Boolean(state.reportStartDate && state.reportEndDate)
      }
      if (state.recognition.date_input_mode === 'multi_auto') {
        return true
      }
      return Boolean(state.reportDate)
    }).length
  }, [cards])

  const uploadingAny = useMemo(() => REPORT_TYPES.some((type) => cards[type].commitStatus === 'saving'), [cards])

  const applyRecognition = (recognition: RecognitionResponse) => {
    if (recognition.report_type === 'unknown') return

    setCards((prev) => {
      const type = recognition.report_type as ReportType
      const existing = prev[type]
      const filtered = existing.candidates.filter((item) => item.temp_file_id !== recognition.temp_file_id)
      const candidates = [...filtered, recognition]
      return {
        ...prev,
        [type]: updateCardFromCandidates(existing, candidates, recognition.temp_file_id),
      }
    })
  }

  const recognizeFiles = async (files: File[]) => {
    if (!files.length) return

    const pendingItems: UploadQueueItem[] = files.map((file) => ({
      localId: crypto.randomUUID(),
      originalFileName: file.name,
      reportType: null,
      recognitionStatus: 'pending',
      error: null,
    }))
    setQueueItems((prev) => [...pendingItems, ...prev])
    setRecognizing(true)

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const queueItem = pendingItems[index]
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('country', selectedCountry)
        const response = await fetch(`${API_BASE}/api/v1/report-upload/recognize`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const recognition = (await response.json()) as RecognitionResponse
        setQueueItems((prev) =>
          prev.map((item) =>
            item.localId === queueItem.localId
              ? {
                  ...item,
                  tempFileId: recognition.temp_file_id,
                  reportType: recognition.report_type,
                  recognitionStatus: recognition.status,
                  error: recognition.status === 'recognized' ? null : recognition.reason,
                }
              : item
          )
        )
        if (recognition.status === 'recognized') {
          applyRecognition(recognition)
        }
      } catch (error) {
        setQueueItems((prev) =>
          prev.map((item) =>
            item.localId === queueItem.localId
              ? {
                  ...item,
                  reportType: 'unknown',
                  recognitionStatus: 'error',
                  error: error instanceof Error ? error.message : '识别失败',
                }
              : item
          )
        )
      }
    }

    setRecognizing(false)
  }

  const onPickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    await recognizeFiles(files)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    await recognizeFiles(Array.from(event.dataTransfer.files || []))
  }

  const removeFile = (localId: string) => {
    const target = queueItems.find((item) => item.localId === localId)
    setQueueItems((prev) => prev.filter((item) => item.localId !== localId))
    if (!target?.tempFileId || !target.reportType || target.reportType === 'unknown') return

    setCards((prev) => {
      const type = target.reportType as ReportType
      const nextCandidates = prev[type].candidates.filter((item) => item.temp_file_id !== target.tempFileId)
      return {
        ...prev,
        [type]: updateCardFromCandidates(prev[type], nextCandidates, prev[type].activeTempFileId),
      }
    })
  }

  const clearAll = () => {
    setQueueItems([])
    setCards(createEmptyCardState())
  }

  const updateCard = (type: ReportType, updater: (state: ReportCardState) => ReportCardState) => {
    setCards((prev) => ({
      ...prev,
      [type]: updater(prev[type]),
    }))
  }

  const commitCard = async (type: ReportType) => {
    const state = cards[type]
    const recognition = state.recognition
    if (!recognition) return

    updateCard(type, (current) => ({ ...current, commitStatus: 'saving', commitMessage: null }))
    try {
      const payload = {
        temp_file_id: recognition.temp_file_id,
        original_filename: recognition.original_filename,
        report_type: type,
        project_name: state.selectedProject,
        report_date: state.reportDate || null,
        report_start_date: state.reportStartDate || null,
        report_end_date: state.reportEndDate || null,
        country: selectedCountry,
      }
      const response = await fetch(`${API_BASE}/api/v1/report-upload/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const result = (await response.json()) as { message: string }
      updateCard(type, (current) => ({
        ...current,
        commitStatus: 'success',
        commitMessage: result.message,
      }))
      setStatusLoading(true)
      try {
        const query = new URLSearchParams({ report_date: statusDate, country: selectedCountry })
        const refresh = await fetch(`${API_BASE}/api/v1/report-upload/status?${query.toString()}`, { cache: 'no-store' })
        if (refresh.ok) {
          const payload = (await refresh.json()) as { items: StatusProjectRow[] }
          setStatusRows(payload.items || [])
          setStatusError(null)
        }
      } finally {
        setStatusLoading(false)
      }
    } catch (error) {
      updateCard(type, (current) => ({
        ...current,
        commitStatus: 'error',
        commitMessage: error instanceof Error ? error.message : '保存失败',
      }))
    }
  }

  const uploadAllReady = async () => {
    for (const type of REPORT_TYPES) {
      const state = cards[type]
      const canCommit = Boolean(
        state.recognition &&
          state.candidates.length === 1 &&
          state.selectedProject &&
          (state.recognition.date_input_mode === 'range_manual'
            ? state.reportStartDate && state.reportEndDate
            : state.recognition.date_input_mode === 'multi_auto'
              ? true
            : state.reportDate) &&
          state.commitStatus !== 'success'
      )
      if (canCommit) {
        // eslint-disable-next-line no-await-in-loop
        await commitCard(type)
      }
    }
  }

  const statusLabelByType: Record<ReportType, string> = useMemo(
    () => ({
      inventory_report: '库存',
      business_report: '业务',
      ad_product_report: '广告',
      sales_report: '订单',
      ad_search_term_report: '搜索词',
      payment_report: '付款',
    }),
    []
  )

  const statusTypeLabel = (cell?: StatusCell) => {
    if (!cell || cell.status === 'missing') return '未入库'
    if (cell.report_start_date && cell.report_end_date && cell.report_start_date !== cell.report_end_date) return '周期入库'
    return '当日入库'
  }

  return (
    <div className="w-full space-y-6">
      <Tabs defaultValue="upload" className="space-y-5">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="upload">报表上传</TabsTrigger>
          <TabsTrigger value="status">报表状态</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="space-y-5">
          <div className="space-y-5">
            <ReportUploadDropzone
              items={queueItems}
              dragActive={dragActive}
              recognizing={recognizing}
              country={selectedCountry}
              onCountryChange={(value) => setSelectedCountry(value)}
              onDrop={onDrop}
              onDragOver={(event) => {
                event.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                setDragActive(false)
              }}
              onPickFiles={onPickFiles}
              onRemove={removeFile}
              onClear={clearAll}
              onUploadReady={() => void uploadAllReady()}
              readyCount={readyCount}
              uploadingAny={uploadingAny}
            />

            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold tracking-tight">当前识别卡片</h2>
                {projectLoadError ? <p className="text-sm text-rose-600">{projectLoadError}</p> : null}
              </div>

              {projectsLoading ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {REPORT_TYPES.map((type) => (
                    <Skeleton key={type} className="h-[320px] rounded-3xl" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {REPORT_CARD_CONFIGS.map((config) => {
                    const state = cards[config.type]
                    const recognition = state.recognition
                    const canCommit = Boolean(
                      recognition &&
                        state.candidates.length === 1 &&
                        state.selectedProject &&
                        (recognition.date_input_mode === 'range_manual'
                          ? state.reportStartDate && state.reportEndDate
                          : recognition.date_input_mode === 'multi_auto'
                            ? true
                          : state.reportDate)
                    )

                    return (
                      <ReportStatusCard
                        key={config.type}
                        config={config}
                        state={state}
                        projects={projects}
                        onPickCandidate={(tempFileId) =>
                          updateCard(config.type, (current) =>
                            updateCardFromCandidates(current, current.candidates, tempFileId)
                          )
                        }
                        onProjectChange={(value) => updateCard(config.type, (current) => ({ ...current, selectedProject: value }))}
                        onDateChange={(field, value) => updateCard(config.type, (current) => ({ ...current, [field]: value }))}
                        onCommit={() => void commitCard(config.type)}
                        canCommit={canCommit}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="status">
          <Card className="border-border/70 bg-card/90 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-600">
                  <LayoutTemplate className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>报表状态</CardTitle>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {statusError ? <p className="mb-4 text-sm text-rose-600">{statusError}</p> : null}
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-muted/20 p-3">
                <Button type="button" variant="outline" size="icon" onClick={() => setStatusDate((current) => shiftDateString(current, -1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <SingleDatePicker
                  value={parseDateInputValue(statusDate)}
                  onChange={(date) => setStatusDate(formatDateInputValue(date))}
                  className="w-[180px] bg-background"
                />
                <Button type="button" variant="outline" size="icon" onClick={() => setStatusDate((current) => shiftDateString(current, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button type="button" variant="secondary" onClick={() => setStatusDate(toLocalDateInputValue())}>
                  今天
                </Button>
                <Select value={selectedCountry} onValueChange={(value) => setSelectedCountry(value as ReportUploadCountry)}>
                  <SelectTrigger className="h-10 w-[160px] rounded-xl border-border/70 bg-background">
                    <SelectValue placeholder="选择站点" />
                  </SelectTrigger>
                  <SelectContent>
                    {REPORT_UPLOAD_COUNTRY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {statusLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 rounded-2xl" />
                  <Skeleton className="h-72 rounded-3xl" />
                </div>
              ) : (
                <ScrollArea className="w-full">
                  <div className="min-w-[920px] space-y-3">
                    <div className="grid grid-cols-[160px_repeat(5,minmax(110px,1fr))] gap-2 px-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
                      <div>项目</div>
                      {REPORT_TYPES.map((type) => (
                        <div key={type}>{statusLabelByType[type]}</div>
                      ))}
                    </div>

                    {statusRows.length === 0 ? (
                      <div className="rounded-3xl border border-dashed border-border/60 bg-muted/30 px-6 py-12 text-center">
                        <p className="text-base font-medium">{statusDate} 暂时没有可展示的报表状态</p>
                        <p className="mt-2 text-sm text-muted-foreground">切换左右日期，或先在“报表上传”页签完成当天报表上传。</p>
                      </div>
                    ) : null}

                    {statusRows.map((row) => (
                      <div
                        key={row.project_id}
                        className="grid grid-cols-[160px_repeat(5,minmax(110px,1fr))] gap-2 rounded-3xl border border-border/60 bg-muted/20 p-2.5"
                      >
                        <div className="rounded-2xl bg-background px-3 py-2.5">
                          <p className="text-sm font-semibold">{row.project_name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {getReportUploadCountryLabel(selectedCountry, true)}
                          </p>
                        </div>
                        {REPORT_TYPES.map((type) => {
                          const cell = row.statuses[type] as StatusCell | undefined
                          const tone =
                            cell?.status === 'available'
                              ? 'border-emerald-200 bg-emerald-50'
                              : cell?.status === 'saved_only'
                                ? 'border-amber-200 bg-amber-50'
                                : 'border-border bg-background'
                          return (
                            <div key={type} className={`rounded-2xl border px-2.5 py-2 ${tone}`}>
                              <div className="flex items-center gap-2">
                                {cell?.status === 'missing' ? (
                                  <CircleX className="h-4 w-4 text-rose-500" />
                                ) : (
                                  <CheckCircle2 className={`h-4 w-4 ${cell?.status === 'saved_only' ? 'text-amber-600' : 'text-emerald-600'}`} />
                                )}
                                <span className="text-xs font-medium">
                                  {cell?.status === 'available'
                                    ? '已入库'
                                    : cell?.status === 'saved_only'
                                      ? '仅文件'
                                      : '缺失'}
                                </span>
                              </div>
                              <p className="mt-1.5 text-[11px] text-muted-foreground">{statusTypeLabel(cell)}</p>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
