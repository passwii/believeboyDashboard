'use client'

import { useState, useEffect, useCallback } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { ProjectContextDialog } from './project-context-dialog'
import { fetchProjectContext } from '@/lib/project-context'
import styles from './project-context-warm.module.css'

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
    return <span className={styles.previewEmpty}>暂无背景信息</span>
  }

  const entries = Object.entries(context)

  return (
    <span className={styles.previewList}>
      {entries.slice(0, 5).map(([key, value]) => (
        <span key={key} className={styles.previewRow}>
          <span className={styles.previewKey}>{key}</span>
          <span className={styles.previewValue}>{value || '-'}</span>
        </span>
      ))}
    </span>
  )
}

function ProjectContextCard({
  project,
  onOpen,
}: {
  project: ProjectWithContext
  onOpen: (project: ProjectWithContext) => void
}) {
  const hasContext = project.project_context && Object.keys(project.project_context).length > 0
  const dimensionCount = hasContext ? Object.keys(project.project_context!).length : 0

  return (
    <button
      type="button"
      className={styles.projectCard}
      onClick={() => onOpen(project)}
    >
      <span className={styles.projectCardHeader}>
        <span className={styles.projectIdentity}>
          <span
            className={cn(
              styles.contextDot,
              hasContext ? styles.contextDotReady : styles.contextDotMissing
            )}
            aria-hidden="true"
          />
          <span className={styles.projectTitle}>{project.name}</span>
        </span>
        {project.brand_name ? (
          <WarmBadge className={styles.brandBadge}>{project.brand_name}</WarmBadge>
        ) : null}
      </span>
      <span className={styles.projectCardBody}>
        <ContextPreview context={project.project_context} />
        {hasContext ? (
          <span className={styles.projectCardFooter}>
            <span className={styles.moreCount}>
              {dimensionCount > 5 ? `+${dimensionCount - 5} 更多...` : ''}
            </span>
            <span>{dimensionCount} 维度</span>
          </span>
        ) : null}
      </span>
    </button>
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

  const loadData = useCallback(async () => {
    setLoading(true)
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
    }
  }, [notify])

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
    <div className={styles.contextTab} data-warm-project-context="true">
      <div>
        {loading ? (
          <div className={styles.loadingGrid} aria-busy="true">
            <span className="sr-only" role="status" aria-live="polite">
              正在加载项目背景
            </span>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={styles.loadingCard}>
                <div className={styles.loadingStack}>
                  <Skeleton className={`${styles.skeleton} h-5 w-32`} />
                  <Skeleton className={`${styles.skeleton} h-4 w-20`} />
                  <Skeleton className={`${styles.skeleton} h-4 w-full`} />
                  <Skeleton className={`${styles.skeleton} h-4 w-3/4`} />
                </div>
              </div>
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className={styles.emptyState}>
            {searchQuery || filterHasContext !== 'all' ? '没有匹配的项目' : '暂无项目数据'}
          </div>
        ) : (
          <div className={styles.tierGroups}>
            {groupProjectsByTier(filteredProjects).map((group) => {
              return (
                <section key={group.tier} className={styles.tierSection} data-tier={group.tier}>
                  <div className={styles.tierHeader}>
                    <span className={styles.tierLabel}>{group.label}</span>
                    <span className={styles.tierCount}>{group.projects.length} 个项目</span>
                  </div>
                  <div className={styles.projectGrid}>
                    {group.projects.map((project) => (
                      <ProjectContextCard
                        key={project.id}
                        project={project}
                        onOpen={handleOpenDialog}
                      />
                    ))}
                  </div>
                </section>
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
