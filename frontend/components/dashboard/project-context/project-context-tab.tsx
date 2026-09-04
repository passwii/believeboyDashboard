'use client'

import { useState, useEffect, useCallback } from 'react'

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useNotifications } from '@/components/notifications'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { ProjectContextDialog } from './project-context-dialog'
import { fetchProjectContext } from '@/lib/project-context'

type ProjectWithContext = {
  id: number
  name: string
  brand_name: string | null
  project_context: Record<string, string> | null
  project_tier: string | null
  sort_order: number
}

const TIER_ORDER = ['T1', 'T2', 'T3', 'T4'] as const

const TIER_LABEL: Record<string, string> = {
  T1: 'T1',
  T2: 'T2',
  T3: 'T3',
  T4: 'T4',
}

// BLF-893：Tier 色板统一走 term 令牌；T1=neg / T2=accent / T3=warn / T4=muted / UNTIERED=faint。
const TIER_SECTION_STYLE: Record<
  string,
  { headerBg: string; headerText: string; cardAccent: string }
> = {
  T1: {
    headerBg: 'bg-term-neg/5',
    headerText: 'text-term-neg',
    cardAccent: 'border-l-4 border-l-term-neg/60',
  },
  T2: {
    headerBg: 'bg-term-accent/5',
    headerText: 'text-term-accent',
    cardAccent: 'border-l-4 border-l-term-accent/60',
  },
  T3: {
    headerBg: 'bg-term-warn/5',
    headerText: 'text-term-warn',
    cardAccent: 'border-l-4 border-l-term-warn/60',
  },
  T4: {
    headerBg: 'bg-term-hover',
    headerText: 'text-term-muted',
    cardAccent: 'border-l-4 border-l-term-border-strong',
  },
  UNTIERED: {
    headerBg: 'bg-term-panel',
    headerText: 'text-term-faint',
    cardAccent: 'border-l-4 border-l-term-border',
  },
}

type TierGroup = {
  tier: string
  label: string
  projects: ProjectWithContext[]
}

function groupProjectsByTier(projects: ProjectWithContext[]): TierGroup[] {
  const groups = new Map<string, ProjectWithContext[]>()

  for (const project of projects) {
    const tier = project.project_tier || 'UNTIERED'
    if (!groups.has(tier)) {
      groups.set(tier, [])
    }
    groups.get(tier)!.push(project)
  }

  // Sort each group by sort_order
  for (const [, items] of groups) {
    items.sort((a, b) => a.sort_order - b.sort_order)
  }

  const result: TierGroup[] = []

  // T1, T2, T3, T4 in order
  for (const tier of TIER_ORDER) {
    if (groups.has(tier)) {
      result.push({ tier, label: TIER_LABEL[tier], projects: groups.get(tier)! })
    }
  }

  // Untiered last
  if (groups.has('UNTIERED')) {
    result.push({ tier: 'UNTIERED', label: '未分级', projects: groups.get('UNTIERED')! })
  }

  return result
}

async function fetchAllProjectContexts(): Promise<ProjectWithContext[]> {
  // 获取所有项目列表
  const projectsRes = await fetch('/api/backend/api/v1/projects/manage')
  if (!projectsRes.ok) {
    throw new Error('获取项目列表失败')
  }
  const projects: {
    id: number
    name: string
    brand_name: string | null
    project_tier: string | null
    sort_order: number
  }[] = await projectsRes.json()

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
    return <span className="font-mono text-xs leading-5 text-term-muted">暂无背景信息</span>
  }

  const entries = Object.entries(context)

  return (
    <div className="space-y-2">
      {entries.slice(0, 5).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2 font-mono text-xs leading-5">
          <span className="w-24 shrink-0 truncate text-left text-term-muted">{key}</span>
          <span className="line-clamp-1 flex-1 break-words text-term-text">{value || '-'}</span>
        </div>
      ))}
    </div>
  )
}

