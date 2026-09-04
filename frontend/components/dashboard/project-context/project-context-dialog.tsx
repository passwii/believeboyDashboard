'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { useGlobalLoading } from '@/components/global-loading-provider'
import {
  fetchProjectContext,
  updateProjectContext,
  type ProjectContextResponse,
} from '@/lib/project-context'
import { AiParseContextSheet } from './ai-parse-context-sheet'
import { DynamicContextCard } from './dynamic-context-card'
import { Loader2, Check, Pencil, Save } from 'lucide-react'

type ProjectContextDialogProps = {
  projectId: number
  projectName: string
  projectBrand?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function ProjectContextDialog({
  projectId,
  projectName,
  projectBrand,
  open,
  onOpenChange,
  onSuccess,
}: ProjectContextDialogProps) {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')
  const [context, setContext] = useState<ProjectContextResponse | null>(null)
  const [draftContext, setDraftContext] = useState<Record<string, string>>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [aiSheetOpen, setAiSheetOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [cardCollapsed, setCardCollapsed] = useState(false)

  const loadData = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const data = await fetchProjectContext(projectId, null)
      setContext(data)
      setDraftContext((data.project_context as Record<string, string>) || {})
    } catch (err) {
      notify({
        type: 'error',
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载项目背景配置失败',
      })
    } finally {
      setLoading(false)
    }
  }, [open, projectId, notify])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (!context) return
    const original = (context.project_context as Record<string, string>) || {}
    const originalKeys = Object.keys(original).sort()
    const draftKeys = Object.keys(draftContext).sort()
    const hasChanged =
      originalKeys.length !== draftKeys.length ||
      originalKeys.some((k) => original[k] !== draftContext[k])
    setHasChanges(hasChanged)
  }, [context, draftContext])

  useEffect(() => {
    if (saveState === 'success') {
      const timer = setTimeout(() => setSaveState('idle'), 2000)
      return () => clearTimeout(timer)
    }
  }, [saveState])

  const handleSave = async () => {
    setSubmitting(true)
    setSaveState('saving')
    startGlobalLoading('blocking')
    try {
      const result = await updateProjectContext(projectId, { project_context: draftContext }, null)
      setContext(result)
      setHasChanges(false)
      setSaveState('success')
      notify({
        type: 'success',
        title: '保存成功',
        message: '项目背景配置已更新',
      })
      onSuccess?.()
    } catch (err) {
      setSaveState('error')
      notify({
        type: 'error',
        title: '保存失败',
        message: err instanceof Error ? err.message : '保存失败',
      })
    } finally {
      endGlobalLoading('blocking')
      setSubmitting(false)
    }
  }

  const handleOpenChange = async (newOpen: boolean) => {
    if (!newOpen && hasChanges) {
      const confirmed = await confirm({
        title: '有未保存的更改，确定要关闭吗？',
        variant: 'destructive',
      })
      if (!confirmed) return
    }
    setHasChanges(false)
    setIsEditing(false)
    onOpenChange(newOpen)
  }

  const handleContextChange = (newContext: Record<string, string>) => {
    setDraftContext(newContext)
  }

  const handleAiParsed = (parsed: Record<string, string>) => {
    setDraftContext((prev) => ({ ...prev, ...parsed }))
    notify({
      type: 'success',
      title: '已填充到表单',
      message: '请检查并确认后点击保存',
    })
  }

  const handleStartEdit = () => {
    setIsEditing(true)
    setCardCollapsed(false)
  }

  const handleCancelEdit = () => {
    if (hasChanges) {
      confirm({ title: '有未保存的更改，确定要取消吗？', variant: 'destructive' }).then(
        (confirmed) => {
          if (confirmed) {
            setDraftContext((context?.project_context as Record<string, string>) || {})
            setIsEditing(false)
          }
        }
      )
    } else {
      setIsEditing(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-lg">
              <span
                className={cn(
                  'h-3 w-3 shrink-0 rounded-full',
                  context?.project_context && Object.keys(context.project_context).length > 0
                    ? 'bg-green-500'
                    : 'bg-term-warn'
                )}
              />
              {projectName}
              {projectBrand && (
                <Badge variant="secondary" className="text-xs">
                  {projectBrand}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {isEditing ? '编辑项目背景信息' : '查看项目背景信息'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-4">
            {loading ? (
              <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-32 w-full" />
                ))}
              </div>
            ) : (
              <DynamicContextCard
                value={draftContext}
                onChange={handleContextChange}
                onAiImport={() => setAiSheetOpen(true)}
                collapsed={isEditing ? cardCollapsed : false}
                onCollapsedChange={isEditing ? setCardCollapsed : undefined}
                readOnly={!isEditing}
              />
            )}
          </div>

          <div className="flex items-center justify-between pt-4 border-t">
            <div>
              {isEditing && hasChanges && (
                <Badge variant="secondary" className="text-[10px]">
                  有未保存更改
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              {isEditing ? (
                <>
                  <Button variant="outline" onClick={handleCancelEdit} disabled={submitting}>
                    取消
                  </Button>
                  <Button
                    onClick={() => void handleSave()}
                    disabled={submitting || !hasChanges}
                    className="min-w-[100px]"
                  >
                    {saveState === 'saving' ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        保存中...
                      </>
                    ) : saveState === 'success' ? (
                      <>
                        <Check className="mr-2 h-4 w-4" />
                        已保存
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        保存配置
                      </>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    关闭
                  </Button>
                  <Button onClick={handleStartEdit}>
                    <Pencil className="mr-2 h-4 w-4" />
                    编辑背景
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AiParseContextSheet
        open={aiSheetOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setAiSheetOpen(false)}
        onParsed={handleAiParsed}
      />
    </>
  )
}

function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(' ')
}
