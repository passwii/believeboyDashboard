'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import {
  AlertCircle,
  CalendarDays,
  Download,
  FileSearch,
  Loader2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { recognizeDataFile, type RecognizedFileType } from '@/lib/file-recognition'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type UploadType = 'sales_report' | 'ad_report' | 'inventory_report'
type AssignedType = UploadType | 'skip'
type UploadStatus = 'empty' | 'ready' | 'uploading' | 'success' | 'error'

type ProjectOption = {
  name: string
}

type MappingRow = {
  id: string
  file: File
  detectedType: RecognizedFileType
  detectedReason: string
  assignedType: AssignedType
  matchFailed: boolean
}

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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''
const REQUIRED_TYPES: UploadType[] = ['sales_report', 'ad_report', 'inventory_report']

const TYPE_LABEL: Record<UploadType, string> = {
  sales_report: '销售报表',
  ad_report: '广告报表',
  inventory_report: '库存报告',
}

function authHeaders(operator?: string, isAdmin = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (API_KEY) headers['X-API-Key'] = API_KEY
  if (isAdmin) headers['X-Is-Admin'] = 'true'
  if (operator && operator.trim()) headers['X-Operator'] = encodeURIComponent(operator.trim())
  return headers
}

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

function yesterdayDateString() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function extractFilenameFromHeader(contentDisposition: string | null) {
  if (!contentDisposition) return null
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1])
  const basicMatch = contentDisposition.match(/filename="?([^"]+)"?/i)
  return basicMatch?.[1] ?? null
}

function createEmptyUploadState(): Record<UploadType, UploadStateItem> {
  return {
    sales_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    ad_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    inventory_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
  }
}

function isUploadType(value: string): value is UploadType {
  return value === 'sales_report' || value === 'ad_report' || value === 'inventory_report'
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
  return { text: '未识别', dot: 'bg-slate-400', bar: 'bg-slate-300' }
}