function ProjectContextCard({
  project,
  tierAccent,
  onOpen,
}: {
  project: ProjectWithContext
  tierAccent?: string
  onOpen: (project: ProjectWithContext) => void
}) {
  const hasContext = project.project_context && Object.keys(project.project_context).length > 0
  const dimensionCount = hasContext ? Object.keys(project.project_context!).length : 0

  return (
    <Card
      className={cn(
        // BLF-893：项目卡终端化——零圆角、term 令牌、零阴影；hover 走 term-accent 弱边。
        'group flex min-h-[220px] cursor-pointer flex-col rounded-none border border-term-border bg-term-bg shadow-none transition-colors hover:border-term-accent',
        tierAccent
      )}
      onClick={() => onOpen(project)}
    >
      <CardHeader className="flex-shrink-0 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                'h-3 w-3 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-term-bg',
                hasContext
                  ? 'bg-term-pos ring-term-pos/30'
                  : 'bg-term-warn ring-term-warn/30'
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate font-mono text-sm leading-5 text-term-text">
                  {project.name}
                </h3>
                {project.brand_name && (
                  <span className="inline-flex h-5 shrink-0 items-center rounded-none border border-term-border bg-term-panel px-1.5 font-mono text-[10px] leading-4 text-term-muted">
                    {project.brand_name}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        <div className="flex-1">
          <ContextPreview context={project.project_context} />
        </div>
        {hasContext && (
          <div className="mt-3 flex items-center justify-between border-t border-term-border pt-2">
            <span className="font-mono text-[11px] leading-4 text-term-muted">
              {dimensionCount > 5 && `+${dimensionCount - 5} 更多...`}
            </span>
            <span className="inline-flex h-5 items-center rounded-none border border-term-border bg-term-panel px-1.5 font-mono text-[10px] leading-4 text-term-muted">
              {dimensionCount} 维度
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function ProjectContextTab() {
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<ProjectWithContext[]>([])
  const [selectedProject, setSelectedProject] = useState<ProjectWithContext | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [searchQuery] = useState('')
  const [filterHasContext] = useState<string>('all')
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

  const handleOpenDialog = (project: ProjectWithContext) => {
    setSelectedProject(project)
    setDialogOpen(true)
  }

  const handleSuccess = () => {
    void loadData()
  }

  // 过滤逻辑
  const filteredProjects = projects.filter((project) => {
    const matchSearch =
      project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (project.brand_name && project.brand_name.toLowerCase().includes(searchQuery.toLowerCase()))

    const hasContext = project.project_context && Object.keys(project.project_context).length > 0
    let matchFilter = true
    if (filterHasContext === 'configured') matchFilter = !!hasContext
    if (filterHasContext === 'not_configured') matchFilter = !hasContext

    return matchSearch && matchFilter
  })

  return (
    <div className="w-full">
      {/* 内容区 */}
      <div>
        {loading ? (
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="min-h-[180px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-3 w-3 rounded-full" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-4 w-full mb-2" />
                  <Skeleton className="h-4 w-3/4" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <EmptyState
            message={searchQuery || filterHasContext !== 'all' ? '没有匹配的项目' : '暂无项目数据'}
            className="py-12"
          />
        ) : (
          <div className="space-y-8">
            {groupProjectsByTier(filteredProjects).map((group) => {
              const style = TIER_SECTION_STYLE[group.tier] || TIER_SECTION_STYLE.UNTIERED
              return (
                <div key={group.tier} className="space-y-3">
                  <div
                    className={cn('flex items-center gap-3 rounded-lg px-4 py-2.5', style.headerBg)}
                  >
                    <span className={cn('text-sm font-bold', style.headerText)}>{group.label}</span>
                    <span className="text-sm text-muted-foreground">
                      {group.projects.length} 个项目
                    </span>
                  </div>
                  <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
                    {group.projects.map((project) => (
                      <ProjectContextCard
                        key={project.id}
                        project={project}
                        tierAccent={style.cardAccent}
                        onOpen={handleOpenDialog}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {selectedProject && (
        <ProjectContextDialog
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          projectBrand={selectedProject.brand_name}
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) {
              setSelectedProject(null)
            }
          }}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  )
}
