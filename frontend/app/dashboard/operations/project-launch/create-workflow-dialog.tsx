'use client'

/**
 * 项目启动台 · 新建流程对话框（BLF-1234，设计稿 §7）。
 *
 * 读取后端模板目录（只含 key/kind/title 元数据），要求填写流程标题
 * （默认取模板标题，女士泳衣模板即「女士泳衣」），提交后由父层创建并刷新。
 * 提交失败在对话框内展示服务端错误，不静默关闭。
 */

import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef, type HTMLAttributes } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Loader2, X } from 'lucide-react'

import {
  DEFAULT_PRODUCT_WORKFLOW_TITLE,
  WORKFLOW_KIND_LABELS,
  type ProjectWorkflowCreateInput,
  type ProjectWorkflowTemplateOption,
} from '@/lib/project-workflows-api'

import styles from './project-launch-warm.module.css'

const Dialog = DialogPrimitive.Root

const DialogContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={styles.dialogOverlay} />
      <DialogPrimitive.Content
        {...props}
        ref={ref}
        className={[styles.createDialog, className].filter(Boolean).join(' ')}
      >
        {children}
        <DialogPrimitive.Close className={styles.dialogClose} aria-label="关闭">
          <X aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={[styles.dialogHeader, className].filter(Boolean).join(' ')} />
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={[styles.dialogFooter, className].filter(Boolean).join(' ')} />
}

const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      {...props}
      ref={ref}
      className={[styles.dialogTitle, className].filter(Boolean).join(' ')}
    />
  )
})

const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      {...props}
      ref={ref}
      className={[styles.dialogDescription, className].filter(Boolean).join(' ')}
    />
  )
})

export function CreateWorkflowDialog({
  open,
  onOpenChange,
  projectName,
  templates,
  templatesLoading,
  templatesError,
  onRetryTemplates,
  defaultTemplateKey,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  /** 已由父层按 kind 过滤的模板目录。 */
  templates: ProjectWorkflowTemplateOption[]
  templatesLoading: boolean
  templatesError: string | null
  onRetryTemplates: () => void
  /** 首选模板键（列表内优先选中，缺失时退回第一项）。 */
  defaultTemplateKey?: string
  /** 抛错时对话框展示错误信息并保持打开。 */
  onSubmit: (input: ProjectWorkflowCreateInput) => Promise<void>
}) {
  const [templateKey, setTemplateKey] = useState('')
  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSubmitting(false)
    const preferred =
      templates.find((template) => template.key === defaultTemplateKey) ?? templates[0]
    setTemplateKey(preferred?.key ?? '')
    setTitle(preferred?.title ?? DEFAULT_PRODUCT_WORKFLOW_TITLE)
    setStartDate('')
  }, [defaultTemplateKey, open, templates])

  const selected = templates.find((template) => template.key === templateKey) ?? null

  function handleTemplateChange(nextKey: string) {
    setTemplateKey(nextKey)
    const next = templates.find((template) => template.key === nextKey)
    if (next) setTitle(next.title)
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) {
      setError('请选择流程模板')
      return
    }
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('请填写流程标题')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        kind: selected.kind,
        template_key: selected.key,
        title: trimmedTitle,
        ...(startDate ? { start_date: startDate } : {}),
      })
      onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '创建流程失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={styles.createDialog}
        data-testid="create-workflow-dialog"
        aria-describedby="create-workflow-description"
      >
        <DialogHeader>
          <DialogTitle className={styles.dialogTitle}>新增产品开发流程</DialogTitle>
          <DialogDescription id="create-workflow-description" className={styles.dialogDescription}>
            为「{projectName}」选择一个产品模板，创建后任务清单会复制到本项目，
            之后模板文案调整不会覆盖已有进度。
          </DialogDescription>
        </DialogHeader>

        {templatesLoading ? (
          <div className={styles.dialogLoading}>
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </div>
        ) : templatesError ? (
          <div className={styles.dialogError} role="alert">
            <div>
              <strong>模板目录加载失败</strong>
              <p>{templatesError}</p>
            </div>
            <button type="button" onClick={onRetryTemplates}>
              重试
            </button>
          </div>
        ) : (
          <form className={styles.dialogForm} onSubmit={handleSubmit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="workflow-template">
                流程模板
              </label>
              <select
                id="workflow-template"
                data-testid="workflow-template-select"
                className={styles.select}
                value={templateKey}
                onChange={(event) => handleTemplateChange(event.target.value)}
                disabled={submitting || templates.length === 0}
              >
                {templates.length === 0 ? <option value="">暂无可用模板</option> : null}
                {templates.map((template) => (
                  <option key={template.key} value={template.key}>
                    {template.title}（{WORKFLOW_KIND_LABELS[template.kind]}）
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="workflow-start-date">
                计划开始日期
              </label>
              <input
                id="workflow-start-date"
                data-testid="workflow-start-date-input"
                className={styles.input}
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                disabled={submitting}
              />
              <p className={styles.formHelp}>
                创建时即按模板工期推算阶段日期；可稍后在流程设置中调整。
              </p>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="workflow-title">
                流程标题
              </label>
              <input
                id="workflow-title"
                data-testid="workflow-title-input"
                className={styles.input}
                value={title}
                maxLength={160}
                placeholder={DEFAULT_PRODUCT_WORKFLOW_TITLE}
                onChange={(event) => setTitle(event.target.value)}
                disabled={submitting}
              />
            </div>

            {error ? (
              <p role="alert" data-testid="create-workflow-error" className={styles.formError}>
                {error}
              </p>
            ) : null}

            <DialogFooter className={styles.dialogFooter}>
              <button
                type="button"
                className={styles.buttonQuiet}
                disabled={submitting}
                onClick={() => onOpenChange(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className={styles.button}
                disabled={submitting || templates.length === 0}
              >
                {submitting ? <Loader2 aria-hidden className={styles.spinner} /> : null}
                创建流程
              </button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
