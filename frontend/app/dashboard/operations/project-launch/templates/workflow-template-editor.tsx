'use client'

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { useSession } from 'next-auth/react'
import { ArrowLeft, ArrowRight, Copy, Loader2, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { isAdmin } from '@/lib/backend-auth'
import {
  WORKFLOW_DOCUMENTS,
  WORKFLOW_KIND_LABELS,
  copyTemplate,
  createTemplate,
  createTemplateContent,
  createTemplateTask,
  deleteTemplate,
  deleteTemplateContent,
  deleteTemplateTask,
  deleteTemplateTaskAttachment,
  fetchAdminTemplate,
  fetchAdminTemplates,
  reorderTemplateTasks,
  updateTemplate,
  updateTemplateContent,
  updateTemplateTask,
  uploadTemplateTaskAttachment,
  type AdminWorkflowTemplate,
  type WorkflowTemplateDetail,
  type WorkflowTemplateTask,
} from '@/lib/project-workflows-api'
import styles from './workflow-template-editor-warm.module.css'

type LocalButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'secondary' | 'term' | 'outline'
  size?: 'sm'
}

function Button({ className, variant: _variant, size, ...props }: LocalButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={[
        styles.button,
        size === 'sm' ? styles.buttonCompact : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
}

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={[styles.input, className].filter(Boolean).join(' ')}
      />
    )
  }
)

