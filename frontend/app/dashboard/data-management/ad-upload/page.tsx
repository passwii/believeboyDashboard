'use client'

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { useSession } from 'next-auth/react'
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  FileSpreadsheet,
  HelpCircle,
  Loader2,
  Radar,
  ShieldCheck,
  Upload,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

const API_BASE = '/api/backend'
const COUNTRY_OPTIONS = [
  { value: 'US', label: 'US 美国站' },
  { value: 'DE', label: 'DE 德国站' },
  { value: 'UK', label: 'UK 英国站' },
] as const

type ProjectItem = {
  id: number
  name: string
}

type ProjectMatchSummary = {
  status: 'unmatched' | 'matched' | 'conflict' | 'manual'
  project_name: string | null
  candidate_projects: string[]
  matched_by: string | null
  matched_values: string[]
  message: string | null
}

type RecognitionResponse = {
  temp_file_id: string
  original_filename: string
  extension: string
  report_type: string
  report_label: string
  matched_columns: string[]
  reason: string
  status: 'recognized' | 'unsupported' | 'error'
  country: string
  detected_report_date: string | null
  detected_start_date: string | null
  detected_end_date: string | null
  project_match: ProjectMatchSummary
  row_count_preview: number | null
  warnings: string[]
}

type CommitResponse = {
  id: number
  report_type: string
  report_label: string
  ingestion_status: 'pending' | 'saved' | 'failed'
  project_name: string
  country: string
  report_date: string | null
  report_start_date: string
  report_end_date: string
  file_id: string
  file_path: string
  version: number
  is_current: boolean
  message: string
}

type StatusItem = {
  id: number
  project_name: string
  report_type: string
  report_label: string
  country: string
  report_date: string | null
  report_start_date: string
  report_end_date: string
  version: number
  is_current: boolean
  recognition_status: 'recognized' | 'unsupported' | 'error'
  ingestion_status: 'pending' | 'saved' | 'failed'
  original_filename: string | null
  row_count_preview: number | null
  updated_at: string | null
  warnings: string[]
}

type StatusResponse = {
  country: string
  items: StatusItem[]
}

type QueueItem = {
  localId: string
  originalFilename: string
  recognitionStatus: 'recognizing' | 'recognized' | 'error'
  recognition: RecognitionResponse | null
  selectedProject: string
  commitStatus: 'idle' | 'saving' | 'success' | 'error'
  commitMessage: string | null
  error: string | null
  commitResult: CommitResponse | null
}

type BatchProjectState = {
  status: 'idle' | 'resolved' | 'missing' | 'conflict'
  projectName: string | null
  sourceFilename: string | null
  message: string
}

async function parseError(response: Response): Promise<string> {
  return parseResponseError(response, '请求失败')
}

function formatDateRange(start?: string | null, end?: string | null) {
  if (start && end) return `${start} ~ ${end}`
  return start || end || '-'
}

function formatSingleDate(value?: string | null) {
  return value || '-'
}

