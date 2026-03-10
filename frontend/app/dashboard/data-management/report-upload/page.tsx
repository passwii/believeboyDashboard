'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { CheckCircle2, Database, FileArchive, Loader2, Upload, X } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { cn } from '@/lib/utils'

type ReportTabKey = 'daily-sales' | 'inventory-snapshot' | 'promoted-products'
type QueueStatus = 'ready' | 'uploading' | 'success' | 'error'

type ProjectOption = {
  name: string
}

type UploadQueueItem = {
  id: string
  file: File
  status: QueueStatus
  error: string | null
  uploadedName: string | null
  originalName: string | null
}

type TabUploadState = {
  items: UploadQueueItem[]
  uploading: boolean
  dragActive: boolean
  message: string | null
}

const API_BASE = '/api/backend'

const REPORT_CONFIG: Record<
  ReportTabKey,
  {
    title: string
    description: string
    fileType: 'sales_report' | 'inventory_report' | 'ad_report'
    accept: string
    extensions: string[]
    badge: string
  }
> = {
  'daily-sales': {
    title: '每日销售',
    description: '上传 Order Sales 等销售日报原始文件，仅归档上传，不触发额外处理。',
    fileType: 'sales_report',
    accept: '.txt,text/plain',
    extensions: ['.txt'],
    badge: '日报归档',
  },
  'inventory-snapshot': {
    title: '库存快照',
    description: '上传库存 Snapshot 原始文件，按快照类报表存储。',
    fileType: 'inventory_report',
    accept: '.txt,text/plain',
    extensions: ['.txt'],
    badge: 'Snapshot',
  },
  'promoted-products': {
    title: '已推广商品报告',
    description: '上传推广商品相关报表，按推广报表类型存档。',
    fileType: 'ad_report',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    badge: '推广报表',
  },
}

function createInitialTabState(): Record<ReportTabKey, TabUploadState> {
  return {
    'daily-sales': { items: [], uploading: false, dragActive: false, message: null },
    'inventory-snapshot': { items: [], uploading: false, dragActive: false, message: null },
    'promoted-products': { items: [], uploading: false, dragActive: false, message: null },
  }
}

function getExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown; message?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    const text = await response.text()
    if (text.trim()) return text
  }
  return `上传失败 (${response.status})`
}

