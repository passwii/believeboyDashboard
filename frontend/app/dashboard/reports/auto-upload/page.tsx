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
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
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
import styles from './auto-upload-warm.module.css'

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
    <div className={styles.progressRow}>
      <span className={styles.progressLabel}>{label}</span>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
      <span className={styles.progressValue}>
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
    <div className={styles.progressSummary}>
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
    <section
      className={styles.panel}
      role="region"
      aria-label="RPA 报表状态"
      data-warm-rpa-status="true"
    >
      <header className={styles.panelHeader}>
        <div className={styles.panelTitleGroup}>
          <span className={styles.panelIcon}>
            <LayoutDashboard aria-hidden />
          </span>
          <h2 className={styles.panelTitle}>RPA 报表状态</h2>
        </div>

        <div className={styles.statusControls}>
          <div className={styles.controlGroup}>
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) ensureProjects()
              }}
            >
              <DropdownMenuTrigger asChild>
                <WarmButton
                  variant="secondary"
                  className={cn(styles.control, styles.projectFilter)}
                >
                  {projectFilterLabel}
                </WarmButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={styles.dropdownContent}>
                <DropdownMenuLabel className={styles.dropdownLabel}>项目筛选</DropdownMenuLabel>
                <DropdownMenuSeparator className={styles.dropdownSeparator} />
                <button
                  type="button"
                  className={styles.dropdownAll}
                  onClick={() => setSelectedProjects([])}
                >
                  全部项目
                </button>
                <DropdownMenuSeparator className={styles.dropdownSeparator} />
                {projectsRequested.current && projectsLoading ? (
                  <div className={styles.dropdownStatus}>加载中…</div>
                ) : null}
                {projects.map((project) => (
                  <DropdownMenuCheckboxItem
                    key={project}
                    checked={selectedProjects.includes(project)}
                    className={styles.dropdownItem}
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
              <SelectTrigger
                className={cn(styles.control, styles.countrySelect)}
                aria-label="选择站点"
              >
                <SelectValue placeholder="选择站点" />
              </SelectTrigger>
              <SelectContent className={styles.selectContent}>
                {COUNTRY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className={styles.selectItem}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={styles.dateGroup}>
            <WarmIconButton
              aria-label="前一天"
              className={styles.iconButton}
              onClick={() => setStatusDate((v) => shiftDateString(v, -1))}
            >
              <ChevronLeft aria-hidden />
            </WarmIconButton>
            <SimpleDatePicker
              value={parseDateInputValue(statusDate)}
              onChange={(date) => setStatusDate(formatDateInputValue(date))}
              className={styles.datePicker}
            />
            <WarmIconButton
              aria-label="后一天"
              className={styles.iconButton}
              onClick={() => setStatusDate((v) => shiftDateString(v, 1))}
            >
              <ChevronRight aria-hidden />
            </WarmIconButton>
          </div>

          <div className={styles.actionGroup}>
            <WarmButton
              variant="secondary"
              className={styles.todayButton}
              onClick={() => setStatusDate(toLocalDateInputValue(undefined))}
            >
              今天
            </WarmButton>
            <WarmIconButton
              aria-label="刷新状态"
              className={styles.iconButton}
              onClick={() => void loadStatus()}
              loading={statusLoading}
              loadingLabel="正在刷新报表状态"
            >
              {statusLoading ? null : <Loader2 aria-hidden />}
            </WarmIconButton>
          </div>
        </div>
      </header>

      <div className={styles.panelBody}>
        {statusError ? (
          <p className={styles.errorBar} role="alert">
            {statusError}
          </p>
        ) : null}

        {showSkeleton ? (
          <div className={styles.statusSkeleton} aria-busy="true">
            <Skeleton className={styles.skeletonHeader} />
            <Skeleton className={styles.skeletonBody} />
          </div>
        ) : (
          <RefreshProgressBar refreshing={isRefreshing} className={styles.statusRefresh}>
            <div
              className={styles.statusScroller}
              data-testid="rpa-status-scroll"
              data-auto-upload-status-scroll="true"
            >
              <div
                className={styles.statusGrid}
                style={{ gridTemplateColumns: `160px repeat(${REPORT_TYPES.length}, 96px)` }}
              >
                <div className={cn(styles.statusHeaderCell, styles.statusCorner)}>
                  <span>项目</span>
                </div>
                {REPORT_TYPES.map((rt) => (
                  <div key={rt.key} className={styles.statusHeaderCell}>
                    <span>{rt.label}</span>
                  </div>
                ))}

                {filteredRows.length === 0 ? (
                  <div className={styles.statusEmpty}>
                    <p>{statusDate} 暂时没有可展示的报表状态</p>
                    <p>切换左右日期，或检查 RPA 是否已接入该日期的数据</p>
                  </div>
                ) : (
                  filteredRows.map((row) => (
                    <div
                      key={row.project_id}
                      className={styles.statusRow}
                      style={{ gridTemplateColumns: `160px repeat(${REPORT_TYPES.length}, 96px)` }}
                    >
                      <div className={styles.statusProjectCell}>
                        <span title={row.project_name}>{row.project_name}</span>
                      </div>
                      {REPORT_TYPES.map((rt) => {
                        const cell = row.statuses.find((s) => s.report_type === rt.key)
                        const isUploaded = cell?.is_uploaded ?? false
                        return (
                          <div
                            key={rt.key}
                            className={styles.statusDataCell}
                            role="img"
                            data-state={isUploaded ? 'uploaded' : 'missing'}
                            aria-label={`${row.project_name} ${rt.label}${isUploaded ? '已上传' : '未上传'}`}
                          >
                            {isUploaded ? (
                              <CheckCircle2 aria-hidden />
                            ) : (
                              <CircleX aria-hidden />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          </RefreshProgressBar>
        )}
      </div>
    </section>
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
    <div className="flex flex-1 flex-col gap-4" data-warm-upload-workspace="true">
      {/* Top controls：手机端 2 列网格（站点全宽一行 + 双按钮各半），sm+ 恢复横向 */}
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-3">
        <Select value={country} onValueChange={(v) => onCountryChange(v as ReportUploadCountry)}>
          <SelectTrigger
            className="col-span-2 h-10 w-full rounded-[var(--warm-ledger-radius-inner)] border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-window)] font-sans text-xs text-[color:var(--warm-ledger-color-text)] sm:col-span-1 sm:w-[150px]"
            aria-label="选择上传站点"
          >
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

        <WarmButton
          variant="primary"
          onClick={handleUploadAll}
          disabled={pendingCount === 0 || uploading}
          loading={uploading}
          loadingLabel="正在上传全部文件"
          className="flex-1 sm:flex-none"
        >
          {uploading ? null : <Upload aria-hidden />}
          {uploading ? '上传中...' : `上传全部 (${pendingCount})`}
        </WarmButton>

        <WarmButton
          variant="secondary"
          onClick={clearAll}
          disabled={queueItems.length === 0 || recognizing || uploading}
          className="flex-1 sm:flex-none"
        >
          清空列表
        </WarmButton>
      </div>

      {/* Dropzone + File list */}
      <div className="grid flex-1 gap-3 overflow-hidden lg:grid-cols-[1fr_2fr]">
        {/* Dropzone */}
        <Card className="overflow-hidden rounded-[var(--warm-ledger-radius-panel)] border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] shadow-none">
          <CardContent className="flex h-full !px-3 !py-3">
            <div
              className={cn(
                'relative flex w-full flex-col items-center justify-center rounded-[var(--warm-ledger-radius-inner)] border border-dashed px-4 transition-[border-color,background-color] duration-[var(--duration-quick)]',
                dragActive
                  ? 'border-[color:color-mix(in_srgb,var(--warm-ledger-color-accent)_70%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-accent)_10%,transparent)]'
                  : 'border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)]'
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
                <div className="flex h-11 w-11 items-center justify-center rounded-[var(--warm-ledger-radius-inner)] border border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] text-[color:var(--warm-ledger-color-text-muted)]">
                  <Upload className="h-5 w-5 text-[color:var(--warm-ledger-color-accent-strong)]" aria-hidden />
                </div>
                <div className="space-y-1">
                  <p className="font-sans text-xs font-semibold text-[color:var(--warm-ledger-color-text)] sm:text-sm">
                    拖拽文件到这里，或点击选择
                  </p>
                  <p className="font-sans text-[11px] text-[color:var(--warm-ledger-color-text-faint)]">
                    支持 .txt / .csv / .xlsx
                  </p>
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
        <Card className="flex flex-col overflow-hidden rounded-[var(--warm-ledger-radius-panel)] border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] shadow-none">
          <CardHeader className="rounded-[var(--warm-ledger-radius-inner)] border-b border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-3 pb-2.5 pt-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="font-sans text-xs font-semibold uppercase tracking-wider text-[color:var(--warm-ledger-color-text-muted)]">
                  本次识别文件
                </CardTitle>
                <CardDescription className="font-mono text-[11px] tabular-nums text-[color:var(--warm-ledger-color-text-faint)]">
                  {queueItems.length} 个文件
                </CardDescription>
              </div>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin text-[color:var(--warm-ledger-color-accent-strong)]" aria-hidden /> : null}
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
                  <div className="rounded-[var(--warm-ledger-radius-inner)] border border-dashed border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-4 py-8 text-center font-sans text-xs text-[color:var(--warm-ledger-color-text-faint)]">
                    暂无文件
                  </div>
                ) : null}
                {queueItems.map((item) => (
                  <div
                    key={item.localId}
                    className={cn(
                      'relative flex items-start justify-between gap-3 rounded-[var(--warm-ledger-radius-inner)] border border-[color:var(--warm-ledger-color-hairline)] bg-[color-mix(in_srgb,var(--warm-ledger-color-panel-strong)_85%,transparent)] px-3 py-2.5 transition-colors duration-[var(--duration-quick)]',
                      // 上传成功：整条 pos 覆盖
                      item.fileCommitStatus === 'success' && 'border-[color:color-mix(in_srgb,var(--warm-ledger-color-positive)_50%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-positive)_10%,transparent)]',
                      // 保存中：accent
                      item.fileCommitStatus === 'saving' && 'border-[color:color-mix(in_srgb,var(--warm-ledger-color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-accent)_10%,transparent)]',
                      // 识别错误：neg
                      item.recognitionStatus === 'error' && 'border-[color:color-mix(in_srgb,var(--warm-ledger-color-negative)_40%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-negative)_10%,transparent)]'
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
                          <span className="font-medium tabular-nums text-[color:var(--warm-ledger-color-positive)]">
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
                              <span className="font-medium text-[color:var(--warm-ledger-color-accent-strong)]">
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
                              <span className="font-sans text-xs text-[color:var(--warm-ledger-color-accent)]">
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
                                <SelectTrigger className="h-6 w-[140px] rounded-[var(--warm-ledger-radius-inner)] border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-window)] px-1.5 py-0.5 font-sans text-xs">
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
                                      className="-my-1 ml-1 rounded-[var(--warm-ledger-radius-inner)] px-1.5 py-1 font-sans text-[11px] text-[color:var(--warm-ledger-color-accent-strong)] hover:bg-[color-mix(in_srgb,var(--warm-ledger-color-accent)_10%,transparent)]"
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
                                      className="-my-1 ml-1 rounded-[var(--warm-ledger-radius-inner)] px-1.5 py-1 font-sans text-[11px] text-[color:var(--warm-ledger-color-accent-strong)] hover:bg-[color-mix(in_srgb,var(--warm-ledger-color-accent)_10%,transparent)]"
                                    >
                                      {item.userReportDate ? '取消' : '编辑'}
                                    </button>
                                  </>
                                )}
                              </p>
                              {item.reportType === 'payment_report' &&
                              item.userReportStartDate !== null ? (
                                <div className="flex items-center gap-1.5 pt-0.5">
                                  <span className="font-sans text-[11px] text-[color:var(--warm-ledger-color-accent)]">起：</span>
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
                                  <span className="font-sans text-[11px] text-[color:var(--warm-ledger-color-accent)]">止：</span>
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
                                  <span className="font-sans text-[11px] text-[color:var(--warm-ledger-color-accent)]">日期：</span>
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
                              <span className="font-sans text-xs text-[color:var(--warm-ledger-color-accent)]">
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
                            <p className="font-sans text-xs text-[color:var(--warm-ledger-color-negative)]">{item.error}</p>
                          ) : null}
                          {item.commitError ? (
                            <p className="font-sans text-xs text-[color:var(--warm-ledger-color-negative)]">
                              {item.commitError}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {item.fileCommitStatus === 'saving' ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[color:var(--warm-ledger-color-accent-strong)]" aria-hidden />
                      ) : null}
                      {item.fileCommitStatus === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 text-[color:var(--warm-ledger-color-positive)]" aria-hidden />
                      ) : null}
                      {item.fileCommitStatus === 'error' ? (
                        <CircleX className="h-4 w-4 text-[color:var(--warm-ledger-color-negative)]" aria-hidden />
                      ) : null}
                      <WarmIconButton
                        onClick={() => removeItem(item.localId)}
                        aria-label={`移除 ${item.originalFileName}`}
                        className="h-9 w-9 shrink-0"
                      >
                        <CircleX className="h-4 w-4" aria-hidden />
                      </WarmIconButton>
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
    <div
      className={cn(styles.page, 'flex h-full min-h-0 flex-col overflow-hidden')}
      data-warm-auto-upload="true"
    >
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'upload' | 'status')}
        className={styles.tabs}
      >
        <TabsList className={styles.tabList} data-warm-tablist="true">
          <TabsTrigger value="upload" className={styles.tab}>
            <Upload aria-hidden />
            文件上传
          </TabsTrigger>
          <TabsTrigger value="status" className={styles.tab}>
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
            <TabsList className={styles.tabList}>
              <TabsTrigger value="report-upload" className={styles.tab}>
                <FileSpreadsheet aria-hidden />
                通用报表
              </TabsTrigger>
              <TabsTrigger value="ad-upload" className={styles.tab}>
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
