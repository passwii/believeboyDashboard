'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  AlertCircle,
  DatabaseZap,
  Download,
  FileSearch,
  Loader2,
  Sparkles,
  Upload,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

type RecognizedFileType =
  | 'sales_report'
  | 'inventory_report'
  | 'ad_report'
  | 'payment_report'
  | 'monthly_summary_pdf'
  | 'unknown'
import {
  formatMonthInputValue,
  parseMonthInputValue,
} from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { pickSessionDisplayName } from '@/lib/auth/display-name'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useSharedReportProject } from '../shared-project'
import {
  DEFAULT_REPORT_UPLOAD_COUNTRY,
  type ReportUploadCountry,
} from '@/components/report-upload/types'
import { MonthNavigation } from '@/components/dashboard/console'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import {
  HeaderSlotSelect,
  TERM_HEADER_TRIGGER,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
} from '@/components/terminal/header-filter-suite'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import styles from './generate-warm.module.css'

type UploadType = 'payment_report' | 'monthly_summary_pdf'
type AssignedType = UploadType | 'skip'
type UploadStatus = 'empty' | 'ready' | 'uploading' | 'success' | 'error'

type ProjectOption = { id?: number | null; name: string }
type CountryOption = ReportUploadCountry

const GENERATE_COUNTRY_SLOT_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

type MappingRow = {
  id: string
  file: File
  detectedType: RecognizedFileType
  detectedReason: string
  assignedType: AssignedType
  matchFailed: boolean
}

type UploadFileMeta = {
  filename: string
  originalFilename: string
}

type UploadStateItem = {
  status: UploadStatus
  mappedRowId: string | null
  selectedFile: File | null
  error: string | null
  uploaded: UploadFileMeta | null
}

type SubmitState = {
  status: 'idle' | 'submitting' | 'success' | 'error'
  message: string | null
  filename: string | null
}

type JobProgress = {
  stage: string
  progress: number
  message: string
}

type DownloadTarget = {
  endpoint: string | null
  filenameHint: string | null
  downloading: boolean
}

type PersistenceSyncState = {
  status: 'idle' | 'running' | 'success' | 'failed'
  message: string | null
}

const API_BASE = '/api/backend'
const UPLOAD_TYPES: UploadType[] = ['payment_report', 'monthly_summary_pdf']
const REQUIRED_TYPES: UploadType[] = ['payment_report']
const JOB_POLL_INTERVAL_MS = 1000
const JOB_POLL_MAX_WAIT_MS = 5 * 60 * 1000

const TYPE_LABEL: Record<UploadType, string> = {
  payment_report: '交易明细 CSV',
  monthly_summary_pdf: '月度总结 PDF',
}
const PROGRESS_STEP_LABELS = [
  '处理中',
  '合成数据（报表总览）',
  '合成数据（报表核算/明细）',
  '处理表格样式',
  '完成',
]

function authHeaders(_operator?: string, _isAdmin = false): Record<string, string> {
  return {}
}

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