function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={[styles.label, className].filter(Boolean).join(' ')} />
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        {...props}
        ref={ref}
        className={[styles.textarea, className].filter(Boolean).join(' ')}
      />
    )
  }
)

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export default function WorkflowTemplateEditor() {
  const { data: session, status: sessionStatus } = useSession()
  const admin = isAdmin(session)
  const [templates, setTemplates] = useState<AdminWorkflowTemplate[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<WorkflowTemplateDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newTemplateOpen, setNewTemplateOpen] = useState(false)
  const [newKind, setNewKind] = useState<'store_launch' | 'product_development'>('store_launch')
  const [newTitle, setNewTitle] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newContentByTask, setNewContentByTask] = useState<Record<number, { title: string; body: string }>>({})
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null)
  const detailRequest = useRef(0)
  const [refreshing, setRefreshing] = useState(false)

  const loadList = useCallback(async (preferredId?: number | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchAdminTemplates(session)
      setTemplates(result.templates)
      setSelectedId((current) => preferredId ?? (current != null && result.templates.some((template) => template.id === current) ? current : result.templates[0]?.id ?? null))
    } catch (loadError) {
      setTemplates([])
      setError(errorMessage(loadError, '模板列表加载失败'))
    } finally {
      setLoading(false)
    }
  }, [session])

  const loadDetail = useCallback(async (templateId: number, quiet = false) => {
    const requestId = ++detailRequest.current
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const next = await fetchAdminTemplate(templateId, session)
      if (requestId !== detailRequest.current) return
      setDetail(next)
      setTemplates((current) => current.map((item) => item.id === next.id ? next : item))
    } catch (loadError) {
      if (requestId === detailRequest.current) setError(errorMessage(loadError, '模板详情加载失败'))
    } finally {
      if (requestId === detailRequest.current && !quiet) setLoading(false)
    }
  }, [session, detailRequest])

  useEffect(() => {
    if (sessionStatus === 'loading' || !admin) return
    void loadList()
  }, [admin, loadList, sessionStatus])

  useEffect(() => {
    detailRequest.current += 1
    if (selectedId == null || !admin) {
      setDetail(null)
      setActiveTaskId(null)
      return
    }
    setDetail(null)
    setActiveTaskId(null)
    void loadDetail(selectedId)
  }, [admin, loadDetail, selectedId])

  const refreshDraftRef = useRef({ detail, activeTaskId, busyKey })
  refreshDraftRef.current = { detail, activeTaskId, busyKey }
  const saveTaskRef = useRef<((task: WorkflowTemplateTask) => Promise<void>) | null>(null)
  const saveTaskContentsRef = useRef<((task: WorkflowTemplateTask) => Promise<void>) | null>(null)
  const refreshCurrentTemplate = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const draft = refreshDraftRef.current
      if (draft.busyKey !== null) return
      const activeTask = draft.detail?.tasks.find((task) => task.id === draft.activeTaskId)
      if (activeTask) {
        await saveTaskRef.current?.(activeTask)
        await saveTaskContentsRef.current?.(activeTask)
      }
      await loadList(selectedId)
      if (selectedId != null) await loadDetail(selectedId, true)
    } finally {
      setRefreshing(false)
    }
  }, [loadDetail, loadList, selectedId])
  useHeaderRefresh(refreshCurrentTemplate, { loading: loading || refreshing })

  useEffect(() => {
    if (!detail) return
    if (detail.tasks.length === 0) {
      setActiveTaskId(null)
    } else if (activeTaskId == null || !detail.tasks.some((task) => task.id === activeTaskId)) {
      setActiveTaskId(detail.tasks[0].id)
    }
  }, [activeTaskId, detail])

  async function runAction(key: string, action: () => Promise<void>, success?: string) {
    setBusyKey(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (success) setNotice(success)
    } catch (actionError) {
      setError(errorMessage(actionError, '操作失败'))
    } finally {
      setBusyKey(null)
    }
  }

  async function saveTemplate() {
    if (!detail) return
    await runAction('save-template', async () => {
      const updated = await updateTemplate(detail.id, {
        title: detail.title,
        description: detail.description,
        sort_order: detail.sort_order,
      }, session)
      setDetail(updated)
      setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
    }, '模板已保存')
  }

  async function addTemplate() {
    const title = newTitle.trim()
    if (!title) {
      setError('请填写模板标题')
      return
    }
    await runAction('new-template', async () => {
      const created = await createTemplate({ kind: newKind, title }, session)
      setNewTitle('')
      setNewTemplateOpen(false)
      await loadList(created.id)
      await loadDetail(created.id, true)
    }, '模板已创建')
  }

  async function addTask() {
    if (!detail || !newTaskTitle.trim()) {
      setError('请填写节点名称')
      return
    }
    await runAction('new-task', async () => {
      const updated = await createTemplateTask(detail.id, { title: newTaskTitle.trim() }, session)
      setDetail(updated)
      setActiveTaskId(updated.tasks[updated.tasks.length - 1]?.id ?? null)
      setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
      setNewTaskTitle('')
    }, '节点已添加')
  }

  async function uploadAttachment(task: WorkflowTemplateTask, file: File | undefined) {
    if (!file) return
    await runAction(`upload-${task.id}`, async () => {
      await uploadTemplateTaskAttachment(task.id, file, session)
      await loadDetail(task.template_id, true)
    }, '附件已上传')
  }

  function updateTaskLocal(taskId: number, patch: Partial<WorkflowTemplateTask>) {
    setDetail((current) => current ? {
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, ...patch } : task),
    } : current)
  }

  function updateContentLocal(taskId: number, contentId: number, patch: { title?: string | null; body?: string }) {
    setDetail((current) => current ? {
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? {
        ...task,
        contents: (task.contents ?? []).map((content) => content.id === contentId ? { ...content, ...patch } : content),
      } : task),
    } : current)
  }

  const saveTask = useCallback(async (task: WorkflowTemplateTask) => {
    const updated = await updateTemplateTask(task.id, {
      title: task.title,
      description: task.description,
      attachment_key: task.attachment_key,
      duration_days: task.duration_days,
    }, session)
    setDetail(updated)
    setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
  }, [session])

  const saveTaskContents = useCallback(async (task: WorkflowTemplateTask) => {
    for (const content of task.contents ?? []) {
      const saved = await updateTemplateContent(content.id, { title: content.title, body: content.body }, session)
      setDetail(saved)
      setTemplates((current) => current.map((item) => item.id === saved.id ? saved : item))
    }
  }, [session])
  saveTaskRef.current = saveTask
  saveTaskContentsRef.current = saveTaskContents

  async function switchTask(nextTaskId: number) {
    if (!detail || busyKey !== null || nextTaskId === activeTaskId) return
    const activeTask = detail.tasks.find((task) => task.id === activeTaskId)
    if (!activeTask) {
      setActiveTaskId(nextTaskId)
      return
    }
    try {
      await runAction('switch-task', async () => {
        await saveTask(activeTask)
        await saveTaskContents(activeTask)
        setActiveTaskId(nextTaskId)
      }, '阶段已自动保存')
    } catch {
      // Keep the current stage selected so the user can correct the failed save.
    }
  }

  async function moveTask(index: number, direction: -1 | 1) {
    if (!detail) return
    const ordered = [...detail.tasks]
    const destination = index + direction
    if (destination < 0 || destination >= ordered.length) return
    ;[ordered[index], ordered[destination]] = [ordered[destination], ordered[index]]
    await runAction('reorder-tasks', async () => {
      const updated = await reorderTemplateTasks(detail.id, ordered.map((task) => task.id), session)
      setDetail(updated)
      setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
    }, '阶段顺序已更新')
  }

  if (sessionStatus === 'loading') {
    return (
      <div className={styles.loadingState} role="status">
        <Loader2 aria-hidden className={styles.spinner} />
        正在确认管理员权限…
      </div>
    )
  }

  if (!admin) {
    return (
      <div
        className={styles.forbidden}
        data-testid="template-editor-forbidden"
        data-warm-surface="warm-ledger"
      >
        <h1>无权限</h1>
        <p>流程模板仅允许管理员维护。</p>
      </div>
    )
  }

  return (
    <main
      className={styles.page}
      data-testid="workflow-template-editor-warm-page"
      data-warm-surface="warm-ledger"
      aria-busy={loading || refreshing || busyKey !== null}
    >
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h1>流程模板</h1>
          <p>维护模板、阶段工期、每阶段内容与附件。修改不会覆盖已创建的项目流程。</p>
        </div>
        <Button size="sm" onClick={() => void loadList(selectedId)} disabled={loading}><RefreshCw aria-hidden />刷新</Button>
        <Button size="sm" onClick={() => setNewTemplateOpen((open) => !open)}><Plus aria-hidden />新建模板</Button>
      </header>

      {error ? <div role="alert" className={styles.errorBanner}>{error}</div> : null}
      {notice ? <div role="status" className={styles.noticeBanner}>{notice}</div> : null}

      {newTemplateOpen ? (
        <section className="flex flex-col gap-2 border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] p-2 md:flex-row md:items-end" aria-label="新建模板">
          <div className="flex-1 space-y-1"><Label htmlFor="new-template-kind">流程类型</Label><select id="new-template-kind" className={styles.select} value={newKind} onChange={(event) => setNewKind(event.target.value as typeof newKind)}><option value="store_launch">店铺启动</option><option value="product_development">产品开发</option></select></div>
          <div className="flex-[2] space-y-1"><Label htmlFor="new-template-title">模板名称</Label><Input id="new-template-title" value={newTitle} maxLength={160} onChange={(event) => setNewTitle(event.target.value)} placeholder="例如：女士泳衣" /></div>
          <Button type="button" className="w-full md:w-auto" disabled={busyKey !== null} onClick={() => void addTemplate()}>{busyKey === 'new-template' ? <Loader2 className="animate-spin" /> : <Plus />}创建</Button>
        </section>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-[minmax(220px,0.72fr)_minmax(0,2fr)]">
        <section className="min-w-0 border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)]" aria-label="模板列表">
          <div className="flex items-center justify-between border-b border-[var(--warm-ledger-color-hairline)] px-2 py-2"><h2 className="text-xs text-[var(--warm-ledger-color-text)]">模板目录</h2><span className={`${styles.numeric} text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>{templates.length}</span></div>
          {loading && templates.length === 0 ? <div className="p-3 text-xs text-[var(--warm-ledger-color-text-muted)]">加载模板中…</div> : templates.length === 0 ? <p className="p-3 text-xs text-[var(--warm-ledger-color-text-muted)]">暂无模板。新建模板后可添加阶段。</p> : (
            <ul className="max-h-52 divide-y divide-[var(--warm-ledger-color-hairline)] overflow-y-auto lg:max-h-none">
              {templates.map((template) => <li key={template.id}>
                <button type="button" aria-current={selectedId === template.id ? 'true' : undefined} onClick={() => setSelectedId(template.id)} className={`flex min-h-[44px] w-full flex-col justify-center gap-1 px-2 py-2 text-left transition-colors hover:bg-[var(--warm-ledger-color-raised-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--warm-ledger-color-hairline-strong)] ${selectedId === template.id ? 'bg-[var(--warm-ledger-color-raised)]' : ''}`}>
                  <span className="flex w-full items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs">{template.title}</span><WarmBadge tone="neutral">{WORKFLOW_KIND_LABELS[template.kind]}</WarmBadge></span>
                  <span className={`${styles.numeric} text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>{template.task_count} 个阶段 · {template.key}</span>
                </button>
              </li>)}
            </ul>
          )}
        </section>

        <section className="min-w-0 border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)]" aria-label="模板详情">
          {!detail ? <div className="p-4 text-xs text-[var(--warm-ledger-color-text-muted)]">{loading ? '正在读取模板…' : '从左侧选择一个模板，开始维护阶段。'}</div> : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--warm-ledger-color-hairline)] px-2 py-2">
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--warm-ledger-color-text)]">{detail.title}</span>
                <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => void runAction('copy', async () => {
                  const copied = await copyTemplate(detail.id, {}, session)
                  await loadList(copied.id)
                  await loadDetail(copied.id, true)
                }, '模板副本已创建')}><Copy aria-hidden />复制模板</Button>
                <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => void saveTemplate()}>{busyKey === 'save-template' ? <Loader2 className="animate-spin" /> : null}保存模板</Button>
                <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => {
                  if (!window.confirm(`确认删除「${detail.title}」？已创建的项目流程不受影响。`)) return
                  void runAction('delete-template', async () => {
                    await deleteTemplate(detail.id, session)
                    setDetail(null)
                    setSelectedId(null)
                    await loadList()
                  }, '模板已删除')
                }}><Trash2 aria-hidden />删除</Button>
              </div>
              <div className="space-y-4 p-3">
                <section className="space-y-2" aria-label="模板基本信息">
                  <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-[var(--warm-ledger-color-text)]">模板信息</h3><span className={`${styles.numeric} truncate text-[11px] text-[var(--warm-ledger-color-text-muted)]`} data-numeric="true">Key: {detail.key}</span></div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_100px]">
                    <div className="space-y-1"><Label htmlFor="template-title">模板名称</Label><Input id="template-title" value={detail.title} onChange={(event) => setDetail({ ...detail, title: event.target.value })} maxLength={160} /></div>
                    <div className="space-y-1"><Label htmlFor="template-order">目录顺序</Label><Input id="template-order" type="number" min={0} value={detail.sort_order} onChange={(event) => setDetail({ ...detail, sort_order: Number(event.target.value) || 0 })} /></div>
                    <div className="space-y-1 md:col-span-2"><Label htmlFor="template-description">模板说明</Label><Textarea id="template-description" value={detail.description ?? ''} onChange={(event) => setDetail({ ...detail, description: event.target.value })} rows={2} /></div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-[var(--warm-ledger-color-hairline)] pt-3" aria-label="阶段编辑">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-xs font-semibold text-[var(--warm-ledger-color-text)]">阶段编辑</h3><span className={`${styles.numeric} text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>{detail.tasks.length} 个阶段</span></div>
                  {detail.tasks.length > 0 ? (
                    <>
                      <ol className="flex gap-1 overflow-x-auto border-b border-[var(--warm-ledger-color-hairline)] pb-2" aria-label="阶段导航">
                        {detail.tasks.map((task, index) => {
                          const active = task.id === activeTaskId
                          return <li key={task.id} className="min-w-0 flex-1">
                            <button type="button" aria-current={active ? 'step' : undefined} aria-label={`第 ${index + 1} 阶段：${task.title}`} onClick={() => void switchTask(task.id)} disabled={busyKey !== null} className={`flex h-full min-h-12 w-full min-w-[112px] items-center gap-2 border px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--warm-ledger-color-hairline-strong)] disabled:cursor-wait ${active ? 'border-[var(--warm-ledger-color-hairline-strong)] bg-[var(--warm-ledger-color-raised)] text-[var(--warm-ledger-color-text)]' : 'border-[var(--warm-ledger-color-hairline)] text-[var(--warm-ledger-color-text-muted)] hover:bg-[var(--warm-ledger-color-raised-hover)] hover:text-[var(--warm-ledger-color-text)]'}`}>
                              <span className={`${styles.numeric} flex h-6 w-6 shrink-0 items-center justify-center border text-[11px] ${active ? 'border-[var(--warm-ledger-color-hairline-strong)] text-[var(--warm-ledger-color-text)]' : 'border-[var(--warm-ledger-color-hairline)] text-[var(--warm-ledger-color-text-muted)]'}`}>{String(index + 1).padStart(2, '0')}</span>
                              <span className="min-w-0 truncate text-[11px]">{task.title}</span>
                            </button>
                          </li>
                        })}
                      </ol>
                      {(() => {
                        const taskIndex = detail.tasks.findIndex((task) => task.id === activeTaskId)
                        const task = detail.tasks[taskIndex]
                        if (!task) return null
                        const taskContents = task.contents ?? []
                        const taskAttachments = task.attachments ?? []
                        return <div className="space-y-4" data-testid={`template-task-${task.id}`}>
                          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--warm-ledger-color-hairline)] pb-2">
                            <div className="min-w-0 flex-1"><p className={`${styles.numeric} text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>阶段 {String(taskIndex + 1).padStart(2, '0')} / {String(detail.tasks.length).padStart(2, '0')}</p><h4 className="mt-1 truncate text-sm font-semibold text-[var(--warm-ledger-color-text)]">{task.title}</h4></div>
                            <span className="text-[11px] text-[var(--warm-ledger-color-text-muted)]">切换时自动保存</span>
                          </div>
                          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[36px_minmax(0,1fr)_110px]">
                            <span className={`${styles.numeric} flex h-9 items-center justify-center border border-[var(--warm-ledger-color-hairline)] text-xs text-[var(--warm-ledger-color-text-muted)]`}>{String(taskIndex + 1).padStart(2, '0')}</span>
                            <div className="space-y-1"><Label htmlFor={`task-title-${task.id}`}>阶段名称</Label><Input id={`task-title-${task.id}`} value={task.title} onChange={(event) => updateTaskLocal(task.id, { title: event.target.value })} maxLength={160} /></div>
                            <div className="space-y-1"><Label htmlFor={`task-days-${task.id}`}>计划工期（天）</Label><Input id={`task-days-${task.id}`} type="number" min={0} max={3650} value={task.duration_days ?? ''} onChange={(event) => updateTaskLocal(task.id, { duration_days: event.target.value === '' ? null : Number(event.target.value) })} placeholder="未设置" /></div>
                            <div className="space-y-1 md:col-span-2"><Label htmlFor={`task-description-${task.id}`}>阶段说明</Label><Textarea id={`task-description-${task.id}`} value={task.description ?? ''} onChange={(event) => updateTaskLocal(task.id, { description: event.target.value })} rows={2} /></div>
                            <div className="space-y-1"><Label htmlFor={`task-document-${task.id}`}>固定资料</Label><select id={`task-document-${task.id}`} className={styles.select} value={task.attachment_key ?? ''} onChange={(event) => updateTaskLocal(task.id, { attachment_key: event.target.value || null })}><option value="">不关联固定资料</option>{Object.entries(WORKFLOW_DOCUMENTS).map(([key, doc]) => <option value={key} key={key}>{doc.label}</option>)}</select></div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => void runAction(`save-task-${task.id}`, () => saveTask(task), '阶段已保存')}>保存阶段</Button>
                            <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null || taskIndex === 0} onClick={() => void moveTask(taskIndex, -1)}>上移</Button>
                            <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null || taskIndex === detail.tasks.length - 1} onClick={() => void moveTask(taskIndex, 1)}>下移</Button>
                            <Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => {
                              if (!window.confirm(`确认删除阶段「${task.title}」？`)) return
                              void runAction(`delete-task-${task.id}`, async () => {
                                const nextIndex = Math.min(taskIndex, detail.tasks.length - 2)
                                const updated = await deleteTemplateTask(task.id, session)
                                setDetail(updated)
                                setActiveTaskId(updated.tasks[Math.max(0, nextIndex)]?.id ?? null)
                                setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
                              }, '阶段已删除')
                            }}><Trash2 aria-hidden />删除阶段</Button>
                          </div>

                          <div className="grid min-w-0 grid-cols-1 gap-4 border-t border-[var(--warm-ledger-color-hairline)] pt-3 xl:grid-cols-2">
                            <section aria-label={`${task.title} 内容`}>
                              <div className="mb-2 flex items-center justify-between gap-2"><h5 className="text-xs font-semibold text-[var(--warm-ledger-color-text)]">阶段内容</h5><span className={`${styles.numeric} text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>{taskContents.length} 条</span></div>
                              <div className="space-y-2">
                                {taskContents.map((content) => <div key={content.id} className="grid gap-1 border border-[var(--warm-ledger-color-hairline)] p-2">
                                  <Label htmlFor={`content-title-${content.id}`}>小标题（可选）</Label><Input id={`content-title-${content.id}`} value={content.title ?? ''} onChange={(event) => updateContentLocal(task.id, content.id, { title: event.target.value })} />
                                  <Label htmlFor={`content-body-${content.id}`}>内容</Label><Textarea id={`content-body-${content.id}`} value={content.body} onChange={(event) => updateContentLocal(task.id, content.id, { body: event.target.value })} rows={3} />
                                  <div className="flex justify-end gap-1"><Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => void runAction(`save-content-${content.id}`, async () => {
                                    const edited = detail.tasks.find((candidate) => candidate.id === task.id)?.contents?.find((item) => item.id === content.id)
                                    if (!edited) return
                                    const updated = await updateTemplateContent(content.id, { title: edited.title, body: edited.body }, session)
                                    setDetail(updated)
                                    setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
                                  }, '内容已保存')}>保存内容</Button><Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => {
                                    if (!window.confirm('确认删除这条阶段内容？')) return
                                    void runAction(`delete-content-${content.id}`, async () => {
                                      const updated = await deleteTemplateContent(content.id, session)
                                      setDetail(updated)
                                      setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
                                    }, '内容已删除')
                                  }}><Trash2 aria-hidden />删除</Button></div>
                                </div>)}
                                <div className="grid gap-1 border border-dashed border-[var(--warm-ledger-color-hairline)] p-2"><Label htmlFor={`new-content-title-${task.id}`}>新增内容标题</Label><Input id={`new-content-title-${task.id}`} value={newContentByTask[task.id]?.title ?? ''} onChange={(event) => setNewContentByTask((current) => ({ ...current, [task.id]: { title: event.target.value, body: current[task.id]?.body ?? '' } }))} /><Label htmlFor={`new-content-body-${task.id}`}>新增内容</Label><Textarea id={`new-content-body-${task.id}`} rows={2} value={newContentByTask[task.id]?.body ?? ''} onChange={(event) => setNewContentByTask((current) => ({ ...current, [task.id]: { title: current[task.id]?.title ?? '', body: event.target.value } }))} /><Button type="button" variant="secondary" size="sm" className="w-full justify-self-stretch sm:w-auto sm:justify-self-end" disabled={busyKey !== null || !(newContentByTask[task.id]?.body ?? '').trim()} onClick={() => void runAction(`add-content-${task.id}`, async () => {
                                  const content = newContentByTask[task.id]
                                  if (!content?.body.trim()) return
                                  const updated = await createTemplateContent(task.id, { title: content.title || undefined, body: content.body }, session)
                                  setNewContentByTask((current) => ({ ...current, [task.id]: { title: '', body: '' } }))
                                  setDetail(updated)
                                  setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
                                }, '内容已添加')}><Plus aria-hidden />添加内容</Button></div>
                              </div>
                            </section>

                            <section aria-label={`${task.title} 附件`}>
                              <div className="mb-2 flex items-center justify-between gap-2"><h5 className="text-xs font-semibold text-[var(--warm-ledger-color-text)]">模板附件</h5><span className={`${styles.numeric} text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>{taskAttachments.length} 个</span></div>
                              <ul className="divide-y divide-[var(--warm-ledger-color-hairline)] border-y border-[var(--warm-ledger-color-hairline)]">
                                {taskAttachments.map((attachment) => <li key={attachment.id} className="flex min-w-0 items-center gap-2 py-2"><span className="min-w-0 flex-1 truncate text-xs text-[var(--warm-ledger-color-text)]" title={attachment.filename}>{attachment.filename}</span><span className={`${styles.numeric} shrink-0 text-[11px] text-[var(--warm-ledger-color-text-muted)]`}>{formatFileSize(attachment.file_size)}</span><Button type="button" variant="secondary" size="sm" disabled={busyKey !== null} onClick={() => {
                                  if (!window.confirm(`确认移除模板附件「${attachment.filename}」？现有项目中仍引用的对象会保留。`)) return
                                  void runAction(`delete-attachment-${attachment.id}`, async () => {
                                    const updated = await deleteTemplateTaskAttachment(attachment.id, session)
                                    setDetail(updated)
                                    setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item))
                                  }, '附件已移除')
                                }}><Trash2 aria-hidden /><span className="sr-only">删除 {attachment.filename}</span></Button></li>)}
                              </ul>
                              <label className="mt-2 inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center gap-1.5 border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-2 text-[11px] text-[var(--warm-ledger-color-text-muted)] hover:border-[var(--warm-ledger-color-hairline-strong)] hover:text-[var(--warm-ledger-color-text)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 sm:min-h-8 sm:w-auto">
                                {busyKey === `upload-${task.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload aria-hidden className="h-3.5 w-3.5" />}上传附件
                                <input className="sr-only" type="file" accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.zip,.png,.jpg,.jpeg,.webp" disabled={busyKey !== null} onChange={(event: ChangeEvent<HTMLInputElement>) => { void uploadAttachment(task, event.target.files?.[0]); event.target.value = '' }} />
                              </label>
                              <p className="mt-1 text-[11px] leading-4 text-[var(--warm-ledger-color-text-muted)]">单个文件最大 50 MB。模板附件会随模板复制到新流程。</p>
                            </section>
                          </div>
                          <div className="flex flex-col gap-2 border-t border-[var(--warm-ledger-color-hairline)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                            <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" disabled={busyKey !== null || taskIndex === 0} onClick={() => void switchTask(detail.tasks[taskIndex - 1].id)}><ArrowLeft aria-hidden />上一步</Button>
                            <span className="text-[11px] text-[var(--warm-ledger-color-text-muted)]">离开此阶段时自动保存阶段设置与已有内容</span>
                            <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" disabled={busyKey !== null || taskIndex === detail.tasks.length - 1} onClick={() => void switchTask(detail.tasks[taskIndex + 1].id)}>下一步<ArrowRight aria-hidden /></Button>
                          </div>
                        </div>
                      })()}
                    </>
                  ) : <p className="border border-dashed border-[var(--warm-ledger-color-hairline)] p-4 text-xs text-[var(--warm-ledger-color-text-muted)]">当前模板还没有阶段，添加阶段后即可开始编辑。</p>}
                  <div className="flex flex-col gap-2 border-t border-[var(--warm-ledger-color-hairline)] pt-3 sm:flex-row sm:items-end">
                    <div className="min-w-0 flex-1 space-y-1"><Label htmlFor="new-template-task">新增阶段</Label><Input id="new-template-task" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="输入阶段名称" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addTask() } }} /></div>
                    <Button type="button" variant="secondary" className="w-full sm:w-auto" disabled={busyKey !== null || !newTaskTitle.trim()} onClick={() => void addTask()}>{busyKey === 'new-task' ? <Loader2 className="animate-spin" /> : <Plus aria-hidden />}新增阶段</Button>
                  </div>
                </section>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}
