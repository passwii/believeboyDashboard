'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import {
  AlertCircle,
  CalendarRange,
  Check,
  CheckCircle2,
  Download,
  FileSearch,
  FlaskConical,
  Loader2,
  Package,
  Rocket,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type UploadType = 'business_report' | 'payment_report' | 'ad_report' | 'inventory_report'
type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

type UploadFileMeta = {
  filePath: string
  filename: string
  originalFilename: string
}

type UploadStateItem = {
  status: UploadStatus
  selectedFile: File | null
  selectedReason: string | null
  uploaded: UploadFileMeta | null
  error: string | null
}

type SubmitState = {
  status: 'idle' | 'submitting' | 'success' | 'error'
  message: string | null
  filename: string | null
}

type ProjectOption = {
  name: string
}

type FileConfig = {
  key: UploadType
  title: string
  description: string
  accept: string
  required: boolean
}

type StatusMeta = {
  text: string
  progress: number
  tone: 'neutral' | 'loading' | 'success' | 'error'
}

type ProductRecognizedType = UploadType | 'unknown'

type ProductRecognitionResult = {
  type: ProductRecognizedType
  reason: string
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

function authHeaders() {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
}

const FILE_CONFIG: FileConfig[] = [
  {
    key: 'business_report',
    title: '商业报告',
    description: '必需，.csv（优先包含业务数据头）',
    accept: '.csv,text/csv',
    required: true,
  },
  {
    key: 'payment_report',
    title: '付款报告',
    description: '必需，.csv（首行建议包含 Includes Amazon Marketplace）',
    accept: '.csv,text/csv',
    required: true,
  },
  {
    key: 'ad_report',
    title: '广告报告',
    description: '必需，.xlsx（文件名建议包含 ad/广告/推广）',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    required: true,
  },
  {
    key: 'inventory_report',
    title: '库存报告',
    description: '可选，.txt（首行建议包含 snapshot-date）',
    accept: '.txt,text/plain',
    required: false,
  },
]

function extractFilenameFromHeader(contentDisposition: string | null) {
  if (!contentDisposition) {
    return null
  }
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }
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
    if (firstLine.includes('snapshot-date')) {
      return { type: 'inventory_report', reason: '首行包含 snapshot-date' }
    }
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
    if (firstLine.includes('includes amazon marketplace')) {
      return { type: 'payment_report', reason: '首行包含 Includes Amazon Marketplace' }
    }
    if (lowerName.includes('payment') || lowerName.includes('付款')) {
      return { type: 'payment_report', reason: '文件名命中 payment/付款 关键词' }
    }
    if (
      lowerName.includes('business') ||
      lowerName.includes('商业') ||
      lowerName.includes('业务') ||
      firstLine.includes('child asin') ||
      firstLine.includes('ordered product sales') ||
      firstLine.includes('sessions - total')
    ) {
      return { type: 'business_report', reason: 'csv 命中商业报告内容/文件名特征' }
    }
    return { type: 'unknown', reason: 'csv 未命中付款或商业报告规则' }
  }

  return { type: 'unknown', reason: `不支持的文件格式: ${ext || '未知'}` }
}

function initialUploadState(): Record<UploadType, UploadStateItem> {
  return {
    business_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
    payment_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
    ad_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
    inventory_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
  }
}

function getStatusMeta(state: UploadStateItem): StatusMeta {
  if (state.status === 'success') return { text: '上传完成', progress: 100, tone: 'success' }
  if (state.status === 'uploading') return { text: '上传中', progress: 68, tone: 'loading' }
  if (state.status === 'error') return { text: '上传失败', progress: 100, tone: 'error' }
  if (state.selectedFile) return { text: '已选择文件', progress: 36, tone: 'loading' }
  return { text: '待处理', progress: 18, tone: 'neutral' }
}

function StatusPill({ status }: { status: UploadStatus }) {
  if (status === 'success') {
    return (
      <Badge className="border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-50 dark:bg-emerald-900/50 dark:text-emerald-300">
        <Check className="mr-1 h-3.5 w-3.5" />
        已上传
      </Badge>
    )
  }

  if (status === 'error') {
    return (
      <Badge variant="destructive" className="border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-50 dark:bg-rose-900/50 dark:text-rose-300">
        <X className="mr-1 h-3.5 w-3.5" />
        失败
      </Badge>
    )
  }

  if (status === 'uploading') {
    return (
      <Badge className="border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-50 dark:bg-blue-900/50 dark:text-blue-300">
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        上传中
      </Badge>
    )
  }

  return <Badge variant="secondary">待上传</Badge>
}

