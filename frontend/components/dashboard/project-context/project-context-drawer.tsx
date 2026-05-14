'use client'

import { useState, useEffect, useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'

import { useNotifications } from '@/components/notifications'
import { useGlobalLoading } from '@/components/global-loading-provider'

import { fetchProjectContext, updateProjectContext, type ProjectContextResponse, type ProjectContextUpdate } from '@/lib/project-context'

import { FactoryCard } from './cards/factory-card'
import { SeasonalityCard } from './cards/seasonality-card'
import { GrowthCard } from './cards/growth-card'
import { StatusCard } from './cards/status-card'
import { SkuContextCard } from './cards/sku-context-card'
import { NotesCard } from './cards/notes-card'

type ProjectContextDrawerProps = {
  projectId: number
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

type FactoryContext = {
  description?: string
  productionCapacity?: string
  communication?: string
}

type SeasonalityContext = {
  peakSeason?: string
  offSeason?: string
  restockStrategy?: string
}

type GrowthContext = {
  description?: string
  growthDriver?: string
}

type StatusContext = {
  description?: string
  riskNotes?: string
}

type SkuContext = Record<string, {
  status?: string
  reason?: string
  action?: string
  startDate?: string
  endDate?: string
}>

type ProjectContextDraft = {
  factory?: FactoryContext
  productSeasonality?: SeasonalityContext
  productGrowth?: GrowthContext
  projectStatus?: StatusContext
  notes?: string
}

export function ProjectContextDrawer({
  projectId,
  projectName,
  open,
  onOpenChange,
  onSuccess,
}: ProjectContextDrawerProps) {
  const { notify } = useNotifications()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [context, setContext] = useState<ProjectContextResponse | null>(null)
  const [draft, setDraft] = useState<ProjectContextUpdate>({})
  const [hasChanges, setHasChanges] = useState(false)

  const loadData = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const data = await fetchProjectContext(projectId, null)
      setContext(data)
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
    const projectCtx = context.project_context as ProjectContextDraft | null
    const hasProjectChanges =
      (draft.project_context && Object.keys(draft.project_context).length > 0)
    const hasSkuChanges =
      (draft.sku_context && Object.keys(draft.sku_context).length > 0)
    const hasNotesChange = draft.project_context?.notes !== undefined

    setHasChanges(Boolean(hasProjectChanges || hasSkuChanges || hasNotesChange))
  }, [context, draft])

  const handleSave = async () => {
    setSubmitting(true)
    startGlobalLoading('blocking')
    try {
      const result = await updateProjectContext(projectId, draft, null)
      setContext(result)
      setDraft({})
      setHasChanges(false)
      notify({
        type: 'success',
        title: '保存成功',
        message: '项目背景配置已更新',
      })
      onSuccess?.()
    } catch (err) {
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

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && hasChanges) {
      const confirmed = window.confirm('有未保存的更改，确定要关闭吗？')
      if (!confirmed) return
    }
    setDraft({})
    setHasChanges(false)
    onOpenChange(newOpen)
  }

  const updateDraft = (updates: ProjectContextUpdate) => {
    setDraft((prev) => {
      const newProjectContext = {
        ...(prev.project_context || {}),
        ...(updates.project_context || {}),
      }
      const newSkuContext = {
        ...(prev.sku_context || {}),
        ...(updates.sku_context || {}),
      }
      return {
        project_context: Object.keys(newProjectContext).length > 0 ? newProjectContext : undefined,
        sku_context: Object.keys(newSkuContext).length > 0 ? newSkuContext : undefined,
      }
    })
  }

  const getCurrentProjectContext = (): ProjectContextDraft | null => {
    if (!context) return null
    return context.project_context as ProjectContextDraft | null
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="w-[440px] max-w-full sm:max-w-[440px] flex flex-col">
        <SheetHeader>
          <SheetTitle>项目背景配置</SheetTitle>
          <SheetDescription>项目：{projectName}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-1 py-4 space-y-4">
          {loading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <FactoryCard
                value={getCurrentProjectContext()?.factory}
                onChange={(factory) => updateDraft({ project_context: { factory } })}
              />
              <SeasonalityCard
                value={getCurrentProjectContext()?.productSeasonality}
                onChange={(productSeasonality) => updateDraft({ project_context: { productSeasonality } })}
              />
              <GrowthCard
                value={getCurrentProjectContext()?.productGrowth}
                onChange={(productGrowth) => updateDraft({ project_context: { productGrowth } })}
              />
              <StatusCard
                value={getCurrentProjectContext()?.projectStatus}
                onChange={(projectStatus) => updateDraft({ project_context: { projectStatus } })}
              />
              <SkuContextCard
                value={context?.sku_context as SkuContext | null}
                onChange={(sku_context) => updateDraft({ sku_context })}
              />
              <NotesCard
                value={getCurrentProjectContext()?.notes}
                onChange={(notes) => updateDraft({ project_context: { notes } })}
              />
            </>
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
          >
            {submitting ? '保存中...' : '保存配置'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  )
}