'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleX,
  FileSpreadsheet,
  LayoutDashboard,
  Loader2,
  Megaphone,
  Upload,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  formatDateInputValue,
  parseDateInputValue,
  SimpleDatePicker,
} from '@/components/ui/date-picker'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  REPORT_UPLOAD_COUNTRY_OPTIONS,
  getMultiCountryDisplay,
  getReportUploadCountryLabel,
  isDateRequired,
  type UploadQueueItem,
  type RecognitionResponse,
  type ReportUploadCountry,
} from '@/components/report-upload/types'
import { getUploadReportTypeLabel, REPORT_TYPES } from './report-type-labels'

const API_BASE = '/api/backend'

// ── Shared constants ─────────────────────────────────────────────────────────

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站' },
  { value: 'DE', label: '德国站' },
  { value: 'UK', label: '英国站' },
]

// ── RPA Status types ──────────────────────────────────────────────────────────

function getTodayLocal(): Date {
  return new Date()
}

function toLocalDateInputValue(input?: Date): string {
  const date = input ?? getTodayLocal()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDateString(value: string, offsetDays: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year!, (month! || 1) - 1, day! || 1)
  date.setDate(date.getDate() + offsetDays)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

type StatusCell = {
  report_type: string
  has_data: boolean
  is_uploaded: boolean
  latest_date: string | null
  original_filename: string | null
}

type ProjectRow = {
  project_id: number
  project_name: string
  country: string
  statuses: StatusCell[]
}

const TABLE_HEADER_HEIGHT_CLASS = 'h-[clamp(3.5rem,3.8vh,4.25rem)] min-h-14 max-h-[4.25rem]'
const TABLE_ROW_HEIGHT_CLASS = 'h-[clamp(2.8rem,3.2vh,3.5rem)] min-h-[2.8rem] max-h-[3.5rem]'

// ── Upload progress summary ──────────────────────────────────────────────────

function ProgressRow({
  label,
  done,
  total,
  pct,
}: {
  label: string
  done: number
  total: number
  pct: number
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-term-raised">
        <div
          className="h-full rounded-full bg-term-accent transition-all duration-[var(--duration-very-slow)] ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 text-right text-[11px] tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  )
}

function UploadProgressSummary({
  recognitionDone,
  recognitionTotal,
  uploadDone,
  uploadTotal,
}: {
  recognitionDone: number
  recognitionTotal: number
  uploadDone: number
  uploadTotal: number
}) {
  if (recognitionTotal === 0 && uploadTotal === 0) return null
  const recPct = recognitionTotal === 0 ? 0 : Math.round((recognitionDone / recognitionTotal) * 100)
  const upPct = uploadTotal === 0 ? 0 : Math.round((uploadDone / uploadTotal) * 100)
  return (
    <div className="space-y-1.5 pt-1.5">
      <ProgressRow label="识别" done={recognitionDone} total={recognitionTotal} pct={recPct} />
      <ProgressRow label="上传" done={uploadDone} total={uploadTotal} pct={upPct} />
    </div>
  )
}

// ── RPA Status Grid ──────────────────────────────────────────────────────────

function RpaStatusGrid({
  country,
  onCountryChange,
  refreshHandlerRef,
}: {
  country: string
  onCountryChange: (v: string) => void
  refreshHandlerRef: React.MutableRefObject<(() => Promise<void>) | null>
}) {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [selectedProjects, setSelectedProjects] = useState<string[]>([])

  const [statusRows, setStatusRows] = useState<ProjectRow[]>([])
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const { showSkeleton, isRefreshing } = useSmoothRefresh({
    loading: statusLoading,
    hasData: statusRows.length > 0,
  })

  const [statusDate, setStatusDate] = useState(() => toLocalDateInputValue())

  // BEL-422：项目列表仅服务于「项目筛选」下拉，首次打开下拉时才拉取，
  // 不再随 mount 预拉（带 2 分钟客户端缓存，打开后重复交互零请求）。
  const projectsRequested = useRef(false)
  const loadProjects = useCallback(async (force = false) => {
    setProjectsLoading(true)
    try {
      const payload = await fetchManagedProjectsCached<Array<{ name: string }>>(session, false, { force })
      setProjects(payload.map((item) => item.name).filter(Boolean))
    } catch (_error) {
      // 保留已有筛选选项；首次加载失败时列表仍为空。
    } finally {
      setProjectsLoading(false)
    }
  }, [session])
  const ensureProjects = () => {
    if (projectsRequested.current) return
    projectsRequested.current = true
    void loadProjects()
  }

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const query = new URLSearchParams({ report_date: statusDate, country })
      const response = await fetch(`${API_BASE}/api/v1/rpa-reports/status?${query.toString()}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }
      const payload = (await response.json()) as { items: ProjectRow[] }
      setStatusRows(payload.items || [])
    } catch (error) {
      setStatusError(normalizeErrorMessage(error, '报表状态加载失败'))
    } finally {
      setStatusLoading(false)
    }
  }, [country, statusDate])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const refreshStatus = useCallback(async () => {
    const refreshes: Promise<void>[] = [loadStatus()]
    if (projectsRequested.current) refreshes.push(loadProjects(true))
    await Promise.all(refreshes)
  }, [loadProjects, loadStatus])

  useEffect(() => {
    refreshHandlerRef.current = refreshStatus
    return () => {
      if (refreshHandlerRef.current === refreshStatus) refreshHandlerRef.current = null
    }
  }, [refreshHandlerRef, refreshStatus])

  const filteredRows = useMemo(() => {
    if (selectedProjects.length === 0) return statusRows
    return statusRows.filter((row) => selectedProjects.includes(row.project_name))
  }, [selectedProjects, statusRows])

  const projectFilterLabel = useMemo(() => {
    if (selectedProjects.length === 0) return '全部项目'
    if (selectedProjects.length === 1) return selectedProjects[0]
    return `已选 ${selectedProjects.length} 个项目`
  }, [selectedProjects])

  return (
    <Card className="flex flex-1 flex-col overflow-hidden rounded-none border-term-border bg-term-panel shadow-none">
      <CardHeader className="shrink-0 rounded-none border-b border-term-border bg-term-raised px-3 py-2.5">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-none border border-term-border bg-term-panel text-term-muted">
              <LayoutDashboard className="h-4 w-4" aria-hidden />
            </div>
            <CardTitle className="self-center font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
              RPA 报表状态
            </CardTitle>
          </div>

          {/* Mobile: 2-column grid; lg+: horizontal row */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-row lg:flex-wrap lg:items-center lg:gap-2">
            {/* Row 1: 项目 + 站点 */}
            <div className="contents lg:flex lg:items-center lg:gap-2">
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open) ensureProjects()
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 w-full justify-start rounded-none border-term-border bg-term-bg text-left font-normal font-mono text-xs text-term-text sm:w-auto"
                  >
                    {projectFilterLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[280px]">
                  <DropdownMenuLabel>项目筛选</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setSelectedProjects([])}
                  >
                    全部项目
                  </button>
                  <DropdownMenuSeparator />
                  {projectsRequested && projectsLoading && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">加载中…</div>
                  )}
                  {projects.map((project) => (
                    <DropdownMenuCheckboxItem
                      key={project}
                      checked={selectedProjects.includes(project)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedProjects((prev) => {
                          if (checked) {
                            return prev.includes(project) ? prev : [...prev, project]
                          }
                          return prev.filter((p) => p !== project)
                        })
                      }}
                    >
                      {project}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Select value={country} onValueChange={onCountryChange}>
                <SelectTrigger className="h-9 w-full rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text sm:w-[130px]">
                  <SelectValue placeholder="选择站点" />
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

            {/* Row 2: 日期导航 */}
            <div className="contents lg:flex lg:items-center lg:gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-none border-term-border bg-term-panel"
                onClick={() => setStatusDate((v) => shiftDateString(v, -1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <SimpleDatePicker
                value={parseDateInputValue(statusDate)}
                onChange={(date) => setStatusDate(formatDateInputValue(date))}
                className="h-9 w-full rounded-none border-term-border bg-term-bg font-mono text-xs sm:w-[160px]"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-none border-term-border bg-term-panel"
                onClick={() => setStatusDate((v) => shiftDateString(v, 1))}
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>

            {/* Row 3: 今天 + 刷新 */}
            <div className="contents lg:flex lg:items-center lg:gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-9 rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted hover:text-term-text"
                onClick={() => setStatusDate(toLocalDateInputValue(undefined))}
              >
                今天
              </Button>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-none border-term-border bg-term-panel"
                onClick={() => void loadStatus()}
                disabled={statusLoading}
                title="刷新状态"
              >
                <Loader2 className={cn('h-3.5 w-3.5', statusLoading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>

      <div className="flex min-h-0 flex-1 flex-col p-0 relative">
        {statusError ? (
          <p className="border-b border-term-neg/40 bg-term-neg/10 py-2 pl-3 font-mono text-xs text-term-neg">{statusError}</p>
        ) : null}

        {showSkeleton ? (
          <div className="flex min-h-0 flex-1 flex-col space-y-3">
            <Skeleton className="h-8 w-full rounded-none shrink-0" />
            <Skeleton className="flex-1 w-full rounded-none min-h-0" />
          </div>
        ) : (
          <RefreshProgressBar
            refreshing={isRefreshing}
            className="flex min-h-0 flex-1 flex-col overflow-auto"
          >
            <div
              className="grid min-w-max shrink-0"
              style={{ gridTemplateColumns: `160px repeat(${REPORT_TYPES.length}, 96px)` }}
            >
              <div
                className={`sticky left-0 z-20 flex items-center border border-b-0 border-r border-term-border bg-term-raised px-2 ${TABLE_HEADER_HEIGHT_CLASS}`}
              >
                <span className="font-mono text-xs font-medium uppercase tracking-wider text-term-muted">
                  项目
                </span>
              </div>
              {REPORT_TYPES.map((rt, colIdx) => (
                <div
                  key={rt.key}
                  className={`flex items-center justify-center border-b border-t border-term-border px-1 ${TABLE_HEADER_HEIGHT_CLASS}${colIdx < REPORT_TYPES.length - 1 ? ' border-r' : ''}`}
                >
                  <span className="text-center font-mono text-[11px] font-medium uppercase tracking-wider text-term-muted">
                    {rt.label}
                  </span>
                </div>
              ))}
            </div>

            {filteredRows.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-16">
                <p className="text-base font-medium">{statusDate} 暂时没有可展示的报表状态</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  切换左右日期，或检查 RPA 是否已接入该日期的数据
                </p>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col min-w-max">
                {filteredRows.map((row) => (
                  <div
                    key={row.project_id}
                    className={`grid border border-t-0 border-term-border transition-colors hover:bg-term-hover ${TABLE_ROW_HEIGHT_CLASS}`}
                    style={{ gridTemplateColumns: `160px repeat(${REPORT_TYPES.length}, 96px)` }}
                  >
                    <div className="sticky left-0 z-10 flex items-center border-r border-term-border bg-term-panel px-2">
                      <span className="truncate font-mono text-xs text-term-text">{row.project_name}</span>
                    </div>
                    {REPORT_TYPES.map((rt, colIdx) => {
                      const cell = row.statuses.find((s) => s.report_type === rt.key)
                      const isUploaded = cell?.is_uploaded ?? false
                      return (
                        <div
                          key={rt.key}
                          className={`flex items-center justify-center border-term-border px-1 py-2.5${colIdx < REPORT_TYPES.length - 1 ? ' border-r' : ''}${
                            isUploaded ? ' bg-term-pos/10' : ' bg-term-neg/10'
                          }`}
                        >
                          {isUploaded ? (
                            <CheckCircle2 className="h-4 w-4 text-term-pos" aria-hidden />
                          ) : (
                            <CircleX className="h-4 w-4 text-term-neg" aria-hidden />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </RefreshProgressBar>
        )}
      </div>
    </Card>
  )
}

// ── Auto Upload Content ──────────────────────────────────────────────────────

type UploadEndpoint = 'report-upload' | 'ad-upload'

function AutoUploadContent({
  country,
  onCountryChange,
  endpoint,
  refreshHandlerRef,
}: {
  country: ReportUploadCountry
  onCountryChange: (v: ReportUploadCountry) => void
  endpoint: UploadEndpoint
  refreshHandlerRef: React.MutableRefObject<(() => Promise<void>) | null>
}) {
  const { data: session } = useSession()
  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([])
  const [recognitionMap, setRecognitionMap] = useState<Record<string, RecognitionResponse>>({})
  // 项目列表（用于手动选择）
  const [availableProjects, setAvailableProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  const refreshProjects = useCallback(async (force = false) => {
    setProjectsLoading(true)
    try {
      const payload = await fetchManagedProjectsCached<Array<{ name: string }>>(session, false, { force })
      setAvailableProjects(payload.map((item) => item.name).filter(Boolean))
    } catch {
      // Keep existing options and upload queue when project lookup fails.
    } finally {
      setProjectsLoading(false)
    }
  }, [session])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    refreshHandlerRef.current = () => refreshProjects(true)
    return () => {
      refreshHandlerRef.current = null
    }
  }, [refreshHandlerRef, refreshProjects])

  // 进度条统计：识别（成功 + 失败都算完成）/ 上传（仅识别成功且非 unknown 可上传的项，success + error 都算完成）
  const recognitionStats = useMemo(() => {
    const total = queueItems.length
    const done = queueItems.filter((it) => it.recognitionStatus !== 'pending').length
    return { total, done }
  }, [queueItems])

  const uploadStats = useMemo(() => {
    const eligible = queueItems.filter(
      (it) => it.recognitionStatus === 'recognized' && it.reportType && it.reportType !== 'unknown'
    )
    const total = eligible.length
    const done = eligible.filter(
      (it) => it.fileCommitStatus === 'success' || it.fileCommitStatus === 'error'
    ).length
    return { total, done }
  }, [queueItems])

  const recognizeFiles = async (files: File[]) => {
    if (!files.length) return

    const pending: UploadQueueItem[] = files.map((file) => ({
      localId: crypto.randomUUID(),
      originalFileName: file.name,
      reportType: null,
      recognitionStatus: 'pending',
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
      error: null,
      rowsIngested: null,
    }))

    setQueueItems((prev) => [...pending, ...prev])
    setRecognizing(true)

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const item = pending[i]
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('country', country)
        const res = await fetch(`${API_BASE}/api/v1/${endpoint}/recognize`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || '识别失败')
        }
        const recognition: RecognitionResponse = await res.json()

        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  tempFileId: recognition.temp_file_id,
                  reportType: recognition.report_type as UploadQueueItem['reportType'],
                  recognitionStatus: recognition.status,
                  recognizedProject:
                    recognition.project_match.status === 'matched'
                      ? (recognition.project_match.project_name ?? null)
                      : recognition.project_match.status === 'conflict'
                        ? `候选 ${recognition.project_match.candidate_projects.length} 个`
                        : '未匹配',
                  detectedDate: recognition.detected_date ?? recognition.detected_end_date ?? null,
                  detectedStartDate: recognition.detected_start_date ?? null,
                  detectedEndDate: recognition.detected_end_date ?? null,
                  detectedCountry: recognition.country,
                  detectedCountries: recognition.detected_countries ?? [],
                  isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
                  error: recognition.status === 'recognized' ? null : recognition.reason,
                }
              : it
          )
        )
        setRecognitionMap((prev) => ({ ...prev, [item.localId]: recognition }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : '识别失败'
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  reportType: 'unknown',
                  recognitionStatus: 'error',
                  recognizedProject: null,
                  userSelectedProject: null,
                  fileCommitStatus: 'error',
                  error: msg,
                }
              : it
          )
        )
      }
    }

    setRecognizing(false)
  }

  const handleUploadAll = async () => {
    setUploading(true)

    for (const item of queueItems) {
      if (
        item.recognitionStatus !== 'recognized' ||
        !item.tempFileId ||
        !item.reportType ||
        item.reportType === 'unknown' ||
        item.fileCommitStatus === 'success'
      ) {
        continue
      }

      const recognition = recognitionMap[item.localId]
      if (!recognition) continue

      // Multi-country detection: sales reports with multiple countries are auto-split
      const isMultiCountrySalesReport =
        item.reportType === 'sales_report' &&
        recognition.detected_countries &&
        recognition.detected_countries.length > 1

      // Validate country only for single-country files
      if (!isMultiCountrySalesReport && recognition.country && recognition.country !== country) {
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  fileCommitStatus: 'error',
                  commitError: `文件站点（${recognition.country}）与所选站点（${country}）不一致，请上传到对应站点`,
                }
              : it
          )
        )
        continue
      }

      // 检查项目匹配状态
      const autoMatchedProject =
        recognition.project_match.status === 'matched'
          ? (recognition.project_match.project_name ?? null)
          : null
      const finalProjectName = item.userSelectedProject ?? autoMatchedProject

      // 如果项目未匹配且用户未手动选择，报错
      if (!finalProjectName) {
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  fileCommitStatus: 'error',
                  commitError: '请先选择项目',
                }
              : it
          )
        )
        continue
      }

      // Check if date is required but missing
      const resolvedDate =
        item.userReportDate ?? recognition.detected_date ?? recognition.detected_end_date ?? null
      const resolvedStartDate = item.userReportStartDate ?? recognition.detected_start_date ?? null
      const resolvedEndDate = item.userReportEndDate ?? recognition.detected_end_date ?? null
      if (isDateRequired(item.reportType)) {
        if (item.reportType === 'payment_report') {
          if (!resolvedStartDate || !resolvedEndDate) {
            setQueueItems((prev) =>
              prev.map((it) =>
                it.localId === item.localId
                  ? {
                      ...it,
                      fileCommitStatus: 'error',
                      commitError: '请填写完整的日期范围',
                    }
                  : it
              )
            )
            continue
          }
        } else if (!resolvedDate) {
          setQueueItems((prev) =>
            prev.map((it) =>
              it.localId === item.localId
                ? {
                    ...it,
                    fileCommitStatus: 'error',
                    commitError: '请填写报表日期',
                  }
                : it
            )
          )
          continue
        }
      }

      setQueueItems((prev) =>
        prev.map((it) =>
          it.localId === item.localId
            ? { ...it, fileCommitStatus: 'saving', commitError: null }
            : it
        )
      )

      try {
        const resolvedStartDate =
          item.userReportStartDate ?? recognition.detected_start_date ?? null
        const resolvedEndDate = item.userReportEndDate ?? recognition.detected_end_date ?? null

        // 多站点文件：传入 primary_country 供后端参考（后端会按检测到的所有国家拆分）
        const effectiveCountry = isMultiCountrySalesReport
          ? (recognition.primary_country ?? country)
          : country

        const payload = {
          temp_file_id: item.tempFileId,
          original_filename: item.originalFileName,
          report_type: item.reportType,
          report_date: resolvedDate,
          report_start_date: resolvedStartDate,
          report_end_date: resolvedEndDate,
          country: effectiveCountry,
          project_name: finalProjectName,
        }
        const res = await fetch(`${API_BASE}/api/v1/${endpoint}/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || '上传失败')
        }
        // 读取结构化响应：rows_ingested 用于上传成功后的行数反馈（按行入库类型才有值）
        let rowsIngested: number | null = null
        try {
          const commitPayload = (await res.json()) as { rows_ingested?: number | null }
          rowsIngested =
            typeof commitPayload.rows_ingested === 'number' && commitPayload.rows_ingested > 0
              ? commitPayload.rows_ingested
              : null
        } catch {
          // 响应非 JSON 时忽略，仅缺失行数反馈，不影响成功状态
        }
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? { ...it, fileCommitStatus: 'success', commitError: null, rowsIngested }
              : it
          )
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败'
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? { ...it, fileCommitStatus: 'error', commitError: msg }
              : it
          )
        )
      }
    }

    setUploading(false)
  }

  const removeItem = (localId: string) => {
    setQueueItems((prev) => prev.filter((it) => it.localId !== localId))
    setRecognitionMap((prev) => {
      const next = { ...prev }
      delete next[localId]
      return next
    })
  }

  const clearAll = () => {
    setQueueItems([])
    setRecognitionMap({})
  }

  const pendingCount = queueItems.filter(
    (it) =>
      it.recognitionStatus === 'recognized' &&
      it.fileCommitStatus !== 'success' &&
      it.fileCommitStatus !== 'saving'
  ).length

  return (
    <div className="flex flex-1 flex-col gap-4">
      {/* Top controls：手机端 2 列网格（站点全宽一行 + 双按钮各半），sm+ 恢复横向 */}
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-3">
        <Select value={country} onValueChange={(v) => onCountryChange(v as ReportUploadCountry)}>
          <SelectTrigger className="col-span-2 h-10 w-full rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text sm:col-span-1 sm:w-[150px]">
            <SelectValue placeholder="选择站点" />
          </SelectTrigger>
          <SelectContent>
            {REPORT_UPLOAD_COUNTRY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button onClick={handleUploadAll} disabled={pendingCount === 0 || uploading} className="flex-1 sm:flex-none">
          {uploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              上传中...
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              上传全部 ({pendingCount})
            </>
          )}
        </Button>

        <Button
          variant="outline"
          onClick={clearAll}
          disabled={queueItems.length === 0 || recognizing || uploading}
          className="flex-1 sm:flex-none"
        >
          清空列表
        </Button>
      </div>

      {/* Dropzone + File list */}
      <div className="grid flex-1 gap-3 overflow-hidden lg:grid-cols-[1fr_2fr]">
        {/* Dropzone */}
        <Card className="overflow-hidden rounded-none border-term-border bg-term-panel shadow-none">
          <CardContent className="flex h-full !px-3 !py-3">
            <div
              className={cn(
                'relative flex w-full flex-col items-center justify-center rounded-none border border-dashed px-4 transition-[border-color,background-color] duration-[var(--duration-quick)]',
                dragActive
                  ? 'border-term-accent/70 bg-term-accent/10'
                  : 'border-term-border bg-term-raised'
              )}
              style={{ flex: 1 }}
              onDrop={(e) => {
                e.preventDefault()
                setDragActive(false)
                void recognizeFiles(Array.from(e.dataTransfer.files))
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
            >
              <input
                id="auto-upload-input"
                type="file"
                multiple
                className="hidden"
                accept=".txt,.csv,.xlsx"
                onChange={(e) => {
                  void recognizeFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              <label
                htmlFor="auto-upload-input"
                className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 text-center"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-none border border-term-border bg-term-panel text-term-muted">
                  <Upload className="h-5 w-5 text-term-accent" aria-hidden />
                </div>
                <div className="space-y-1">
                  <p className="font-mono text-xs font-semibold uppercase tracking-wider text-term-text sm:text-sm">
                    拖拽文件到这里，或点击选择
                  </p>
                  <p className="font-mono text-[11px] text-term-faint">支持 .txt / .csv / .xlsx</p>
                </div>
              </label>
              {recognizing ? (
                <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在识别...
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* File list */}
        <Card className="flex flex-col overflow-hidden rounded-none border-term-border bg-term-panel shadow-none">
          <CardHeader className="rounded-none border-b border-term-border bg-term-raised px-3 pb-2.5 pt-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
                  本次识别文件
                </CardTitle>
                <CardDescription className="font-mono text-[11px] tabular-nums text-term-faint">
                  {queueItems.length} 个文件
                </CardDescription>
              </div>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin text-term-accent" aria-hidden /> : null}
            </div>
            <UploadProgressSummary
              recognitionDone={recognitionStats.done}
              recognitionTotal={recognitionStats.total}
              uploadDone={uploadStats.done}
              uploadTotal={uploadStats.total}
            />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col overflow-hidden px-0 pt-0">
            <ScrollArea className="flex-1">
              <div className="space-y-2 p-3">
                {queueItems.length === 0 ? (
                  <div className="rounded-none border border-dashed border-term-border bg-term-raised px-4 py-8 text-center font-mono text-xs text-term-faint">
                    暂无文件
                  </div>
                ) : null}
                {queueItems.map((item) => (
                  <div
                    key={item.localId}
                    className={cn(
                      'relative flex items-start justify-between gap-3 rounded-none border border-term-border bg-term-raised/85 px-3 py-2.5 transition-colors duration-[var(--duration-quick)]',
                      // 上传成功：整条 pos 覆盖
                      item.fileCommitStatus === 'success' && 'border-term-pos/50 bg-term-pos/10',
                      // 保存中：accent
                      item.fileCommitStatus === 'saving' && 'border-term-accent/40 bg-term-accent/10',
                      // 识别错误：neg
                      item.recognitionStatus === 'error' && 'border-term-neg/40 bg-term-neg/10'
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {item.originalFileName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.recognitionStatus === 'pending'
                          ? '识别中'
                          : `类型：${getUploadReportTypeLabel(item.reportType)}`}
                      </p>
                      {item.fileCommitStatus === 'success' && item.rowsIngested != null ? (
                        <p className="text-xs text-muted-foreground">
                          入库：
                          <span className="font-medium tabular-nums text-term-pos">
                            {item.rowsIngested.toLocaleString()}
                          </span>{' '}
                          行
                        </p>
                      ) : null}
                      {item.recognitionStatus !== 'pending' ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            国家：
                            {item.isMultiCountry ? (
                              <span className="font-medium text-term-accent">
                                {getMultiCountryDisplay(item.detectedCountries)} (自动拆分)
                              </span>
                            ) : item.detectedCountry ? (
                              getReportUploadCountryLabel(item.detectedCountry, true)
                            ) : (
                              '未识别'
                            )}
                          </p>
                          {item.recognizedProject === '未匹配' ||
                          item.recognizedProject === null ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs text-term-warn">
                                项目：
                              </span>
                              <Select
                                value={item.userSelectedProject ?? ''}
                                onValueChange={(value) => {
                                  setQueueItems((prev) =>
                                    prev.map((it) =>
                                      it.localId === item.localId
                                        ? { ...it, userSelectedProject: value || null }
                                        : it
                                    )
                                  )
                                }}
                              >
                                <SelectTrigger className="h-6 w-[140px] rounded-none border-term-border bg-term-bg px-1.5 py-0.5 font-mono text-xs">
                                  <SelectValue placeholder="选择项目" />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableProjects.map((project) => (
                                    <SelectItem key={project} value={project}>
                                      {project}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              项目：{item.userSelectedProject ?? item.recognizedProject}
                            </p>
                          )}
                          {item.detectedDate || item.detectedStartDate || item.detectedEndDate ? (
                            <div className="flex flex-col gap-0.5">
                              <p className="text-xs text-muted-foreground">
                                {item.reportType === 'payment_report' ? (
                                  <>
                                    日期范围：
                                    <span className="font-mono">
                                      {item.userReportStartDate || item.detectedStartDate || '—'} →{' '}
                                      {item.userReportEndDate || item.detectedEndDate || '—'}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const start =
                                          item.userReportStartDate || item.detectedStartDate || ''
                                        const end =
                                          item.userReportEndDate || item.detectedEndDate || ''
                                        setQueueItems((prev) =>
                                          prev.map((it) =>
                                            it.localId === item.localId
                                              ? {
                                                  ...it,
                                                  userReportStartDate:
                                                    it.userReportStartDate === null ? start : null,
                                                  userReportEndDate:
                                                    it.userReportEndDate === null ? end : null,
                                                }
                                              : it
                                          )
                                        )
                                      }}
                                      className="-my-1 ml-1 rounded-none px-1.5 py-1 font-mono text-[10px] text-term-accent hover:bg-term-accent/10"
                                    >
                                      {item.userReportStartDate ? '取消' : '编辑'}
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    日期：{item.userReportDate || item.detectedDate}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setQueueItems((prev) =>
                                          prev.map((it) =>
                                            it.localId === item.localId
                                              ? {
                                                  ...it,
                                                  userReportDate:
                                                    it.userReportDate === null
                                                      ? item.detectedDate || ''
                                                      : null,
                                                }
                                              : it
                                          )
                                        )
                                      }}
                                      className="-my-1 ml-1 rounded-none px-1.5 py-1 font-mono text-[10px] text-term-accent hover:bg-term-accent/10"
                                    >
                                      {item.userReportDate ? '取消' : '编辑'}
                                    </button>
                                  </>
                                )}
                              </p>
                              {item.reportType === 'payment_report' &&
                              item.userReportStartDate !== null ? (
                                <div className="flex items-center gap-1.5 pt-0.5">
                                  <span className="font-mono text-[10px] text-term-warn">起：</span>
                                  <SimpleDatePicker
                                    value={parseDateInputValue(item.userReportStartDate || '')}
                                    onChange={(date) => {
                                      setQueueItems((prev) =>
                                        prev.map((it) =>
                                          it.localId === item.localId
                                            ? {
                                                ...it,
                                                userReportStartDate: formatDateInputValue(date),
                                              }
                                            : it
                                        )
                                      )
                                    }}
                                    className="h-6 w-[130px] text-xs"
                                  />
                                  <span className="font-mono text-[10px] text-term-warn">止：</span>
                                  <SimpleDatePicker
                                    value={parseDateInputValue(item.userReportEndDate || '')}
                                    onChange={(date) => {
                                      setQueueItems((prev) =>
                                        prev.map((it) =>
                                          it.localId === item.localId
                                            ? {
                                                ...it,
                                                userReportEndDate: formatDateInputValue(date),
                                              }
                                            : it
                                        )
                                      )
                                    }}
                                    className="h-6 w-[130px] text-xs"
                                  />
                                </div>
                              ) : item.userReportDate !== null &&
                                item.reportType !== 'payment_report' ? (
                                <div className="flex items-center gap-1.5 pt-0.5">
                                  <span className="font-mono text-[10px] text-term-warn">日期：</span>
                                  <SimpleDatePicker
                                    value={parseDateInputValue(item.userReportDate || '')}
                                    onChange={(date) => {
                                      setQueueItems((prev) =>
                                        prev.map((it) =>
                                          it.localId === item.localId
                                            ? { ...it, userReportDate: formatDateInputValue(date) }
                                            : it
                                        )
                                      )
                                    }}
                                    className="h-6 w-[130px] text-xs"
                                  />
                                </div>
                              ) : null}
                            </div>
                          ) : isDateRequired(item.reportType) ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs text-term-warn">
                                {item.reportType === 'payment_report' ? '日期范围' : '日期'}：
                              </span>
                              {item.reportType === 'payment_report' ? (
                                <div className="flex items-center gap-1.5">
                                  <SimpleDatePicker
                                    value={parseDateInputValue(item.userReportStartDate || '')}
                                    onChange={(date) => {
                                      setQueueItems((prev) =>
                                        prev.map((it) =>
                                          it.localId === item.localId
                                            ? {
                                                ...it,
                                                userReportStartDate: formatDateInputValue(date),
                                              }
                                            : it
                                        )
                                      )
                                    }}
                                    className="h-6 w-[130px] text-xs"
                                  />
                                  <span className="text-xs text-muted-foreground">→</span>
                                  <SimpleDatePicker
                                    value={parseDateInputValue(item.userReportEndDate || '')}
                                    onChange={(date) => {
                                      setQueueItems((prev) =>
                                        prev.map((it) =>
                                          it.localId === item.localId
                                            ? {
                                                ...it,
                                                userReportEndDate: formatDateInputValue(date),
                                              }
                                            : it
                                        )
                                      )
                                    }}
                                    className="h-6 w-[130px] text-xs"
                                  />
                                </div>
                              ) : (
                                <SimpleDatePicker
                                  value={parseDateInputValue(item.userReportDate || '')}
                                  onChange={(date) => {
                                    setQueueItems((prev) =>
                                      prev.map((it) =>
                                        it.localId === item.localId
                                          ? { ...it, userReportDate: formatDateInputValue(date) }
                                          : it
                                      )
                                    )
                                  }}
                                  className="h-6 w-[130px] text-xs"
                                />
                              )}
                            </div>
                          ) : null}
                          {item.error ? (
                            <p className="font-mono text-xs text-term-neg">{item.error}</p>
                          ) : null}
                          {item.commitError ? (
                            <p className="font-mono text-xs text-term-neg">
                              {item.commitError}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {item.fileCommitStatus === 'saving' ? (
                        <Loader2 className="h-4 w-4 animate-spin text-term-accent" aria-hidden />
                      ) : null}
                      {item.fileCommitStatus === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 text-term-pos" aria-hidden />
                      ) : null}
                      {item.fileCommitStatus === 'error' ? (
                        <CircleX className="h-4 w-4 text-term-neg" aria-hidden />
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeItem(item.localId)}
                         className="h-9 w-9 shrink-0 rounded-none border border-transparent text-term-muted hover:border-term-neg/50 hover:text-term-neg"
                      >
                        <CircleX className="h-4 w-4" />
                        <span className="sr-only">移除</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function AutoUploadPage() {
  const [activeTab, setActiveTab] = useState<'upload' | 'status'>('status')
  const [uploadSubTab, setUploadSubTab] = useState<UploadEndpoint>('report-upload')
  const [country, setCountry] = useState('US')
  const [headerRefreshing, setHeaderRefreshing] = useState(false)
  const statusRefreshHandlerRef = useRef<(() => Promise<void>) | null>(null)
  const reportUploadRefreshHandlerRef = useRef<(() => Promise<void>) | null>(null)
  const adUploadRefreshHandlerRef = useRef<(() => Promise<void>) | null>(null)

  const refreshActiveTab = useCallback(async () => {
    const refresh = activeTab === 'status'
      ? statusRefreshHandlerRef.current
      : uploadSubTab === 'report-upload'
        ? reportUploadRefreshHandlerRef.current
        : adUploadRefreshHandlerRef.current
    if (!refresh) return
    setHeaderRefreshing(true)
    try {
      await refresh()
    } finally {
      setHeaderRefreshing(false)
    }
  }, [activeTab, uploadSubTab])
  useHeaderRefresh(refreshActiveTab, { loading: headerRefreshing })

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      {/* Tab switcher（BLF-883 全局统一：variant="term" + 前置 icon） */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'upload' | 'status')} className="flex min-h-0 flex-col gap-3 overflow-hidden">
        <TabsList variant="term" className="w-fit justify-start">
          <TabsTrigger value="upload" variant="term">
            <Upload aria-hidden />
            文件上传
          </TabsTrigger>
          <TabsTrigger value="status" variant="term">
            <Activity aria-hidden />
            RPA 状态
          </TabsTrigger>
        </TabsList>

        {/* Tab content */}
        <TabsContent value="status" className="min-h-0 flex-1 space-y-0">
          <RpaStatusGrid
            country={country}
            onCountryChange={setCountry}
            refreshHandlerRef={statusRefreshHandlerRef}
          />
        </TabsContent>
        <TabsContent value="upload" className="min-h-0 flex-1 space-y-0 overflow-auto pb-2 sm:overflow-hidden">
          <Tabs value={uploadSubTab} onValueChange={(v) => setUploadSubTab(v as UploadEndpoint)} className="flex min-h-0 flex-col gap-3">
            <TabsList variant="term" className="w-fit justify-start">
              <TabsTrigger value="report-upload" variant="term">
                <FileSpreadsheet aria-hidden />
                通用报表
              </TabsTrigger>
              <TabsTrigger value="ad-upload" variant="term">
                <Megaphone aria-hidden />
                广告报表
              </TabsTrigger>
            </TabsList>
            <TabsContent value="report-upload" className="min-h-0 flex-1 space-y-0">
              <AutoUploadContent
                country={country as ReportUploadCountry}
                onCountryChange={setCountry}
                endpoint="report-upload"
                refreshHandlerRef={reportUploadRefreshHandlerRef}
              />
            </TabsContent>
            <TabsContent value="ad-upload" className="min-h-0 flex-1 space-y-0">
              <AutoUploadContent
                country={country as ReportUploadCountry}
                onCountryChange={setCountry}
                endpoint="ad-upload"
                refreshHandlerRef={adUploadRefreshHandlerRef}
              />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  )
}
