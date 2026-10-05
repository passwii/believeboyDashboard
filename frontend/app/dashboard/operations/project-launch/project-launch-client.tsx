'use client'

/**
 * 项目启动台（BLF-1234，设计稿 §7 前端 UX 契约）。
 *
 * 结构：左侧项目列表（窄屏换成项目选择器）+ 右侧项目详情；详情三个 Tab：
 * 概览 / 店铺启动 / 产品开发（`Tabs variant="term"`）。
 *
 * 数据获取：`fetchManagedProjectsCached` 拿可见项目 + `/project-workflows/summary`
 * 一次批量拿流程概要，列表渲染不做逐项目请求；选中项目的详情按需拉取。
 * 创建 / 改状态成功后**同时**刷新详情与概要，保证列表与详情一致。
 *
 * 写语义：任务状态先本地乐观更新，服务端失败则整体回滚到保存前的 workflow
 * 并展示服务端错误（设计稿 §7「写失败保留上一次已保存状态」）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { FolderOpen, Loader2, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_BUTTON, TERM_SELECT_NATIVE } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { isAdmin } from '@/lib/backend-auth'
import type { ManagedProjectOption } from '@/lib/hooks/use-managed-projects'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import {
  PROJECT_NOT_STARTED_LABEL,
  PRODUCT_SWIMWEAR_TEMPLATE_KEY,
  STORE_LAUNCH_TEMPLATE_KEY,
  WORKFLOW_KIND_LABELS,
  applyTaskStatusLocally,
  createProjectWorkflow,
  deriveProjectStatus,
  downloadProjectWorkflowDocument,
  type ProjectWorkflowSummaryItem,
  fetchProjectWorkflows,
  fetchWorkflowSummary,
  fetchWorkflowTemplates,
  formatWorkflowProgress,
  updateProjectWorkflowTaskStatus,
  type ProjectWorkflow,
  type ProjectWorkflowCreateInput,
  type ProjectWorkflowSummaryWorkflow,
  type ProjectWorkflowTask,
  type ProjectWorkflowTemplateOption,
  type WorkflowStatus,
} from '@/lib/project-workflows-api'
import { cn } from '@/lib/utils'

import { CreateWorkflowDialog } from './create-workflow-dialog'
import { WorkflowOverviewRow, WorkflowStatusPill, WorkflowTaskList } from './project-workflow-list'

const TABS = ['overview', 'store_launch', 'product_development'] as const
type TabKey = (typeof TABS)[number]

const TAB_LABELS: Record<TabKey, string> = {
  overview: '概览',
  store_launch: '店铺启动',
  product_development: '产品开发',
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function ProjectLaunchClient() {
  const { data: session, status: sessionStatus } = useSession()
  const admin = isAdmin(session)

  const [projects, setProjects] = useState<ManagedProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const [summaryError, setSummaryError] = useState<string | null>(null)

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [workflows, setWorkflows] = useState<ProjectWorkflow[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [templates, setTemplates] = useState<ProjectWorkflowTemplateOption[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState<string | null>(null)

  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [storeLaunchStartDate, setStoreLaunchStartDate] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // 竞态保护：快速切换项目时丢弃过期详情响应。
  const detailSeq = useRef(0)
  // 已请求过的项目 id：防止 session 引用抖动把详情 effect 变成无限重拉。
  const detailProjectRef = useRef<number | null>(null)
  // 按项目分组的概要索引（列表行渲染 O(1) 取用）。
  const [summariesByProject, setSummariesByProject] = useState<
    Map<number, ProjectWorkflowSummaryItem>
  >(new Map())
  const [workflowMutationBusy, setWorkflowMutationBusy] = useState(false)
  const selectedSummary = selectedProjectId == null ? null : summariesByProject.get(selectedProjectId)

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null

  // ── 读：项目列表 + 流程概要（一次批量，无逐项目 fan-out） ────────────────
  const loadProjectsAndSummary = useCallback(
    async (options?: { force?: boolean }) => {
      setProjectsLoading(true)
      setProjectsError(null)
      setSummaryError(null)

      const [projectsResult, summaryResult] = await Promise.allSettled([
        fetchManagedProjectsCached<ManagedProjectOption[]>(session, undefined, {
          force: options?.force,
        }),
        fetchWorkflowSummary(session),
      ])

      if (projectsResult.status === 'fulfilled') {
        setProjects(projectsResult.value)
      } else {
        setProjects([])
        setProjectsError(errorText(projectsResult.reason, '项目列表加载失败'))
      }

      if (summaryResult.status === 'fulfilled') {
        setSummariesByProject(
          new Map(summaryResult.value.projects.map((row) => [row.project_id, row] as const))
        )
      } else {
        setSummariesByProject(new Map())
        setSummaryError(errorText(summaryResult.reason, '流程概要加载失败'))
      }

      setProjectsLoading(false)
    },
    [session]
  )

  const refreshSummary = useCallback(async () => {
    try {
      const result = await fetchWorkflowSummary(session)
      setSummariesByProject(
        new Map(result.projects.map((row) => [row.project_id, row] as const))
      )
      setSummaryError(null)
    } catch (error) {
      setSummaryError(errorText(error, '流程概要加载失败'))
    }
  }, [session])

  // ── 读：选中项目详情 ─────────────────────────────────────────────────────
  const loadDetail = useCallback(
    async (projectId: number) => {
      const seq = ++detailSeq.current
      setDetailLoading(true)
      setDetailError(null)
      try {
        const data = await fetchProjectWorkflows(projectId, session)
        if (seq !== detailSeq.current) return
        setWorkflows(data.workflows)
      } catch (error) {
        if (seq !== detailSeq.current) return
        setWorkflows([])
        setDetailError(errorText(error, '项目流程加载失败'))
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false)
      }
    },
    [session]
  )

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplatesError(null)
    try {
      const result = await fetchWorkflowTemplates(session)
      setTemplates(result.templates)
    } catch (error) {
      setTemplates([])
      setTemplatesError(errorText(error, '流程模板加载失败'))
    } finally {
      setTemplatesLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    void loadProjectsAndSummary()
  }, [loadProjectsAndSummary, sessionStatus])

  // 默认选中第一个可见项目（概要加载完成后）。
  useEffect(() => {
    if (selectedProjectId != null) return
    const first = projects[0]
    if (first) setSelectedProjectId(first.id)
  }, [projects, selectedProjectId])

  useEffect(() => {
    if (selectedProjectId == null) {
      detailProjectRef.current = null
      setWorkflows([])
      return
    }
    if (detailProjectRef.current === selectedProjectId) return
    detailProjectRef.current = selectedProjectId
    setWorkflows([])
    setMutationError(null)
    void loadDetail(selectedProjectId)
  }, [loadDetail, selectedProjectId])

  // 模板目录在新对话框首次打开时按需加载（列表渲染不需要）。
  useEffect(() => {
    if (!dialogOpen || templates.length > 0 || templatesLoading) return
    void loadTemplates()
  }, [dialogOpen, loadTemplates, templates.length, templatesLoading])

  // ── Header 全局刷新：项目列表跳缓存 + 概要 + 当前项目详情 ────────────────
  const handleHeaderRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await loadProjectsAndSummary({ force: true })
      if (selectedProjectId != null) await loadDetail(selectedProjectId)
    } finally {
      setRefreshing(false)
    }
  }, [loadDetail, loadProjectsAndSummary, selectedProjectId])
  useHeaderRefresh(handleHeaderRefresh, { loading: refreshing })

  // ── 写：创建流程 ─────────────────────────────────────────────────────────
  const handleCreateWorkflow = useCallback(
    async (input: ProjectWorkflowCreateInput) => {
      if (selectedProjectId == null) throw new Error('请先选择项目')
      await createProjectWorkflow(selectedProjectId, input, session)
      await Promise.all([loadDetail(selectedProjectId), refreshSummary()])
    },
    [loadDetail, refreshSummary, selectedProjectId, session]
  )

  const handleEnableStoreLaunch = useCallback(async () => {
    setMutationError(null)
    try {
      await handleCreateWorkflow({
        kind: 'store_launch',
        template_key: STORE_LAUNCH_TEMPLATE_KEY,
        ...(storeLaunchStartDate ? { start_date: storeLaunchStartDate } : {}),
      })
      setStoreLaunchStartDate('')
    } catch (error) {
      setMutationError(errorText(error, '启用店铺启动流程失败'))
    }
  }, [handleCreateWorkflow, storeLaunchStartDate])

  // ── 写：任务状态（乐观更新 + 失败回滚） ─────────────────────────────────
  const handleWorkflowMutation = useCallback(
    async (action: () => Promise<ProjectWorkflow>): Promise<boolean> => {
      if (selectedProjectId == null) return false
      setWorkflowMutationBusy(true)
      setMutationError(null)
      try {
        const updated = await action()
        setWorkflows((current) => current.map((workflow) => workflow.id === updated.id ? updated : workflow))
        await refreshSummary()
        return true
      } catch (error) {
        setMutationError(errorText(error, '保存流程变更失败'))
        return false
      } finally {
        setWorkflowMutationBusy(false)
      }
    },
    [refreshSummary, selectedProjectId]
  )

  const handleTaskStatusChange = useCallback(
    async (task: ProjectWorkflowTask, status: WorkflowStatus) => {
      if (task.status === status) return
      const snapshot = workflows
      setMutationError(null)
      setPendingTaskId(task.id)
      setWorkflows((current) =>
        current.map((workflow) =>
          workflow.id === task.workflow_id
            ? applyTaskStatusLocally(workflow, task.id, status)
            : workflow
        )
      )
      try {
        const updated = await updateProjectWorkflowTaskStatus(task.id, status, session)
        setWorkflows((current) =>
          current.map((workflow) => (workflow.id === updated.id ? updated : workflow))
        )
        await refreshSummary()
      } catch (error) {
        // 回滚到保存前的状态（保留上一次已保存值）。
        setWorkflows(snapshot)
        setMutationError(errorText(error, '更新任务状态失败'))
      } finally {
        setPendingTaskId(null)
      }
    },
    [refreshSummary, session, workflows]
  )

  // ── 写：文档下载 ─────────────────────────────────────────────────────────
  const handleDownload = useCallback(
    async (task: ProjectWorkflowTask) => {
      if (selectedProjectId == null || !task.attachment_key) return
      setMutationError(null)
      try {
        await downloadProjectWorkflowDocument(selectedProjectId, task.attachment_key, session)
      } catch (error) {
        setMutationError(errorText(error, '文档下载失败'))
      }
    },
    [selectedProjectId, session]
  )

  // ── 派生视图 ─────────────────────────────────────────────────────────────
  const storeLaunchWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.kind === 'store_launch') ?? null,
    [workflows]
  )
  const productWorkflows = useMemo(
    () => workflows.filter((workflow) => workflow.kind === 'product_development'),
    [workflows]
  )
  const productTemplates = useMemo(
    () => templates.filter((template) => template.kind === 'product_development'),
    [templates]
  )
  const projectStatus = deriveProjectStatus(workflows)
  const detailBusy = detailLoading || pendingTaskId != null
  const noProjects = !projectsLoading && !projectsError && projects.length === 0

  function renderProjectRow(project: ManagedProjectOption) {
    const rows = summariesByProject.get(project.id)?.workflows ?? []
    const storeLaunch = rows.find((row) => row.kind === 'store_launch') ?? null
    const products = rows.filter((row) => row.kind === 'product_development')
    const aggregate = deriveProjectStatus(rows)
    const active = project.id === selectedProjectId

    return (
      <li key={project.id}>
        <button
          type="button"
          data-testid={`project-row-${project.id}`}
          aria-current={active ? 'true' : undefined}
          onClick={() => setSelectedProjectId(project.id)}
          className={cn(
            'flex w-full flex-col gap-1 rounded-none border border-transparent px-2 py-2 text-left transition-colors hover:bg-term-hover focus-visible:border-term-border-strong focus-visible:outline-none',
            active && 'border-term-border bg-term-raised'
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs text-term-text">{project.name}</span>
            {aggregate ? (
              <WorkflowStatusPill status={aggregate} className="ml-auto" />
            ) : (
              <span className="ml-auto shrink-0 font-mono text-[11px] leading-4 text-term-faint">
                {PROJECT_NOT_STARTED_LABEL}
              </span>
            )}
          </span>
          <span className="truncate font-mono text-[11px] leading-4 text-term-muted">
            {WORKFLOW_KIND_LABELS.store_launch}：
            {storeLaunch ? formatWorkflowProgress(storeLaunch) : '未启用'}
          </span>
          {products.map((product) => (
            <span
              key={product.id}
              className="truncate font-mono text-[11px] leading-4 text-term-muted"
            >
              {product.title}：{formatWorkflowProgress(product)}
            </span>
          ))}
        </button>
      </li>
    )
  }

  function renderOverview() {
    if (detailLoading) {
      return (
        <div className="space-y-2" data-testid="detail-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )
    }
    if (detailError) {
      return (
        <ErrorState
          title="项目流程加载失败"
          message={detailError}
          onRetry={() => selectedProjectId != null && void loadDetail(selectedProjectId)}
        />
      )
    }
    if (workflows.length === 0) {
      return (
        <Empty data-testid="overview-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{PROJECT_NOT_STARTED_LABEL}</EmptyTitle>
            <EmptyDescription>
              该项目还没有流程。到「店铺启动」或「产品开发」Tab 创建后即可在此查看进度。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    }

    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 border border-term-border px-2 py-2">
          <span className="font-mono text-xs text-term-muted">项目状态</span>
          {projectStatus ? (
            <WorkflowStatusPill status={projectStatus} />
          ) : (
            <span className="font-mono text-[11px] text-term-faint">
              {PROJECT_NOT_STARTED_LABEL}
            </span>
          )}
          <span className="ml-auto font-mono text-[11px] tabular-nums text-term-muted">
            项目排期 {selectedSummary?.schedule_start ?? '未排期'} ~ {selectedSummary?.schedule_end ?? '未排期'}
            {selectedSummary?.schedule_days == null ? '' : ` · ${selectedSummary.schedule_days} 天`}
          </span>
        </div>
        <ul className="flex flex-col rounded-none border border-term-border">
          {workflows.map((workflow) => (
            <WorkflowOverviewRow key={workflow.id} workflow={workflow} />
          ))}
        </ul>
      </div>
    )
  }

  function renderStoreLaunch() {
    if (detailLoading) {
      return (
        <div className="space-y-2" data-testid="detail-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )
    }
    if (detailError) {
      return (
        <ErrorState
          title="项目流程加载失败"
          message={detailError}
          onRetry={() => selectedProjectId != null && void loadDetail(selectedProjectId)}
        />
      )
    }
    if (!storeLaunchWorkflow) {
      return (
        <Empty data-testid="store-launch-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen aria-hidden />
            </EmptyMedia>
            <EmptyTitle>尚未启用店铺启动流程</EmptyTitle>
            <EmptyDescription>
              每个项目可维护一条店铺启动流程（注册资料收集 → 收款账户 → 业务审核 →
              品牌备案 → UPC 豁免 → 收款账户绑定验证）。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1 text-left">
                <Label htmlFor="store-launch-start-date">计划开始日期（可选）</Label>
                <Input id="store-launch-start-date" type="date" value={storeLaunchStartDate} onChange={(event) => setStoreLaunchStartDate(event.target.value)} disabled={detailBusy} />
              </div>
              <Button
                type="button"
                data-testid="enable-store-launch"
                disabled={detailBusy}
                onClick={() => void handleEnableStoreLaunch()}
              >
                <Plus aria-hidden />
                启用店铺启动流程
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )
    }

    return (
      <div data-testid="store-launch-workflow" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-term-text">{storeLaunchWorkflow.title}</span>
          <WorkflowStatusPill status={storeLaunchWorkflow.status} />
          <span className="ml-auto font-mono text-[11px] tabular-nums text-term-muted">
            {formatWorkflowProgress(storeLaunchWorkflow)}
          </span>
        </div>
        <WorkflowTaskList
          workflow={storeLaunchWorkflow}
          pendingTaskId={pendingTaskId}
          disabled={pendingTaskId != null || workflowMutationBusy}
          isAdmin={admin}
          projectId={selectedProjectId ?? storeLaunchWorkflow.project_id}
          session={session}
          onStatusChange={(task, nextStatus) => void handleTaskStatusChange(task, nextStatus)}
          onWorkflowMutation={handleWorkflowMutation}
          onDownloadDocument={(task) => void handleDownload(task)}
          onError={setMutationError}
        />
      </div>
    )
  }

  function renderProductDevelopment() {
    if (detailLoading) {
      return (
        <div className="space-y-2" data-testid="detail-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )
    }
    if (detailError) {
      return (
        <ErrorState
          title="项目流程加载失败"
          message={detailError}
          onRetry={() => selectedProjectId != null && void loadDetail(selectedProjectId)}
        />
      )
    }

    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-term-muted">
            同一时间可并行推进多条产品流程，互不影响。
          </span>
          <Button
            type="button"
            variant="term"
            data-testid="open-create-workflow"
            disabled={selectedProjectId == null}
            onClick={() => setDialogOpen(true)}
          >
            <Plus aria-hidden />
            新增产品流程
          </Button>
        </div>

        {productWorkflows.length === 0 ? (
          <Empty data-testid="product-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen aria-hidden />
              </EmptyMedia>
              <EmptyTitle>还没有产品开发流程</EmptyTitle>
              <EmptyDescription>
                选择产品模板（如「女士泳衣」）创建流程，任务清单会复制到本项目。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          productWorkflows.map((workflow) => (
            <section
              key={workflow.id}
              data-testid={`product-workflow-${workflow.id}`}
              className="flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-term-text">{workflow.title}</span>
                <WorkflowStatusPill status={workflow.status} />
                <span className="ml-auto font-mono text-[11px] tabular-nums text-term-muted">
                  {formatWorkflowProgress(workflow)}
                </span>
              </div>
              <WorkflowTaskList
                workflow={workflow}
                pendingTaskId={pendingTaskId}
                disabled={pendingTaskId != null || workflowMutationBusy}
                isAdmin={admin}
                projectId={selectedProjectId ?? workflow.project_id}
                session={session}
                onStatusChange={(task, nextStatus) => void handleTaskStatusChange(task, nextStatus)}
                onWorkflowMutation={handleWorkflowMutation}
                onDownloadDocument={(task) => void handleDownload(task)}
                onError={setMutationError}
              />
            </section>
          ))
        )}
      </div>
    )
  }

  function renderSelectedPane() {
    if (projectsLoading) {
      return (
        <div className="space-y-2 p-2" data-testid="projects-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )
    }

    if (projectsError) {
      return (
        <ErrorState
          data-testid="projects-error-detail"
          title="项目列表加载失败"
          message={projectsError}
          onRetry={() => void loadProjectsAndSummary({ force: true })}
        />
      )
    }

    if (noProjects) {
      return (
        <Empty data-testid="no-projects">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen aria-hidden />
            </EmptyMedia>
            <EmptyTitle>没有可见项目</EmptyTitle>
            <EmptyDescription>当前账号没有可管理的项目，请联系管理员确认项目权限。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    }

    if (!selectedProject) {
      return null
    }

    return (
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)}>
        <TabsMotionGroup id="project-launch-tabs">
          <TabsList variant="term" className="w-fit justify-start">
            {TABS.map((tab) => (
              <SlidingTabsTrigger
                key={tab}
                value={tab}
                activeValue={activeTab}
                layoutId="project-launch-tab-indicator"
                variant="term"
              >
                {TAB_LABELS[tab]}
              </SlidingTabsTrigger>
            ))}
          </TabsList>
        </TabsMotionGroup>

        <DirectionalTabTransition value={activeTab} order={TABS} className="mt-2">
          <TabsContent forceMount value={activeTab} className="mt-0">
            {activeTab === 'overview'
              ? renderOverview()
              : activeTab === 'store_launch'
                ? renderStoreLaunch()
                : renderProductDevelopment()}
          </TabsContent>
        </DirectionalTabTransition>
      </Tabs>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2" data-testid="project-launch">
      {/* 窄屏：项目选择器替代左侧列表 */}
      <div className="flex items-center gap-2 md:hidden">
        <label htmlFor="project-launch-picker" className="shrink-0 font-mono text-[11px] text-term-muted">
          项目
        </label>
        <select
          id="project-launch-picker"
          data-testid="project-picker"
          className={`${TERM_SELECT_NATIVE} w-full`}
          value={selectedProjectId == null ? '' : String(selectedProjectId)}
          disabled={projects.length === 0}
          onChange={(event) => setSelectedProjectId(Number(event.target.value) || null)}
        >
          {projects.length === 0 ? <option value="">暂无项目</option> : null}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      {admin ? <div className="flex justify-end"><Button asChild variant="term" size="sm"><Link href="/dashboard/operations/project-launch/templates">流程模板管理</Link></Button></div> : null}

      <div className="flex min-w-0 flex-col gap-2 md:grid md:grid-cols-[260px_minmax(0,1fr)]">
        {/* 桌面：左侧项目列表 */}
        <TermPanel
          title="项目"
          className="hidden max-h-[calc(100vh-9rem)] md:flex"
          bodyClassName="overflow-y-auto"
        >
          <div className="flex items-center justify-between border-b border-term-border px-2 py-1">
            <span className="font-mono text-[11px] text-term-faint">
              {projectsLoading ? '加载中…' : `共 ${projects.length} 个项目`}
            </span>
            {refreshing ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-term-muted" />
            ) : null}
          </div>
          {projectsError ? (
            <ErrorState
              title="项目列表加载失败"
              message={projectsError}
              onRetry={() => void loadProjectsAndSummary({ force: true })}
            />
          ) : projectsLoading ? (
            <div className="space-y-2 p-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <ul className="flex flex-col p-1">{projects.map(renderProjectRow)}</ul>
          )}
        </TermPanel>

        {/* 右侧：选中项目详情 */}
        <TermPanel
          title={selectedProject ? selectedProject.name : '项目详情'}
          className="min-h-[320px]"
          bodyClassName="p-2"
        >
          {summaryError ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 border border-term-border px-2 py-1.5">
              <span
                role="alert"
                data-testid="summary-error"
                className="font-mono text-[11px] text-term-neg"
              >
                {summaryError}
              </span>
              <button
                type="button"
                className={`${TERM_BUTTON} ml-auto`}
                onClick={() => void refreshSummary()}
              >
                重试
              </button>
            </div>
          ) : null}

          {mutationError ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 border border-term-border px-2 py-1.5">
              <span
                role="alert"
                data-testid="mutation-error"
                className="font-mono text-[11px] text-term-neg"
              >
                {mutationError}
              </span>
              <button
                type="button"
                className={`${TERM_BUTTON} ml-auto`}
                onClick={() => setMutationError(null)}
              >
                关闭
              </button>
            </div>
          ) : null}

          {renderSelectedPane()}
        </TermPanel>
      </div>

      {selectedProject ? (
        <CreateWorkflowDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          projectName={selectedProject.name}
          templates={productTemplates}
          templatesLoading={templatesLoading}
          templatesError={templatesError}
          onRetryTemplates={() => void loadTemplates()}
          defaultTemplateKey={PRODUCT_SWIMWEAR_TEMPLATE_KEY}
          onSubmit={handleCreateWorkflow}
        />
      ) : null}
    </div>
  )
}
