'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { AlertCircle, CalendarRange, DatabaseZap, Download, FileSearch, Loader2, Sparkles, Upload } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangePicker, formatDateInputValue, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

type UploadType = 'business_report' | 'payment_report' | 'ad_report' | 'inventory_report'
type AssignedType = UploadType | 'skip'
type UploadStatus = 'empty' | 'ready' | 'uploading' | 'success' | 'error'

type UploadFileMeta = {
  filePath: string
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

type PersistenceStatus = 'idle' | 'running' | 'success' | 'failed'

type SyncState = {
  status: PersistenceStatus
  message: string | null
}

type ProjectOption = {
  name: string
}

type CountryOption = 'US' | 'DE' | 'UK'

type FileConfig = {
  key: UploadType
  title: string
  accept: string
  required: boolean
}

type ProductRecognizedType = UploadType | 'unknown'

type ProductRecognitionResult = {
  type: ProductRecognizedType
  reason: string
}

type MappingRow = {
  id: string
  file: File
  detectedType: ProductRecognizedType
  detectedReason: string
  assignedType: AssignedType
  matchFailed: boolean
}

const API_BASE = '/api/backend'

function authHeaders(_operator?: string, _isAdmin = false): Record<string, string> {
  return {}
}

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

function translateProductAnalysisError(message: string) {
  const text = message.trim()
  if (!text) return '未知错误'

  if (
    text.includes('Inventory report validation failed:')
    && text.includes('matched active SKU info')
  ) {
    const ratioMatch = text.match(/match rate\s+(\d+%)/i)
    const rowsMatch = text.match(/(\d+)\/(\d+)\s+rows matched/i)
    const sampleMatch = text.match(/Unmatched sample:\s*(.+)$/i)
    const ratioText = ratioMatch?.[1] ? `，匹配率 ${ratioMatch[1]}` : ''
    const rowsText = rowsMatch?.[1] && rowsMatch?.[2] ? `已匹配 ${rowsMatch[1]}/${rowsMatch[2]} 行` : '库存表匹配率异常'
    const sampleText = sampleMatch?.[1] && sampleMatch[1] !== 'N/A' ? `。未匹配示例：${sampleMatch[1]}` : ''
    return `库存报告与当前项目的 active SKU 信息匹配率过低，疑似上传到了错误项目。${rowsText}${ratioText}。请确认项目、站点与库存文件是否一致后重新上传${sampleText}`
  }

  return text
}

const FILE_CONFIG: FileConfig[] = [
  { key: 'business_report', title: '业务报告', accept: '.csv,text/csv', required: true },
  { key: 'payment_report', title: '付款报告', accept: '.csv,text/csv', required: true },
  { key: 'ad_report', title: '广告报告', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', required: true },
  { key: 'inventory_report', title: '库存报告（可选）', accept: '.txt,text/plain', required: false },
]

const TYPE_LABEL: Record<UploadType, string> = {
  business_report: '业务报告',
  payment_report: '付款报告',
  ad_report: '广告报告',
  inventory_report: '库存报告',
}

const PROGRESS_STEP_LABELS = ['初始化', '读取源数据', '计算指标', '生成报表', '完成']
const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

function extractFilenameFromHeader(contentDisposition: string | null) {
  if (!contentDisposition) return null
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1])
  const basicMatch = contentDisposition.match(/filename="?([^"]+)"?/i)
  return basicMatch?.[1] ?? null
}

