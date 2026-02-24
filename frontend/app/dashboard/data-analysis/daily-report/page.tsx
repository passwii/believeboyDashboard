'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  CalendarDays,
  Download,
  FileSearch,
  FileText,
  Loader2,
  Package,
  Rocket,
} from 'lucide-react'

import { recognizeDataFile } from '@/lib/file-recognition'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type UploadType = 'sales_report' | 'ad_report' | 'inventory_report'
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''

const FILE_CONFIG: {
  key: UploadType
  title: string
  description: string
  accept: string
}[] = [
  {
    key: 'sales_report',
    title: '销售报表',
    description: '仅支持 .txt，首行建议包含 amazon-order-id',
    accept: '.txt,text/plain',
  },
  {
    key: 'ad_report',
    title: '广告报表',
    description: '仅支持 .xlsx，文件名建议包含 ad/广告/推广',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    key: 'inventory_report',
    title: '库存报告',
    description: '仅支持 .txt，首行建议包含 snapshot-date',
    accept: '.txt,text/plain',
  },
]

function yesterdayDateString() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

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

function initialUploadState(): Record<UploadType, UploadStateItem> {
  return {
    sales_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
    ad_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
    inventory_report: { status: 'idle', selectedFile: null, selectedReason: null, uploaded: null, error: null },
  }
}

function isUploadType(value: string): value is UploadType {
  return value === 'sales_report' || value === 'ad_report' || value === 'inventory_report'
}

