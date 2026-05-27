'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { fetchProjectContext, updateProjectContext, type ProjectContextResponse } from '@/lib/project-context'
import { AiParseContextSheet } from './ai-parse-context-sheet'
import { DynamicContextCard } from './dynamic-context-card'
import { Loader2, Check } from 'lucide-react'

type ProjectContextDrawerProps = {
  projectId: number
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function ProjectContextDrawer({
  projectId,
  projectName,
  open,
  onOpenChange,
  onSuccess,
}: ProjectContextDrawerProps) {
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

  const loadData = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const data = await fetchProjectContext(projectId, null)
      setContext(data)
      // project_context 本身就是 Record<string, string>
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
    // 正确的值比较
    const originalKeys = Object.keys(original).sort()
    const draftKeys = Object.keys(draftContext).sort()
    const hasChanged =
      originalKeys.length !== draftKeys.length ||
      originalKeys.some((k) => original[k] !== draftContext[k])
    setHasChanges(hasChanged)
  }, [context, draftContext])

  // 保存成功后短暂显示成功状态
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
      const confirmed = await confirm({ title: '有未保存的更改，确定要关闭吗？', variant: 'destructive' })
      if (!confirmed) return
    }
    setHasChanges(false)
    onOpenChange(newOpen)
  }

  const handleContextChange = (newContext: Record<string, string>) => {
    setDraftContext(newContext)
  }

  const handleAiParsed = (parsed: Record<string, string>) => {
    // 合并解析结果到现有 context
    setDraftContext(prev => ({ ...prev, ...parsed }))
    notify({
      type: 'success',
      title: '已填充到表单',
      message: '请检查并确认后点击保存',
    })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className="w-[90vw] max-w-[640px] lg:max-w-[720px] flex flex-col">
          <SheetHeader>
            <div className="flex items-center justify-between pr-8">
              <div className="flex items-center gap-3">
                <SheetTitle>项目背景配置</SheetTitle>
                {hasChanges && (
                  <Badge variant="secondary" className="text-[10px]">
                    有未保存更改
                  </Badge>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAiSheetOpen(true)}
                className="text-xs gap-1"
              >
                <span>🤖</span>
                AI 辅助
              </Button>
            </div>
            <SheetDescription>项目：{projectName}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-1 py-4">
            {loading ? (
              <LoadingSkeleton />
            ) : (
              <DynamicContextCard
                value={draftContext}
                onChange={handleContextChange}
                onAiImport={() => setAiSheetOpen(true)}
              />
            )}
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
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
                '保存配置'
              )}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

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

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  )
}
