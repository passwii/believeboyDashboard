'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  WarmBadge,
  WarmButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import {
  fetchProjectContext,
  updateProjectContext,
  type ProjectContextResponse,
} from '@/lib/project-context'
import { AiParseContextSheet } from './ai-parse-context-sheet'
import { DynamicContextCard } from './dynamic-context-card'
import { Check } from 'lucide-react'
import styles from './project-context-warm.module.css'

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

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')
  const [context, setContext] = useState<ProjectContextResponse | null>(null)
  const [loadedProjectId, setLoadedProjectId] = useState<number | null>(null)
  const [draftContext, setDraftContext] = useState<Record<string, string>>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [aiSheetOpen, setAiSheetOpen] = useState(false)
  const projectIdRef = useRef(projectId)
  const saveRequestIdRef = useRef(0)
  projectIdRef.current = projectId

  useEffect(() => {
    saveRequestIdRef.current += 1
    setSubmitting(false)
  }, [open, projectId])

  useEffect(() => {
    if (!open) {
      setLoading(false)
      setLoadedProjectId(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadedProjectId(null)
    setContext(null)
    setDraftContext({})
    setHasChanges(false)
    setSaveState('idle')

    void fetchProjectContext(projectId, null)
      .then((data) => {
        if (cancelled) return
        setContext(data)
        setDraftContext((data.project_context as Record<string, string>) || {})
      })
      .catch((err: unknown) => {
        if (cancelled) return
        notify({
          type: 'error',
          title: '加载失败',
          message: err instanceof Error ? err.message : '加载项目背景配置失败',
        })
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setLoadedProjectId(projectId)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, projectId, notify])

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
    const requestId = ++saveRequestIdRef.current
    const savingProjectId = projectId
    setSubmitting(true)
    setSaveState('saving')
    try {
      const result = await updateProjectContext(
        savingProjectId,
        { project_context: draftContext },
        null
      )
      if (requestId !== saveRequestIdRef.current || projectIdRef.current !== savingProjectId) {
        return
      }
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
      if (requestId !== saveRequestIdRef.current || projectIdRef.current !== savingProjectId) {
        return
      }
      setSaveState('error')
      notify({
        type: 'error',
        title: '保存失败',
        message: err instanceof Error ? err.message : '保存失败',
      })
    } finally {
      if (requestId === saveRequestIdRef.current && projectIdRef.current === savingProjectId) {
        setSubmitting(false)
      }
    }
  }

  const handleOpenChange = async (newOpen: boolean) => {
    if (!newOpen && submitting) return
    if (!newOpen && hasChanges) {
      const confirmed = await confirm({
        title: '有未保存的更改，确定要关闭吗？',
        variant: 'destructive',
      })
      if (!confirmed) return
    }
    setHasChanges(false)
    onOpenChange(newOpen)
  }

  const handleContextChange = (newContext: Record<string, string>) => {
    setDraftContext(newContext)
  }

  const isProjectLoading = open && (loading || loadedProjectId !== projectId)

  const handleAiParsed = (parsed: Record<string, string>) => {
    // 合并解析结果到现有 context
    setDraftContext((prev) => ({ ...prev, ...parsed }))
    notify({
      type: 'success',
      title: '已填充到表单',
      message: '请检查并确认后点击保存',
    })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className={`${styles.surface} ${styles.sheetSurface} flex flex-col`}>
          <SheetHeader>
            <div className={styles.dialogHeader}>
              <div className={styles.headerActions}>
                <SheetTitle className={styles.surfaceTitle}>项目背景配置</SheetTitle>
                {hasChanges && (
                  <WarmBadge className={styles.unsavedBadge}>有未保存更改</WarmBadge>
                )}
              </div>
              <WarmButton
                variant="secondary"
                onClick={() => setAiSheetOpen(true)}
                disabled={isProjectLoading || submitting}
              >
                AI 辅助
              </WarmButton>
            </div>
            <SheetDescription className={styles.surfaceDescription}>
              项目：{projectName}
            </SheetDescription>
          </SheetHeader>

          <div className={styles.surfaceBody}>
            {isProjectLoading ? (
              <LoadingSkeleton />
            ) : (
              <DynamicContextCard
                value={draftContext}
                onChange={handleContextChange}
                onAiImport={() => setAiSheetOpen(true)}
                readOnly={submitting}
              />
            )}
          </div>

          <div className={`${styles.surfaceFooter} ${styles.footerEnd}`}>
            <WarmButton
              variant="secondary"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              取消
            </WarmButton>
            <WarmButton
              variant="primary"
              onClick={() => void handleSave()}
              disabled={submitting || !hasChanges}
              loading={saveState === 'saving'}
              loadingLabel="正在保存项目背景"
            >
              {saveState === 'saving' ? (
                '保存中...'
              ) : saveState === 'success' ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  已保存
                </>
              ) : (
                '保存配置'
              )}
            </WarmButton>
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
    <div className={styles.loadingStack}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className={styles.loadingRow}>
          <Skeleton className={`${styles.skeleton} h-8 w-full`} />
          <Skeleton className={`${styles.skeleton} h-24 w-full`} />
        </div>
      ))}
    </div>
  )
}
