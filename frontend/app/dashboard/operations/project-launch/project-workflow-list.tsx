'use client'

/** 项目启动台流程、阶段排期、内容与附件。 */

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Download, Loader2, Plus, Save, Trash2, Upload } from 'lucide-react'
import type { Session } from 'next-auth'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
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
import { cn } from '@/lib/utils'

import styles from './project-launch-warm.module.css'

function dateLabel(value: string | null | undefined) {
  return value || '未排期'
}

function fileSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function LocalButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={[styles.button, styles.buttonCompact, className].filter(Boolean).join(' ')}
    />
  )
}

const LocalInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function LocalInput({ className, ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={[styles.input, className].filter(Boolean).join(' ')}
      />
    )
  }
)

function LocalLabel({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={[styles.label, className].filter(Boolean).join(' ')} />
}

function LocalTextarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={[styles.textarea, className].filter(Boolean).join(' ')} />
  )
}

export function WorkflowStatusPill({
  status,
  className,
}: {
  status: WorkflowStatus
  className?: string
}) {
  const tone =
    status === 'completed'
      ? 'positive'
      : status === 'in_progress'
        ? 'accent'
        : 'neutral'
  return (
    <WarmBadge tone={tone} className={cn(styles.statusBadge, className)}>
      {WORKFLOW_STATUS_LABELS[status]}
    </WarmBadge>
  )
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
      className={cn(styles.statusSelect, className)}
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
  const [duration, setDuration] = useState(
    task.duration_days == null ? '' : String(task.duration_days)
  )
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
    <li data-testid={`workflow-task-${task.id}`} className={styles.taskRow}>
      <div className={styles.taskMain}>
        <div className={styles.taskIdentity}>
          <span className={styles.taskNumber}>{String(index + 1).padStart(2, '0')}</span>
          <div className={styles.taskCopy}>
            <div className={styles.taskTitleLine}>
              <span className={styles.taskTitle}>{task.title}</span>
              <span className={styles.taskDate}>
                {dateLabel(task.start_date)} ~ {dateLabel(task.end_date)}
              </span>
              <span className={styles.taskDuration}>
                {task.span_days != null
                  ? `${task.span_days} 天`
                  : task.duration_days != null
                    ? `${task.duration_days} 天`
                    : '工期未设置'}
              </span>
            </div>
            {task.description ? <p className={styles.taskDescription}>{task.description}</p> : null}
          </div>
        </div>
        <div className={styles.taskActions}>
          <TaskStatusSelect
            task={task}
            disabled={disabled}
            onChange={(status) => onStatusChange(task, status)}
          />
          {fixedDocument ? (
            <LocalButton
              disabled={disabled}
              onClick={() => onDownloadDocument(task)}
              title={`下载固定资料：${fixedDocument}`}
              data-testid={`task-download-${task.id}`}
            >
              <Download aria-hidden />
              固定资料
            </LocalButton>
          ) : null}
          {isAdmin ? (
            <LocalButton
              disabled={disabled}
              onClick={() => {
                if (!editing) {
                  setTitle(task.title)
                  setDescription(task.description ?? '')
                  setDuration(task.duration_days == null ? '' : String(task.duration_days))
                  setStartDate(task.start_date ?? '')
                  setEndDate(task.end_date ?? '')
                }
                setEditing((value) => !value)
              }}
            >
              {editing ? '收起编辑' : '编辑节点 / 排期'}
            </LocalButton>
          ) : null}
          {isAdmin ? (
            <LocalButton
              disabled={disabled || index === 0}
              aria-label={`上移 ${task.title}`}
              onClick={() => void onMoveTask(index, -1)}
            >
              上移
            </LocalButton>
          ) : null}
          {isAdmin ? (
            <LocalButton
              disabled={disabled || index === count - 1}
              aria-label={`下移 ${task.title}`}
              onClick={() => void onMoveTask(index, 1)}
            >
              下移
            </LocalButton>
          ) : null}
          {isAdmin ? (
            <LocalButton
              disabled={disabled}
              onClick={() =>
                void withConfirm(
                  `确认删除阶段「${task.title}」？相关内容与附件记录也会删除。`,
                  () => deleteProjectTask(task.id, session)
                )
              }
            >
              <Trash2 aria-hidden />
              删除
            </LocalButton>
          ) : null}
        </div>
      </div>

      {editing && isAdmin ? (
        <section className={styles.editorGrid} aria-label={`${task.title} 节点编辑`}>
          <div className={styles.field}>
            <LocalLabel htmlFor={`task-edit-title-${task.id}`}>阶段名称</LocalLabel>
            <LocalInput
              id={`task-edit-title-${task.id}`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <LocalLabel htmlFor={`task-edit-duration-${task.id}`}>计划工期（天）</LocalLabel>
            <LocalInput
              id={`task-edit-duration-${task.id}`}
              type="number"
              min={0}
              max={3650}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              placeholder="未设置"
            />
          </div>
          <div className={styles.field}>
            <LocalLabel htmlFor={`task-edit-start-${task.id}`}>开始日期（手动覆盖）</LocalLabel>
            <LocalInput
              id={`task-edit-start-${task.id}`}
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <LocalLabel htmlFor={`task-edit-end-${task.id}`}>结束日期（手动覆盖）</LocalLabel>
            <LocalInput
              id={`task-edit-end-${task.id}`}
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
          <div className={styles.fieldWide}>
            <LocalLabel htmlFor={`task-edit-description-${task.id}`}>阶段说明</LocalLabel>
            <LocalTextarea
              id={`task-edit-description-${task.id}`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </div>
          <div className={styles.editorActions}>
            <LocalButton
              disabled={disabled}
              onClick={() =>
                void onWorkflowMutation(() =>
                  updateProjectTaskDefinition(
                    task.id,
                    {
                      title,
                      description,
                      duration_days: duration === '' ? null : Number(duration),
                      start_date: startDate || null,
                      end_date: endDate || null,
                    },
                    session
                  )
                ).then((saved) => {
                  if (saved) setEditing(false)
                })
              }
            >
              <Save aria-hidden />
              保存阶段
            </LocalButton>
          </div>
        </section>
      ) : null}

      {contents.length > 0 || isAdmin ? (
        <section className={styles.taskSection} aria-label={`${task.title} 内容`}>
          <div className={styles.subsectionHeader}>
            <h3>阶段内容</h3>
            <span>{contents.length} 条</span>
          </div>
          <div className={styles.contentGrid}>
            {contents.map((content) => (
              <div key={content.id} className={styles.contentCard}>
                {content.title ? <h4>{content.title}</h4> : null}
                <p>{content.body}</p>
                {isAdmin ? (
                  editingContentId === content.id ? (
                    <div className={styles.contentEditor}>
                      <div className={styles.field}>
                        <LocalLabel htmlFor={`edit-content-title-${content.id}`}>
                          内容标题（可选）
                        </LocalLabel>
                        <LocalInput
                          id={`edit-content-title-${content.id}`}
                          value={contentTitleDraft}
                          onChange={(event) => setContentTitleDraft(event.target.value)}
                        />
                      </div>
                      <div className={styles.field}>
                        <LocalLabel htmlFor={`edit-content-body-${content.id}`}>
                          内容正文
                        </LocalLabel>
                        <LocalTextarea
                          id={`edit-content-body-${content.id}`}
                          value={contentBodyDraft}
                          onChange={(event) => setContentBodyDraft(event.target.value)}
                          rows={3}
                        />
                      </div>
                      <div className={styles.inlineActions}>
                        <LocalButton
                          disabled={disabled || !contentBodyDraft.trim()}
                          onClick={() =>
                            void onWorkflowMutation(() =>
                              updateProjectContent(
                                content.id,
                                { title: contentTitleDraft || null, body: contentBodyDraft },
                                session
                              )
                            ).then((saved) => {
                              if (saved) setEditingContentId(null)
                            })
                          }
                        >
                          <Save aria-hidden />
                          保存内容
                        </LocalButton>
                        <LocalButton disabled={disabled} onClick={() => setEditingContentId(null)}>
                          取消
                        </LocalButton>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.inlineActions}>
                      <LocalButton
                        disabled={disabled}
                        onClick={() => {
                          setEditingContentId(content.id)
                          setContentTitleDraft(content.title ?? '')
                          setContentBodyDraft(content.body)
                        }}
                      >
                        编辑内容
                      </LocalButton>
                      <LocalButton
                        disabled={disabled}
                        onClick={() =>
                          void withConfirm('确认删除这条阶段内容？', () =>
                            deleteProjectContent(content.id, session)
                          )
                        }
                      >
                        <Trash2 aria-hidden />
                        删除
                      </LocalButton>
                    </div>
                  )
                ) : null}
              </div>
            ))}
          </div>
          {isAdmin ? (
            <div className={styles.contentCreateGrid}>
              <div className={styles.field}>
                <LocalLabel htmlFor={`new-content-title-${task.id}`}>
                  内容标题（可选）
                </LocalLabel>
                <LocalInput
                  id={`new-content-title-${task.id}`}
                  value={newContentTitle}
                  onChange={(event) => setNewContentTitle(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <LocalLabel htmlFor={`new-content-body-${task.id}`}>新增内容</LocalLabel>
                <LocalTextarea
                  id={`new-content-body-${task.id}`}
                  rows={2}
                  value={newContentBody}
                  onChange={(event) => setNewContentBody(event.target.value)}
                />
              </div>
              <LocalButton
                disabled={disabled || !newContentBody.trim()}
                onClick={() =>
                  void onWorkflowMutation(() =>
                    createProjectContent(
                      projectId,
                      task.id,
                      { title: newContentTitle || undefined, body: newContentBody },
                      session
                    )
                  ).then((saved) => {
                    if (saved) {
                      setNewContentTitle('')
                      setNewContentBody('')
                    }
                  })
                }
              >
                <Plus aria-hidden />
                添加内容
              </LocalButton>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={styles.taskSection} aria-label={`${task.title} 附件`}>
        <div className={styles.attachmentHeader}>
          <h3>附件</h3>
          <span>{attachments.length} 个</span>
          <label className={styles.uploadButton}>
            {disabled ? (
              <Loader2 aria-hidden className={styles.spinner} />
            ) : (
              <Upload aria-hidden />
            )}
            上传附件
            <input
              className="sr-only"
              type="file"
              accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.zip,.png,.jpg,.jpeg,.webp"
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0]
                if (file) {
                  void onWorkflowMutation(() =>
                    uploadTaskAttachment(projectId, task.id, file, session)
                  )
                }
                event.target.value = ''
              }}
            />
          </label>
        </div>
        {attachments.length === 0 ? (
          <p className={styles.emptyText}>暂无附件</p>
        ) : (
          <ul className={styles.attachmentList}>
            {attachments.map((attachment) => (
              <li key={attachment.id} className={styles.attachmentRow}>
                <span className={styles.attachmentName} title={attachment.filename}>
                  {attachment.filename}
                </span>
                {attachment.origin === 'template' ? (
                  <WarmBadge tone="neutral">模板附件</WarmBadge>
                ) : null}
                <span className={styles.attachmentMeta}>
                  {fileSize(attachment.file_size)}
                </span>
                {attachment.uploader ? (
                  <span className={styles.attachmentMeta} title={attachment.uploader}>
                    {attachment.uploader}
                  </span>
                ) : null}
                <time
                  className={styles.attachmentMeta}
                  dateTime={attachment.created_at}
                >
                  {attachment.created_at.slice(0, 10)}
                </time>
                <LocalButton
                  disabled={disabled}
                  onClick={() =>
                    void downloadTaskAttachment(projectId, attachment, session).catch((error) =>
                      onError(error instanceof Error ? error.message : '附件下载失败')
                    )
                  }
                >
                  <Download aria-hidden />
                  下载
                </LocalButton>
                <LocalButton
                  disabled={disabled}
                  onClick={() =>
                    void withConfirm(`确认删除附件「${attachment.filename}」？`, () =>
                      deleteTaskAttachment(projectId, attachment.id, session)
                    )
                  }
                >
                  <Trash2 aria-hidden />
                  <span className="sr-only">删除 {attachment.filename}</span>
                </LocalButton>
              </li>
            ))}
          </ul>
        )}
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
    await onWorkflowMutation(() =>
      reorderProjectTasks(
        projectId,
        workflow.id,
        tasks.map((task) => task.id),
        session
      )
    )
  }

  return (
    <div className={styles.taskListWrap}>
      {isAdmin ? (
        <div className={styles.schedulePanel} aria-label="流程排期设置">
          <div className={styles.field}>
            <LocalLabel htmlFor={`workflow-title-${workflow.id}`}>流程名称</LocalLabel>
            <LocalInput
              id={`workflow-title-${workflow.id}`}
              value={workflowTitle}
              onChange={(event) => setWorkflowTitle(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <LocalLabel htmlFor={`workflow-anchor-${workflow.id}`}>计划开始日期</LocalLabel>
            <LocalInput
              ref={anchorInputRef}
              id={`workflow-anchor-${workflow.id}`}
              type="date"
              value={anchor}
              onChange={(event) => setAnchor(event.target.value)}
            />
          </div>
          <LocalButton
            disabled={disabled}
            onClick={() =>
              void onWorkflowMutation(() =>
                updateWorkflowDefinition(
                  workflow.id,
                  { title: workflowTitle.trim(), start_date: anchor || null },
                  session
                )
              ).then((saved) => {
                if (saved) setWorkflowTitle(workflowTitle.trim())
              })
            }
          >
            <Save aria-hidden />
            保存流程设置
          </LocalButton>
        </div>
      ) : null}
      <ul className={styles.taskList}>
        {workflow.tasks.map((task, index) => (
          <WorkflowTaskRow
            key={task.id}
            task={task}
            index={index}
            count={workflow.tasks.length}
            projectId={projectId}
            session={session}
            isAdmin={isAdmin}
            disabled={disabled || pendingTaskId != null}
            onStatusChange={onStatusChange}
            onWorkflowMutation={onWorkflowMutation}
            onMoveTask={moveTask}
            onDownloadDocument={onDownloadDocument}
            onError={onError}
          />
        ))}
      </ul>
      {isAdmin ? (
        <div className={styles.taskCreateGrid}>
          <div className={styles.field}>
            <LocalLabel htmlFor={`new-task-title-${workflow.id}`}>新增阶段</LocalLabel>
            <LocalInput
              id={`new-task-title-${workflow.id}`}
              value={newTaskTitle}
              onChange={(event) => setNewTaskTitle(event.target.value)}
              placeholder="阶段名称"
            />
          </div>
          <div className={styles.field}>
            <LocalLabel htmlFor={`new-task-days-${workflow.id}`}>计划工期（天）</LocalLabel>
            <LocalInput
              id={`new-task-days-${workflow.id}`}
              type="number"
              min={0}
              max={3650}
              value={newTaskDays}
              onChange={(event) => setNewTaskDays(event.target.value)}
              placeholder="选填"
            />
          </div>
          <LocalButton
            disabled={disabled || !newTaskTitle.trim()}
            onClick={() =>
              void onWorkflowMutation(() =>
                createProjectTask(
                  projectId,
                  workflow.id,
                  {
                    title: newTaskTitle.trim(),
                    duration_days: newTaskDays === '' ? null : Number(newTaskDays),
                  },
                  session
                )
              ).then((saved) => {
                if (saved) {
                  setNewTaskTitle('')
                  setNewTaskDays('')
                }
              })
            }
          >
            <Plus aria-hidden />
            新增节点
          </LocalButton>
        </div>
      ) : null}
    </div>
  )
}

export function WorkflowOverviewRow({ workflow }: { workflow: ProjectWorkflow }) {
  const next = findFirstIncompleteTask(workflow.tasks)
  return (
    <li data-testid={`workflow-overview-${workflow.id}`} className={styles.overviewRow}>
      <div className={styles.workflowHeader}>
        <span className={styles.workflowTitle}>{workflow.title}</span>
        <WorkflowStatusPill status={workflow.status} />
        <span className={styles.workflowProgress}>{formatWorkflowProgress(workflow)}</span>
      </div>
      <p className={styles.overviewNext}>
        {next ? `下一步：${next.title}` : '全部任务已完成'}
      </p>
      <p className={styles.overviewSchedule}>
        排期：{dateLabel(workflow.schedule_start)} ~ {dateLabel(workflow.schedule_end)}
        {workflow.schedule_days == null ? ' · 未排期' : ` · ${workflow.schedule_days} 天`}
      </p>
    </li>
  )
}