function currentMonthString() {
  const now = new Date()
  now.setDate(1)
  now.setMonth(now.getMonth() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function shiftMonth(value: string, delta: number) {
  const [yearStr, monthStr] = value.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return value
  const next = new Date(year, month - 1, 1)
  next.setMonth(next.getMonth() + delta)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`
}

function extractFilenameFromHeader(contentDisposition: string | null) {
  if (!contentDisposition) return null
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1])
  const basicMatch = contentDisposition.match(/filename="?([^"]+)"?/i)
  return basicMatch?.[1] ?? null
}

function isUploadType(value: string): value is UploadType {
  return value === 'payment_report' || value === 'monthly_summary_pdf'
}

function createEmptyUploadState(): Record<UploadType, UploadStateItem> {
  return {
    payment_report: {
      status: 'empty',
      mappedRowId: null,
      selectedFile: null,
      error: null,
      uploaded: null,
    },
    monthly_summary_pdf: {
      status: 'empty',
      mappedRowId: null,
      selectedFile: null,
      error: null,
      uploaded: null,
    },
  }
}

function getAssignedRow(rows: MappingRow[], type: UploadType): MappingRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].assignedType === type) return rows[i]
  }
  return null
}

function recognizeMonthlyFileByExtension(file: File): { type: RecognizedFileType; reason: string } {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.csv')) return { type: 'payment_report', reason: '按后缀识别为 csv' }
  if (lowerName.endsWith('.pdf')) return { type: 'monthly_summary_pdf', reason: '按后缀识别为 pdf' }
  return { type: 'unknown', reason: '仅支持 .csv 或 .pdf' }
}

function validateFile(type: UploadType, file: File): string | null {
  if (type === 'payment_report') {
    if (!file.name.toLowerCase().endsWith('.csv')) return '交易文件仅支持 .csv'
    return null
  }

  if (!file.name.toLowerCase().endsWith('.pdf')) return '总结文件仅支持 .pdf'
  return null
}

function getUploadMeta(state: UploadStateItem) {
  if (state.status === 'success')
    return { text: '已上传', tone: 'positive' as const }
  if (state.status === 'uploading')
    return { text: '上传中', tone: 'accent' as const }
  if (state.status === 'error') return { text: '上传失败', tone: 'negative' as const }
  if (state.status === 'ready') return { text: '待上传', tone: 'accent' as const }
  return {
    text: '未识别',
    tone: 'neutral' as const,
  }
}

function normalizeProgress(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function parseProgressLog(logExcerpt?: string | null): JobProgress | null {
  if (!logExcerpt || !logExcerpt.trim()) return null
  try {
    const parsed = JSON.parse(logExcerpt) as {
      stage?: unknown
      progress?: unknown
      message?: unknown
    }
    if (typeof parsed.stage !== 'string' || typeof parsed.message !== 'string') return null
    const numericProgress = typeof parsed.progress === 'number' ? parsed.progress : 0
    return {
      stage: parsed.stage,
      progress: normalizeProgress(numericProgress),
      message: parsed.message,
    }
  } catch {
    return {
      stage: 'processing',
      progress: 0,
      message: logExcerpt.trim(),
    }
  }
}

function fallbackProgressByStatus(
  status: 'pending' | 'running' | 'success' | 'failed'
): JobProgress {
  if (status === 'pending') return { stage: 'started', progress: 2, message: '处理中：任务排队中' }
  if (status === 'running')
    return { stage: 'processing', progress: 10, message: '处理中：任务执行中' }
  if (status === 'success')
    return { stage: 'completed', progress: 100, message: '处理完成：报表已生成，可下载' }
  return { stage: 'failed', progress: 100, message: '处理失败' }
}

function resolveProgressStepIndex(stage?: string | null): number {
  if (!stage) return 0
  if (stage === 'completed') return 4
  if (stage === 'building_overview') return 1
  if (stage === 'building_accounting' || stage === 'writing_detail_sheets') return 2
  if (stage === 'styling_workbook' || stage === 'saving_workbook' || stage === 'persisting_results')
    return 3
  return 0
}

function normalizePersistenceStatus(value: unknown): PersistenceSyncState['status'] {
  if (value === 'running' || value === 'success' || value === 'failed') return value
  return 'idle'
}

export default function GenerateTab() {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  // BLF-1441：操作人只取 user_accounts.full_name（无姓名时为空，
  // 不回落运营名 / 登录名 / 邮箱）。规则见 lib/auth/display-name.ts。
  const currentOperator = pickSessionDisplayName(session?.user) ?? ''

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  // 月报上传页面：项目名 / 国家 / 上报月份 同步到 URL search param，
  // 刷新、分享链接、浏览器后退都能记住选择（用户经常复制同一份月报链接给同事填）。
  // 默认月份用 useMemo 锁定（保持与原 useState 一致的"挂载时一次性快照"语义）。
  const defaultReportMonth = useMemo(() => currentMonthString(), [])
  const [projectName, setProjectName] = useUrlParam<string>('project', '')
  // BLF-1344：月报三个 tab 共享一个「当前项目」（共享记忆里存项目 id）。本页面向 URL 和
  // 接口历来都用项目名称，所以这里做一层 id ↔ 名称适配，共享记忆仍以 id 为准。
  const projectIdFromName = useMemo(
    () => projects.find((project) => project.name === projectName)?.id ?? null,
    [projects, projectName]
  )
  const selectProjectById = useCallback(
    (id: string) => {
      const target = projects.find((project) => String(project.id) === id)
      if (target) setProjectName(target.name)
    },
    [projects, setProjectName]
  )
  useSharedReportProject({
    projectId: projectIdFromName === null ? '' : String(projectIdFromName),
    setProjectId: selectProjectById,
  })
  const [country, setCountry] = useUrlParam<CountryOption>(
    'country',
    DEFAULT_REPORT_UPLOAD_COUNTRY,
    {
      allowed: ['US', 'DE', 'UK'],
    }
  )
  const [reportMonth, setReportMonth] = useUrlParam<string>('month', defaultReportMonth)
  const [formError, setFormError] = useState<string | null>(null)

  const [mappingRows, setMappingRows] = useState<MappingRow[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [mappingBusy, setMappingBusy] = useState(false)

  const [uploadState, setUploadState] =
    useState<Record<UploadType, UploadStateItem>>(createEmptyUploadState)
  const [uploadBusy, setUploadBusy] = useState(false)

  const [submitState, setSubmitState] = useState<SubmitState>({
    status: 'idle',
    message: null,
    filename: null,
  })
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null)
  const [persistenceSync, setPersistenceSync] = useState<PersistenceSyncState>({
    status: 'idle',
    message: null,
  })
  const [downloadTarget, setDownloadTarget] = useState<DownloadTarget>({
    endpoint: null,
    filenameHint: null,
    downloading: false,
  })
  const latestTaskIdRef = useRef<number | null>(null)

  const handleShiftReportMonth = (delta: number) => {
    setReportMonth(shiftMonth(reportMonth, delta))
  }

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const raw =
          await fetchManagedProjectsCached<Array<{ id?: number | null; name?: string }>>(session)
        const data = raw
          .filter((item) => typeof item.name === 'string' && item.name.trim().length > 0)
          .map((item) => ({
            id: typeof item.id === 'number' && item.id > 0 ? item.id : null,
            name: item.name as string,
          }))
        setProjects(data)
      } catch (error) {
        setProjectLoadError(normalizeErrorMessage(error, '项目列表加载失败'))
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  useEffect(() => {
    setUploadState((prev) => {
      const next = { ...prev }
      UPLOAD_TYPES.forEach((type) => {
        const assigned = getAssignedRow(mappingRows, type)
        const previous = prev[type]

        if (!assigned) {
          next[type] = {
            status: 'empty',
            mappedRowId: null,
            selectedFile: null,
            error: null,
            uploaded: null,
          }
          return
        }

        if (
          previous.mappedRowId === assigned.id &&
          (previous.status === 'success' || previous.status === 'uploading')
        ) {
          next[type] = previous
          return
        }

        next[type] = {
          status: 'ready',
          mappedRowId: assigned.id,
          selectedFile: assigned.file,
          error: null,
          uploaded: null,
        }
      })
      return next
    })
  }, [mappingRows])

  const recognizedCount = useMemo(
    () => UPLOAD_TYPES.filter((type) => uploadState[type].status !== 'empty').length,
    [uploadState]
  )

  const uploadedCount = useMemo(
    () => UPLOAD_TYPES.filter((type) => uploadState[type].status === 'success').length,
    [uploadState]
  )

  const manualMatchRows = useMemo(
    () => mappingRows.filter((row) => row.matchFailed && row.assignedType === 'skip'),
    [mappingRows]
  )

  const dropZoneHeight = Math.min(
    380,
    190 + Math.max(2, manualMatchRows.length + UPLOAD_TYPES.length) * 30
  )

  const canGenerate =
    projectName.trim().length > 0 &&
    reportMonth.length > 0 &&
    REQUIRED_TYPES.every((type) => uploadState[type].status === 'success') &&
    submitState.status !== 'submitting'
  const currentProgressStep = useMemo(
    () => resolveProgressStepIndex(jobProgress?.stage),
    [jobProgress?.stage]
  )
  const hasProgressState = submitState.status !== 'idle' || jobProgress !== null

  const generationMeta = useMemo(() => {
    if (submitState.status === 'success') return { label: '已完成', tone: 'positive' }
    if (submitState.status === 'submitting') return { label: '进行中', tone: 'accent' }
    if (submitState.status === 'error') return { label: '异常', tone: 'negative' }
    return { label: '未开始', tone: 'neutral' }
  }, [submitState.status])

  const syncMeta = useMemo(() => {
    if (persistenceSync.status === 'success') return { label: '已同步', tone: 'positive' }
    if (persistenceSync.status === 'running') return { label: '同步中', tone: 'accent' }
    if (persistenceSync.status === 'failed') return { label: '失败', tone: 'warning' }
    return { label: '待同步', tone: 'neutral' }
  }, [persistenceSync.status])

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    setFormError(null)
    setMappingBusy(true)

    const detectedRows = files.map((file) => ({ file, ...recognizeMonthlyFileByExtension(file) }))

    setMappingRows((prev) => {
      const next = [...prev]

      detectedRows.forEach(({ file, type, reason }) => {
        const row: MappingRow = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          file,
          detectedType: type,
          detectedReason: reason,
          assignedType: isUploadType(type) ? type : 'skip',
          matchFailed: !isUploadType(type),
        }

        if (isUploadType(row.assignedType)) {
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].assignedType === row.assignedType) {
              next[i] = { ...next[i], assignedType: 'skip', matchFailed: false }
              break
            }
          }
        }

        next.push(row)
      })

      return next
    })

    setMappingBusy(false)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    await addFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const changeAssignedType = (rowId: string, value: AssignedType) => {
    setMappingRows((prev) => {
      const updated: MappingRow[] = prev.map((row) => {
        if (row.id !== rowId) return row
        return { ...row, assignedType: value, matchFailed: false }
      })

      if (value === 'skip') return updated

      return updated.map((row) => {
        if (row.id === rowId) return row
        if (row.assignedType === value) return { ...row, assignedType: 'skip', matchFailed: false }
        return row
      })
    })
  }

  const uploadType = async (type: UploadType) => {
    if (!projectName.trim()) {
      setFormError('请先填写项目名称，再执行上传。')
      return
    }

    const target = uploadState[type]
    if (!target.selectedFile) {
      setUploadState((prev) => ({
        ...prev,
        [type]: { ...prev[type], status: 'error', error: '缺少已确认文件，请先匹配。' },
      }))
      return
    }

    const validationError = validateFile(type, target.selectedFile)
    if (validationError) {
      setUploadState((prev) => ({
        ...prev,
        [type]: { ...prev[type], status: 'error', error: validationError },
      }))
      return
    }

    setUploadState((prev) => ({
      ...prev,
      [type]: { ...prev[type], status: 'uploading', error: null, uploaded: null },
    }))

    const formData = new FormData()
    formData.append('file', target.selectedFile)
    formData.append('project_name', projectName.trim())
    formData.append('file_type', type)
    formData.append('country', country)

    try {
      const response = await fetch(`${API_BASE}/api/v1/uploads`, {
        method: 'POST',
        body: formData,
        headers: authHeaders(currentOperator),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '上传失败')
      }

      const payload = (await response.json()) as {
        filename?: string
        original_filename?: string
      }

      if (!payload.filename || !payload.original_filename) {
        throw new Error('上传成功但返回字段不完整')
      }

      setUploadState((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: 'success',
          error: null,
          uploaded: { filename: payload.filename, originalFilename: payload.original_filename },
        },
      }))
    } catch (error) {
      setUploadState((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: 'error',
          error: error instanceof Error ? error.message : '上传失败',
          uploaded: null,
        },
      }))
    }
  }

  const uploadAllConfirmed = async () => {
    if (uploadBusy) return
    setUploadBusy(true)
    for (const type of UPLOAD_TYPES) {
      const state = uploadState[type]
      if (state.status === 'ready' || state.status === 'error') {
        // eslint-disable-next-line no-await-in-loop
        await uploadType(type)
      }
    }
    setUploadBusy(false)
  }

  const generateReport = async () => {
    setFormError(null)
    setSubmitState({ status: 'idle', message: null, filename: null })
    setJobProgress(null)
    setPersistenceSync({ status: 'idle', message: null })
    latestTaskIdRef.current = null

    if (!projectName.trim()) {
      setFormError('项目名称不能为空')
      return
    }
    if (!reportMonth) {
      setFormError('请选择报表月份')
      return
    }
    if (!REQUIRED_TYPES.every((type) => uploadState[type].status === 'success')) {
      setFormError('请先完成交易 CSV 上传')
      return
    }

    const transactionFileId = uploadState.payment_report.uploaded?.filename
    const summaryPdfFileId = uploadState.monthly_summary_pdf.uploaded?.filename
    const selectedProject = projects.find((project) => project.name === projectName)
    const projectId = selectedProject?.id ?? null

    if (!transactionFileId) {
      setFormError('上传结果异常，请重新上传文件')
      return
    }

    setSubmitState({ status: 'submitting', message: '处理中：正在提交任务...', filename: null })
    setJobProgress({ stage: 'started', progress: 1, message: '处理中：正在提交任务...' })

    try {
      const createResponse = await fetch(`${API_BASE}/api/v1/monthly-reports`, {
        method: 'POST',
        headers: {
          ...authHeaders(currentOperator),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_id: projectId,
          project_name: projectName.trim(),
          country,
          report_month: reportMonth,
          transaction_file_id: transactionFileId,
          summary_pdf_file_id: summaryPdfFileId || undefined,
        }),
      })

      if (!createResponse.ok) {
        const message = await createResponse.text()
        throw new Error(message || '创建任务失败')
      }

      const created = (await createResponse.json()) as {
        job_id: number
        status_endpoint?: string
        result_endpoint?: string
        status?: 'pending' | 'running' | 'success' | 'failed'
      }
      const jobId = created.job_id
      latestTaskIdRef.current = jobId
      const statusEndpoint =
        created.status_endpoint?.trim() || `/api/v1/monthly-reports/tasks/${jobId}`
      const resultEndpoint =
        created.result_endpoint?.trim() || `/api/v1/monthly-reports/tasks/${jobId}/result`

      const pollStartedAt = Date.now()
      let finished = created.status === 'success'
      let failedMessage: string | null = null
      let lastStatus: 'pending' | 'running' | 'success' | 'failed' | null = created.status ?? null
      let lastStatusChangeTime = Date.now()
      const MIN_STATUS_DISPLAY_MS = 1000 // 每个状态最少显示1秒

      while (!finished && Date.now() - pollStartedAt <= JOB_POLL_MAX_WAIT_MS) {
        // eslint-disable-next-line no-await-in-loop
        const statusResponse = await fetch(resolveApiUrl(statusEndpoint), {
          cache: 'no-store',
          headers: authHeaders(currentOperator),
        })
        if (!statusResponse.ok) {
          // eslint-disable-next-line no-await-in-loop
          const message = await statusResponse.text()
          throw new Error(message || '状态查询失败')
        }

        // eslint-disable-next-line no-await-in-loop
        const statusPayload = (await statusResponse.json()) as {
          status: 'pending' | 'running' | 'success' | 'failed'
          stage?: string
          progress?: number
          message?: string | null
          error_message?: string | null
          persistence_status?: string
          persistence_message?: string | null
          runs?: Array<{ error_message?: string | null; log_excerpt?: string | null }>
        }
        if (latestTaskIdRef.current !== jobId) break

        // 如果状态发生变化，确保上一个状态至少显示1秒
        if (statusPayload.status !== lastStatus) {
          const timeSinceLastChange = Date.now() - lastStatusChangeTime
          const remainingDelay = MIN_STATUS_DISPLAY_MS - timeSinceLastChange
          if (remainingDelay > 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, remainingDelay))
          }
          lastStatus = statusPayload.status
          lastStatusChangeTime = Date.now()
        }

        const latestRun = statusPayload.runs?.[statusPayload.runs.length - 1]
        const directProgress =
          typeof statusPayload.stage === 'string'
            ? {
                stage: statusPayload.stage,
                progress: normalizeProgress(
                  typeof statusPayload.progress === 'number' ? statusPayload.progress : 0
                ),
                message:
                  (statusPayload.message || '').trim() ||
                  fallbackProgressByStatus(statusPayload.status).message,
              }
            : null
        const currentProgress =
          directProgress ??
          parseProgressLog(latestRun?.log_excerpt) ??
          fallbackProgressByStatus(statusPayload.status)
        setJobProgress(currentProgress)
        const persistenceStatus = normalizePersistenceStatus(statusPayload.persistence_status)
        if (persistenceStatus !== 'idle') {
          setPersistenceSync({
            status: persistenceStatus,
            message: statusPayload.persistence_message?.trim() || null,
          })
        }

        if (statusPayload.status === 'failed') {
          failedMessage =
            statusPayload.error_message ??
            latestRun?.error_message ??
            currentProgress.message ??
            '任务失败'
          finished = true
          break
        }

        if (statusPayload.status === 'success') {
          setSubmitState({ status: 'submitting', message: currentProgress.message, filename: null })
          finished = true
          break
        }

        setSubmitState({ status: 'submitting', message: currentProgress.message, filename: null })

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS))
      }

      if (failedMessage) throw new Error(failedMessage)
      if (!finished) throw new Error('任务超时，请稍后重试')

      const fallbackName = `${projectName.trim()}_Monthly_Report_${reportMonth}.xlsx`
      setDownloadTarget({
        endpoint: resultEndpoint,
        filenameHint: fallbackName,
        downloading: false,
      })

      const pollPersistenceStatus = async () => {
        const startedAt = Date.now()
        while (Date.now() - startedAt <= JOB_POLL_MAX_WAIT_MS) {
          if (latestTaskIdRef.current !== jobId) break
          const resp = await fetch(resolveApiUrl(statusEndpoint), {
            cache: 'no-store',
            headers: authHeaders(currentOperator),
          })
          if (!resp.ok) break
          const payload = (await resp.json()) as {
            persistence_status?: string
            persistence_message?: string | null
          }
          const status = normalizePersistenceStatus(payload.persistence_status)
          if (status !== 'idle') {
            setPersistenceSync({
              status,
              message: payload.persistence_message?.trim() || null,
            })
          }
          if (status === 'success' || status === 'failed') break
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }

      // 默认不自动下载，由用户点击"下载报表"按钮触发
      setJobProgress({ stage: 'completed', progress: 100, message: '处理完成：报表已生成，可下载' })
      setSubmitState({
        status: 'success',
        message: '生成成功，可点击"下载报表"按钮下载',
        filename: fallbackName,
      })
      void pollPersistenceStatus()
    } catch (error) {
      setJobProgress((prev) => prev ?? { stage: 'failed', progress: 100, message: '处理失败' })
      setSubmitState({
        status: 'error',
        message: `生成失败：${error instanceof Error ? error.message : '未知错误'}`,
        filename: null,
      })
    }
  }

  const retryDownload = async () => {
    if (!downloadTarget.endpoint || downloadTarget.downloading) return
    setDownloadTarget((prev) => ({ ...prev, downloading: true }))

    try {
      const fallbackName =
        downloadTarget.filenameHint || `${projectName.trim()}_Monthly_Report_${reportMonth}.xlsx`
      const filename = await downloadByEndpoint(
        downloadTarget.endpoint,
        fallbackName,
        currentOperator
      )
      setSubmitState({ status: 'success', message: `下载成功：${filename}`, filename })
      setDownloadTarget((prev) => ({ ...prev, filenameHint: filename, downloading: false }))
    } catch (error) {
      setSubmitState({
        status: 'error',
        message: `下载失败：${error instanceof Error ? error.message : '未知错误'}`,
        filename: downloadTarget.filenameHint,
      })

      setDownloadTarget((prev) => ({ ...prev, downloading: false }))
    }
  }

  // —— BLF-963 · head 插槽（复用 BLF-962 display 试点模式）——
  // 本页无刷新语义（上传 / 生成流程），不注册 useHeaderRefresh。
  // 桌面端：项目 / 国家 / 账期月份三个控件 portal 进 Top Header 中段。
  // 项目沿用页面原生选项集（按名称 value）；国家沿用 US/DE/UK 三站集合
  //（与旧 CountrySelect 默认 options 一致）；账期月份保留前后月切换语义
  //（handleShiftReportMonth），在插槽内用紧凑 MonthNavigation 变体呈现。
  const projectSlotOptions = projects.map((project) => ({
    value: project.name,
    label: project.name,
  }))
  const reportMonthDate = parseMonthInputValue(reportMonth)
  const headerFilterControls = (
    <>
      <HeaderSlotSelect
        value={projectName}
        onChange={setProjectName}
        options={projectSlotOptions}
        placeholder={projectsLoading ? '项目加载中…' : '请选择项目名称'}
        disabled={projectsLoading || projects.length === 0}
        widthClass={TERM_HEADER_W_MD}
        title="项目筛选"
      />
      <HeaderSlotSelect
        value={country}
        onChange={(value) => setCountry(value as CountryOption)}
        options={[...GENERATE_COUNTRY_SLOT_OPTIONS]}
        widthClass={TERM_HEADER_W_SM}
        title="国家站点筛选"
      />
      <MonthNavigation
        value={reportMonthDate}
        onChange={(date) => setReportMonth(formatMonthInputValue(date))}
        onPrev={() => handleShiftReportMonth(-1)}
        onNext={() => handleShiftReportMonth(1)}
        showCurrentMonth={false}
        monthLabel=""
        className={cn(
          TERM_HEADER_TRIGGER,
          TERM_HEADER_W_MD,
          '[&>button]:h-8 [&>button]:w-8 [&_span]:text-xs'
        )}
      />
    </>
  )
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={headerFilterControls} />
  )

  // 移动端：筛选控件下迁为正文顶部可折叠筛选条（短控件 1/2，月份占整行）。
  const mobileProjectLabel = projectName || '选择项目'
  const mobileCountryLabel =
    GENERATE_COUNTRY_SLOT_OPTIONS.find((opt) => opt.value === country)?.label ?? country
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${reportMonth || '——'}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <HeaderSlotSelect
            value={projectName}
            onChange={setProjectName}
            options={projectSlotOptions}
            placeholder={projectsLoading ? '项目加载中…' : '请选择项目名称'}
            disabled={projectsLoading || projects.length === 0}
            widthClass={TERM_HEADER_W_MD}
            title="项目筛选"
          />
          <HeaderSlotSelect
            value={country}
            onChange={(value) => setCountry(value as CountryOption)}
            options={[...GENERATE_COUNTRY_SLOT_OPTIONS]}
            widthClass={TERM_HEADER_W_SM}
            title="国家站点筛选"
          />
          <MobileFilterWide>
            <MonthNavigation
              value={reportMonthDate}
              onChange={(date) => setReportMonth(formatMonthInputValue(date))}
              onPrev={() => handleShiftReportMonth(-1)}
              onNext={() => handleShiftReportMonth(1)}
              showCurrentMonth={false}
              monthLabel=""
              className="h-10 w-full"
            />
          </MobileFilterWide>
        </>
      }
    />
  )

  return (
    <div className={styles.page} data-warm-monthly-generate="true">
      {headerSlotPortal}
      {/* 移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}
      <div className={styles.main}>
        <section
          className={styles.panel}
          role="region"
          aria-label="控制台"
          data-warm-surface="true"
        >
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>控制台</h2>
          </div>
          <div className={styles.panelBody}>
            {!projectsLoading && !projectLoadError && projects.length === 0 ? (
              <p className={styles.mutedText}>暂无项目，请先到项目信息页面新增。</p>
            ) : null}
            {projectLoadError ? (
              <p className={styles.errorText}>{projectLoadError}</p>
            ) : null}

            <div className={styles.metricGrid}>
              <div className={styles.metric} data-warm-metric="true">
                <p className={styles.metricLabel}>识别</p>
                <p className={styles.metricValue}>
                  {recognizedCount}/{UPLOAD_TYPES.length}
                </p>
              </div>
              <div className={styles.metric} data-warm-metric="true">
                <p className={styles.metricLabel}>上传</p>
                <p className={styles.metricValue}>
                  {uploadedCount}/{UPLOAD_TYPES.length}
                </p>
              </div>
              <div className={styles.metric} data-warm-metric="true">
                <p className={styles.metricLabel}>表格生成</p>
                <p className={styles.metricValue} data-tone={generationMeta.tone}>
                  {generationMeta.label}
                </p>
              </div>
              <div className={styles.metric} data-warm-metric="true">
                <p className={styles.metricLabel}>数据同步</p>
                <p className={styles.metricValue} data-tone={syncMeta.tone}>
                  {syncMeta.label}
                </p>
              </div>
            </div>

            {formError ? (
              <p className={styles.alert}>{formError}</p>
            ) : null}
          </div>
        </section>

        <section
          className={styles.panel}
          role="region"
          aria-label="文件识别与上传"
          data-warm-surface="true"
        >
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>文件识别与上传</h2>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.uploadLayout}>
              <div
                className={cn(
                  styles.dropZone,
                  dragActive && styles.dropZoneActive
                )}
                data-active={dragActive ? 'true' : undefined}
                style={{ minHeight: `${dropZoneHeight}px` }}
                onDrop={(event) => void onDrop(event)}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragActive(true)
                }}
                onDragLeave={(event) => {
                  event.preventDefault()
                  setDragActive(false)
                }}
              >
                <p className={styles.dropTitle}>拖拽文件到这里</p>
                <p className={styles.dropHint}>支持 csv/pdf 批量识别</p>

                <div className={styles.dropActions}>
                  <WarmButton
                    type="button"
                    variant="secondary"
                    className={styles.fullWidth}
                    onClick={() => document.getElementById('monthly-file-picker')?.click()}
                  >
                    <FileSearch className="mr-1 h-4 w-4" />
                    选择多个文件
                  </WarmButton>
                  <Input
                    id="monthly-file-picker"
                    type="file"
                    multiple
                    accept=".csv,.pdf"
                    className="hidden"
                    onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
                  />
                  <WarmButton
                    type="button"
                    variant="primary"
                    className={styles.fullWidth}
                    onClick={() => void uploadAllConfirmed()}
                    disabled={uploadBusy || mappingBusy || !projectName.trim()}
                  >
                    {uploadBusy ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-1 h-4 w-4" />
                    )}
                    一键上传已匹配文件
                  </WarmButton>
                </div>
              </div>

              <div className={styles.uploadList}>
                {UPLOAD_TYPES.map((type) => {
                  const state = uploadState[type]
                  const meta = getUploadMeta(state)
                  const matched = state.status !== 'empty'
                  return (
                    <div
                      key={type}
                      className={styles.uploadCard}
                      data-tone={meta.tone}
                    >
                      <div className={styles.uploadCardHeader}>
                        <div className={styles.statusLabel}>
                          <span className={styles.statusDot} />
                          <p className={styles.uploadCardTitle}>{TYPE_LABEL[type]}</p>
                        </div>
                        <span className={styles.statusText}>{meta.text}</span>
                      </div>

                      <div className={styles.progressTrack}>
                        <div
                          className={styles.progressFill}
                          data-complete={matched ? 'true' : 'false'}
                          style={{ width: matched ? '100%' : '28%' }}
                        />
                      </div>

                      <div className={styles.uploadCardFooter}>
                        <div className={styles.fileNameWrap}>
                          <p className={styles.fileName}>
                            {state.selectedFile?.name ?? '等待识别或手动匹配'}
                          </p>
                          {state.error ? (
                            <p className={styles.errorText}>{state.error}</p>
                          ) : null}
                        </div>
                        <WarmButton
                          type="button"
                          variant="secondary"
                          className={styles.compactButton}
                          onClick={() => void uploadType(type)}
                          disabled={
                            state.status === 'empty' ||
                            state.status === 'uploading' ||
                            !projectName.trim()
                          }
                        >
                          {state.status === 'uploading' ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="mr-1 h-3.5 w-3.5" />
                          )}
                          上传
                        </WarmButton>
                      </div>
                    </div>
                  )
                })}

                {manualMatchRows.length > 0 ? (
                  <div className={styles.manualMatch}>
                    <p className={styles.manualMatchTitle}>手动匹配</p>
                    <p className={styles.manualMatchHint}>以下文件识别失败，请手动指定类型。</p>

                    <div className={styles.manualMatchList}>
                      {manualMatchRows.map((row) => (
                        <div
                          key={row.id}
                          className={styles.manualMatchRow}
                        >
                          <div>
                            <p className={styles.manualFileName}>
                              {row.file.name}
                            </p>
                            <p className={styles.mutedText}>{row.detectedReason}</p>
                          </div>
                          <Select
                            value={row.assignedType}
                            onValueChange={(value) =>
                              changeAssignedType(row.id, value as AssignedType)
                            }
                          >
                            <SelectTrigger className={styles.selectTrigger}>
                              <SelectValue placeholder="手动选择类型" />
                            </SelectTrigger>
                            <SelectContent className={styles.selectContent}>
                              <SelectItem value="payment_report">交易明细 CSV</SelectItem>
                              <SelectItem value="monthly_summary_pdf">月度总结 PDF</SelectItem>
                              <SelectItem value="skip">跳过</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      <section
        className={styles.sidePanel}
        role="region"
        aria-label="处理状态"
        data-warm-surface="true"
      >
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>处理状态</h2>
        </div>
        <div className={styles.panelBody}>
          <div className={styles.progressPanel}>
            <div className={styles.progressHeader}>
              <div className={styles.progressLabel}>
                {submitState.status === 'submitting' ? (
                  <Loader2 className={styles.spinner} />
                ) : (
                  <DatabaseZap className={styles.mutedIcon} />
                )}
                <span>{submitState.message || '等待生成任务'}</span>
              </div>
              <span className={styles.progressValue}>
                {normalizeProgress(jobProgress?.progress ?? 0)}%
              </span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                data-complete="true"
                style={{ width: `${normalizeProgress(jobProgress?.progress ?? 0)}%` }}
              />
            </div>
            <div className={styles.progressSteps}>
              {PROGRESS_STEP_LABELS.map((label, index) => {
                const done =
                  hasProgressState &&
                  (currentProgressStep > index || (currentProgressStep === 4 && index === 4))
                const active = hasProgressState && currentProgressStep === index && !done
                const isLastStep = index === 4
                return (
                  <div key={label} className={styles.progressStep}>
                    <span
                      className={styles.stepDot}
                      data-state={done ? 'done' : active ? 'active' : 'pending'}
                    />
                    <div className={styles.stepLabelRow}>
                      <span data-state={done ? 'done' : active ? 'active' : 'pending'}>
                        {label}
                      </span>
                      {isLastStep && done && submitState.filename && (
                        <span className={styles.fileSuccess}>
                          ：{submitState.filename}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {submitState.status === 'error' ? (
            <div className={styles.alert}>
              <AlertCircle className="h-4 w-4" />
              {submitState.message}
            </div>
          ) : null}

          <div className={styles.actionStack}>
            <WarmButton
              type="button"
              variant="secondary"
              className={styles.fullWidth}
              onClick={() => void retryDownload()}
              disabled={
                !downloadTarget.endpoint ||
                downloadTarget.downloading ||
                submitState.status === 'submitting'
              }
            >
              {downloadTarget.downloading ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1 h-4 w-4" />
              )}
              下载报表
            </WarmButton>

            <WarmButton
              type="button"
              variant="primary"
              className={styles.fullWidth}
              onClick={() => void generateReport()}
              disabled={!canGenerate}
            >
              {submitState.status === 'submitting' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-4 w-4" />
              )}
              生成财务月报
            </WarmButton>
          </div>
        </div>
      </section>
    </div>
  )
}

async function downloadByEndpoint(endpoint: string, fallbackName: string, operator: string) {
  const downloadResponse = await fetch(resolveApiUrl(endpoint), {
    headers: authHeaders(operator),
  })
  if (!downloadResponse.ok) {
    const message = await downloadResponse.text()
    throw new Error(message || '下载失败')
  }

  const blob = await downloadResponse.blob()
  const headerName = extractFilenameFromHeader(downloadResponse.headers.get('Content-Disposition'))
  const filename = headerName || fallbackName

  const downloadUrl = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(downloadUrl)

  return filename
}
