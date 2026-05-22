'use client'

import { useState, useEffect, useCallback } from 'react'
import { FileText, Edit3, RefreshCw } from 'lucide-react'

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useNotifications } from '@/components/notifications'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { ProjectContextDrawer } from './project-context-drawer'
import { fetchProjectContext } from '@/lib/project-context'

type ProjectWithContext = {
  id: number
  name: string
  brand_name: string | null
  project_context: Record<string, string> | null
}

async function fetchAllProjectContexts(): Promise<ProjectWithContext[]> {
  // 获取所有项目列表
  const projectsRes = await fetch('/api/backend/api/v1/projects/manage')
  if (!projectsRes.ok) {
    throw new Error('获取项目列表失败')
  }
  const projects: { id: number; name: string; brand_name: string | null }[] = await projectsRes.json()

  // 批量获取每个项目的背景信息
  const results = await Promise.allSettled(
    projects.map(async (project) => {
      try {
        const context = await fetchProjectContext(project.id, null)
        return { ...project, project_context: context.project_context || {} }
      } catch {
        return { ...project, project_context: {} }
      }
    })
  )

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<ProjectWithContext>).value)
}

function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

function ContextPreview({ context }: { context: Record<string, string> | null }) {
  if (!context || Object.keys(context).length === 0) {
    return <span className="text-sm text-muted-foreground">暂无背景信息</span>
  }

  const entries = Object.entries(context)
  return (
    <div className="space-y-1.5">
      {entries.slice(0, 4).map(([key, value]) => (
        <div key={key} className="flex gap-2 text-sm">
          <span className="text-muted-foreground shrink-0">{key}:</span>
          <span className="text-foreground line-clamp-2 break-words">{value || '-'}</span>
        </div>
      ))}
      {entries.length > 4 && (
        <span className="text-xs text-muted-foreground">+{entries.length - 4} 更多...</span>
      )}
    </div>
  )
}

function ProjectContextCard({
  project,
  onEdit,
}: {
  project: ProjectWithContext
  onEdit: (project: ProjectWithContext) => void
}) {
  const hasContext = project.project_context && Object.keys(project.project_context).length > 0

  return (
    <Card className="group hover:border-primary/30 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                hasContext ? 'bg-green-500' : 'bg-muted-foreground/30'
              )}
            />
            <h3 className="font-medium text-foreground truncate">{project.name}</h3>
            {project.brand_name && (
              <Badge variant="secondary" className="text-xs shrink-0">
                {project.brand_name}
              </Badge>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onEdit(project)}
            className="opacity-0 group-hover:opacity-100 transition-opacity h-8 px-2"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ContextPreview context={project.project_context} />
      </CardContent>
    </Card>
  )
}

export function ProjectContextTab() {
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<ProjectWithContext[]>([])
  const [editingProject, setEditingProject] = useState<ProjectWithContext | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { notify } = useNotifications()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()

  const loadData = useCallback(async () => {
    setLoading(true)
    startGlobalLoading('blocking')
    try {
      const data = await fetchAllProjectContexts()
      setProjects(data)
    } catch (err) {
      notify({
        type: 'error',
        title: '加载失败',
        message: err instanceof Error ? err.message : '获取项目背景列表失败',
      })
    } finally {
      setLoading(false)
      endGlobalLoading('blocking')
    }
  }, [notify, startGlobalLoading, endGlobalLoading])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleEdit = (project: ProjectWithContext) => {
    setEditingProject(project)
    setDrawerOpen(true)
  }

  const handleSuccess = () => {
    void loadData()
  }

  return (
    <div className="w-full md:h-[calc(100vh-8.5rem)] md:overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Badge variant="outline" className="w-fit rounded-md">项目背景</Badge>
          <p className="text-sm text-muted-foreground">维护各项目的背景信息，便于查阅和编辑。</p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadData()}
          disabled={loading}
        >
          <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
          {loading ? '加载中...' : '刷新数据'}
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-2 w-2 rounded-full" />
                  <Skeleton className="h-5 w-32" />
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          message="暂无项目数据"
          className="py-12"
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {projects.map((project) => (
            <ProjectContextCard
              key={project.id}
              project={project}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {editingProject && (
        <ProjectContextDrawer
          projectId={editingProject.id}
          projectName={editingProject.name}
          open={drawerOpen}
          onOpenChange={(open) => {
            setDrawerOpen(open)
            if (!open) {
              setEditingProject(null)
            }
          }}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  )
}