export default function DailyReportPage() {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (session?.user?.operatorNameZh || session?.user?.name || session?.user?.email || session?.user?.id || '').trim()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [reportDate, setReportDate] = useState(yesterdayDateString())
  const [formError, setFormError] = useState<string | null>(null)

  const [mappingRows, setMappingRows] = useState<MappingRow[]>([])
  const [mappingBusy, setMappingBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const [uploadState, setUploadState] = useState<Record<UploadType, UploadStateItem>>(createEmptyUploadState)
  const [uploadBusy, setUploadBusy] = useState(false)

  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle', message: null, filename: null })

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        })
        if (!response.ok) throw new Error(`项目列表加载失败 (${response.status})`)
        const data = (await response.json()) as ProjectOption[]
        setProjects(data)
      } catch (error) {
        setProjectLoadError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [currentOperator, isAdmin])

  useEffect(() => {
    setUploadState((prev) => {
      const next = { ...prev }
      REQUIRED_TYPES.forEach((type) => {
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

        if (previous.mappedRowId === assigned.id && (previous.status === 'success' || previous.status === 'uploading')) {
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
    () => REQUIRED_TYPES.filter((type) => uploadState[type].status !== 'empty').length,
    [uploadState]
  )

  const uploadedCount = useMemo(
    () => REQUIRED_TYPES.filter((type) => uploadState[type].status === 'success').length,
    [uploadState]
  )

  const manualMatchRows = useMemo(
    () => mappingRows.filter((row) => row.matchFailed && row.assignedType === 'skip'),
    [mappingRows]
  )

  const dropZoneHeight = Math.min(420, 190 + Math.max(3, manualMatchRows.length + REQUIRED_TYPES.length) * 26)

  const canGenerate =
    projectName.trim().length > 0 &&
    reportDate.length > 0 &&
    REQUIRED_TYPES.every((type) => uploadState[type].status === 'success') &&
    submitState.status !== 'submitting'

  const addFiles = async (files: File[]) => {
    if (!files.length) return

    setFormError(null)
    setMappingBusy(true)

    const detectedRows = await Promise.all(
      files.map(async (file) => {
        const match = await recognizeDataFile(file)
        return { file, ...match }
      })
    )

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
        throw new Error(message || '文件上传失败，请重试。')
      }

      const payload = (await response.json()) as {
        file_path?: string
        filename?: string
        original_filename?: string
      }

      if (!payload.file_path || !payload.filename || !payload.original_filename) {
        throw new Error('上传成功但响应缺少必要字段。')
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
          error: error instanceof Error ? error.message : '文件上传失败，请重试。',
          uploaded: null,
        },
      }))
    }
  }

  const uploadAllConfirmed = async () => {
    if (uploadBusy) return
    setUploadBusy(true)
    for (const type of REQUIRED_TYPES) {
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

    if (!projectName.trim()) {
      setFormError('项目名称不能为空。')
      return
    }
    if (!reportDate) {
      setFormError('报表日期不能为空。')
      return
    }
    if (!REQUIRED_TYPES.every((type) => uploadState[type].status === 'success')) {
      setFormError('请先完成销售/广告/库存三份文件上传。')
      return
    }

    const salesReportFileId = uploadState.sales_report.uploaded?.filename
    const adReportFileId = uploadState.ad_report.uploaded?.filename
    const inventoryReportFileId = uploadState.inventory_report.uploaded?.filename

    if (!salesReportFileId || !adReportFileId || !inventoryReportFileId) {
      setFormError('上传结果异常，请重新上传文件。')
      return
    }

    setSubmitState({ status: 'submitting', message: '系统处理中，请稍候...', filename: null })

    try {
      const createJobResponse = await fetch(`${API_BASE}/api/v1/daily-reports`, {
        method: 'POST',
        headers: {
          ...authHeaders(currentOperator, isAdmin),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_name: projectName.trim(),
          report_date: reportDate,
          sales_report_file_id: salesReportFileId,
          ad_report_file_id: adReportFileId,
          inventory_report_file_id: inventoryReportFileId,
        }),
      })

      if (!createJobResponse.ok) {
        const message = await createJobResponse.text()
        throw new Error(message || '生成失败，请重试。')
      }

      const created = (await createJobResponse.json()) as {
        job_id: number
        status_endpoint?: string
        result_endpoint?: string
        status?: 'pending' | 'running' | 'success' | 'failed'
      }
      const jobId = created.job_id
      const statusEndpoint = created.status_endpoint?.trim() || `/api/v1/daily-reports/tasks/${jobId}`
      const resultEndpoint = created.result_endpoint?.trim() || `/api/v1/daily-reports/tasks/${jobId}/result`

      let attempts = 0
      let finished = created.status === 'success'
      let failedMessage: string | null = null

      while (attempts < 120 && !finished) {
        attempts += 1
        // eslint-disable-next-line no-await-in-loop
        const statusResponse = await fetch(resolveApiUrl(statusEndpoint), {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        })

        if (!statusResponse.ok) {
          // eslint-disable-next-line no-await-in-loop
          const message = await statusResponse.text()
          throw new Error(message || '任务状态查询失败。')
        }

        // eslint-disable-next-line no-await-in-loop
        const statusPayload = (await statusResponse.json()) as {
          status: 'pending' | 'running' | 'success' | 'failed'
          message?: string | null
          error_message?: string | null
          runs?: Array<{ error_message?: string | null }>
        }
        if (statusPayload.message?.trim()) {
          setSubmitState({ status: 'submitting', message: statusPayload.message.trim(), filename: null })
        }

        if (statusPayload.status === 'failed') {
          failedMessage =
            statusPayload.error_message ?? statusPayload.runs?.[statusPayload.runs.length - 1]?.error_message ?? '任务执行失败。'
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
      if (!finished) throw new Error('任务执行超时，请稍后重试。')

      const response = await fetch(resolveApiUrl(resultEndpoint), {
        headers: authHeaders(currentOperator, isAdmin),
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '结果下载失败。')
      }

      const blob = await response.blob()
      const headerName = extractFilenameFromHeader(response.headers.get('Content-Disposition'))
      const fallbackName = `${projectName.trim()}_Daily_Report_${reportDate}.xlsx`
      const filename = headerName || fallbackName

      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)

      setSubmitState({ status: 'success', message: `生成成功，已下载 ${filename}`, filename })
    } catch (error) {
      setSubmitState({
        status: 'error',
        message: `生成失败：${error instanceof Error ? error.message : '未知错误'}`,
        filename: null,
      })
    }
  }

  return (
    <div className="w-full space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">参数配置</CardTitle>
            <CardDescription>项目名称必填，日期默认昨天。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="project_name" className="text-sm font-medium text-foreground">项目名称</label>
              <Select
                value={projectName}
                onValueChange={setProjectName}
                disabled={projectsLoading || projects.length === 0}
              >
                <SelectTrigger
                  id="project_name"
                  className="h-10 transition-all duration-200 data-[state=open]:ring-2 data-[state=open]:ring-blue-500/30"
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
              {!projectsLoading && projects.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无项目，请先到“项目信息”页面新增。</p>
              ) : null}
              {projectLoadError ? <p className="text-xs text-destructive">{projectLoadError}</p> : null}
            </div>

            <div className="space-y-2">
              <label htmlFor="report_date" className="text-sm font-medium text-foreground">报表日期</label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="report_date"
                  type="date"
                  value={reportDate}
                  onChange={(event) => setReportDate(event.target.value)}
                  className="max-w-xs"
                />
                <Button type="button" variant="secondary" onClick={() => setReportDate(yesterdayDateString())}>
                  <CalendarDays className="mr-1 h-4 w-4" />
                  昨天
                </Button>
              </div>
            </div>

            {formError ? <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{formError}</p> : null}
          </CardContent>
        </Card>

        <Card className="flex min-h-[320px] flex-col shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">生成与下载</CardTitle>
            <CardDescription>上传三份文件后生成日报并自动下载。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">识别覆盖</p>
                <p className="mt-1 font-semibold">{recognizedCount}/3</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">上传完成</p>
                <p className="mt-1 font-semibold">{uploadedCount}/3</p>
              </div>
            </div>

            {submitState.status === 'submitting' ? (
              <div className="flex items-center gap-2 rounded-md border border-blue-300/40 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-900/25 dark:text-blue-200">
                <Loader2 className="h-4 w-4 animate-spin" />
                {submitState.message}
              </div>
            ) : null}

            {submitState.status === 'success' ? (
              <div className="space-y-2 rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200">
                {submitState.filename ? (
                  <div className="flex items-center gap-2">
                    <Download className="mr-1 h-3.5 w-3.5" />
                    {submitState.filename}
                  </div>
                ) : null}
              </div>
            ) : null}

            {submitState.status === 'error' ? (
              <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
                <AlertCircle className="h-4 w-4" />
                {submitState.message}
              </div>
            ) : null}

            <Button
              type="button"
              className="mt-auto h-11 w-full bg-blue-600 hover:bg-blue-500"
              onClick={() => void generateReport()}
              disabled={!canGenerate}
            >
              {submitState.status === 'submitting' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
              生成日报
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">文件识别与上传</CardTitle>
          <CardDescription>左侧投递文件，右侧实时展示三份文件识别状态；匹配失败时出现手动匹配。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
            <div
              className={cn(
                'flex flex-col rounded-xl border-2 border-dashed p-4 text-center transition-colors',
                dragActive ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-900/20' : 'border-border bg-muted/30'
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
              <p className="mt-1 text-xs text-muted-foreground">支持 txt/xlsx 批量识别</p>

              <div className="mt-auto space-y-2 pt-4">
                <Button type="button" variant="outline" className="w-full" onClick={() => document.getElementById('daily-report-batch-picker')?.click()}>
                  <FileSearch className="mr-1 h-4 w-4" />
                  选择多个文件
                </Button>
                <Input
                  id="daily-report-batch-picker"
                  type="file"
                  multiple
                  accept=".txt,.xlsx"
                  className="hidden"
                  onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
                />
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => void uploadAllConfirmed()}
                  disabled={uploadBusy || mappingBusy || !projectName.trim()}
                >
                  {uploadBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
                  一键上传已匹配文件
                </Button>
              </div>
            </div>

            <div className="space-y-4">
              {REQUIRED_TYPES.map((type) => {
                const state = uploadState[type]
                const meta = getUploadMeta(state)
                const matched = state.status !== 'empty'
                return (
                  <div key={type} className="flex min-h-[120px] flex-col rounded-lg border bg-card p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2.5 w-2.5 rounded-full', meta.dot)} />
                        <p className="text-sm font-semibold text-foreground">{TYPE_LABEL[type]}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">{meta.text}</span>
                    </div>

                    <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div className={cn('h-full transition-all duration-200', matched ? meta.bar : 'bg-slate-300 dark:bg-slate-700')} style={{ width: matched ? '100%' : '28%' }} />
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
                        onClick={() => void uploadType(type)}
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
                      <div key={row.id} className="grid gap-2 rounded-md border border-blue-200/70 bg-white/90 p-2 dark:border-blue-800/40 dark:bg-slate-900/60 md:grid-cols-[1fr_190px]">
                        <div>
                          <p className="truncate text-sm font-medium text-foreground">{row.file.name}</p>
                          <p className="text-xs text-muted-foreground">{row.detectedReason}</p>
                        </div>
                        <Select value={row.assignedType} onValueChange={(value) => changeAssignedType(row.id, value as AssignedType)}>
                          <SelectTrigger>
                            <SelectValue placeholder="手动选择类型" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sales_report">销售报表</SelectItem>
                            <SelectItem value="ad_report">广告报表</SelectItem>
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
  )
}