export default function DailyReportPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [manualProjectInput, setManualProjectInput] = useState(false)

  const [projectName, setProjectName] = useState('')
  const [reportDate, setReportDate] = useState('')
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

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const response = await fetch(`${API_BASE}/api/projects`, { cache: 'no-store' })
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
  const allUploaded = useMemo(
    () => FILE_CONFIG.every((item) => uploadState[item.key].status === 'success' && uploadState[item.key].uploaded),
    [uploadState]
  )
  const uploadedCount = useMemo(
    () => FILE_CONFIG.filter((item) => uploadState[item.key].status === 'success' && uploadState[item.key].uploaded).length,
    [uploadState]
  )
  const canGenerate = projectName.trim() && reportDate && allUploaded && submitState.status !== 'submitting'
  const getStatusMeta = (state: UploadStateItem) => {
    if (state.status === 'success') return { text: '上传完成', bar: 'bg-emerald-500', track: 'bg-emerald-100', width: 'w-full' }
    if (state.status === 'uploading') return { text: '上传中', bar: 'bg-blue-500', track: 'bg-blue-100', width: 'w-2/3' }
    if (state.status === 'error') return { text: '上传失败', bar: 'bg-rose-500', track: 'bg-rose-100', width: 'w-full' }
    if (state.selectedFile) return { text: '已选择文件', bar: 'bg-amber-500', track: 'bg-amber-100', width: 'w-1/3' }
    return { text: '待处理', bar: 'bg-slate-400', track: 'bg-slate-200', width: 'w-1/4' }
  }

  const validateFile = (file: File, key: UploadType) => {
    const fileName = file.name.toLowerCase()
    if (key === 'ad_report') {
      return fileName.endsWith('.xlsx')
    }
    return fileName.endsWith('.txt')
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
    if (!files.length) {
      return
    }
    setRecognitionMessages([])
    setMatchingFiles(true)

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
        if (item.type === 'payment_report') {
          messages.push(`已跳过 ${item.file.name}：识别为付款报告（本页面不需要）`)
          return
        }
        messages.push(`无法识别 ${item.file.name}：${item.reason}`)
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
      const response = await fetch(`${API_BASE}/upload-file`, {
        method: 'POST',
        body: formData,
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

  const generateReport = async () => {
    setFormError(null)
    setSubmitState({ status: 'idle', message: null, filename: null })

    if (!projectName.trim()) {
      setFormError('项目名称不能为空')
      return
    }
    if (!reportDate) {
      setFormError('报表日期不能为空')
      return
    }
    if (!allUploaded) {
      setFormError('请先完成三份文件上传')
      return
    }

    setSubmitState({ status: 'submitting', message: '系统处理中，请稍候...', filename: null })

    const payload = new FormData()
    payload.append('project_name', projectName.trim())
    payload.append('report_date', reportDate)
    payload.append('sales_report_path', uploadState.sales_report.uploaded?.filePath ?? '')
    payload.append('ad_report_path', uploadState.ad_report.uploaded?.filePath ?? '')
    payload.append('inventory_report_path', uploadState.inventory_report.uploaded?.filePath ?? '')

    try {
      const response = await fetch(`${API_BASE}/daily-report`, {
        method: 'POST',
        body: payload,
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '生成失败，请重试')
      }

      const blob = await response.blob()
      const headerName = extractFilenameFromHeader(response.headers.get('Content-Disposition'))
      const fallbackName = `${projectName.trim()}_${reportDate}_日报.xlsx`
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
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="border-0 bg-gradient-to-br from-amber-50 via-white to-orange-50 shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Package className="h-5 w-5 text-orange-600" />
              基础参数
            </CardTitle>
            <CardDescription>项目和日期是上传与生成的前置条件。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="project_name" className="text-sm font-medium">
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
                  className="bg-white"
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
                    className="bg-white"
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
              <label htmlFor="report_date" className="text-sm font-medium">
                报表日期
              </label>
              <div className="flex gap-2">
                <Input
                  id="report_date"
                  type="date"
                  value={reportDate}
                  onChange={(event) => setReportDate(event.target.value)}
                  className="max-w-xs bg-white"
                />
                <Button type="button" variant="secondary" onClick={() => setReportDate(yesterdayDateString())}>
                  <CalendarDays className="mr-1 h-4 w-4" />
                  昨天
                </Button>
              </div>
            </div>
            {formError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {formError}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white shadow-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Rocket className="h-5 w-5 text-cyan-300" />
              生成与结果
            </CardTitle>
            <CardDescription className="text-slate-300">完成前置条件后，一次点击生成并自动下载日报文件。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-white/15 bg-white/5 p-4">
              <p className="text-sm text-slate-200">执行状态</p>
              <div className="mt-3 space-y-2">
                <div className="rounded-md bg-white/10 p-3">
                  <p className="text-xs text-slate-300">项目名称</p>
                  <p className="mt-1 text-sm font-medium">{projectName.trim() ? '已填写' : '未填写'}</p>
                </div>
                <div className="rounded-md bg-white/10 p-3">
                  <p className="text-xs text-slate-300">报表日期</p>
                  <p className="mt-1 text-sm font-medium">{reportDate ? '已选择' : '未选择'}</p>
                </div>
                <div className="rounded-md bg-white/10 p-3">
                  <p className="text-xs text-slate-300">上传进度</p>
                  <p className="mt-1 text-sm font-medium">{uploadedCount}/3</p>
                </div>
              </div>
            </div>

            <Button type="button" className="h-11 w-full" onClick={() => void generateReport()} disabled={!canGenerate}>
              {submitState.status === 'submitting' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              生成日报
            </Button>

            {submitState.filename ? (
              <Badge variant="outline" className="justify-center gap-1 border-white/30 text-white">
                <Download className="h-3.5 w-3.5" />
                {submitState.filename}
              </Badge>
            ) : (
              <p className="text-xs text-slate-400">生成后将自动下载，文件名会展示在这里。</p>
            )}

            {submitState.status === 'success' ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-400/50 bg-emerald-500/20 px-3 py-2 text-sm text-emerald-100">
                <CheckCircle2 className="h-4 w-4" />
                {submitState.message}
              </div>
            ) : null}
            {submitState.status === 'error' ? (
              <div className="flex items-center gap-2 rounded-md border border-rose-400/40 bg-rose-500/20 px-3 py-2 text-sm text-rose-100">
                <AlertCircle className="h-4 w-4" />
                {submitState.message}
              </div>
            ) : null}
            {submitState.status === 'submitting' ? (
              <div className="flex items-center gap-2 rounded-md border border-cyan-300/30 bg-cyan-500/20 px-3 py-2 text-sm text-cyan-100">
                <Loader2 className="h-4 w-4 animate-spin" />
                {submitState.message}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card className="border-0 bg-card shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileSearch className="h-5 w-5 text-blue-600" />
            文件识别与上传
          </CardTitle>
          <CardDescription>拖拽识别、状态追踪、单文件上传都在同一个区域内完成。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div
            className={cn(
              'rounded-xl border-2 border-dashed p-6 text-center transition-all',
              dragActive
                ? 'scale-[1.01] border-blue-500 bg-blue-500/5 shadow-md'
                : 'border-slate-200 bg-gradient-to-br from-slate-50 via-white to-cyan-50'
            )}
            onDrop={(event) => void onDrop(event)}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
          >
            <p className="text-sm font-semibold text-slate-700">拖拽文件到这里，系统会自动识别并分发到下方类型</p>
            <p className="mt-1 text-xs text-muted-foreground">
              规则：订单(txt+amazon-order-id/or*)、库存(txt+snapshot-date/*fba*)、广告(xlsx+ad/广告/推广)
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
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
              <Button type="button" onClick={() => void uploadAll()} disabled={!canUpload || matchingFiles}>
                {matchingFiles ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                一键上传已识别文件
              </Button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {FILE_CONFIG.map((fileItem) => {
              const state = uploadState[fileItem.key]
              const statusMeta = getStatusMeta(state)
              return (
                <div key={fileItem.key} className="rounded-lg border bg-slate-50/80 p-3">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700">{fileItem.title}</span>
                    <span className="text-xs text-slate-500">{statusMeta.text}</span>
                  </div>
                  <div className={cn('h-2 rounded-full', statusMeta.track)}>
                    <div className={cn('h-2 rounded-full transition-all', statusMeta.bar, statusMeta.width)} />
                  </div>
                  <p className="mt-2 truncate text-xs text-slate-500">
                    {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
                  </p>
                </div>
              )
            })}
          </div>

          {recognitionMessages.length ? (
            <div className="max-h-40 space-y-1 overflow-auto rounded-md border bg-muted/10 p-3 text-xs text-slate-700">
              {recognitionMessages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            {FILE_CONFIG.map((fileItem) => {
              const state = uploadState[fileItem.key]
              return (
                <div
                  key={fileItem.key}
                  className={cn(
                    'rounded-lg border p-3 transition-all',
                    state.status === 'success' && 'border-emerald-200 bg-emerald-50/60',
                    state.status === 'error' && 'border-rose-200 bg-rose-50/60',
                    state.status === 'uploading' && 'border-blue-200 bg-blue-50/60',
                    state.status === 'idle' && 'border-slate-200 bg-slate-50/70'
                  )}
                >
                  <div className="grid gap-3 lg:grid-cols-[120px_1fr_auto] lg:items-center">
                    <div>
                      <p className="text-sm font-medium">{fileItem.title}</p>
                      <p className="text-[11px] text-muted-foreground">{fileItem.description}</p>
                    </div>
                    <div className="space-y-2">
                      <Input
                        type="file"
                        accept={fileItem.accept}
                        onChange={(event) => onPickFile(fileItem.key, event.target.files?.[0] ?? null)}
                        disabled={state.status === 'uploading'}
                        className="bg-white"
                      />
                      <p className="truncate text-xs text-slate-500">
                        {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 lg:justify-end">
                      <Badge variant={state.status === 'success' ? 'default' : state.status === 'error' ? 'destructive' : 'secondary'}>
                        {state.status === 'idle' && '待上传'}
                        {state.status === 'uploading' && '上传中'}
                        {state.status === 'success' && '已上传'}
                        {state.status === 'error' && '失败'}
                      </Badge>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void uploadFile(fileItem.key)}
                        disabled={!canUpload || !state.selectedFile || state.status === 'uploading'}
                      >
                        {state.status === 'uploading' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                        上传
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => clearUpload(fileItem.key)}
                        disabled={state.status === 'uploading'}
                      >
                        重置
                      </Button>
                    </div>
                  </div>
                  {state.error ? <p className="mt-2 text-xs text-destructive">{state.error}</p> : null}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
