'use client'

import { type DragEvent, type ChangeEvent } from 'react'
import { FileUp, Loader2, Trash2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { REPORT_UPLOAD_COUNTRY_OPTIONS, type ReportUploadCountry, type UploadQueueItem } from '@/components/report-upload/types'

type Props = {
  items: UploadQueueItem[]
  dragActive: boolean
  recognizing: boolean
  country: ReportUploadCountry
  onCountryChange: (value: ReportUploadCountry) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void
  onPickFiles: (event: ChangeEvent<HTMLInputElement>) => void
  onRemove: (localId: string) => void
  onClear: () => void
  onUploadReady: () => void
  readyCount: number
  uploadingAny: boolean
}

export function ReportUploadDropzone({
  items,
  dragActive,
  recognizing,
  country,
  onCountryChange,
  onDrop,
  onDragOver,
  onDragLeave,
  onPickFiles,
  onRemove,
  onClear,
  onUploadReady,
  readyCount,
  uploadingAny,
}: Props) {
  return (
    <Card className="border-border/70 bg-card/80 shadow-sm">
      <CardHeader className="space-y-0 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-xl">统一上传区</CardTitle>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <Select value={country} onValueChange={onCountryChange}>
              <SelectTrigger className="h-10 w-[160px] rounded-xl border-border/70 bg-background">
                <SelectValue placeholder="选择站点" />
              </SelectTrigger>
              <SelectContent>
                {REPORT_UPLOAD_COUNTRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={onUploadReady} disabled={readyCount === 0 || uploadingAny}>
              {uploadingAny ? '上传中...' : `上传全部 (${readyCount})`}
            </Button>
            <Button variant="outline" onClick={onClear} disabled={items.length === 0 || recognizing || uploadingAny}>
              <Trash2 className="mr-2 h-4 w-4" />
              清空列表
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.02fr)_minmax(300px,0.98fr)]">
          <div
            className={cn(
              'relative flex min-h-[188px] rounded-3xl border border-dashed px-5 py-5 transition',
              dragActive ? 'border-sky-500 bg-sky-500/10' : 'border-border bg-muted/40'
            )}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
          >
            <input
              id="report-upload-input"
              type="file"
              multiple
              className="hidden"
              accept=".txt,.csv,.xlsx"
              onChange={onPickFiles}
            />
            <label htmlFor="report-upload-input" className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-background shadow-sm">
                <FileUp className="h-6 w-6 text-sky-600" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold sm:text-base">拖拽文件到这里，或点击选择</p>
                <p className="text-xs text-muted-foreground sm:text-sm">支持 `txt`、`csv`、`xlsx`</p>
              </div>
            </label>
            {recognizing ? (
              <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在识别
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-border/60 bg-background">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <p className="text-sm font-semibold">本次识别文件</p>
              <span className="text-xs text-muted-foreground">{items.length} 个</span>
            </div>
            <ScrollArea className="h-[188px]">
              <div className="space-y-2 p-3">
                {items.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">
                    暂无文件
                  </div>
                ) : null}
                {items.map((item) => (
                  <div
                    key={item.localId}
                    className="flex items-start justify-between gap-3 rounded-2xl border border-border/60 bg-muted/30 px-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium">{item.originalFileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.recognitionStatus === 'pending'
                          ? '识别中'
                          : item.reportType === 'unknown' || !item.reportType
                            ? '未匹配到已支持的报表类型'
                            : `已识别为 ${item.reportType}`}
                      </p>
                      {item.error ? <p className="text-xs text-rose-600">{item.error}</p> : null}
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => onRemove(item.localId)} className="h-8 w-8 shrink-0">
                      <XCircle className="h-4 w-4" />
                      <span className="sr-only">remove</span>
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