export default function ReportUploadPage() {
  const { data: session, status } = useSession()
  const fileInputRefs = useRef<Record<ReportTabKey, HTMLInputElement | null>>({
    'daily-sales': null,
    'inventory-snapshot': null,
    'promoted-products': null,
  })

  const [activeTab, setActiveTab] = useState<ReportTabKey>('daily-sales')
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Record<ReportTabKey, TabUploadState>>(createInitialTabState)

  useEffect(() => {
    if (status === 'loading') return

    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const payload = (await response.json()) as ProjectOption[]
        setProjects(payload)
      } catch (error) {
        setProjectLoadError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }

    void loadProjects()
  }, [session, status])

  const totalQueued = useMemo(
    () => Object.values(tabs).reduce((sum, tab) => sum + tab.items.length, 0),
    [tabs]
  )

  const totalUploaded = useMemo(
    () =>
      Object.values(tabs).reduce(
        (sum, tab) => sum + tab.items.filter((item) => item.status === 'success').length,
        0
      ),
    [tabs]
  )

  const updateTabState = (key: ReportTabKey, updater: (state: TabUploadState) => TabUploadState) => {
    setTabs((prev) => ({
      ...prev,
      [key]: updater(prev[key]),
    }))
  }

  const queueFiles = (key: ReportTabKey, files: File[]) => {
    if (!files.length) return

    const allowed = REPORT_CONFIG[key].extensions
    const validFiles = files.filter((file) => allowed.includes(getExtension(file.name)))
    const rejectedCount = files.length - validFiles.length

    updateTabState(key, (state) => ({
      ...state,
      message: rejectedCount > 0 ? `已忽略 ${rejectedCount} 个不符合格式要求的文件。` : null,
      items: [
        ...state.items,
        ...validFiles.map((file) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          file,
          status: 'ready' as const,
          error: null,
          uploadedName: null,
          originalName: null,
        })),
      ],
    }))
  }

  const onInputChange = (key: ReportTabKey, event: ChangeEvent<HTMLInputElement>) => {
    queueFiles(key, Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const onDrop = (key: ReportTabKey, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    updateTabState(key, (state) => ({ ...state, dragActive: false }))
    queueFiles(key, Array.from(event.dataTransfer.files ?? []))
  }

  const removeItem = (key: ReportTabKey, itemId: string) => {
    updateTabState(key, (state) => ({
      ...state,
      items: state.items.filter((item) => item.id !== itemId),
      message: null,
    }))
  }

  const uploadTabFiles = async (key: ReportTabKey) => {
    const currentTab = tabs[key]
    if (currentTab.uploading) return

    if (!projectName.trim()) {
      setGlobalError('请先选择项目，再上传报表。')
      return
    }

    const pendingItems = currentTab.items.filter(
      (item) => item.status === 'ready' || item.status === 'error'
    )
    if (pendingItems.length === 0) {
      updateTabState(key, (state) => ({
        ...state,
        message: '当前 Tab 没有待上传文件。',
      }))
      return
    }

    setGlobalError(null)
    updateTabState(key, (state) => ({ ...state, uploading: true, message: null }))

    for (const pending of pendingItems) {
      updateTabState(key, (state) => ({
        ...state,
        items: state.items.map((item) =>
          item.id === pending.id
            ? { ...item, status: 'uploading', error: null, uploadedName: null, originalName: null }
            : item
        ),
      }))

      const formData = new FormData()
      formData.append('file', pending.file)
      formData.append('project_name', projectName.trim())
      formData.append('file_type', REPORT_CONFIG[key].fileType)

      try {
        const response = await fetch(`${API_BASE}/api/v1/uploads`, {
          method: 'POST',
          body: formData,
          headers: buildBackendHeaders(session),
        })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }

        const payload = (await response.json()) as {
          filename?: string
          original_filename?: string
        }

        updateTabState(key, (state) => ({
          ...state,
          items: state.items.map((item) =>
            item.id === pending.id
              ? {
                  ...item,
                  status: 'success',
                  error: null,
                  uploadedName: payload.filename ?? null,
                  originalName: payload.original_filename ?? pending.file.name,
                }
              : item
          ),
        }))
      } catch (error) {
        updateTabState(key, (state) => ({
          ...state,
          items: state.items.map((item) =>
            item.id === pending.id
              ? {
                  ...item,
                  status: 'error',
                  error: error instanceof Error ? error.message : '上传失败，请重试。',
                }
              : item
          ),
        }))
      }
    }

    updateTabState(key, (state) => ({
      ...state,
      uploading: false,
      message: '上传完成，可继续补充更多文件。',
    }))
  }

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_24px_60px_-32px_rgba(15,23,42,0.35)]">
        <CardHeader className="space-y-4 bg-[linear-gradient(135deg,rgba(14,116,144,0.12),rgba(14,165,233,0.08)_45%,rgba(255,255,255,0)_100%)]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="rounded-md border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
              数据管理
            </Badge>
            <Badge variant="outline" className="rounded-md border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              报表上传
            </Badge>
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl">报表上传中心</CardTitle>
            <CardDescription>
              将每日销售、库存 Snapshot、已推广商品报告统一上传归档。该页面只负责入库保存，不执行额外计算或加工。
            </CardDescription>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs text-muted-foreground">当前项目</p>
              <p className="mt-2 text-lg font-semibold">{projectName || '尚未选择'}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs text-muted-foreground">已加入队列</p>
              <p className="mt-2 text-lg font-semibold">{totalQueued}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs text-muted-foreground">上传成功</p>
              <p className="mt-2 text-lg font-semibold">{totalUploaded}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 p-5 sm:p-7">
          {globalError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {globalError}
            </div>
          ) : null}
          {projectLoadError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {projectLoadError}
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
            <div className="space-y-2">
              <p className="text-sm font-medium">所属项目</p>
              <Select value={projectName} onValueChange={setProjectName} disabled={projectsLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={projectsLoading ? '项目加载中...' : '请选择项目'} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.name} value={project.name}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-2xl border border-dashed border-border/80 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              每个 Tab 可批量选择多个文件并顺序上传；如果格式不符合当前报表类型，会在加入队列时被忽略。
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ReportTabKey)} className="space-y-4">
        <TabsList className="h-auto w-full justify-start gap-2 rounded-2xl bg-muted/50 p-2">
          {(Object.keys(REPORT_CONFIG) as ReportTabKey[]).map((key) => (
            <TabsTrigger
              key={key}
              value={key}
              className="rounded-xl border border-transparent px-4 py-2 data-[state=active]:border-border data-[state=active]:bg-background"
            >
              {REPORT_CONFIG[key].title}
            </TabsTrigger>
          ))}
        </TabsList>

        {(Object.keys(REPORT_CONFIG) as ReportTabKey[]).map((key) => {
          const config = REPORT_CONFIG[key]
          const state = tabs[key]
          const uploadedCount = state.items.filter((item) => item.status === 'success').length

          return (
            <TabsContent key={key} value={key} className="mt-0">
              <Card className="border-border/80">
                <CardHeader className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{config.badge}</Badge>
                        <Badge variant="secondary">{config.extensions.join(' / ')}</Badge>
                      </div>
                      <CardTitle>{config.title}</CardTitle>
                      <CardDescription>{config.description}</CardDescription>
                    </div>
                    <div className="grid min-w-[220px] gap-2 sm:grid-cols-2">
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">队列文件</p>
                        <p className="mt-1 text-xl font-semibold">{state.items.length}</p>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">已上传</p>
                        <p className="mt-1 text-xl font-semibold">{uploadedCount}</p>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {state.message ? (
                    <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                      {state.message}
                    </div>
                  ) : null}

                  <div
                    className={cn(
                      'rounded-3xl border border-dashed px-6 py-10 transition-colors',
                      state.dragActive ? 'border-sky-500 bg-sky-500/5' : 'border-border/80 bg-background'
                    )}
                    onDragOver={(event) => {
                      event.preventDefault()
                      updateTabState(key, (tabState) => ({ ...tabState, dragActive: true }))
                    }}
                    onDragLeave={() => updateTabState(key, (tabState) => ({ ...tabState, dragActive: false }))}
                    onDrop={(event) => onDrop(key, event)}
                  >
                    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 text-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-700 dark:text-sky-300">
                        <Upload className="h-6 w-6" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-base font-semibold">拖拽文件到这里，或手动选择</p>
                        <p className="text-sm text-muted-foreground">
                          支持批量上传，当前 Tab 仅接受 {config.extensions.join(' / ')} 文件。
                        </p>
                      </div>
                      <input
                        ref={(node) => {
                          fileInputRefs.current[key] = node
                        }}
                        type="file"
                        accept={config.accept}
                        multiple
                        className="hidden"
                        onChange={(event) => onInputChange(key, event)}
                      />
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button type="button" onClick={() => fileInputRefs.current[key]?.click()}>
                          <FileArchive className="h-4 w-4" />
                          选择文件
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void uploadTabFiles(key)}
                          disabled={state.uploading || state.items.length === 0}
                        >
                          {state.uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                          {state.uploading ? '上传中...' : '上传当前 Tab'}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {state.items.length === 0 ? (
                      <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                        当前还没有待上传文件。
                      </div>
                    ) : (
                      state.items.map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/70 px-4 py-3"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">{item.file.name}</p>
                              {item.status === 'success' ? (
                                <Badge className="bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300">
                                  已上传
                                </Badge>
                              ) : null}
                              {item.status === 'uploading' ? (
                                <Badge variant="secondary">上传中</Badge>
                              ) : null}
                              {item.status === 'error' ? (
                                <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/10">
                                  失败
                                </Badge>
                              ) : null}
                              {item.status === 'ready' ? <Badge variant="outline">待上传</Badge> : null}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {(item.file.size / 1024 / 1024).toFixed(2)} MB
                              {item.uploadedName ? ` · 文件ID ${item.uploadedName}` : ''}
                            </p>
                            {item.error ? <p className="text-xs text-destructive">{item.error}</p> : null}
                          </div>
                          <div className="flex items-center gap-2">
                            {item.status === 'success' ? (
                              <div className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-300">
                                <CheckCircle2 className="h-4 w-4" />
                                已归档
                              </div>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeItem(key, item.id)}
                              disabled={item.status === 'uploading'}
                            >
                              <X className="h-4 w-4" />
                              <span className="sr-only">移除文件</span>
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )
        })}
      </Tabs>
    </div>
  )
}
