'use client'

import { type ChangeEvent, type DragEvent, useState } from 'react'
import {
  CheckCircle2,
  FileUp,
  Loader2,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  REPORT_UPLOAD_COUNTRY_OPTIONS,
  type ReportType,
  type UploadQueueItem,
  type RecognitionResponse,
} from '@/components/report-upload/types'

const API_BASE = '/api/backend'

const REPORT_TYPE_LABELS: Record<string, string> = {
  inventory_report: '亚马逊物流库存',
  business_report: '业务报告',
  ad_product_report: '广告 - 已推广商品',
  sales_report: '销售报表 - 所有订单',
  payment_report: '付款报告',
}

function getReportTypeLabel(type: UploadQueueItem['reportType']): string {
  if (!type || type === 'unknown') return '未识别'
  return REPORT_TYPE_LABELS[type] ?? type
}

export default function AutoUploadPage() {
  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([])
  // Store recognition result per item (keyed by localId)
  const [recognitionMap, setRecognitionMap] = useState<
    Record<string, RecognitionResponse>
  >({})
  const [country, setCountry] = useState(
    REPORT_UPLOAD_COUNTRY_OPTIONS[0].value,
  )

  // ── File recognition ─────────────────────────────────────────────────────────

  const recognizeFiles = async (files: File[]) => {
    if (!files.length) return

    const pending: UploadQueueItem[] = files.map((file) => ({
      localId: crypto.randomUUID(),
      originalFileName: file.name,
      reportType: null,
      recognitionStatus: 'pending',
      recognizedProject: null,
      detectedDate: null,
      fileCommitStatus: 'idle',
      commitError: null,
      error: null,
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
        const res = await fetch(`${API_BASE}/api/v1/report-upload/recognize`, {
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
                      ? recognition.project_match.project_name ?? null
                      : recognition.project_match.status === 'conflict'
                        ? `候选 ${recognition.project_match.candidate_projects.length} 个`
                        : '未匹配',
                  detectedDate:
                    recognition.detected_date ??
                    recognition.detected_end_date ??
                    null,
                  error:
                    recognition.status === 'recognized'
                      ? null
                      : recognition.reason,
                }
              : it,
          ),
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
                  fileCommitStatus: 'error',
                  error: msg,
                }
              : it,
          ),
        )
      }
    }

    setRecognizing(false)
  }

  // ── Upload all ────────────────────────────────────────────────────────────────

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

      setQueueItems((prev) =>
        prev.map((it) =>
          it.localId === item.localId
            ? { ...it, fileCommitStatus: 'saving', commitError: null }
            : it,
        ),
      )

      try {
        const payload = {
          temp_file_id: item.tempFileId,
          original_filename: item.originalFileName,
          report_type: item.reportType,
          // project_name intentionally omitted → backend auto-derives from recognition
          report_date:
            recognition.detected_date ?? recognition.detected_end_date ?? null,
          report_start_date: recognition.detected_start_date ?? null,
          report_end_date: recognition.detected_end_date ?? null,
          country,
        }
        const res = await fetch(`${API_BASE}/api/v1/report-upload/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || '上传失败')
        }
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? { ...it, fileCommitStatus: 'success', commitError: null }
              : it,
          ),
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败'
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? { ...it, fileCommitStatus: 'error', commitError: msg }
              : it,
          ),
        )
      }
    }

    setUploading(false)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

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
      it.fileCommitStatus !== 'saving',
  ).length

  return (
    <div className='space-y-6'>
      {/* Page header */}
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>报表自动化</h1>
        <p className='mt-1 text-sm text-muted-foreground'>
          拖拽上传报表，系统自动识别项目与日期，逐个文件校验提交。
        </p>
      </div>

      {/* Top controls */}
      <div className='flex items-center gap-3'>
        <Select value={country} onValueChange={(v) => setCountry(v)}>
          <SelectTrigger className='h-10 w-[160px] rounded-md border-border/70 bg-[hsl(var(--surface-overlay))]'>
            <SelectValue placeholder='选择站点' />
          </SelectTrigger>
          <SelectContent>
            {REPORT_UPLOAD_COUNTRY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button onClick={handleUploadAll} disabled={pendingCount === 0 || uploading}>
          {uploading ? (
            <>
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              上传中...
            </>
          ) : (
            <>
              <Upload className='mr-2 h-4 w-4' />
              上传全部 ({pendingCount})
            </>
          )}
        </Button>

        <Button
          variant='outline'
          onClick={clearAll}
          disabled={queueItems.length === 0 || recognizing || uploading}
        >
          <Trash2 className='mr-2 h-4 w-4' />
          清空列表
        </Button>
      </div>

      {/* Dropzone + File list */}
      <div className='grid gap-4 lg:grid-cols-[1fr_2fr]'>
        {/* Dropzone */}
        <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'>
          <CardContent className='p-5'>
            <div
              className={cn(
                'relative flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed px-5 py-8 transition-[border-color,background-color] duration-200',
                dragActive
                  ? 'border-sky-500/70 bg-sky-500/8'
                  : 'border-border/70 bg-[hsl(var(--surface-subtle))]',
              )}
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
                id='auto-upload-input'
                type='file'
                multiple
                className='hidden'
                accept='.txt,.csv,.xlsx'
                onChange={(e) => {
                  void recognizeFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              <label
                htmlFor='auto-upload-input'
                className='flex cursor-pointer flex-col items-center justify-center gap-3 text-center'
              >
                <div className='flex h-14 w-14 items-center justify-center rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] shadow-sm'>
                  <FileUp className='h-6 w-6 text-sky-600 dark:text-sky-300' />
                </div>
                <div className='space-y-1'>
                  <p className='text-sm font-semibold text-foreground sm:text-base'>
                    拖拽文件到这里，或点击选择
                  </p>
                  <p className='text-xs text-muted-foreground sm:text-sm'>
                    支持 `txt`、`csv`、`xlsx`
                  </p>
                </div>
              </label>
              {recognizing ? (
                <div className='absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 text-sm text-muted-foreground'>
                  <Loader2 className='h-4 w-4 animate-spin' />
                  正在识别...
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* File list */}
        <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'>
          <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-4 pb-3 pt-4'>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle className='text-base'>本次识别文件</CardTitle>
                <CardDescription className='text-xs'>
                  {queueItems.length} 个文件
                </CardDescription>
              </div>
              {uploading ? (
                <Loader2 className='h-4 w-4 animate-spin text-sky-500' />
              ) : null}
            </div>
          </CardHeader>
          <CardContent className='p-0'>
            <ScrollArea className='h-[calc(100vh-16rem)]'>
              <div className='space-y-2 p-3'>
                {queueItems.length === 0 ? (
                  <div className='rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]/45 px-4 py-8 text-center text-sm text-muted-foreground'>
                    暂无文件
                  </div>
                ) : null}
                {queueItems.map((item) => (
                  <div
                    key={item.localId}
                    className='flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-[hsl(var(--surface-subtle))]/85 px-3 py-3'
                  >
                    <div className='min-w-0 flex-1 space-y-1'>
                      <p className='truncate text-sm font-medium text-foreground'>
                        {item.originalFileName}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {item.recognitionStatus === 'pending'
                          ? '识别中'
                          : `类型：${getReportTypeLabel(item.reportType)}`}
                      </p>
                      {item.recognitionStatus !== 'pending' ? (
                        <>
                          <p className='text-xs text-muted-foreground'>
                            项目：{item.recognizedProject ?? '未识别'}
                          </p>
                          {item.detectedDate ? (
                            <p className='text-xs text-muted-foreground'>
                              日期：{item.detectedDate}
                            </p>
                          ) : null}
                          {item.error ? (
                            <p className='text-xs text-rose-600 dark:text-rose-300'>
                              {item.error}
                            </p>
                          ) : null}
                          {item.commitError ? (
                            <p className='text-xs text-rose-600 dark:text-rose-300'>
                              {item.commitError}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <div className='flex items-center gap-1.5'>
                      {item.fileCommitStatus === 'saving' ? (
                        <Loader2 className='h-4 w-4 animate-spin text-sky-600 dark:text-sky-300' />
                      ) : null}
                      {item.fileCommitStatus === 'success' ? (
                        <CheckCircle2 className='h-4 w-4 text-emerald-600 dark:text-emerald-300' />
                      ) : null}
                      {item.fileCommitStatus === 'error' ? (
                        <XCircle className='h-4 w-4 text-rose-600 dark:text-rose-300' />
                      ) : null}
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => removeItem(item.localId)}
                        className='h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:bg-rose-400/10 dark:hover:text-rose-300'
                      >
                        <XCircle className='h-4 w-4' />
                        <span className='sr-only'>移除</span>
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