function toDateInputValue(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getLastWeekRange() {
  const now = new Date()
  const day = now.getDay()
  const distanceToCurrentMonday = day === 0 ? 6 : day - 1
  const currentMonday = new Date(now)
  currentMonday.setDate(now.getDate() - distanceToCurrentMonday)
  const lastWeekMonday = new Date(currentMonday)
  lastWeekMonday.setDate(currentMonday.getDate() - 7)
  const lastWeekSunday = new Date(lastWeekMonday)
  lastWeekSunday.setDate(lastWeekMonday.getDate() + 6)
  return {
    start: toDateInputValue(lastWeekMonday),
    end: toDateInputValue(lastWeekSunday),
  }
}

function getExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

async function readFirstLine(file: File) {
  try {
    const content = await file.slice(0, 4096).text()
    const firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? ''
    return firstLine.trim()
  } catch {
    return ''
  }
}

async function recognizeProductFile(file: File): Promise<ProductRecognitionResult> {
  const lowerName = file.name.toLowerCase()
  const ext = getExtension(file.name)

  if (ext === '.txt') {
    const firstLine = (await readFirstLine(file)).toLowerCase()
    if (firstLine.includes('snapshot-date')) return { type: 'inventory_report', reason: '首行包含 snapshot-date' }
    if (lowerName.includes('fba') || lowerName.includes('inventory') || lowerName.includes('库存')) {
      return { type: 'inventory_report', reason: '文件名命中 fba/inventory/库存 关键词' }
    }
    return { type: 'unknown', reason: 'txt 文件未命中库存识别规则' }
  }

  if (ext === '.xlsx') {
    if (lowerName.includes('ad') || lowerName.includes('广告') || lowerName.includes('推广')) {
      return { type: 'ad_report', reason: 'xlsx 文件名命中 ad/广告/推广关键词' }
    }
    return { type: 'ad_report', reason: 'xlsx 默认按广告报告处理（可手动修正）' }
  }

  if (ext === '.csv') {
    const firstLine = (await readFirstLine(file)).toLowerCase()
    if (firstLine.includes('includes amazon marketplace')) return { type: 'payment_report', reason: '首行包含 Includes Amazon Marketplace' }
    if (lowerName.includes('payment') || lowerName.includes('付款')) return { type: 'payment_report', reason: '文件名命中 payment/付款 关键词' }
    if (
      lowerName.includes('business') ||
      lowerName.includes('商业') ||
      lowerName.includes('业务') ||
      firstLine.includes('child asin') ||
      firstLine.includes('ordered product sales') ||
      firstLine.includes('sessions - total')
    ) {
      return { type: 'business_report', reason: 'csv 命中业务报告内容/文件名特征' }
    }
    return { type: 'unknown', reason: 'csv 未命中付款或业务报告规则' }
  }

  return { type: 'unknown', reason: `不支持的文件格式: ${ext || '未知'}` }
}

function createEmptyUploadState(): Record<UploadType, UploadStateItem> {
  return {
    business_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    payment_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    ad_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    inventory_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
  }
}

function getAssignedRow(rows: MappingRow[], type: UploadType): MappingRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].assignedType === type) return rows[i]
  }
  return null
}

function getUploadMeta(state: UploadStateItem) {
  if (state.status === 'success') return { text: '已上传', dot: 'bg-emerald-500', bar: 'bg-emerald-500' }
  if (state.status === 'uploading') return { text: '上传中', dot: 'bg-blue-500', bar: 'bg-blue-500' }
  if (state.status === 'error') return { text: '上传失败', dot: 'bg-rose-500', bar: 'bg-rose-500' }
  if (state.status === 'ready') return { text: '待上传', dot: 'bg-sky-500', bar: 'bg-sky-500' }
  return { text: '未识别', dot: 'bg-[hsl(var(--surface-outline))]', bar: 'bg-[hsl(var(--surface-outline))]' }
}

