'use client'

import { AlertCircle, CalendarDays, CheckCircle2, FileText, Loader2, PackageSearch } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangePicker, SingleDatePicker, formatDateInputValue, parseDateInputValue, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ReportCardConfig, ReportCardState } from '@/components/report-upload/types'
import { cn } from '@/lib/utils'

type Props = {
  config: ReportCardConfig
  state: ReportCardState
  projects: string[]
  onPickCandidate: (tempFileId: string) => void
  onProjectChange: (value: string) => void
  onDateChange: (field: 'reportDate' | 'reportStartDate' | 'reportEndDate', value: string) => void
  onCommit: () => void
  canCommit: boolean
}

function statusBadge(state: ReportCardState) {
  if (state.commitStatus === 'success') {
    return (
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white"
        aria-label="已完成"
        title="已完成"
      >
        <CheckCircle2 className="h-4 w-4" />
      </span>
    )
  }
  if (state.commitStatus === 'saving') return <Badge className="bg-sky-600 text-white hover:bg-sky-600">处理中</Badge>
  if (state.commitStatus === 'error') return <Badge variant="destructive">失败</Badge>
  if (state.candidates.length > 1) return <Badge variant="secondary">多文件待确认</Badge>
  if (state.recognition) return <Badge variant="secondary">待确认</Badge>
  return <Badge variant="outline">未识别</Badge>
}

function needsProjectAttention(state: ReportCardState) {
  if (!state.recognition) return false
  return !state.selectedProject && state.recognition.project_match.status !== 'matched'
}

function needsDateAttention(state: ReportCardState) {
  if (!state.recognition) return false
  if (state.recognition.date_input_mode === 'multi_auto') {
    return false
  }
  if (state.recognition.date_input_mode === 'range_manual') {
    return !state.reportStartDate || !state.reportEndDate
  }
  return !state.reportDate
}

export function ReportStatusCard({
  config,
  state,
  projects,
  onPickCandidate,
  onProjectChange,
  onDateChange,
  onCommit,
  canCommit,
}: Props) {
  const recognition = state.recognition
  const projectWarning = needsProjectAttention(state)
  const dateWarning = needsDateAttention(state)
  const useRangePicker = recognition?.date_input_mode === 'range_manual' || (!recognition && config.type === 'payment_report')

  return (
    <Card className="flex h-full flex-col border-border/70 bg-card/90 shadow-sm">
      <CardHeader className="space-y-3 pb-4">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-6">{config.title}</CardTitle>
          {statusBadge(state)}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="min-h-[92px] space-y-2 rounded-2xl bg-muted/35 px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4 text-sky-600" />
            当前文件
          </div>
          {state.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">等待左侧上传区识别到该报表。</p>
          ) : (
            <>
              {state.candidates.length > 1 ? (
                <Select value={state.activeTempFileId || ''} onValueChange={onPickCandidate}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择要使用的文件" />
                  </SelectTrigger>
                  <SelectContent>
                    {state.candidates.map((candidate) => (
                      <SelectItem key={candidate.temp_file_id} value={candidate.temp_file_id}>
                        {candidate.original_filename}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {recognition ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium">{recognition.original_filename}</p>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="grid flex-1 gap-3 content-start">
          <div className="grid gap-3">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/30">
                <PackageSearch className={cn('h-4 w-4 text-sky-600', projectWarning && 'text-rose-600')} />
              </div>
              <Select value={state.selectedProject || undefined} onValueChange={onProjectChange}>
                <SelectTrigger
                  className={cn(
                    projectWarning &&
                      'border-rose-300 bg-rose-50/80 text-rose-700 ring-offset-background focus:ring-rose-500 data-[placeholder]:text-rose-500'
                  )}
                >
                  <SelectValue placeholder="请选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project} value={project}>
                      {project}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/30">
                <CalendarDays className={cn('h-4 w-4 text-sky-600', dateWarning && 'text-rose-600')} />
              </div>
              {useRangePicker ? (
                <DateRangePicker
                  value={parseDateRangeInputValue(state.reportStartDate, state.reportEndDate)}
                  className={cn('w-full', dateWarning && 'border-rose-300 bg-rose-50/80 text-rose-700 focus-visible:ring-rose-500')}
                  onChange={(range) => {
                    onDateChange('reportStartDate', formatDateInputValue(range?.from))
                    onDateChange('reportEndDate', formatDateInputValue(range?.to))
                  }}
                />
              ) : recognition?.date_input_mode === 'multi_auto' ? (
                <div className="space-y-2">
                  <div className="rounded-2xl border border-border/60 bg-muted/30 px-3 py-2 text-sm text-foreground">
                    {recognition.detected_start_date && recognition.detected_end_date
                      ? `${recognition.detected_start_date} ~ ${recognition.detected_end_date}`
                      : '将按 purchase-date 自动拆分多个日期'}
                  </div>
                  <p className="text-xs text-muted-foreground">识别为周期日期，已锁定，无需手动填写，可直接上传。</p>
                </div>
              ) : (
                <SingleDatePicker
                  value={parseDateInputValue(state.reportDate)}
                  className={cn(dateWarning && 'border-rose-300 bg-rose-50/80 text-rose-700 focus-visible:ring-rose-500')}
                  onChange={(date) => onDateChange('reportDate', formatDateInputValue(date))}
                />
              )}
            </div>
          </div>
        </div>

        {recognition?.warnings?.length ? (
          <div className="rounded-2xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {recognition.warnings.join('；')}
          </div>
        ) : null}

        {state.commitMessage && state.commitStatus === 'error' ? (
          <div
            className="rounded-2xl border border-rose-300/70 bg-rose-50 px-3 py-2 text-xs text-rose-700"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {state.commitMessage}
            </div>
          </div>
        ) : null}

        <Button onClick={onCommit} disabled={!canCommit || state.commitStatus === 'saving'} className="mt-auto w-full">
          {state.commitStatus === 'saving' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              处理中
            </>
          ) : (
            '确认保存'
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
