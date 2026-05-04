'use client'

import { AlertCircle, CalendarDays, CheckCircle2, CircleHelp, FileText, Loader2, PackageSearch } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
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
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-500 text-white"
        aria-label="已完成"
        title="已完成"
      >
        <CheckCircle2 className="h-4 w-4" />
      </span>
    )
  }
  if (state.commitStatus === 'saving') return <Badge className="bg-slate-600 text-white hover:bg-slate-600">处理中</Badge>
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
  // Auto modes don't need attention — dates are pre-filled from file
  if (state.recognition.date_input_mode === 'range_auto') {
    return !state.reportStartDate || !state.reportEndDate
  }
  if (state.recognition.date_input_mode === 'single_auto') {
    return !state.reportDate
  }
  if (state.recognition.date_input_mode === 'range_manual') {
    return !state.reportStartDate || !state.reportEndDate
  }
  return !state.reportDate
}

function isMultiCommitWithDerivedDates(state: ReportCardState) {
  // Exclude modes where dates come from the file (not from per-file derivation)
  const derivedModes = {'range_manual', 'range_auto'}
  return state.candidates.length > 1 && !derivedModes.has(state.recognition?.date_input_mode ?? '')
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
  const useRangePicker = recognition?.date_input_mode === 'range_manual' || recognition?.date_input_mode === 'range_auto' || (!recognition && config.type === 'payment_report')

  return (
    <Card className="flex h-full flex-col overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm dark:border-border/90">
      <CardContent className="flex flex-1 flex-col gap-4 px-5 !pt-6 pb-5 md:!pt-7">
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <CardTitle className="text-base leading-6 text-foreground">{config.title}</CardTitle>
            <div className="group relative mt-0.5 shrink-0">
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="查看识别字段"
                title={config.subtitle}
              >
                <CircleHelp className="h-4 w-4" />
              </button>
              <div className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-20 w-max max-w-[220px] -translate-x-1/2 rounded-md border border-border/80 bg-popover px-3 py-1.5 text-xs leading-5 text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 dark:border-border/95 dark:bg-[hsl(var(--surface-panel))]">
                {config.subtitle}
              </div>
            </div>
          </div>
          {statusBadge(state)}
        </div>
        <div className="space-y-2 rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))]/80 px-3 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <FileText className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            当前文件
          </div>
          {state.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">等待左侧上传区识别到该报表。</p>
          ) : (
            <>
              {state.candidates.length > 1 ? (
                <Select value={state.activeTempFileId || ''} onValueChange={onPickCandidate}>
                  <SelectTrigger className="rounded-md border-border/70 bg-[hsl(var(--surface-soft))] dark:border-border/95">
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
              {recognition && state.candidates.length <= 1 ? (
                <p className="truncate text-xs font-medium text-muted-foreground" title={recognition.original_filename}>
                  {recognition.original_filename}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="grid flex-1 gap-3 content-start">
          <div className="grid gap-3">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))]">
                <PackageSearch className={cn('h-4 w-4 text-slate-400 dark:text-slate-500', projectWarning && 'text-slate-500 dark:text-slate-400')} />
              </div>
              <Select value={state.selectedProject || undefined} onValueChange={onProjectChange}>
                <SelectTrigger
                  className={cn(
                    'rounded-md border-border/70 bg-[hsl(var(--surface-soft))] dark:border-border/95',
                    projectWarning &&
                      'border-slate-400/70 bg-slate-50/80 text-slate-700 ring-offset-background focus:ring-slate-400 dark:border-slate-400/50 dark:bg-slate-800/50 dark:text-slate-200'
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
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))]">
                <CalendarDays className={cn('h-4 w-4 text-slate-400 dark:text-slate-500', dateWarning && 'text-slate-500 dark:text-slate-400')} />
              </div>
              {useRangePicker ? (
                <DateRangePicker
                  value={parseDateRangeInputValue(state.reportStartDate, state.reportEndDate)}
                  className={cn(
                    'w-full rounded-md border-border/70 bg-[hsl(var(--surface-soft))] dark:border-border/95',
                    dateWarning &&
                      'border-slate-400/70 bg-slate-50/80 text-slate-700 focus-visible:ring-slate-400 dark:border-slate-400/50 dark:bg-slate-800/50 dark:text-slate-200'
                  )}
                  onChange={(range) => {
                    onDateChange('reportStartDate', formatDateInputValue(range?.from))
                    onDateChange('reportEndDate', formatDateInputValue(range?.to))
                  }}
                />
              ) : isMultiCommitWithDerivedDates(state) ? (
                <div className="rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-foreground">
                  每个文件将自动提取各自的日期
                </div>
              ) : recognition?.date_input_mode === 'multi_auto' ? (
                <div className="rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-foreground">
                  {recognition.detected_start_date && recognition.detected_end_date
                    ? `${recognition.detected_start_date} ~ ${recognition.detected_end_date}`
                    : '将按 purchase-date 自动拆分多个日期'}
                </div>
              ) : recognition?.date_input_mode === 'range_auto' ? (
                <div className="rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-foreground">
                  {recognition.detected_start_date && recognition.detected_end_date
                    ? `${recognition.detected_start_date} ~ ${recognition.detected_end_date}`
                    : '已从文件中自动识别日期范围'}
                </div>
              ) : recognition?.date_input_mode === 'single_auto' ? (
                <div className="rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-foreground">
                  {recognition.detected_date || '已从文件中自动识别日期'}
                </div>
              ) : (
                <SingleDatePicker
                  value={parseDateInputValue(state.reportDate)}
                  className={cn(
                    'rounded-md border-border/70 bg-[hsl(var(--surface-soft))] dark:border-border/95',
                    dateWarning &&
                      'border-slate-400/70 bg-slate-50/80 text-slate-700 focus-visible:ring-slate-400 dark:border-slate-400/50 dark:bg-slate-800/50 dark:text-slate-200'
                  )}
                  onChange={(date) => onDateChange('reportDate', formatDateInputValue(date))}
                />
              )}
            </div>
          </div>
        </div>

        {recognition?.warnings?.length ? (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/35 dark:bg-amber-400/10 dark:text-amber-100">
            {recognition.warnings.join('；')}
          </div>
        ) : null}

        {state.commitMessage && state.commitStatus === 'error' ? (
          <div className="rounded-xl border border-rose-300/70 bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/45 dark:bg-rose-500/10 dark:text-rose-100">
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
