'use client'

/**
 * 项目启动台 · 流程与任务展示（BLF-1234，设计稿 §7）。
 *
 * 纯展示组件：状态变更 / 下载由父层注入回调（父层独占 API 调用与错误回滚），
 * 便于单测与「写失败保留上一次已保存状态」的语义收口在一处。
 */

import { Download, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { TermPill, type TermTone } from '@/components/terminal/term-controls'
import { cn } from '@/lib/utils'
import {
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_OPTIONS,
  findFirstIncompleteTask,
  formatWorkflowProgress,
  resolveDocumentFilename,
  type ProjectWorkflow,
  type ProjectWorkflowTask,
  type WorkflowStatus,
} from '@/lib/project-workflows-api'

const STATUS_TONE: Record<WorkflowStatus, TermTone> = {
  not_started: 'muted',
  in_progress: 'accent',
  waiting_on_partner: 'warn',
  completed: 'pos',
}

export function WorkflowStatusPill({
  status,
  className,
}: {
  status: WorkflowStatus
  className?: string
}) {
  return (
    <TermPill tone={STATUS_TONE[status]} className={className}>
      {WORKFLOW_STATUS_LABELS[status]}
    </TermPill>
  )
}

/** 任务行状态控件（唯一可写入口）。 */
export function TaskStatusSelect({
  task,
  disabled,
  onChange,
  className,
}: {
  task: ProjectWorkflowTask
  disabled?: boolean
  onChange: (status: WorkflowStatus) => void
  className?: string
}) {
  return (
    <select
      aria-label={`${task.title} 状态`}
      data-testid={`task-status-${task.id}`}
      className={cn(
        'h-8 shrink-0 rounded-none border border-term-border bg-term-bg px-1.5 font-mono text-[11px] leading-4 text-term-text shadow-none transition-colors focus:border-term-border-strong focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      value={task.status}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as WorkflowStatus)}
    >
      {WORKFLOW_STATUS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** 单条任务行：标题 + 模板短描述 + 状态控件 +（有附件键时）下载按钮。 */
export function WorkflowTaskRow({
  task,
  pending,
  disabled,
  onStatusChange,
  onDownload,
}: {
  task: ProjectWorkflowTask
  pending: boolean
  disabled: boolean
  onStatusChange: (task: ProjectWorkflowTask, status: WorkflowStatus) => void
  onDownload: (task: ProjectWorkflowTask) => void
}) {
  const filename = resolveDocumentFilename(task.attachment_key)

  return (
    <li
      data-testid={`workflow-task-${task.id}`}
      className="flex flex-col gap-2 border-b border-term-border px-2 py-2 last:border-b-0 md:flex-row md:items-center md:gap-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-term-faint">
            {String(task.sort_order).padStart(2, '0')}
          </span>
          <span className="truncate font-mono text-xs text-term-text">{task.title}</span>
        </div>
        {task.description ? (
          <p className="pl-[calc(1.5rem+0.5rem)] font-mono text-[11px] leading-4 text-term-muted">
            {task.description}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 pl-[calc(1.5rem+0.5rem)] md:pl-0">
        {pending ? (
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-term-muted" />
        ) : null}
        <TaskStatusSelect
          task={task}
          disabled={disabled}
          onChange={(status) => onStatusChange(task, status)}
        />
        {filename ? (
          <Button
            type="button"
            variant="term"
            size="sm"
            disabled={disabled}
            onClick={() => onDownload(task)}
            title={`下载 ${filename}`}
            data-testid={`task-download-${task.id}`}
          >
            <Download aria-hidden />
            下载
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** 一个流程的完整任务列表。 */
export function WorkflowTaskList({
  workflow,
  pendingTaskId,
  disabled,
  onStatusChange,
  onDownload,
}: {
  workflow: ProjectWorkflow
  pendingTaskId: number | null
  disabled: boolean
  onStatusChange: (task: ProjectWorkflowTask, status: WorkflowStatus) => void
  onDownload: (task: ProjectWorkflowTask) => void
}) {
  return (
    <ul className="flex flex-col rounded-none border border-term-border">
      {workflow.tasks.map((task) => (
        <WorkflowTaskRow
          key={task.id}
          task={task}
          pending={pendingTaskId === task.id}
          disabled={disabled}
          onStatusChange={onStatusChange}
          onDownload={onDownload}
        />
      ))}
    </ul>
  )
}

/** 概览 Tab 的流程摘要行：进度 + 第一个未完成任务。 */
export function WorkflowOverviewRow({ workflow }: { workflow: ProjectWorkflow }) {
  const next = findFirstIncompleteTask(workflow.tasks)

  return (
    <li
      data-testid={`workflow-overview-${workflow.id}`}
      className="flex flex-col gap-1 border-b border-term-border px-2 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate font-mono text-xs text-term-text">{workflow.title}</span>
        <WorkflowStatusPill status={workflow.status} />
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-term-muted">
          {formatWorkflowProgress(workflow)}
        </span>
      </div>
      <p className="truncate font-mono text-[11px] leading-4 text-term-muted">
        {next ? `下一步：${next.title}` : '全部任务已完成'}
      </p>
    </li>
  )
}
