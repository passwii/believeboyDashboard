'use client'

/** 项目启动台流程、阶段排期、内容与附件。 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Download, Loader2, Plus, Save, Trash2, Upload } from 'lucide-react'
import type { Session } from 'next-auth'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { TermPill, type TermTone } from '@/components/terminal/term-controls'
import {
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_OPTIONS,
  createProjectContent,
  createProjectTask,
  deleteProjectContent,
  deleteProjectTask,
  deleteTaskAttachment,
  downloadTaskAttachment,
  findFirstIncompleteTask,
  formatWorkflowProgress,
  reorderProjectTasks,
  resolveDocumentFilename,
  updateProjectContent,
  updateProjectTaskDefinition,
  updateWorkflowDefinition,
  uploadTaskAttachment,
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

function dateLabel(value: string | null | undefined) {
  return value || '未排期'
}

function fileSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function WorkflowStatusPill({ status, className }: { status: WorkflowStatus; className?: string }) {
  return <TermPill tone={STATUS_TONE[status]} className={className}>{WORKFLOW_STATUS_LABELS[status]}</TermPill>
}

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
      className={`h-8 shrink-0 border border-term-border bg-term-bg px-1.5 font-mono text-[11px] leading-4 text-term-text transition-colors focus:border-term-border-strong focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ''}`}
      value={task.status}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as WorkflowStatus)}
    >
      {WORKFLOW_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

function WorkflowTaskRow({
  task,
  index,
  count,
  projectId,
  session,
  isAdmin,
  disabled,
  onStatusChange,
  onWorkflowMutation,
  onMoveTask,
  onDownloadDocument,
  onError,
}: {
  task: ProjectWorkflowTask
  index: number
  count: number
  projectId: number
  session: Session | null
  isAdmin: boolean
  disabled: boolean
  onStatusChange: (task: ProjectWorkflowTask, status: WorkflowStatus) => void
  onWorkflowMutation: (action: () => Promise<ProjectWorkflow>) => Promise<boolean>
  onMoveTask: (index: number, direction: -1 | 1) => Promise<void>
  onDownloadDocument: (task: ProjectWorkflowTask) => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [duration, setDuration] = useState(task.duration_days == null ? '' : String(task.duration_days))
  const [startDate, setStartDate] = useState(task.start_date ?? '')
  const [endDate, setEndDate] = useState(task.end_date ?? '')
  const [newContentTitle, setNewContentTitle] = useState('')
  const [newContentBody, setNewContentBody] = useState('')
  const previousTaskId = useRef(task.id)
  const [editingContentId, setEditingContentId] = useState<number | null>(null)
  const [contentTitleDraft, setContentTitleDraft] = useState('')
  const [contentBodyDraft, setContentBodyDraft] = useState('')
  const fixedDocument = resolveDocumentFilename(task.attachment_key)
  const contents = task.contents ?? []
  const attachments = task.attachments ?? []

  useEffect(() => {
    if (previousTaskId.current !== task.id) {
      previousTaskId.current = task.id
      setEditing(false)
      setEditingContentId(null)
      setNewContentTitle('')
      setNewContentBody('')
    }
    setTitle(task.title)
    setDescription(task.description ?? '')
    setDuration(task.duration_days == null ? '' : String(task.duration_days))
    setStartDate(task.start_date ?? '')
    setEndDate(task.end_date ?? '')
  }, [task.id, task.title, task.description, task.duration_days, task.start_date, task.end_date])

  async function withConfirm(message: string, action: () => Promise<ProjectWorkflow>) {
    if (!window.confirm(message)) return
    await onWorkflowMutation(action)
  }

  return (
    <li data-testid={`workflow-task-${task.id}`} className="border-b border-term-border px-2 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 gap-2">
          <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-term-faint">{String(index + 1).padStart(2, '0')}</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-term-text">{task.title}</span>
              <span className="font-mono text-[11px] tabular-nums text-term-muted">{dateLabel(task.start_date)} ~ {dateLabel(task.end_date)}</span>
              <span className="font-mono text-[11px] tabular-nums text-term-faint">{task.span_days != null ? `${task.span_days} 天` : task.duration_days != null ? `${task.duration_days} 天` : '工期未设置'}</span>
            </div>
            {task.description ? <p className="mt-1 font-mono text-[11px] leading-4 text-term-muted">{task.description}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-5 lg:pl-0">
          <TaskStatusSelect task={task} disabled={disabled} onChange={(status) => onStatusChange(task, status)} />
          {fixedDocument ? <Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => onDownloadDocument(task)} title={`下载固定资料：${fixedDocument}`} data-testid={`task-download-${task.id}`}><Download aria-hidden />固定资料</Button> : null}
          {isAdmin ? <Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => {
            if (!editing) {
              setTitle(task.title)
              setDescription(task.description ?? '')
              setDuration(task.duration_days == null ? '' : String(task.duration_days))
              setStartDate(task.start_date ?? '')
              setEndDate(task.end_date ?? '')
            }
            setEditing((value) => !value)
          }}>{editing ? '收起编辑' : '编辑节点 / 排期'}</Button> : null}
          {isAdmin ? <Button type="button" variant="term" size="sm" disabled={disabled || index === 0} aria-label={`上移 ${task.title}`} onClick={() => void onMoveTask(index, -1)}>上移</Button> : null}
          {isAdmin ? <Button type="button" variant="term" size="sm" disabled={disabled || index === count - 1} aria-label={`下移 ${task.title}`} onClick={() => void onMoveTask(index, 1)}>下移</Button> : null}
          {isAdmin ? <Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => void withConfirm(`确认删除阶段「${task.title}」？相关内容与附件记录也会删除。`, () => deleteProjectTask(task.id, session))}><Trash2 aria-hidden />删除</Button> : null}
        </div>
      </div>

      {editing && isAdmin ? (
        <section className="mt-3 grid min-w-0 grid-cols-1 gap-2 border-t border-term-border pt-3 md:grid-cols-2" aria-label={`${task.title} 节点编辑`}>
          <div className="space-y-1"><Label htmlFor={`task-edit-title-${task.id}`}>阶段名称</Label><Input id={`task-edit-title-${task.id}`} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor={`task-edit-duration-${task.id}`}>计划工期（天）</Label><Input id={`task-edit-duration-${task.id}`} type="number" min={0} max={3650} value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="未设置" /></div>
          <div className="space-y-1"><Label htmlFor={`task-edit-start-${task.id}`}>开始日期（手动覆盖）</Label><Input id={`task-edit-start-${task.id}`} type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor={`task-edit-end-${task.id}`}>结束日期（手动覆盖）</Label><Input id={`task-edit-end-${task.id}`} type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor={`task-edit-description-${task.id}`}>阶段说明</Label><Textarea id={`task-edit-description-${task.id}`} value={description} onChange={(event) => setDescription(event.target.value)} rows={2} /></div>
          <div className="flex justify-end md:col-span-2"><Button type="button" disabled={disabled} onClick={() => void onWorkflowMutation(() => updateProjectTaskDefinition(task.id, {
            title,
            description,
            duration_days: duration === '' ? null : Number(duration),
            start_date: startDate || null,
            end_date: endDate || null,
          }, session)).then((saved) => { if (saved) setEditing(false) })}><Save aria-hidden />保存阶段</Button></div>
        </section>
      ) : null}

      {contents.length > 0 || isAdmin ? (
        <section className="mt-3 border-t border-term-border pt-3" aria-label={`${task.title} 内容`}>
          <div className="mb-2 flex items-center gap-2"><h3 className="font-mono text-[11px] text-term-muted">阶段内容</h3><span className="font-mono text-[10px] tabular-nums text-term-faint">{contents.length} 条</span></div>
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {contents.map((content) => (
              <div key={content.id} className="min-w-0 border border-term-border px-2 py-2">
                {content.title ? <h4 className="mb-1 font-mono text-xs text-term-text">{content.title}</h4> : null}
                <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-term-muted">{content.body}</p>
                {isAdmin ? editingContentId === content.id ? <div className="mt-2 grid gap-2 border-t border-term-border pt-2">
                  <div className="space-y-1"><Label htmlFor={`edit-content-title-${content.id}`}>内容标题（可选）</Label><Input id={`edit-content-title-${content.id}`} value={contentTitleDraft} onChange={(event) => setContentTitleDraft(event.target.value)} /></div>
                  <div className="space-y-1"><Label htmlFor={`edit-content-body-${content.id}`}>内容正文</Label><Textarea id={`edit-content-body-${content.id}`} value={contentBodyDraft} onChange={(event) => setContentBodyDraft(event.target.value)} rows={3} /></div>
                  <div className="flex justify-end gap-1.5"><Button type="button" variant="term" size="sm" disabled={disabled || !contentBodyDraft.trim()} onClick={() => void onWorkflowMutation(() => updateProjectContent(content.id, { title: contentTitleDraft || null, body: contentBodyDraft }, session)).then((saved) => { if (saved) setEditingContentId(null) })}><Save aria-hidden />保存内容</Button><Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => setEditingContentId(null)}>取消</Button></div>
                </div> : <div className="mt-2 flex justify-end gap-1.5"><Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => {
                  setEditingContentId(content.id)
                  setContentTitleDraft(content.title ?? '')
                  setContentBodyDraft(content.body)
                }}>编辑内容</Button><Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => void withConfirm('确认删除这条阶段内容？', () => deleteProjectContent(content.id, session))}><Trash2 aria-hidden />删除</Button></div> : null}
              </div>
            ))}
          </div>
          {isAdmin ? <div className="mt-2 grid grid-cols-1 gap-2 border border-dashed border-term-border p-2 md:grid-cols-[minmax(0,0.7fr)_minmax(0,2fr)_auto] md:items-end">
            <div className="space-y-1"><Label htmlFor={`new-content-title-${task.id}`}>内容标题（可选）</Label><Input id={`new-content-title-${task.id}`} value={newContentTitle} onChange={(event) => setNewContentTitle(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor={`new-content-body-${task.id}`}>新增内容</Label><Textarea id={`new-content-body-${task.id}`} rows={2} value={newContentBody} onChange={(event) => setNewContentBody(event.target.value)} /></div>
            <Button type="button" variant="term" disabled={disabled || !newContentBody.trim()} onClick={() => void onWorkflowMutation(() => createProjectContent(projectId, task.id, { title: newContentTitle || undefined, body: newContentBody }, session)).then((saved) => { if (saved) { setNewContentTitle(''); setNewContentBody('') } })}><Plus aria-hidden />添加内容</Button>
          </div> : null}
        </section>
      ) : null}

      <section className="mt-3 border-t border-term-border pt-3" aria-label={`${task.title} 附件`}>
        <div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="font-mono text-[11px] text-term-muted">附件</h3><span className="font-mono text-[10px] tabular-nums text-term-faint">{attachments.length} 个</span><label className="ml-auto inline-flex h-8 cursor-pointer items-center gap-1.5 border border-term-border bg-term-panel px-2 font-mono text-[11px] text-term-muted hover:border-term-border-strong hover:text-term-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">{disabled ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Upload aria-hidden className="h-3.5 w-3.5" />}上传附件<input className="sr-only" type="file" accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.zip,.png,.jpg,.jpeg,.webp" disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0]
          if (file) void onWorkflowMutation(() => uploadTaskAttachment(projectId, task.id, file, session))
          event.target.value = ''
        }} /></label></div>
        {attachments.length === 0 ? <p className="font-mono text-[11px] text-term-faint">暂无附件</p> : <ul className="divide-y divide-term-border border-y border-term-border">
          {attachments.map((attachment) => <li key={attachment.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-term-text" title={attachment.filename}>{attachment.filename}</span>
            {attachment.origin === 'template' ? <TermPill tone="info">模板附件</TermPill> : null}
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-term-muted">{fileSize(attachment.file_size)}</span>
            {attachment.uploader ? <span className="max-w-28 truncate font-mono text-[10px] text-term-faint" title={attachment.uploader}>{attachment.uploader}</span> : null}
            <time className="shrink-0 font-mono text-[10px] tabular-nums text-term-faint" dateTime={attachment.created_at}>{attachment.created_at.slice(0, 10)}</time>
            <Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => void downloadTaskAttachment(projectId, attachment, session).catch((error) => onError(error instanceof Error ? error.message : '附件下载失败'))}><Download aria-hidden />下载</Button>
            <Button type="button" variant="term" size="sm" disabled={disabled} onClick={() => void withConfirm(`确认删除附件「${attachment.filename}」？`, () => deleteTaskAttachment(projectId, attachment.id, session))}><Trash2 aria-hidden /><span className="sr-only">删除 {attachment.filename}</span></Button>
          </li>)}
        </ul>}
      </section>
    </li>
  )
}

export function WorkflowTaskList({
  workflow,
  pendingTaskId,
  disabled,
  isAdmin,
  projectId,
  session,
  onStatusChange,
  onWorkflowMutation,
  onDownloadDocument,
  onError,
}: {
  workflow: ProjectWorkflow
  pendingTaskId: number | null
  disabled: boolean
  isAdmin: boolean
  projectId: number
  session: Session | null
  onStatusChange: (task: ProjectWorkflowTask, status: WorkflowStatus) => void
  onWorkflowMutation: (action: () => Promise<ProjectWorkflow>) => Promise<boolean>
  onDownloadDocument: (task: ProjectWorkflowTask) => void
  onError: (message: string) => void
}) {
  const [workflowTitle, setWorkflowTitle] = useState(workflow.title)
  const [anchor, setAnchor] = useState(workflow.start_date ?? '')
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDays, setNewTaskDays] = useState('')
  const previousWorkflowId = useRef(workflow.id)
  const anchorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (previousWorkflowId.current !== workflow.id) {
      previousWorkflowId.current = workflow.id
      setNewTaskTitle('')
      setNewTaskDays('')
    } else if (anchorInputRef.current && document.activeElement !== anchorInputRef.current) {
      setAnchor(workflow.start_date ?? '')
    }
    setWorkflowTitle(workflow.title)
  }, [workflow.id, workflow.title, workflow.start_date])

  async function moveTask(index: number, direction: -1 | 1) {
    const tasks = [...workflow.tasks]
    const target = index + direction
    if (target < 0 || target >= tasks.length) return
    ;[tasks[index], tasks[target]] = [tasks[target], tasks[index]]
    await onWorkflowMutation(() => reorderProjectTasks(projectId, workflow.id, tasks.map((task) => task.id), session))
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {isAdmin ? <div className="grid grid-cols-1 gap-2 border border-term-border bg-term-panel p-2 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end" aria-label="流程排期设置">
        <div className="space-y-1"><Label htmlFor={`workflow-title-${workflow.id}`}>流程名称</Label><Input id={`workflow-title-${workflow.id}`} value={workflowTitle} onChange={(event) => setWorkflowTitle(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`workflow-anchor-${workflow.id}`}>计划开始日期</Label><Input ref={anchorInputRef} id={`workflow-anchor-${workflow.id}`} type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} /></div>
        <Button type="button" variant="term" disabled={disabled} onClick={() => void onWorkflowMutation(() => updateWorkflowDefinition(workflow.id, { title: workflowTitle.trim(), start_date: anchor || null }, session)).then((saved) => { if (saved) setWorkflowTitle(workflowTitle.trim()) })}><Save aria-hidden />保存流程设置</Button>
      </div> : null}
      <ul className="flex min-w-0 flex-col border border-term-border">
        {workflow.tasks.map((task, index) => <WorkflowTaskRow key={task.id} task={task} index={index} count={workflow.tasks.length} projectId={projectId} session={session} isAdmin={isAdmin} disabled={disabled || pendingTaskId != null} onStatusChange={onStatusChange} onWorkflowMutation={onWorkflowMutation} onMoveTask={moveTask} onDownloadDocument={onDownloadDocument} onError={onError} />)}
      </ul>
      {isAdmin ? <div className="grid grid-cols-1 gap-2 border border-dashed border-term-border p-2 md:grid-cols-[minmax(0,1fr)_140px_auto] md:items-end">
        <div className="space-y-1"><Label htmlFor={`new-task-title-${workflow.id}`}>新增阶段</Label><Input id={`new-task-title-${workflow.id}`} value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="阶段名称" /></div>
        <div className="space-y-1"><Label htmlFor={`new-task-days-${workflow.id}`}>计划工期（天）</Label><Input id={`new-task-days-${workflow.id}`} type="number" min={0} max={3650} value={newTaskDays} onChange={(event) => setNewTaskDays(event.target.value)} placeholder="选填" /></div>
        <Button type="button" variant="term" disabled={disabled || !newTaskTitle.trim()} onClick={() => void onWorkflowMutation(() => createProjectTask(projectId, workflow.id, { title: newTaskTitle.trim(), duration_days: newTaskDays === '' ? null : Number(newTaskDays) }, session)).then((saved) => { if (saved) { setNewTaskTitle(''); setNewTaskDays('') } })}><Plus aria-hidden />新增节点</Button>
      </div> : null}
    </div>
  )
}

export function WorkflowOverviewRow({ workflow }: { workflow: ProjectWorkflow }) {
  const next = findFirstIncompleteTask(workflow.tasks)
  return <li data-testid={`workflow-overview-${workflow.id}`} className="flex flex-col gap-1 border-b border-term-border px-2 py-3 last:border-b-0">
    <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="truncate font-mono text-xs text-term-text">{workflow.title}</span><WorkflowStatusPill status={workflow.status} /><span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-term-muted">{formatWorkflowProgress(workflow)}</span></div>
    <p className="truncate font-mono text-[11px] leading-4 text-term-muted">{next ? `下一步：${next.title}` : '全部任务已完成'}</p>
    <p className="font-mono text-[11px] tabular-nums text-term-faint">排期：{dateLabel(workflow.schedule_start)} ~ {dateLabel(workflow.schedule_end)}{workflow.schedule_days == null ? ' · 未排期' : ` · ${workflow.schedule_days} 天`}</p>
  </li>
}
