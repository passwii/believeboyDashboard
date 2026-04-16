'use client'

import { type DragEvent, type ChangeEvent } from 'react'
import { CheckCircle2, FileUp, Loader2, Trash2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { REPORT_UPLOAD_COUNTRY_OPTIONS, type ReportUploadCountry, type UploadQueueItem } from '@/components/report-upload/types'

function getReportTypeLabel(type: UploadQueueItem['reportType']): string {
  switch (type) {
    case 'inventory_report':
      return '亚马逊物流库存'
    case 'business_report':
      return '业务报告'
    case 'ad_product_report':
      return '广告 - 已推广商品'
    case 'ad_search_term_report':
      return '广告搜索词报告'
    case 'sales_report':
      return '销售报表 - 所有订单'
    case 'payment_report':
      return '付款报告'
    case 'return_report':
      return '退货明细'
    default:
      return '未识别'
  }
}

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
    <Card className="overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm">
      <CardContent className="p-4 md:p-5">
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.02fr)_minmax(300px,0.98fr)]">
          <div className="flex h-full min-h-[252px] flex-col gap-4 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={country} onValueChange={onCountryChange}>
                <SelectTrigger className="h-10 w-[160px] rounded-md border-border/70 bg-[hsl(var(--surface-overlay))] dark:border-border/95 dark:bg-[hsl(var(--surface-soft))]">
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

            <div
              className={cn(
                'relative flex flex-1 rounded-2xl border border-dashed px-5 py-5 transition-[border-color,background-color] duration-200',
                dragActive
                  ? 'border-sky-500/70 bg-sky-500/8'
                  : 'border-border/70 bg-[hsl(var(--surface-subtle))]'
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
              <label
                htmlFor="report-upload-input"
                className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 text-center"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] shadow-sm">
                  <FileUp className="h-6 w-6 text-sky-600 dark:text-sky-300" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground sm:text-base">拖拽文件到这里，或点击选择</p>
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
          </div>

          <div className="mt-2 flex h-full max-h-[252px] min-h-[252px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-[hsl(var(--surface-soft))]">
            <div className="flex items-center justify-between border-b border-border/60 bg-[hsl(var(--surface-subtle))]/80 px-4 pb-3 pt-5">
              <p className="text-sm font-semibold text-foreground">本次识别文件</p>
              <span className="text-xs text-muted-foreground">{items.length} 个</span>
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-2 p-3">
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]/45 px-4 py-8 text-center text-sm text-muted-foreground dark:border-border/85 dark:bg-[hsl(var(--surface-low))]/75">
                    暂无文件
                  </div>
                ) : null}
                {items.map((item) => (
                  <div
                    key={item.localId}
                    className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-[hsl(var(--surface-subtle))]/85 px-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium text-foreground">{item.originalFileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.recognitionStatus === 'pending'
                          ? '识别中'
                          : `类型：${getReportTypeLabel(item.reportType)}`}
                      </p>
                      {item.recognitionStatus !== 'pending' ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            项目：{item.recognizedProject || '未识别'}
                          </p>
                          {item.detectedDate ? (
                            <p className="text-xs text-muted-foreground">
                              日期：{item.detectedDate}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                      {item.error ? <p className="text-xs text-rose-600 dark:text-rose-300">{item.error}</p> : null}
                      {item.commitError ? <p className="text-xs text-rose-600 dark:text-rose-300">{item.commitError}</p> : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {item.fileCommitStatus === 'saving' ? (
                        <Loader2 className="h-4 w-4 animate-spin text-sky-600 dark:text-sky-300" />
                      ) : null}
                      {item.fileCommitStatus === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                      ) : null}
                      {item.fileCommitStatus === 'error' ? (
                        <XCircle className="h-4 w-4 text-rose-600 dark:text-rose-300" />
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemove(item.localId)}
                        className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:bg-rose-400/10 dark:hover:text-rose-300"
                      >
                        <XCircle className="h-4 w-4" />
                        <span className="sr-only">remove</span>
                      </Button>
                    </div>
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