function UploadProgressRail({ meta, reduceMotion }: { meta: StatusMeta; reduceMotion: boolean }) {
  const toneClasses = {
    neutral: 'bg-foreground/40',
    loading: 'bg-blue-500',
    success: 'bg-emerald-500',
    error: 'bg-rose-500',
  }

  const trackClasses = {
    neutral: 'bg-muted',
    loading: 'bg-blue-100',
    success: 'bg-emerald-100',
    error: 'bg-rose-100',
  }

  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full', trackClasses[meta.tone])}>
      <motion.div
        className={cn('h-full rounded-full', toneClasses[meta.tone])}
        initial={{ width: 0 }}
        animate={{ width: `${meta.progress}%` }}
        transition={reduceMotion ? { duration: 0.1 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  )
}

function UploadRow({
  fileItem,
  state,
  canUpload,
  reduceMotion,
  onPickFile,
  onUpload,
  onReset,
}: {
  fileItem: FileConfig
  state: UploadStateItem
  canUpload: boolean
  reduceMotion: boolean
  onPickFile: (key: UploadType, file: File | null, reason?: string) => void
  onUpload: (key: UploadType) => Promise<void>
  onReset: (key: UploadType) => void
}) {
  const toneClasses =
    state.status === 'success'
      ? 'border-emerald-200/90 bg-emerald-50/60 dark:bg-emerald-900/40'
      : state.status === 'error'
        ? 'border-rose-200/90 bg-rose-50/60 dark:bg-rose-900/40'
        : state.status === 'uploading'
          ? 'border-blue-200/90 bg-blue-50/70 dark:bg-blue-900/50'
          : 'border-border bg-card'

  return (
    <motion.div
      layout
      whileHover={reduceMotion ? undefined : { y: -2 }}
      transition={reduceMotion ? { duration: 0.1 } : { duration: 0.2, ease: 'easeOut' }}
      className={cn('rounded-xl border p-4 shadow-sm', toneClasses)}
    >
      <div className="grid gap-3 xl:grid-cols-[190px_1fr_auto] xl:items-center">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">{fileItem.title}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{fileItem.description}</p>
          {state.selectedReason ? <p className="text-[11px] text-blue-600 dark:text-blue-300">{state.selectedReason}</p> : null}
        </div>

        <div className="space-y-2">
          <Input
            type="file"
            accept={fileItem.accept}
            onChange={(event) => onPickFile(fileItem.key, event.target.files?.[0] ?? null)}
            disabled={state.status === 'uploading'}
            className="bg-background"
          />
          <p className="truncate text-xs text-muted-foreground">
            {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
          </p>
        </div>

        <div className="flex items-center gap-2 xl:justify-end">
          <StatusPill status={state.status} />
          <Button
            type="button"
            size="sm"
            onClick={() => void onUpload(fileItem.key)}
            disabled={!canUpload || !state.selectedFile || state.status === 'uploading'}
            className="min-w-20"
          >
            {state.status === 'uploading' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
            上传
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onReset(fileItem.key)}
            disabled={state.status === 'uploading'}
            className="min-w-20"
          >
            重置
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {state.error ? (
          <motion.p
            initial={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
            transition={reduceMotion ? { duration: 0.1 } : { duration: 0.22, ease: 'easeOut' }}
            className="mt-2 text-xs text-destructive"
          >
            {state.error}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}

export default function ProductAnalysisPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [manualProjectInput, setManualProjectInput] = useState(false)

  const [projectName, setProjectName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [uploadState, setUploadState] = useState<Record<UploadType, UploadStateItem>>(initialUploadState)
  const [dragActive, setDragActive] = useState(false)
  const [matchingFiles, setMatchingFiles] = useState(false)
  const [recognitionMessages, setRecognitionMessages] = useState<string[]>([])
  const [submitState, setSubmitState] = useState<SubmitState>({
    status: 'idle',
    message: null,
    filename: null,
  })

  const shouldReduceMotion = useReducedMotion()

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: shouldReduceMotion ? 0 : 0.08,
        delayChildren: shouldReduceMotion ? 0 : 0.05,
      },
    },
  }

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        duration: shouldReduceMotion ? 0.1 : 0.3,
        ease: [0.22, 1, 0.36, 1],
      },
    },
  }

  const statusVariants: Variants = {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : -8 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        duration: shouldReduceMotion ? 0.1 : 0.24,
        ease: [0.16, 1, 0.3, 1],
      },
    },
    exit: {
      opacity: 0,
      y: shouldReduceMotion ? 0 : -8,
      transition: { duration: shouldReduceMotion ? 0.08 : 0.2 },
    },
  }

  const logItemVariants: Variants = {
    hidden: { opacity: 0, x: shouldReduceMotion ? 0 : -8 },
    show: {
      opacity: 1,
      x: 0,
      transition: {
        duration: shouldReduceMotion ? 0.1 : 0.22,
        ease: [0.16, 1, 0.3, 1],
      },
    },
    exit: { opacity: 0, x: shouldReduceMotion ? 0 : -8, transition: { duration: 0.15 } },
  }

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects`, {
          cache: 'no-store',
          headers: authHeaders(),
        })
        if (!response.ok) {
          throw new Error(`项目列表加载失败 (${response.status})`)
        }
        const data = (await response.json()) as ProjectOption[]
        setProjects(data)
      } catch (error) {
        setProjectLoadError(error instanceof Error ? error.message : '项目列表加载失败')
        setManualProjectInput(true)
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [])

  const canUpload = projectName.trim().length > 0
  const requiredKeys = useMemo(() => FILE_CONFIG.filter((item) => item.required).map((item) => item.key), [])
  const requiredUploaded = useMemo(
    () => requiredKeys.every((key) => uploadState[key].status === 'success' && uploadState[key].uploaded),
    [requiredKeys, uploadState]
  )
  const uploadedCount = useMemo(
    () => FILE_CONFIG.filter((item) => uploadState[item.key].status === 'success' && uploadState[item.key].uploaded).length,
    [uploadState]
  )
  const requiredUploadedCount = useMemo(
    () => requiredKeys.filter((key) => uploadState[key].status === 'success' && uploadState[key].uploaded).length,
    [requiredKeys, uploadState]
  )
  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate
  const canGenerate = projectName.trim() && dateRangeValid && requiredUploaded && submitState.status !== 'submitting'

  const latestAction = useMemo(() => {
    if (submitState.message) return submitState.message
    if (recognitionMessages.length > 0) return recognitionMessages[recognitionMessages.length - 1]
    return '等待文件识别与上传'
  }, [recognitionMessages, submitState.message])

  const validateFile = (file: File, key: UploadType) => {
    const fileName = file.name.toLowerCase()
    if (key === 'ad_report') return fileName.endsWith('.xlsx')
    if (key === 'inventory_report') return fileName.endsWith('.txt')
    return fileName.endsWith('.csv')
  }

  const onPickFile = (key: UploadType, file: File | null, reason = '手动选择文件') => {
    setFormError(null)
    if (!file) {
      return
    }
    if (!validateFile(file, key)) {
      setUploadState((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: 'error',
          error: '文件格式不支持，请上传正确格式',
          selectedFile: null,
          selectedReason: null,
          uploaded: null,
        },
      }))
      return
    }
    setUploadState((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        selectedFile: file,
        selectedReason: reason,
        status: 'idle',
        error: null,
        uploaded: null,
      },
    }))
  }

  const mapDetectedFiles = async (files: File[]) => {
    if (!files.length) return

    setRecognitionMessages([])
    setMatchingFiles(true)

    const messages: string[] = []
    const assignedTypes = new Set<UploadType>()
    const recognized = await Promise.all(
      files.map(async (file) => {
        const match = await recognizeProductFile(file)
        return { file, ...match }
      })
    )

    recognized.forEach((item) => {
      if (item.type === 'unknown') {
        return
      }

      if (assignedTypes.has(item.type)) {
        messages.push(`已跳过 ${item.file.name}：同批次重复识别为 ${item.type}`)
        return
      }
      assignedTypes.add(item.type)
      onPickFile(item.type, item.file, `拖拽识别：${item.reason}`)
      messages.push(`已识别 ${item.file.name} -> ${item.type}`)
    })

    const unresolvedCsvFiles = recognized.filter(
      (item) => item.type === 'unknown' && getExtension(item.file.name) === '.csv'
    )
    const hasBusinessInBatch = assignedTypes.has('business_report')
    if (!hasBusinessInBatch && unresolvedCsvFiles.length > 0) {
      const candidate = unresolvedCsvFiles[0]
      onPickFile('business_report', candidate.file, '拖拽识别：csv 兜底分配为商业报告')
      assignedTypes.add('business_report')
      messages.push(`已识别 ${candidate.file.name} -> business_report（csv兜底）`)
    }

    recognized
      .filter((item) => item.type === 'unknown')
      .forEach((item) => messages.push(`无法识别 ${item.file.name}：${item.reason}`))

    setRecognitionMessages(messages)
    setMatchingFiles(false)
  }

  const uploadFile = async (key: UploadType) => {
    if (!canUpload) {
      setFormError('项目名称不能为空')
      return
    }

    const target = uploadState[key]
    if (!target.selectedFile) {
      setUploadState((prev) => ({
        ...prev,
        [key]: { ...prev[key], status: 'error', error: '请先选择文件' },
      }))
      return
    }

    setUploadState((prev) => ({
      ...prev,
      [key]: { ...prev[key], status: 'uploading', error: null, uploaded: null },
    }))

    const formData = new FormData()
    formData.append('file', target.selectedFile)
    formData.append('project_name', projectName.trim())
    formData.append('file_type', key)

    try {
      const response = await fetch(`${API_BASE}/api/v1/uploads`, {
        method: 'POST',
        body: formData,
        headers: authHeaders(),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '文件上传失败，请重试')
      }
      const payload = (await response.json()) as {
        file_id?: string
        file_path?: string
        filename?: string
        original_filename?: string
      }
      if (!payload.file_path || !payload.filename || !payload.original_filename) {
        throw new Error('上传成功但响应缺少必要字段')
      }
      setUploadState((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
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
        [key]: {
          ...prev[key],
          status: 'error',
          error: error instanceof Error ? error.message : '文件上传失败，请重试',
          uploaded: null,
        },
      }))
    }
  }

  const uploadAll = async () => {
    for (const item of FILE_CONFIG) {
      const state = uploadState[item.key]
      if (state.selectedFile && state.status !== 'success') {
        // eslint-disable-next-line no-await-in-loop
        await uploadFile(item.key)
      }
    }
  }

  const clearUpload = (key: UploadType) => {
    setUploadState((prev) => ({
      ...prev,
      [key]: {
        status: 'idle',
        selectedFile: null,
        selectedReason: null,
        uploaded: null,
        error: null,
      },
    }))
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    const dropped = Array.from(event.dataTransfer.files ?? [])
    await mapDetectedFiles(dropped)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
  }

  const applyLastWeek = () => {
    const range = getLastWeekRange()
    setStartDate(range.start)
    setEndDate(range.end)
    setFormError(null)
  }

  const generateReport = async () => {
    setFormError(null)
    setSubmitState({ status: 'idle', message: null, filename: null })

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
    if (!requiredUploaded) {
      setFormError('请先完成 3 份必需文件上传（商业/付款/广告）')
      return
    }

    setSubmitState({ status: 'submitting', message: '系统处理中，请稍候...', filename: null })

    try {
      const createJobResponse = await fetch(`${API_BASE}/api/v1/jobs`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          job_type: 'product_analysis',
          file_id: uploadState.business_report.uploaded?.filename ?? '',
          params: {
            project_name: projectName.trim(),
            report_start_date: startDate,
            report_end_date: endDate,
            business_report_path: uploadState.business_report.uploaded?.filePath ?? '',
            payment_report_path: uploadState.payment_report.uploaded?.filePath ?? '',
            ad_report_path: uploadState.ad_report.uploaded?.filePath ?? '',
            inventory_report_path: uploadState.inventory_report.uploaded?.filePath ?? '',
          },
        }),
      })

      if (!createJobResponse.ok) {
        const message = await createJobResponse.text()
        throw new Error(message || '生成失败，请重试')
      }

      const created = (await createJobResponse.json()) as { id: number }
      const jobId = created.id

      let attempts = 0
      const maxAttempts = 120
      let failedMessage: string | null = null
      let finished = false

      while (attempts < maxAttempts && !finished) {
        attempts += 1
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 2000))
        // eslint-disable-next-line no-await-in-loop
        const statusResponse = await fetch(`${API_BASE}/api/v1/jobs/${jobId}`, {
          cache: 'no-store',
          headers: authHeaders(),
        })
        if (!statusResponse.ok) {
          // eslint-disable-next-line no-await-in-loop
          const msg = await statusResponse.text()
          throw new Error(msg || '任务状态查询失败')
        }

        // eslint-disable-next-line no-await-in-loop
        const statusPayload = (await statusResponse.json()) as {
          status: 'pending' | 'running' | 'success' | 'failed'
          runs?: Array<{ error_message?: string | null }>
        }

        if (statusPayload.status === 'failed') {
          failedMessage = statusPayload.runs?.[statusPayload.runs.length - 1]?.error_message ?? '任务执行失败'
          finished = true
          break
        }

        if (statusPayload.status === 'success') {
          finished = true
          break
        }
      }

      if (failedMessage) {
        throw new Error(failedMessage)
      }
      if (!finished) {
        throw new Error('任务执行超时，请稍后重试')
      }

      const response = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/result`, {
        headers: authHeaders(),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '结果下载失败')
      }

      const blob = await response.blob()
      const headerName = extractFilenameFromHeader(response.headers.get('Content-Disposition'))
      const fallbackName = `${projectName.trim()}_product_analysis_${startDate}_${endDate}.xlsx`
      const filename = headerName || fallbackName

      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)

      setSubmitState({
        status: 'success',
        message: `生成成功，已下载 ${filename}`,
        filename,
      })
    } catch (error) {
      setSubmitState({
        status: 'error',
        message: `生成失败：${error instanceof Error ? error.message : '未知错误'}`,
        filename: null,
      })
    }
  }

  return (
    <motion.div initial="hidden" animate="show" variants={containerVariants} className="space-y-6">
      <motion.div variants={itemVariants} className="grid gap-6 2xl:grid-cols-2">
        <Card className="relative overflow-hidden border border-amber-100/80 bg-gradient-to-br from-orange-50 via-white to-amber-50 shadow-lg dark:border-border dark:from-slate-950 dark:via-slate-900 dark:to-slate-900">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-amber-400/10 blur-3xl" />
          <CardHeader className="relative">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Package className="h-5 w-5 text-amber-600" />
              参数控制台
            </CardTitle>
            <CardDescription>先选择项目与日期区间，再上传文件并执行产品分析任务。</CardDescription>
          </CardHeader>
          <CardContent className="relative space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-background/80 p-2.5">
                <p className="text-[11px] text-muted-foreground">项目名称</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{projectName.trim() ? '已填写' : '未填写'}</p>
              </div>
              <div className="rounded-lg border border-border bg-background/80 p-2.5">
                <p className="text-[11px] text-muted-foreground">日期区间</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{dateRangeValid ? '已设置' : '未设置'}</p>
              </div>
              <div className="rounded-lg border border-border bg-background/80 p-2.5">
                <p className="text-[11px] text-muted-foreground">必需文件完成度</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{requiredUploadedCount}/3</p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="project_name" className="text-sm font-medium text-foreground">
                  项目名称
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setManualProjectInput((prev) => !prev)}
                  className="h-7 px-2 text-xs"
                >
                  {manualProjectInput ? '改用下拉候选' : '手动输入'}
                </Button>
              </div>
              {manualProjectInput ? (
                <Input
                  id="project_name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="输入项目名称"
                  className="bg-background"
                />
              ) : (
                <>
                  <Input
                    id="project_name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder={projectsLoading ? '项目加载中...' : '输入或选择项目'}
                    disabled={projectsLoading}
                    list="project-options"
                    className="bg-background"
                  />
                  <datalist id="project-options">
                    {projects.map((project) => (
                      <option key={project.name} value={project.name} />
                    ))}
                  </datalist>
                </>
              )}
              {projectLoadError ? <p className="text-xs text-destructive">{projectLoadError}</p> : null}
            </div>

            <div className="space-y-2">
              <label htmlFor="report_start_date" className="text-sm font-medium text-foreground">
                日期范围
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="report_start_date"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  className="w-[180px] bg-background"
                />
                <span className="text-sm text-muted-foreground">至</span>
                <Input
                  id="report_end_date"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  className="w-[180px] bg-background"
                />
                <Button type="button" variant="secondary" onClick={applyLastWeek}>
                  <CalendarRange className="mr-1 h-4 w-4" />
                  上周
                </Button>
              </div>
              {startDate && endDate && startDate > endDate ? (
                <p className="text-xs text-destructive">开始日期不能晚于结束日期</p>
              ) : null}
            </div>

            <AnimatePresence>
              {formError ? (
                <motion.div
                  variants={statusVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  {formError}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white shadow-xl">
          <div className="pointer-events-none absolute -left-12 -top-12 h-52 w-52 rounded-full bg-cyan-400/15 blur-3xl" />
          <CardHeader className="relative">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Rocket className="h-5 w-5 text-cyan-300" />
              执行控制台
            </CardTitle>
            <CardDescription className="text-white/80">完成前置条件后，一次点击生成并自动下载产品分析文件。</CardDescription>
          </CardHeader>
          <CardContent className="relative space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border border-white/15 bg-white/10 p-3 dark:bg-white/5">
                <p className="text-xs text-white/80 dark:text-white/70">已上传文件</p>
                <p className="mt-1 text-sm font-semibold">{uploadedCount}/4</p>
              </div>
              <div className="rounded-md border border-white/15 bg-white/10 p-3 dark:bg-white/5">
                <p className="text-xs text-white/80 dark:text-white/70">可执行状态</p>
                <p className="mt-1 text-sm font-semibold">{canGenerate ? '可生成' : '未就绪'}</p>
              </div>
              <div className="rounded-md border border-white/15 bg-white/10 p-3 dark:bg-white/5">
                <p className="text-xs text-white/80 dark:text-white/70">最近动作</p>
                <p className="mt-1 truncate text-sm font-semibold">{latestAction}</p>
              </div>
            </div>

            <motion.div
              whileHover={shouldReduceMotion ? undefined : canGenerate ? { scale: 1.01 } : undefined}
              whileTap={shouldReduceMotion ? undefined : canGenerate ? { scale: 0.995 } : undefined}
              transition={{ duration: shouldReduceMotion ? 0.1 : 0.18, ease: 'easeOut' }}
              className={cn(canGenerate && 'rounded-lg ring-2 ring-cyan-300/40 ring-offset-2 ring-offset-slate-900')}
            >
              <Button type="button" className="h-11 w-full bg-blue-600 hover:bg-blue-500" onClick={() => void generateReport()} disabled={!canGenerate}>
                {submitState.status === 'submitting' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
                生成产品分析表
              </Button>
            </motion.div>

            <AnimatePresence mode="popLayout">
              {submitState.filename ? (
                <motion.div variants={statusVariants} initial="hidden" animate="show" exit="exit">
                  <Badge variant="outline" className="justify-center gap-1 border-white/30 text-white">
                    <Download className="h-3.5 w-3.5" />
                    {submitState.filename}
                  </Badge>
                </motion.div>
              ) : (
                <motion.p key="hint" variants={statusVariants} initial="hidden" animate="show" exit="exit" className="text-xs text-white/75">
                  生成后将自动下载，文件名会展示在这里。
                </motion.p>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {submitState.status === 'success' ? (
                <motion.div
                  key="success"
                  variants={statusVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="flex items-center gap-2 rounded-md border border-emerald-400/50 bg-emerald-500/20 px-3 py-2 text-sm text-emerald-100"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {submitState.message}
                </motion.div>
              ) : null}
              {submitState.status === 'error' ? (
                <motion.div
                  key="error"
                  variants={statusVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="flex items-center gap-2 rounded-md border border-rose-400/40 bg-rose-500/20 px-3 py-2 text-sm text-rose-100"
                >
                  <AlertCircle className="h-4 w-4" />
                  {submitState.message}
                </motion.div>
              ) : null}
              {submitState.status === 'submitting' ? (
                <motion.div
                  key="submitting"
                  variants={statusVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="flex items-center gap-2 rounded-md border border-cyan-300/30 bg-cyan-500/20 px-3 py-2 text-sm text-cyan-100"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {submitState.message}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="border-0 bg-card shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileSearch className="h-5 w-5 text-blue-600" />
              文件识别与上传工作台
            </CardTitle>
            <CardDescription>支持拖拽识别、批量投递与单文件重试，满足 3 必需 + 1 可选上传流程。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <motion.div
              animate={dragActive ? { scale: shouldReduceMotion ? 1 : 1.01 } : { scale: 1 }}
              transition={shouldReduceMotion ? { duration: 0.1 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'relative overflow-hidden rounded-xl border-2 border-dashed p-6 text-center',
                dragActive
                  ? 'border-blue-500/70 bg-gradient-to-br from-blue-500/10 to-cyan-500/10 shadow-md'
                  : 'border-border bg-gradient-to-br from-muted/60 via-background to-cyan-500/10'
              )}
              onDrop={(event) => void onDrop(event)}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
            >
              <div className={cn('pointer-events-none absolute inset-0 opacity-0 transition-opacity', dragActive && 'opacity-100')}>
                <div className="absolute -left-12 -top-16 h-36 w-36 rounded-full bg-blue-300/30 blur-2xl" />
                <div className="absolute -bottom-14 right-0 h-36 w-36 rounded-full bg-cyan-300/30 blur-2xl" />
              </div>

              <p className="relative text-sm font-semibold text-foreground">拖拽文件到这里，系统会自动识别并分发到对应卡片</p>
              <p className="relative mt-1 text-xs text-muted-foreground">
                规则：商业(csv)、付款(csv+Includes Amazon Marketplace)、广告(xlsx)、库存(txt+snapshot-date)
              </p>

              <div className="relative mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant="outline" onClick={() => document.getElementById('smart-file-picker')?.click()}>
                  选择多个文件识别
                </Button>
                <Input
                  id="smart-file-picker"
                  type="file"
                  multiple
                  accept=".txt,.xlsx,.csv"
                  className="hidden"
                  onChange={(event) => void mapDetectedFiles(Array.from(event.target.files ?? []))}
                />
                <Button type="button" onClick={() => void uploadAll()} disabled={!canUpload || matchingFiles} className="bg-blue-600 hover:bg-blue-500">
                  {matchingFiles ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  一键上传已识别文件
                </Button>
              </div>
            </motion.div>

            <div className="grid gap-3 md:grid-cols-4">
              {FILE_CONFIG.map((fileItem) => {
                const state = uploadState[fileItem.key]
                const meta = getStatusMeta(state)
                return (
                  <motion.div
                    key={fileItem.key}
                    layout
                    whileHover={shouldReduceMotion ? undefined : { y: -2 }}
                    transition={{ duration: shouldReduceMotion ? 0.1 : 0.2, ease: 'easeOut' }}
                    className="rounded-xl border border-border bg-muted/40 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="font-semibold text-foreground">{fileItem.title}</span>
                      <span className="text-xs text-muted-foreground">{meta.text}</span>
                    </div>
                    <UploadProgressRail meta={meta} reduceMotion={!!shouldReduceMotion} />
                    <p className="mt-2 truncate text-xs text-muted-foreground">
                      {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
                    </p>
                  </motion.div>
                )
              })}
            </div>

            <AnimatePresence>
              {recognitionMessages.length ? (
                <motion.div
                  variants={statusVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="max-h-44 space-y-1 overflow-auto rounded-md border bg-muted/20 p-3 text-xs text-foreground dark:bg-muted/30"
                >
                  {recognitionMessages.map((message) => (
                    <motion.p key={message} variants={logItemVariants} initial="hidden" animate="show" exit="exit">
                      {message}
                    </motion.p>
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div className="space-y-3">
              {FILE_CONFIG.map((fileItem) => (
                <UploadRow
                  key={fileItem.key}
                  fileItem={fileItem}
                  state={uploadState[fileItem.key]}
                  canUpload={canUpload}
                  reduceMotion={!!shouldReduceMotion}
                  onPickFile={onPickFile}
                  onUpload={uploadFile}
                  onReset={clearUpload}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="border border-amber-200/70 bg-gradient-to-r from-amber-50 to-orange-50 shadow-sm dark:border-border dark:from-slate-900 dark:to-slate-900">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="h-4 w-4 text-amber-600" />
              主要指标口径说明
            </CardTitle>
            <CardDescription>用于页面验收与结果核对，口径与业务文档保持一致。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
            <p>总转化 = 总销量 / 页面浏览量</p>
            <p>广告点击率 = 广告点击量 / 广告展示量</p>
            <p>广告单占比 = 广告订单量 / 总销量</p>
            <p>CPC = 广告花费 / 广告点击量</p>
            <p>ACOS = 广告花费 / 广告销售额</p>
            <p>利润率 = 利润 / 实际销售额</p>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}