function validateTypeFile(type: UploadType, file: File) {
  const fileName = file.name.toLowerCase()
  if (type === 'ad_report') return fileName.endsWith('.xlsx')
  if (type === 'inventory_report') return fileName.endsWith('.txt')
  return fileName.endsWith('.csv')
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

function fallbackProgressByStatus(status: 'pending' | 'running' | 'success' | 'failed'): JobProgress {
  if (status === 'pending') return { stage: 'started', progress: 2, message: '处理中：任务排队中' }
  if (status === 'running') return { stage: 'processing', progress: 10, message: '处理中：任务执行中' }
  if (status === 'success') return { stage: 'completed', progress: 100, message: '处理完成：报表已生成，可下载' }
  return { stage: 'failed', progress: 100, message: '处理失败' }
}

function resolveProgressStepIndex(stage?: string | null): number {
  if (!stage) return 0
  if (stage === 'completed') return 4
  if (stage === 'reading_data') return 1
  if (stage === 'calculating_metrics') return 2
  if (stage === 'generating_report' || stage === 'saving_workbook') return 3
  return 0
}

function normalizePersistenceStatus(value: unknown): PersistenceStatus {
  if (value === 'running' || value === 'success' || value === 'failed') return value
  return 'idle'
}

function getSyncMeta(state: SyncState) {
  if (state.status === 'success') return { text: '已同步', className: 'text-emerald-600' }
  if (state.status === 'running') return { text: '同步中', className: 'text-blue-600' }
  if (state.status === 'failed') return { text: '同步失败', className: 'text-rose-600' }
  return { text: '待同步', className: 'text-muted-foreground' }
}

interface ManualCalculationPanelProps {
  projects: ProjectOption[]
  projectsLoading: boolean
  projectLoadError: string | null
}

export default function ManualCalculationPanel(_props: ManualCalculationPanelProps) {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (session?.user?.operatorNameZh || session?.user?.name || session?.user?.email || session?.user?.id || '').trim()
  const initialDateRange = getLastWeekRange()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(initialDateRange.start)
  const [endDate, setEndDate] = useState(initialDateRange.end)
  const [formError, setFormError] = useState<string | null>(null)

  const [mappingRows, setMappingRows] = useState<MappingRow[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [mappingBusy, setMappingBusy] = useState(false)

  const [uploadState, setUploadState] = useState<Record<UploadType, UploadStateItem>>(createEmptyUploadState)
  const [uploadBusy, setUploadBusy] = useState(false)

  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle', message: null, filename: null })
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null)
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle', message: null })

  const requiredKeys = useMemo(() => FILE_CONFIG.filter((item) => item.required).map((item) => item.key), [])

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
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
      FILE_CONFIG.forEach((item) => {
        const assigned = getAssignedRow(mappingRows, item.key)
        const previous = prev[item.key]

        if (!assigned) {
          next[item.key] = {
            status: 'empty',
            mappedRowId: null,
            selectedFile: null,
            error: null,
            uploaded: null,
          }
          return
        }

        if (previous.mappedRowId === assigned.id && (previous.status === 'success' || previous.status === 'uploading')) {
          next[item.key] = previous
          return
        }

        next[item.key] = {
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

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate

  const requiredReadyCount = useMemo(
    () => requiredKeys.filter((key) => uploadState[key].status !== 'empty').length,
    [requiredKeys, uploadState]
  )

  const requiredUploadedCount = useMemo(
    () => requiredKeys.filter((key) => uploadState[key].status === 'success').length,
    [requiredKeys, uploadState]
  )

  const manualMatchRows = useMemo(
    () => mappingRows.filter((row) => row.matchFailed && row.assignedType === 'skip'),
    [mappingRows]
  )

  const dropZoneHeight = Math.min(460, 210 + Math.max(4, manualMatchRows.length + FILE_CONFIG.length) * 28)

  const canGenerate =
    projectName.trim().length > 0 &&
    dateRangeValid &&
    requiredKeys.every((key) => uploadState[key].status === 'success') &&
    submitState.status !== 'submitting'

  const currentProgressStep = useMemo(() => resolveProgressStepIndex(jobProgress?.stage), [jobProgress?.stage])
  const hasProgressState = submitState.status !== 'idle' || jobProgress !== null

  const generationMeta = useMemo(() => {
    if (submitState.status === 'success') return { label: '已完成', tone: 'text-emerald-600' }
    if (submitState.status === 'submitting') return { label: '进行中', tone: 'text-blue-600' }
    if (submitState.status === 'error') return { label: '异常', tone: 'text-rose-600' }
    return { label: '未开始', tone: 'text-muted-foreground' }
  }, [submitState.status])

  const syncMeta = useMemo(() => getSyncMeta(syncState), [syncState])

  const updateSyncState = (status: unknown, message?: string | null) => {
    setSyncState({
      status: normalizePersistenceStatus(status),
      message: message?.trim() || null,
    })
  }

  const pollPersistenceStatus = async (statusEndpoint: string) => {
    let attempts = 0
    while (attempts < 90) {
      attempts += 1
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(resolveApiUrl(statusEndpoint), {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        })
        if (!response.ok) break

        // eslint-disable-next-line no-await-in-loop
        const payload = (await response.json()) as {
          persistence_status?: PersistenceStatus
          persistence_message?: string | null
        }
        updateSyncState(payload.persistence_status, payload.persistence_message)
        if (payload.persistence_status === 'success' || payload.persistence_status === 'failed') break
      } catch {
        break
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return

    setFormError(null)
    setMappingBusy(true)

    const recognized = await Promise.all(
      files.map(async (file) => {
        const match = await recognizeProductFile(file)
        return { file, ...match }
      })
    )

    setMappingRows((prev) => {
      const next = [...prev]

      recognized.forEach(({ file, type, reason }) => {
        const row: MappingRow = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          file,
          detectedType: type,
          detectedReason: reason,
          assignedType: type === 'unknown' ? 'skip' : type,
          matchFailed: type === 'unknown',
        }

        if (row.assignedType !== 'skip') {
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].assignedType === row.assignedType) {
              next[i] = { ...next[i], assignedType: 'skip', matchFailed: false }
              break
            }
          }
        }

        next.push(row)
      })

      const hasBusiness = next.some((row) => row.assignedType === 'business_report')
      if (!hasBusiness) {
        const fallbackRow = recognized.find((item) => item.type === 'unknown' && getExtension(item.file.name) === '.csv')
        if (fallbackRow) {
          const fallbackId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
          next.push({
            id: fallbackId,
            file: fallbackRow.file,
            detectedType: 'unknown',
            detectedReason: 'csv 兜底分配为业务报告',
            assignedType: 'business_report',
            matchFailed: false,
          })
        }
      }

      return next
    })

    setMappingBusy(false)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    await addFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const applyLastWeek = () => {
    const range = getLastWeekRange()
    setStartDate(range.start)
    setEndDate(range.end)
    setFormError(null)
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

    if (!validateTypeFile(type, target.selectedFile)) {
      setUploadState((prev) => ({
        ...prev,
        [type]: { ...prev[type], status: 'error', error: '文件格式不支持，请检查映射。' },
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

    try {
      const response = await fetch(`${API_BASE}/api/v1/uploads`, {
        method: 'POST',
        body: formData,
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '文件上传失败，请重试')
      }

      const payload = (await response.json()) as {
        file_path?: string
        filename?: string
        original_filename?: string
      }

      if (!payload.file_path || !payload.filename || !payload.original_filename) {
        throw new Error('上传成功但响应缺少必要字段')
      }

      setUploadState((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: 'success',
          error: null,
          uploaded: {
            filePath: payload.file_path,
            filename: payload.filename,
            originalFilename: payload.original_filename,
          },
        },
      }))
    } catch (error) {
      setUploadState((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: 'error',
          error: error instanceof Error ? error.message : '文件上传失败，请重试',
          uploaded: null,
        },
      }))
    }
  }

  const uploadAllConfirmed = async () => {
    if (uploadBusy) return
    setUploadBusy(true)
    for (const item of FILE_CONFIG) {
      const state = uploadState[item.key]
      if (state.status === 'ready' || state.status === 'error') {
        // eslint-disable-next-line no-await-in-loop
        await uploadType(item.key)
      }
    }
    setUploadBusy(false)
  }

  const generateReport = async () => {
    setFormError(null)
    setSubmitState({ status: 'idle', message: null, filename: null })
    setJobProgress(null)
    setSyncState({ status: 'idle', message: null })

    if (!projectName.trim()) {
      setFormError('项目名称不能为空')
      return
    }
    if (!startDate || !endDate) {
      setFormError('开始日期和结束日期不能为空')
      return
    }
    if (startDate > endDate) {
      setFormError('开始日期不能晚于结束日期')
      return
    }
    if (!requiredKeys.every((key) => uploadState[key].status === 'success')) {
            setFormError('请先完成 3 份必需文件上传（业务/付款/广告）')
      return
    }

    const businessReportFileId = uploadState.business_report.uploaded?.filename
    const paymentReportFileId = uploadState.payment_report.uploaded?.filename
    const adReportFileId = uploadState.ad_report.uploaded?.filename
    const inventoryReportFileId = uploadState.inventory_report.uploaded?.filename ?? null

    if (!businessReportFileId || !paymentReportFileId || !adReportFileId) {
      setFormError('上传结果异常，请重新上传文件')
      return
    }

    setSubmitState({ status: 'submitting', message: '系统处理中，请稍候...', filename: null })
    setJobProgress({ stage: 'started', progress: 1, message: '系统处理中，请稍候...' })

    try {
      const createJobResponse = await fetch(`${API_BASE}/api/v1/product-analysis-reports`, {
        method: 'POST',
        headers: {
          ...authHeaders(currentOperator, isAdmin),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_name: projectName.trim(),
          country,
          report_start_date: startDate,
          report_end_date: endDate,
          business_report_file_id: businessReportFileId,
          payment_report_file_id: paymentReportFileId,
          ad_report_file_id: adReportFileId,
          inventory_report_file_id: inventoryReportFileId,
        }),
      })

      if (!createJobResponse.ok) {
        const message = await parseApiError(createJobResponse, '生成失败，请重试')
        throw new Error(translateProductAnalysisError(message))
      }

      const created = (await createJobResponse.json()) as {
        job_id: number
        status_endpoint?: string
        result_endpoint?: string
        status?: 'pending' | 'running' | 'success' | 'failed'
      }
      const jobId = created.job_id
      const statusEndpoint = created.status_endpoint?.trim() || `/api/v1/product-analysis-reports/tasks/${jobId}`
      const resultEndpoint = created.result_endpoint?.trim() || `/api/v1/product-analysis-reports/tasks/${jobId}/result`

      let attempts = 0
      let failedMessage: string | null = null
      let finished = created.status === 'success'
      let lastStatus: 'pending' | 'running' | 'success' | 'failed' | null = created.status ?? null
      let lastStatusChangeTime = Date.now()
      const MIN_STATUS_DISPLAY_MS = 1000 // 每个状态最少显示1秒

      while (attempts < 120 && !finished) {
        attempts += 1
        // eslint-disable-next-line no-await-in-loop
        const statusResponse = await fetch(resolveApiUrl(statusEndpoint), {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        })

        if (!statusResponse.ok) {
          // eslint-disable-next-line no-await-in-loop
          const msg = await parseApiError(statusResponse, '任务状态查询失败')
          throw new Error(translateProductAnalysisError(msg))
        }

        // eslint-disable-next-line no-await-in-loop
        const statusPayload = (await statusResponse.json()) as {
          status: 'pending' | 'running' | 'success' | 'failed'
          message?: string | null
          error_message?: string | null
          persistence_status?: PersistenceStatus
          persistence_message?: string | null
          runs?: Array<{ error_message?: string | null }>
        }

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

        updateSyncState(statusPayload.persistence_status, statusPayload.persistence_message)
        const currentProgress = fallbackProgressByStatus(statusPayload.status)
        setJobProgress(currentProgress)
        if (statusPayload.message?.trim()) {
          setSubmitState({ status: 'submitting', message: statusPayload.message.trim(), filename: null })
          setJobProgress({ ...currentProgress, message: statusPayload.message.trim() })
        }

        if (statusPayload.status === 'failed') {
          failedMessage =
            statusPayload.error_message ?? statusPayload.runs?.[statusPayload.runs.length - 1]?.error_message ?? '任务执行失败'
          failedMessage = translateProductAnalysisError(failedMessage)
          finished = true
          break
        }

        if (statusPayload.status === 'success') {
          finished = true
          break
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 400))
      }

      if (failedMessage) throw new Error(failedMessage)
      if (!finished) throw new Error('任务执行超时，请稍后重试')

      const response = await fetch(resolveApiUrl(resultEndpoint), {
        headers: authHeaders(currentOperator, isAdmin),
      })

      if (!response.ok) {
        const message = await parseApiError(response, '结果下载失败')
        throw new Error(translateProductAnalysisError(message))
      }

      const blob = await response.blob()
      const headerName = extractFilenameFromHeader(response.headers.get('Content-Disposition'))
      const startDateCompact = startDate.replaceAll('-', '')
      const endDateCompact = endDate.replaceAll('-', '')
      const fallbackName = `${projectName.trim()}_Product_Analysis_${startDateCompact}-${endDateCompact.slice(4)}.xlsx`
      const filename = headerName || fallbackName

      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)

      setJobProgress({ stage: 'completed', progress: 100, message: '处理完成：报表已生成，可下载' })
      setSubmitState({ status: 'success', message: `生成成功，已下载 ${filename}`, filename })
      void pollPersistenceStatus(statusEndpoint)
    } catch (error) {
      setJobProgress((prev) => prev ?? { stage: 'failed', progress: 100, message: '处理失败' })
      setSubmitState({
        status: 'error',
        message: `生成失败：${error instanceof Error ? error.message : '未知错误'}`,
        filename: null,
      })
    }
  }

  return (
    <div className="grid w-full gap-6 text-foreground xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <Card className="overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90">
          <CardHeader>
            <CardTitle className="text-lg">控制台</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full min-w-0 space-y-2 sm:w-auto sm:flex-[0_1_140px] sm:max-w-[160px]">
                <label htmlFor="project_name" className="text-sm font-medium">项目名称</label>
                <Select
                  value={projectName}
                  onValueChange={setProjectName}
                  disabled={projectsLoading || projects.length === 0}
                >
                  <SelectTrigger
                    id="project_name"
                    className="h-10 max-w-full transition-all duration-200 data-[state=open]:ring-2 data-[state=open]:ring-blue-500/30"
                  >
                    <SelectValue
                      placeholder={projectsLoading ? '项目加载中...' : projects.length ? '请选择项目名称' : '暂无可选项目'}
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-64 overflow-y-auto">
                    {projects.map((project) => (
                      <SelectItem key={project.name} value={project.name}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!projectsLoading && !projectLoadError && projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无项目，请先到“项目信息”页面新增。</p>
                ) : null}
                {projectLoadError ? <p className="text-xs text-destructive">{projectLoadError}</p> : null}
              </div>

              <div className="w-full min-w-0 space-y-2 sm:w-auto sm:flex-[0_1_180px] sm:max-w-[220px]">
                <label htmlFor="country" className="text-sm font-medium">国家站点</label>
                <Select value={country} onValueChange={(value) => setCountry(value as CountryOption)}>
                  <SelectTrigger id="country" className="h-10 max-w-full">
                    <SelectValue placeholder="请选择国家站点" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <label htmlFor="report_start_date" className="text-sm font-medium">日期范围</label>
                <DateRangePicker
                  value={parseDateRangeInputValue(startDate, endDate)}
                  onChange={(range) => {
                    setStartDate(formatDateInputValue(range?.from))
                    setEndDate(formatDateInputValue(range?.to))
                  }}
                  className="w-full"
                />
                {startDate && endDate && startDate > endDate ? (
                  <p className="text-xs text-destructive">开始日期不能晚于结束日期</p>
                ) : null}
              </div>

              <div className="w-full space-y-2 sm:w-auto sm:flex-none">
                <div className="text-sm font-medium text-transparent select-none">快捷</div>
                <Button type="button" variant="secondary" onClick={applyLastWeek} className="w-full sm:w-auto">
                  <CalendarRange className="mr-1 h-4 w-4" />
                  上周
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
                <p className="text-xs text-muted-foreground">识别</p>
                <p className="mt-1 text-sm font-semibold">{requiredReadyCount}/3</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
                <p className="text-xs text-muted-foreground">上传</p>
                <p className="mt-1 text-sm font-semibold">{requiredUploadedCount}/3</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
                <p className="text-xs text-muted-foreground">表格生成</p>
                <p className={cn('mt-1 text-sm font-semibold', generationMeta.tone)}>{generationMeta.label}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
                <p className="text-xs text-muted-foreground">数据同步</p>
                <p className={cn('mt-1 text-sm font-semibold', syncMeta.className)}>{syncMeta.text}</p>
              </div>
            </div>

            {syncState.message ? <p className="text-xs text-muted-foreground">{syncState.message}</p> : null}

            {formError ? <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{formError}</p> : null}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90">
          <CardHeader>
            <CardTitle className="text-lg">文件识别与上传</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
            <div
              className={cn(
                'flex flex-col rounded-xl border-2 border-dashed p-4 text-center transition-colors',
                dragActive ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-900/20' : 'border-border bg-[hsl(var(--surface-subtle))]'
              )}
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
              <p className="text-sm font-semibold text-foreground">拖拽文件到这里</p>
              <p className="mt-1 text-xs text-muted-foreground">支持 csv/xlsx/txt 批量识别</p>

              <div className="mt-auto space-y-2 pt-4">
                <Button type="button" variant="outline" className="w-full" onClick={() => document.getElementById('product-file-picker')?.click()}>
                  <FileSearch className="mr-1 h-4 w-4" />
                  选择多个文件
                </Button>
                <Input
                  id="product-file-picker"
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.txt"
                  className="hidden"
                  onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
                />
                <Button type="button" className="w-full" onClick={() => void uploadAllConfirmed()} disabled={uploadBusy || mappingBusy || !projectName.trim()}>
                  {uploadBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
                  一键上传已匹配文件
                </Button>
              </div>
            </div>

            <div className="space-y-4">
              {FILE_CONFIG.map((item) => {
                const state = uploadState[item.key]
                const meta = getUploadMeta(state)
                const matched = state.status !== 'empty'
                return (
                  <div key={item.key} className="flex min-h-[120px] flex-col rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2.5 w-2.5 rounded-full', meta.dot)} />
                        <p className="text-sm font-semibold text-foreground">{item.title}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">{meta.text}</span>
                    </div>

                    <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--surface-high))] dark:bg-[hsl(var(--surface-high))]">
                      <div className={cn('h-full transition-all duration-200', matched ? meta.bar : 'bg-[hsl(var(--surface-outline))] dark:bg-[hsl(var(--surface-outline))]')} style={{ width: matched ? '100%' : '28%' }} />
                    </div>

                    <div className="mt-auto flex items-end justify-between gap-3 pt-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-muted-foreground">{state.selectedFile?.name ?? '等待识别或手动匹配'}</p>
                        {state.error ? <p className="mt-1 text-xs text-destructive">{state.error}</p> : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void uploadType(item.key)}
                        disabled={state.status === 'empty' || state.status === 'uploading' || !projectName.trim()}
                      >
                        {state.status === 'uploading' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
                        上传
                      </Button>
                    </div>
                  </div>
                )
              })}

              {manualMatchRows.length > 0 ? (
                <div className="rounded-lg border border-blue-200/70 bg-blue-50/60 p-3 dark:border-blue-800/50 dark:bg-blue-950/20">
                  <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">手动匹配</p>
                  <p className="mt-1 text-xs text-blue-700/80 dark:text-blue-200/80">以下文件识别失败，请手动指定类型。</p>

                  <div className="mt-3 space-y-2">
                    {manualMatchRows.map((row) => (
                      <div key={row.id} className="grid gap-2 rounded-md border border-blue-200/70 bg-[hsl(var(--surface-panel))] p-2 dark:border-blue-800/40 md:grid-cols-[1fr_210px]">
                        <div>
                          <p className="truncate text-sm font-medium text-foreground">{row.file.name}</p>
                          <p className="text-xs text-muted-foreground">{row.detectedReason}</p>
                        </div>
                        <Select value={row.assignedType} onValueChange={(value) => changeAssignedType(row.id, value as AssignedType)}>
                          <SelectTrigger>
                            <SelectValue placeholder="手动选择类型" />
                          </SelectTrigger>
                          <SelectContent>
                                                <SelectItem value="business_report">业务报告</SelectItem>
                            <SelectItem value="payment_report">付款报告</SelectItem>
                            <SelectItem value="ad_report">广告报告</SelectItem>
                            <SelectItem value="inventory_report">库存报告</SelectItem>
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
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90 xl:sticky xl:top-6">
        <CardHeader>
          <CardTitle className="text-lg">处理状态</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                {submitState.status === 'submitting' ? <Loader2 className="h-4 w-4 animate-spin text-blue-500" /> : <DatabaseZap className="h-4 w-4 text-muted-foreground" />}
                <span>{submitState.message || '等待生成任务'}</span>
              </div>
              <span className="text-xs font-semibold text-muted-foreground">{normalizeProgress(jobProgress?.progress ?? 0)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--surface-high))] dark:bg-[hsl(var(--surface-high))]">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${normalizeProgress(jobProgress?.progress ?? 0)}%` }}
              />
            </div>
            <div className="space-y-2 text-sm">
              {PROGRESS_STEP_LABELS.map((label, index) => {
                const done = hasProgressState && (currentProgressStep > index || (currentProgressStep === 4 && index === 4))
                const active = hasProgressState && currentProgressStep === index && !done
                const isLastStep = index === 4
                return (
                  <div key={label} className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2.5 w-2.5 rounded-full transition-colors',
                        done ? 'bg-emerald-500' : active ? 'bg-blue-500' : 'bg-[hsl(var(--surface-outline))] dark:bg-[hsl(var(--surface-outline))]'
                      )}
                    />
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'transition-colors',
                          done
                            ? 'text-emerald-700 dark:text-emerald-200'
                            : active
                              ? 'font-medium text-blue-700 dark:text-blue-200'
                              : 'text-muted-foreground'
                        )}
                      >
                        {label}
                      </span>
                      {isLastStep && done && submitState.filename && (
                        <span className="text-emerald-600 dark:text-emerald-300 font-medium">
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
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4" />
              {submitState.message}
            </div>
          ) : null}



          <div className="space-y-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                const link = document.createElement('a')
                link.click()
              }}
              disabled={submitState.status !== 'success'}
            >
              <Download className="mr-1 h-4 w-4" />
              下载报表
            </Button>

            <Button
              type="button"
              className="h-11 w-full bg-blue-600 hover:bg-blue-500"
              onClick={() => void generateReport()}
              disabled={!canGenerate}
            >
              {submitState.status === 'submitting' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
              生成产品分析表
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
