'use client'

/**
 * 项目启动台 · 新建流程对话框（BLF-1234，设计稿 §7）。
 *
 * 读取后端模板目录（只含 key/kind/title 元数据），要求填写流程标题
 * （默认取模板标题，女士泳衣模板即「女士泳衣」），提交后由父层创建并刷新。
 * 提交失败在对话框内展示服务端错误，不静默关闭。
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { TERM_SELECT_NATIVE } from '@/components/terminal/term-controls'
import {
  DEFAULT_PRODUCT_WORKFLOW_TITLE,
  WORKFLOW_KIND_LABELS,
  type ProjectWorkflowCreateInput,
  type ProjectWorkflowTemplateOption,
} from '@/lib/project-workflows-api'

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

  // 每次打开时按模板目录重置表单（优先选中默认模板 + 其标题）。
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
      <DialogContent className="sm:max-w-md" data-testid="create-workflow-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider">
            新增产品开发流程
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-term-muted">
            为「{projectName}」选择一个产品模板，创建后任务清单会复制到本项目，
            之后模板文案调整不会覆盖已有进度。
          </DialogDescription>
        </DialogHeader>

        {templatesLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : templatesError ? (
          <ErrorState
            title="模板目录加载失败"
            message={templatesError}
            onRetry={onRetryTemplates}
          />
        ) : (
          <form className="space-y-3" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="workflow-template">流程模板</Label>
              <select
                id="workflow-template"
                data-testid="workflow-template-select"
                className={`${TERM_SELECT_NATIVE} w-full`}
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

            <div className="space-y-1.5">
              <Label htmlFor="workflow-start-date">计划开始日期</Label>
              <Input
                id="workflow-start-date"
                data-testid="workflow-start-date-input"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                disabled={submitting}
              />
              <p className="font-mono text-[11px] leading-4 text-term-muted">
                创建时即按模板工期推算阶段日期；可稍后在流程设置中调整。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workflow-title">流程标题</Label>
              <Input
                id="workflow-title"
                data-testid="workflow-title-input"
                value={title}
                maxLength={160}
                placeholder={DEFAULT_PRODUCT_WORKFLOW_TITLE}
                onChange={(event) => setTitle(event.target.value)}
                disabled={submitting}
              />
            </div>

            {error ? (
              <p
                role="alert"
                data-testid="create-workflow-error"
                className="font-mono text-[11px] leading-4 text-term-neg"
              >
                {error}
              </p>
            ) : null}

            <DialogFooter className="gap-1.5">
              <Button
                type="button"
                variant="term"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={submitting || templates.length === 0}>
                {submitting ? <Loader2 aria-hidden className="animate-spin" /> : null}
                创建流程
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