function formatUpdatedAt(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getRecognitionSingleDayDate(recognition: RecognitionResponse | null) {
  if (!recognition) return null
  if (
    recognition.detected_start_date &&
    recognition.detected_end_date &&
    recognition.detected_start_date === recognition.detected_end_date
  ) {
    return recognition.detected_start_date
  }
  return null
}

function isPeriodicRecognition(recognition: RecognitionResponse | null) {
  if (!recognition) return false
  return (
    recognition.report_type.startsWith('ad_') &&
    Boolean(recognition.detected_start_date) &&
    Boolean(recognition.detected_end_date) &&
    recognition.detected_start_date !== recognition.detected_end_date
  )
}

function getBatchStatusLabel(status: BatchProjectState['status']) {
  if (status === 'resolved') return '项目已锁定'
  if (status === 'conflict') return '项目冲突'
  if (status === 'missing') return '待识别'
  return '等待识别'
}

function getBatchStatusTone(status: BatchProjectState['status']) {
  if (status === 'resolved') return 'secondary'
  if (status === 'conflict') return 'destructive'
  return 'outline'
}

function getRecognitionTone(status: QueueItem['recognitionStatus']) {
  if (status === 'recognized') return 'secondary'
  if (status === 'error') return 'destructive'
  return 'outline'
}

function getRecognitionLabel(status: QueueItem['recognitionStatus']) {
  if (status === 'recognized') return '已识别'
  if (status === 'error') return '失败'
  return '识别中'
}

export default function AdUploadPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadPanelRef = useRef<HTMLDivElement | null>(null)
  const { data: session, status: sessionStatus } = useSession()

  const [country, setCountry] = useState<'US' | 'DE' | 'UK'>('US')
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [batchProject, setBatchProject] = useState<BatchProjectState>({
    status: 'idle',
    projectName: null,
    sourceFilename: null,
    message: '当前批次等待通过“推广的商品”报表识别项目。',
  })
  const [statusItems, setStatusItems] = useState<StatusItem[]>([])
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [commitAllBusy, setCommitAllBusy] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadPanelHeight, setUploadPanelHeight] = useState<number | null>(null)

  const batchResolvedDate = (() => {
    const values = Array.from(
      new Set(
        queue
          .map((item) => getRecognitionSingleDayDate(item.recognition))
          .filter((value): value is string => Boolean(value)),
      ),
    )
    return values.length === 1 ? values[0] : null
  })()

  useEffect(() => {
    if (sessionStatus === 'loading') return
    let cancelled = false

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const payload = await fetchManagedProjectsCached<ProjectItem[]>(session)
        if (!cancelled) setProjects(payload)
      } catch (error) {
        if (!cancelled) {
          setProjectsError(normalizeErrorMessage(error, '项目列表加载失败'))
        }
      } finally {
        if (!cancelled) setProjectsLoading(false)
      }
    }

    void loadProjects()
    return () => {
      cancelled = true
    }
  }, [session, sessionStatus])

  useEffect(() => {
    let cancelled = false

    async function loadStatuses() {
      setStatusLoading(true)
      setStatusError(null)
      try {
        const response = await fetch(
          `${API_BASE}/api/v1/ad-upload/status?country=${country}&limit=30`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const payload = (await response.json()) as StatusResponse
        if (!cancelled) setStatusItems(payload.items)
      } catch (error) {
        if (!cancelled) {
          setStatusError(normalizeErrorMessage(error, '状态列表加载失败'))
        }
      } finally {
        if (!cancelled) setStatusLoading(false)
      }
    }

    void loadStatuses()
    return () => {
      cancelled = true
    }
  }, [country])

  useEffect(() => {
    const element = uploadPanelRef.current
    if (!element) return

    const updateHeight = () => {
      setUploadPanelHeight(element.getBoundingClientRect().height)
    }

    updateHeight()

    const observer = new ResizeObserver(() => {
      updateHeight()
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [batchProject.message, batchProject.projectName, batchProject.sourceFilename, batchProject.status, country, projects.length, projectsError, projectsLoading, uploadBusy])

  function updateQueueItem(localId: string, updater: (item: QueueItem) => QueueItem) {
    setQueue((current) => current.map((item) => (item.localId === localId ? updater(item) : item)))
  }

  function applyBatchProject(projectName: string) {
    setQueue((current) =>
      current.map((item) => ({
        ...item,
        selectedProject: projectName,
      })),
    )
  }

  function syncBatchProjectFromRecognition(payload: RecognitionResponse) {
    if (payload.report_type !== 'ad_promoted_product_report') return

    if (payload.project_match.status === 'matched' && payload.project_match.project_name) {
      const matchedProjectName = payload.project_match.project_name
      setBatchProject((current) => {
        if (current.status === 'resolved' && current.projectName && current.projectName !== matchedProjectName) {
          return {
            status: 'conflict',
            projectName: null,
            sourceFilename: payload.original_filename,
            message: `当前批次识别出多个不同项目：${current.projectName} / ${matchedProjectName}，请拆分批次重新上传。`,
          }
        }
        applyBatchProject(matchedProjectName)
        return {
          status: 'resolved',
          projectName: matchedProjectName,
          sourceFilename: payload.original_filename,
          message: `当前批次项目已锁定为 ${matchedProjectName}，来源于推广的商品报表。`,
        }
      })
      return
    }

    setBatchProject((current) => {
      if (current.status === 'resolved' || current.status === 'conflict') return current
      return {
        status: 'missing',
        projectName: null,
        sourceFilename: payload.original_filename,
        message:
          payload.project_match.message ||
          '推广的商品报表未能匹配到唯一项目，当前批次暂时不能入库。',
      }
    })
  }

  async function recognizeFile(file: File, activeCountry: string) {
    const localId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const pendingItem: QueueItem = {
      localId,
      originalFilename: file.name,
      recognitionStatus: 'recognizing',
      recognition: null,
      selectedProject: '',
      commitStatus: 'idle',
      commitMessage: null,
      error: null,
      commitResult: null,
    }
    setQueue((current) => [pendingItem, ...current])

    const formData = new FormData()
    formData.append('file', file)
    formData.append('country', activeCountry)

    try {
      const response = await fetch(`${API_BASE}/api/v1/ad-upload/recognize`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as RecognitionResponse
      syncBatchProjectFromRecognition(payload)
      updateQueueItem(localId, (item) => ({
        ...item,
        recognitionStatus: 'recognized',
        recognition: payload,
        selectedProject:
          payload.report_type === 'ad_promoted_product_report'
            ? payload.project_match.project_name || ''
            : item.selectedProject,
      }))
    } catch (error) {
      updateQueueItem(localId, (item) => ({
        ...item,
        recognitionStatus: 'error',
        error: normalizeErrorMessage(error, '识别失败'),
      }))
    }
  }

  async function processFiles(files: File[]) {
    if (!files.length) return

    setQueue([])
    setBatchProject({
      status: 'idle',
      projectName: null,
      sourceFilename: null,
      message: '当前批次等待通过“推广的商品”报表识别项目。',
    })
    setUploadBusy(true)
    try {
      const sortedFiles = [...files].sort((left, right) => {
        const leftPriority = left.name.includes('推广的商品') ? 0 : 1
        const rightPriority = right.name.includes('推广的商品') ? 0 : 1
        return leftPriority - rightPriority
      })
      for (const file of sortedFiles) {
        await recognizeFile(file, country)
      }
    } finally {
      setUploadBusy(false)
    }
  }

  async function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    try {
      await processFiles(files)
    } finally {
      event.target.value = ''
    }
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    if (!uploadBusy) setIsDragging(true)
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDragging(false)
  }

  async function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setIsDragging(false)
    if (uploadBusy) return
    const files = Array.from(event.dataTransfer.files || [])
    if (!files.length) return
    await processFiles(files)
  }

  function clearRecognitionState() {
    setQueue([])
    setBatchProject({
      status: 'idle',
      projectName: null,
      sourceFilename: null,
      message: '当前批次等待通过“推广的商品”报表识别项目。',
    })
  }

  async function refreshStatuses() {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/ad-upload/status?country=${country}&limit=30`,
        { cache: 'no-store' },
      )
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as StatusResponse
      setStatusItems(payload.items)
    } catch (error) {
      setStatusError(normalizeErrorMessage(error, '状态列表加载失败'))
    } finally {
      setStatusLoading(false)
    }
  }

  async function handleCommit(item: QueueItem, projectName: string) {
    if (!item.recognition) return
    if (!projectName) {
      updateQueueItem(item.localId, (current) => ({
        ...current,
        commitStatus: 'error',
        commitMessage: '当前批次项目尚未锁定，无法保存',
      }))
      return
    }

    updateQueueItem(item.localId, (current) => ({
      ...current,
      commitStatus: 'saving',
      commitMessage: null,
    }))

    try {
      const fallbackDate =
        getRecognitionSingleDayDate(item.recognition) ||
        (item.recognition.row_count_preview === 0 ? batchResolvedDate : null)

      const response = await fetch(`${API_BASE}/api/v1/ad-upload/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          temp_file_id: item.recognition.temp_file_id,
          report_type: item.recognition.report_type,
          original_filename: item.recognition.original_filename,
          project_name: projectName,
          country: item.recognition.country,
          report_date: fallbackDate,
          report_start_date: item.recognition.detected_start_date || fallbackDate,
          report_end_date: item.recognition.detected_end_date || fallbackDate,
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as CommitResponse
      updateQueueItem(item.localId, (current) => ({
        ...current,
        selectedProject: payload.project_name,
        commitStatus: 'success',
        commitMessage: payload.message,
        commitResult: payload,
      }))
      await refreshStatuses()
    } catch (error) {
      updateQueueItem(item.localId, (current) => ({
        ...current,
        commitStatus: 'error',
        commitMessage: normalizeErrorMessage(error, '保存失败'),
      }))
    }
  }

  async function handleCommitAll() {
    if (batchProject.status !== 'resolved' || !batchProject.projectName) return
    setCommitAllBusy(true)
    try {
      for (const item of queue) {
        if (item.recognitionStatus !== 'recognized' || !item.recognition) continue
        if (item.commitStatus === 'success') continue
        await handleCommit(item, batchProject.projectName)
      }
    } finally {
      setCommitAllBusy(false)
    }
  }

  return (
    <div className='space-y-5'>
      <div className='grid gap-5 lg:grid-cols-[420px_minmax(0,1fr)]'>
        <div ref={uploadPanelRef} className='space-y-5'>
          <Card className='overflow-hidden'>
            <CardHeader className='pb-4'>
              <div className='flex items-center gap-2'>
                <FileSpreadsheet className='h-5 w-5 text-primary' />
                <CardTitle className='text-lg'>上传区</CardTitle>
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type='button'
                        className='inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground'
                        aria-label='上传说明'
                      >
                        <HelpCircle className='h-4 w-4' />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-[260px] rounded-xl px-3 py-2 text-sm leading-6'>
                      <p>项目权限范围。</p>
                      <p>批次规则。</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='space-y-2'>
                <p className='text-sm font-medium'>站点</p>
                <Select value={country} onValueChange={(value) => setCountry(value as 'US' | 'DE' | 'UK')}>
                  <SelectTrigger className='h-11 rounded-xl'>
                    <SelectValue placeholder='选择站点' />
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

              <Input
                ref={fileInputRef}
                className='sr-only'
                type='file'
                multiple
                accept='.csv,.xlsx'
                onChange={handleFileSelection}
                disabled={uploadBusy}
              />

              <button
                type='button'
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={(event) => void handleDrop(event)}
                disabled={uploadBusy}
                className={`group w-full rounded-[24px] border border-dashed p-5 text-left transition disabled:cursor-not-allowed ${
                  isDragging
                    ? 'border-sky-500 bg-[linear-gradient(160deg,rgba(239,246,255,1),rgba(219,234,254,0.95))] shadow-[0_0_0_4px_rgba(14,165,233,0.12)] dark:border-sky-400 dark:bg-[linear-gradient(160deg,rgba(12,74,110,0.55),rgba(15,23,42,0.86))]'
                    : 'border-slate-300 bg-[linear-gradient(160deg,rgba(248,250,252,1),rgba(241,245,249,0.82))] hover:border-slate-400 hover:bg-[linear-gradient(160deg,rgba(255,255,255,1),rgba(241,245,249,0.96))] dark:border-slate-700 dark:bg-[linear-gradient(160deg,rgba(15,23,42,0.82),rgba(15,23,42,0.55))]'
                }`}
              >
                <div className='flex items-start justify-between gap-3'>
                  <div className='space-y-3'>
                    <div className='flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'>
                      {uploadBusy ? <Loader2 className='h-5 w-5 animate-spin' /> : <Upload className='h-5 w-5' />}
                    </div>
                    <div className='space-y-1'>
                      <p className='text-base font-semibold'>选择广告报表</p>
                      <p className='text-sm text-muted-foreground'>支持拖拽或点击上传，按当前站点直接识别</p>
                    </div>
                  </div>
                  <Badge
                    variant='outline'
                    className='min-w-fit rounded-full border-border/80 bg-background/90 px-3 py-1 text-xs font-medium text-foreground/80 shadow-sm'
                  >
                    <span className='whitespace-nowrap'>
                      {uploadBusy ? '识别中' : isDragging ? '释放上传' : '开始上传'}
                    </span>
                  </Badge>
                </div>
              </button>

              <div className='rounded-[24px] border border-border/70 bg-background/80 p-5'>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <p className='text-xs uppercase tracking-[0.18em] text-muted-foreground'>批次项目</p>
                  <Badge variant={getBatchStatusTone(batchProject.status)}>{getBatchStatusLabel(batchProject.status)}</Badge>
                </div>
                <div className='mt-3 flex items-center gap-3'>
                  <div className={`h-3 w-3 rounded-full ${batchProject.status === 'resolved' ? 'bg-emerald-500' : batchProject.status === 'conflict' ? 'bg-red-500' : 'bg-amber-500'}`} />
                  <p className='text-2xl font-semibold tracking-tight'>
                    {batchProject.projectName || '未锁定'}
                  </p>
                </div>
                <p className='mt-3 text-sm leading-6 text-muted-foreground'>{batchProject.message}</p>
                {batchProject.sourceFilename ? (
                  <div className='mt-4 rounded-2xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-2.5'>
                    <p className='text-xs text-muted-foreground'>来源文件</p>
                    <p className='mt-1 text-sm font-medium break-all'>{batchProject.sourceFilename}</p>
                  </div>
                ) : null}
              </div>

              <Button
                type='button'
                className='h-11 w-full rounded-xl'
                onClick={() => void handleCommitAll()}
                disabled={commitAllBusy || batchProject.status !== 'resolved'}
              >
                {commitAllBusy ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : <ShieldCheck className='mr-2 h-4 w-4' />}
                批次全部入库
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card className='overflow-hidden xl:self-start' style={uploadPanelHeight ? { height: `${uploadPanelHeight}px` } : undefined}>
          <CardHeader className='pb-4'>
            <div className='flex items-center justify-between gap-3'>
              <div className='flex items-center gap-2'>
                <Radar className='h-5 w-5 text-primary' />
                <CardTitle className='text-lg'>识别结果</CardTitle>
              </div>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='rounded-full'
                onClick={clearRecognitionState}
                disabled={queue.length === 0 || uploadBusy || commitAllBusy}
              >
                清除状态
              </Button>
            </div>
          </CardHeader>
          <CardContent className='flex h-[calc(100%-73px)] min-h-0 flex-col overflow-hidden'>
            <div className='min-h-0 space-y-4 overflow-y-auto pr-1'>
            {queue.length === 0 ? (
              <EmptyState
                icon='file'
                rowHeight='lg'
                message='上传报表后，这里会显示识别结果和入库动作。'
              />
            ) : (
              <>
                {queue.map((item) => {
                  const recognition = item.recognition
                  const effectiveSingleDayDate =
                    getRecognitionSingleDayDate(recognition) ||
                    (recognition?.row_count_preview === 0 ? batchResolvedDate : null)
                  const canCommit =
                    Boolean(recognition) &&
                    batchProject.status === 'resolved' &&
                    Boolean(effectiveSingleDayDate || isPeriodicRecognition(recognition))

                  return (
                    <div
                      key={item.localId}
                      className='rounded-[24px] border border-border/70 bg-[hsl(var(--surface-panel))] p-4 shadow-[var(--shadow-soft)] dark:border-border/90'
                    >
                      <div className='flex flex-wrap items-start justify-between gap-4'>
                        <div className='min-w-0 flex-1 space-y-3'>
                          <div className='flex flex-wrap items-center gap-2'>
                            <p className='truncate text-base font-semibold'>{item.originalFilename}</p>
                            <Badge variant={getRecognitionTone(item.recognitionStatus)}>
                              {item.recognitionStatus === 'recognizing' ? (
                                <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
                              ) : item.recognitionStatus === 'recognized' ? (
                                <CheckCircle2 className='mr-1 h-3.5 w-3.5' />
                              ) : (
                                <AlertCircle className='mr-1 h-3.5 w-3.5' />
                              )}
                              {getRecognitionLabel(item.recognitionStatus)}
                            </Badge>
                            {item.commitStatus === 'success' ? (
                              <Badge variant='outline'>v{item.commitResult?.version ?? 1}</Badge>
                            ) : null}
                          </div>

                          {recognition ? (
                            <div className='grid gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]'>
                              <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3'>
                                <p className='text-[11px] uppercase tracking-[0.16em] text-muted-foreground'>报表</p>
                                <p className='mt-1 text-sm font-medium'>{recognition.report_label}</p>
                              </div>
                              <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3'>
                                <p className='text-[11px] uppercase tracking-[0.16em] text-muted-foreground'>日期</p>
                                <p className='mt-1 text-sm font-medium'>
                                  {isPeriodicRecognition(recognition)
                                    ? formatDateRange(recognition.detected_start_date, recognition.detected_end_date)
                                    : formatSingleDate(effectiveSingleDayDate || recognition.detected_start_date)}
                                </p>
                              </div>
                              <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3'>
                                <p className='text-[11px] uppercase tracking-[0.16em] text-muted-foreground'>站点</p>
                                <p className='mt-1 text-sm font-medium'>{recognition.country}</p>
                              </div>
                              <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3'>
                                <p className='text-[11px] uppercase tracking-[0.16em] text-muted-foreground'>预览</p>
                                <p className='mt-1 text-sm font-medium'>{recognition.row_count_preview ?? 0} 行</p>
                              </div>
                              <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3'>
                                <p className='text-[11px] uppercase tracking-[0.16em] text-muted-foreground'>
                                  {recognition.report_type === 'ad_promoted_product_report' ? '识别结果' : '项目'}
                                </p>
                                <div className='mt-1 flex items-center gap-2'>
                                  <p className='text-sm font-medium'>
                                    {recognition.report_type === 'ad_promoted_product_report'
                                      ? recognition.project_match.project_name || '未识别到唯一项目'
                                      : batchProject.projectName || '等待批次项目'}
                                  </p>
                                  <Badge
                                    variant={
                                      recognition.project_match.status === 'matched'
                                        ? 'secondary'
                                        : recognition.project_match.status === 'conflict'
                                          ? 'destructive'
                                          : 'outline'
                                    }
                                  >
                                    {recognition.report_type === 'ad_promoted_product_report'
                                      ? recognition.project_match.status === 'matched'
                                        ? '已匹配'
                                        : recognition.project_match.status === 'conflict'
                                          ? '有冲突'
                                          : '待识别'
                                      : batchProject.projectName
                                        ? '已继承'
                                        : '等待中'}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        {recognition ? (
                          <Button
                            type='button'
                            className='h-11 rounded-xl'
                            onClick={() => void handleCommit(item, batchProject.projectName || '')}
                            disabled={item.commitStatus === 'saving' || !canCommit}
                          >
                            {item.commitStatus === 'saving' ? (
                              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                            ) : (
                              <ShieldCheck className='mr-2 h-4 w-4' />
                            )}
                            保存
                          </Button>
                        ) : null}
                      </div>

                      {item.error ? (
                        <div className='mt-4 rounded-2xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
                          {item.error}
                        </div>
                      ) : null}

                      {recognition ? (
                        <div className='mt-3 space-y-3'>
                          {recognition.warnings.length > 0 ? (
                            <div className='rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'>
                              {recognition.warnings.join('；')}
                            </div>
                          ) : null}

                          {recognition.row_count_preview === 0 && batchResolvedDate ? (
                            <div className='rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'>
                              空报表按 {batchResolvedDate} 入库。
                            </div>
                          ) : null}

                          {item.commitMessage ? (
                            <div
                              className={`rounded-2xl px-3 py-2.5 text-sm ${
                                item.commitStatus === 'success'
                                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
                                  : item.commitStatus === 'error'
                                    ? 'border border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
                                    : 'border border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                              }`}
                            >
                              {item.commitMessage}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </>
            )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className='overflow-hidden'>
        <CardHeader className='pb-4'>
          <div className='flex items-center gap-2'>
            <BarChart3 className='h-5 w-5 text-primary' />
            <CardTitle className='text-lg'>最新状态</CardTitle>
          </div>
        </CardHeader>
        <CardContent className='space-y-4'>
            {statusError ? (
              <div className='rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
                {statusError}
              </div>
            ) : null}

            {statusLoading ? (
              <EmptyState rowHeight='lg' message='正在加载 ad-upload 状态...' />
            ) : statusItems.length === 0 ? (
              <EmptyState rowHeight='lg' message='当前还没有保存记录，先上传并提交一个广告报表吧。' />
            ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                    <TableHead>项目</TableHead>
                    <TableHead>报表</TableHead>
                    <TableHead>周期</TableHead>
                    <TableHead>版本</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>更新时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statusItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className='align-top'>
                        <div className='space-y-1'>
                          <p className='font-medium'>{item.project_name}</p>
                          <p className='text-xs text-muted-foreground'>{item.original_filename || '-'}</p>
                        </div>
                      </TableCell>
                      <TableCell className='align-top'>
                        <div className='space-y-1'>
                          <p>{item.report_label}</p>
                          <p className='text-xs text-muted-foreground'>{item.report_type}</p>
                        </div>
                      </TableCell>
                      <TableCell className='align-top'>
                        <div className='space-y-1'>
                          <p>{formatDateRange(item.report_start_date, item.report_end_date)}</p>
                          <p className='text-xs text-muted-foreground'>
                            预览 {item.row_count_preview ?? 0} 行 / {item.country}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className='align-top'>
                        <div className='flex flex-wrap gap-2'>
                          <Badge variant='outline'>v{item.version}</Badge>
                          {item.is_current ? <Badge variant='secondary'>current</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className='align-top'>
                        <div className='flex flex-wrap gap-2'>
                          <Badge variant='secondary'>{item.ingestion_status}</Badge>
                          <Badge variant='outline'>{item.recognition_status}</Badge>
                        </div>
                      </TableCell>
                      <TableCell className='align-top text-sm text-muted-foreground'>
                        {formatUpdatedAt(item.updated_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                </Table>
            )}
        </CardContent>
      </Card>
    </div>
  )
}
