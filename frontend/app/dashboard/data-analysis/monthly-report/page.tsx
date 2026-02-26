'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { AlertCircle, CheckCircle2, Download, FileSearch, Loader2, Sparkles, Upload } from 'lucide-react'

import { recognizeDataFile } from '@/lib/file-recognition'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type UploadType = 'payment_report' | 'monthly_summary_pdf'
type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

type ProjectOption = {
  name: string
}

type UploadFileMeta = {
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''
const TXN_FILE_RE = /^\d{4}[A-Za-z]{3}MonthlyUnifiedTransaction\.csv$/
const PDF_FILE_RE = /^\d{4}[A-Za-z]{3}MonthlyUnifiedSummary\.pdf$/

const FILE_CONFIG: Array<{
  key: UploadType
  title: string
  description: string
  accept: string
}> = [
  {
    key: 'payment_report',
    title: '交易明细 CSV',
    description: '示例：2026JanMonthlyUnifiedTransaction.csv',
    accept: '.csv,text/csv',
  },
  {
    key: 'monthly_summary_pdf',
    title: '月度总结 PDF',
    description: '示例：2026JanMonthlyUnifiedSummary.pdf',
    accept: '.pdf,application/pdf',
  },
]

function authHeaders(): Record<string, string> {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
}

function initialUploadState(): Record<UploadType, UploadStateItem> {
  return {
    payment_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
    monthly_summary_pdf: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
  }
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

export default function MonthlyReportPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [reportMonth, setReportMonth] = useState('')
  const [uploadState, setUploadState] = useState<Record<UploadType, UploadStateItem>>(initialUploadState)
  const [dragActive, setDragActive] = useState(false)
  const [recognitionMessages, setRecognitionMessages] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle', message: null, filename: null })

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
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [])

  const allUploaded = useMemo(
    () => FILE_CONFIG.every((item) => uploadState[item.key].status === 'success' && uploadState[item.key].uploaded),
    [uploadState]
  )
  const canGenerate = projectName.trim() && reportMonth && allUploaded && submitState.status !== 'submitting'

  const validateFile = (key: UploadType, file: File) => {
    if (key === 'payment_report') {
      if (!file.name.toLowerCase().endsWith('.csv')) return '交易文件仅支持 .csv'
      if (!TXN_FILE_RE.test(file.name)) return 'CSV 文件名应为 2026JanMonthlyUnifiedTransaction.csv 格式'
      return null
    }

    if (!file.name.toLowerCase().endsWith('.pdf')) return '总结文件仅支持 .pdf'
    if (!PDF_FILE_RE.test(file.name)) return 'PDF 文件名应为 2026JanMonthlyUnifiedSummary.pdf 格式'
    return null
  }

  const pickFile = (key: UploadType, file: File | null, reason = '手动选择文件') => {
    setFormError(null)
    if (!file) return

    const validationError = validateFile(key, file)
    if (validationError) {
      setUploadState((prev) => ({
        ...prev,
        [key]: { ...prev[key], status: 'error', selectedFile: null, uploaded: null, error: validationError },
      }))
      return
    }

    setUploadState((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        status: 'idle',
        selectedFile: file,
        selectedReason: reason,
        uploaded: null,
        error: null,
      },
    }))
  }

  const mapDetectedFiles = async (files: File[]) => {
    if (!files.length) return
    const messages: string[] = []
    const assignedTypes = new Set<UploadType>()
    const recognized = await Promise.all(
      files.map(async (file) => {
        const match = await recognizeDataFile(file)
        return { file, ...match }
      })
    )

    recognized.forEach((item) => {
      if (!isUploadType(item.type)) {
        messages.push(`跳过 ${item.file.name}：${item.reason}`)
        return
      }
      if (assignedTypes.has(item.type)) {
        messages.push(`跳过 ${item.file.name}：同批次重复识别`)
        return
      }
      assignedTypes.add(item.type)
      pickFile(item.type, item.file, `拖拽识别：${item.reason}`)
      messages.push(`已识别 ${item.file.name} -> ${item.type}`)
    })

    setRecognitionMessages(messages)
  }

  const uploadFile = async (key: UploadType) => {
    if (!projectName.trim()) {
      setFormError('请先选择项目名称')
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
        [key]: {
          ...prev[key],
          status: 'success',
          error: null,
          uploaded: { filename: payload.filename, originalFilename: payload.original_filename },
        },
      }))
    } catch (error) {
      setUploadState((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: 'error',
          uploaded: null,
          error: error instanceof Error ? error.message : '上传失败',
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

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    await mapDetectedFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const generateReport = async () => {
    setFormError(null)
    setSubmitState({ status: 'idle', message: null, filename: null })

    if (!projectName.trim()) {
      setFormError('项目名称不能为空')
      return
    }
    if (!reportMonth) {
      setFormError('请选择报表月份')
      return
    }
    if (!allUploaded) {
      setFormError('请先完成 CSV + PDF 上传')
      return
    }

    const transactionFileId = uploadState.payment_report.uploaded?.filename
    const summaryPdfFileId = uploadState.monthly_summary_pdf.uploaded?.filename
    if (!transactionFileId || !summaryPdfFileId) {
      setFormError('上传结果异常，请重新上传文件')
      return
    }

    setSubmitState({ status: 'submitting', message: '后端处理中，请稍候...', filename: null })

    try {
      const createResponse = await fetch(`${API_BASE}/api/v1/monthly-reports`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_name: projectName.trim(),
          report_month: reportMonth,
          transaction_file_id: transactionFileId,
          summary_pdf_file_id: summaryPdfFileId,
        }),
      })
      if (!createResponse.ok) {
        const message = await createResponse.text()
        throw new Error(message || '创建任务失败')
      }

      const created = (await createResponse.json()) as { job_id: number }
      const jobId = created.job_id

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
          const message = await statusResponse.text()
          throw new Error(message || '状态查询失败')
        }
        // eslint-disable-next-line no-await-in-loop
        const statusPayload = (await statusResponse.json()) as {
          status: 'pending' | 'running' | 'success' | 'failed'
          runs?: Array<{ error_message?: string | null }>
        }
        if (statusPayload.status === 'failed') {
          failedMessage = statusPayload.runs?.[statusPayload.runs.length - 1]?.error_message ?? '任务失败'
          finished = true
          break
        }
        if (statusPayload.status === 'success') {
          finished = true
          break
        }
      }

      if (failedMessage) throw new Error(failedMessage)
      if (!finished) throw new Error('任务超时，请稍后重试')

      const downloadResponse = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/result`, {
        headers: authHeaders(),
      })
      if (!downloadResponse.ok) {
        const message = await downloadResponse.text()
        throw new Error(message || '下载失败')
      }

      const blob = await downloadResponse.blob()
      const headerName = extractFilenameFromHeader(downloadResponse.headers.get('Content-Disposition'))
      const fallbackName = `月度财务报表_${projectName.trim()}_美国站_${reportMonth}.xlsx`
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
    <div className="space-y-6">
      <Card className="border border-border">
        <CardHeader>
          <CardTitle>财务月报</CardTitle>
          <CardDescription>选择项目、上传 CSV + PDF，点击生成后由后端处理并自动下载 Excel。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="project_name" className="text-sm font-medium">
                项目名称
              </label>
              <Input
                id="project_name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder={projectsLoading ? '项目加载中...' : '输入或选择项目'}
                disabled={projectsLoading}
                list="monthly-project-options"
              />
              <datalist id="monthly-project-options">
                {projects.map((project) => (
                  <option key={project.name} value={project.name} />
                ))}
              </datalist>
              {projectLoadError ? <p className="text-xs text-destructive">{projectLoadError}</p> : null}
            </div>
            <div className="space-y-2">
              <label htmlFor="report_month" className="text-sm font-medium">
                账期月份
              </label>
              <Input id="report_month" type="month" value={reportMonth} onChange={(event) => setReportMonth(event.target.value)} />
            </div>
          </div>

          {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
        </CardContent>
      </Card>

      <Card className="border border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSearch className="h-5 w-5 text-cyan-600" />
            文件识别与上传
          </CardTitle>
          <CardDescription>拖拽后自动分发：CSV 到 `payment_report`，PDF 到 `monthly_summary_pdf`。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={cn(
              'rounded-lg border-2 border-dashed p-5 text-center',
              dragActive ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-950/20' : 'border-border bg-muted/20'
            )}
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
            <p className="text-sm font-medium">拖拽 CSV/PDF 到此自动识别</p>
            <p className="mt-1 text-xs text-muted-foreground">或手动选择后单独上传。命名需符合示例格式。</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button type="button" variant="outline" onClick={() => document.getElementById('monthly-file-picker')?.click()}>
                选择多个文件识别
              </Button>
              <Input
                id="monthly-file-picker"
                type="file"
                multiple
                accept=".csv,.pdf"
                className="hidden"
                onChange={(event) => void mapDetectedFiles(Array.from(event.target.files ?? []))}
              />
              <Button type="button" onClick={() => void uploadAll()} disabled={!projectName.trim()}>
                一键上传已识别文件
              </Button>
            </div>
          </div>

          {recognitionMessages.length > 0 ? (
            <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-xs">
              {recognitionMessages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {FILE_CONFIG.map((item) => {
              const state = uploadState[item.key]
              return (
                <div key={item.key} className="rounded-lg border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">{item.title}</p>
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                      {state.selectedReason ? <p className="text-xs text-cyan-700 dark:text-cyan-300">{state.selectedReason}</p> : null}
                    </div>
                    <Badge variant={state.status === 'error' ? 'destructive' : 'secondary'}>
                      {state.status === 'success' ? '已上传' : state.status === 'uploading' ? '上传中' : state.status === 'error' ? '失败' : '待处理'}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-2">
                    <Input
                      type="file"
                      accept={item.accept}
                      onChange={(event) => pickFile(item.key, event.target.files?.[0] ?? null)}
                      disabled={state.status === 'uploading'}
                    />
                    <p className="truncate text-xs text-muted-foreground">
                      {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
                    </p>
                    {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={() => void uploadFile(item.key)} disabled={!projectName.trim() || !state.selectedFile || state.status === 'uploading'}>
                        {state.status === 'uploading' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
                        上传
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setUploadState((prev) => ({
                            ...prev,
                            [item.key]: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
                          }))
                        }
                      >
                        重置
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="border border-border">
        <CardHeader>
          <CardTitle>生成与下载</CardTitle>
          <CardDescription>必须先完成两个文件上传，才可触发生成。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" className="w-full md:w-auto" onClick={() => void generateReport()} disabled={!canGenerate}>
            {submitState.status === 'submitting' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            生成财务月报
          </Button>
          {submitState.filename ? (
            <Badge variant="outline" className="gap-1">
              <Download className="h-3.5 w-3.5" />
              {submitState.filename}
            </Badge>
          ) : null}
          {submitState.status === 'success' ? (
            <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              {submitState.message}
            </p>
          ) : null}
          {submitState.status === 'error' ? (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {submitState.message}
            </p>
          ) : null}
          {submitState.status === 'submitting' ? <p className="text-sm text-cyan-700 dark:text-cyan-300">{submitState.message}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
