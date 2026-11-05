'use client'

/**
 * 项目启动台（BLF-1234，设计稿 §7 前端 UX 契约）。
 *
 * 结构：左侧项目列表（窄屏换成项目选择器）+ 右侧项目详情；详情三个 Tab：
 * 概览 / 店铺启动 / 产品开发。
 *
 * 数据获取：`fetchManagedProjectsCached` 拿可见项目 + `/project-workflows/summary`
 * 一次批量拿流程概要，列表渲染不做逐项目请求；选中项目的详情按需拉取。
 * 创建 / 改状态成功后**同时**刷新详情与概要，保证列表与详情一致。
 *
 * 写语义：任务状态先本地乐观更新，服务端失败则整体回滚到保存前的 workflow
 * 并展示服务端错误（设计稿 §7「写失败保留上一次已保存状态」）。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { FolderOpen, Loader2, Plus } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DirectionalTabTransition,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
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
import { hasActiveProjectWorkflow } from '@/lib/project-startup-status'

import { CreateWorkflowDialog } from './create-workflow-dialog'
import { WorkflowOverviewRow, WorkflowStatusPill, WorkflowTaskList } from './project-workflow-list'
import styles from './project-launch-warm.module.css'

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

type LocalButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'secondary' | 'term' | 'outline'
  size?: 'sm'
}

function Button({ variant = 'secondary', size, className, ...props }: LocalButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={[
        styles.button,
        variant === 'term' || variant === 'outline' ? styles.buttonQuiet : '',
        size === 'sm' ? styles.buttonCompact : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
}

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={[styles.input, className].filter(Boolean).join(' ')}
      />
    )
  }
)

function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={[styles.label, className].filter(Boolean).join(' ')} />
}

function Panel({
  title,
  className,
  bodyClassName,
  children,
}: {
  title?: string
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <section className={[styles.panel, className].filter(Boolean).join(' ')}>
      {title ? (
        <header className={styles.panelHeader}>
          <h2>{title}</h2>
        </header>
      ) : null}
      <div className={[styles.panelBody, bodyClassName].filter(Boolean).join(' ')}>{children}</div>
    </section>
  )
}

function InlineError({
  title,
  message,
  onRetry,
  testId,
}: {
  title: string
  message: string
  onRetry: () => void
  testId?: string
}) {
  return (
    <div className={styles.errorState} role="alert" data-testid={testId}>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      <Button onClick={onRetry}>重试</Button>
    </div>
  )
}

export default function ProjectLaunchClient() {
  const { data: session, status: sessionStatus } = useSession()
  const admin = isAdmin(session)

  const [projects, setProjects] = useState<ManagedProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryLoaded, setSummaryLoaded] = useState(false)

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
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
  const archivedProjectCount = !summaryLoaded || summaryError ? 0 : projects.filter((project) =>
    !hasActiveProjectWorkflow(summariesByProject.get(project.id)?.workflows ?? [])
  ).length
  const displayedProjects = useMemo(() => {
    if (showArchivedProjects || summaryError) return projects
    return projects.filter((project) =>
      hasActiveProjectWorkflow(summariesByProject.get(project.id)?.workflows ?? [])
    )
  }, [projects, showArchivedProjects, summariesByProject, summaryError])

  // ── 读：项目列表 + 流程概要（一次批量，无逐项目 fan-out） ────────────────
  const loadProjectsAndSummary = useCallback(
    async (options?: { force?: boolean }) => {
      setProjectsLoading(true)
      setProjectsError(null)
      setSummaryError(null)
      setSummaryLoaded(false)

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
      setSummaryLoaded(true)

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

  // 默认选中第一个当前可见项目；刷新后若原项目进入历史列表则切回首个待处理项目。
  useEffect(() => {
    if (projectsLoading || projectsError) return
    if (selectedProjectId != null && displayedProjects.some((project) => project.id === selectedProjectId)) {
      return
    }
    const nextProjectId = displayedProjects[0]?.id ?? null
    if (selectedProjectId !== nextProjectId) setSelectedProjectId(nextProjectId)
  }, [displayedProjects, projectsError, projectsLoading, selectedProjectId])

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
            styles.projectRow,
            active && styles.projectRowActive
          )}
        >
          <span className={styles.projectRowTop}>
            <span className={styles.projectName}>{project.name}</span>
            {aggregate ? (
              <WorkflowStatusPill status={aggregate} className="ml-auto" />
            ) : (
              <span className={styles.projectState}>
                {PROJECT_NOT_STARTED_LABEL}
              </span>
            )}
          </span>
          <span className={styles.projectMeta}>
            {WORKFLOW_KIND_LABELS.store_launch}：
            {storeLaunch ? formatWorkflowProgress(storeLaunch) : '未启用'}
          </span>
          {products.map((product) => (
            <span key={product.id} className={styles.projectMeta}>
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
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      )
    }
    if (detailError) {
      return (
        <InlineError
          title="项目流程加载失败"
          message={detailError}
          onRetry={() => selectedProjectId != null && void loadDetail(selectedProjectId)}
        />
      )
    }
    if (workflows.length === 0) {
      return (
        <div className={styles.empty} data-testid="overview-empty">
          <span className={styles.emptyIcon}>
            <FolderOpen aria-hidden />
          </span>
          <strong>{PROJECT_NOT_STARTED_LABEL}</strong>
          <p>该项目还没有流程。到「店铺启动」或「产品开发」Tab 创建后即可在此查看进度。</p>
        </div>
      )
    }

    return (
      <div className={styles.stack}>
        <div className={styles.statusStrip}>
          <span className={styles.metaLabel}>项目状态</span>
          {projectStatus ? (
            <WorkflowStatusPill status={projectStatus} />
          ) : (
            <span className={styles.projectState}>
              {PROJECT_NOT_STARTED_LABEL}
            </span>
          )}
          <span className={styles.statusSchedule}>
            项目排期 {selectedSummary?.schedule_start ?? '未排期'} ~ {selectedSummary?.schedule_end ?? '未排期'}
            {selectedSummary?.schedule_days == null ? '' : ` · ${selectedSummary.schedule_days} 天`}
          </span>
        </div>
        <ul className={styles.overviewList}>
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
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      )
    }
    if (detailError) {
      return (
        <InlineError
          title="项目流程加载失败"
          message={detailError}
          onRetry={() => selectedProjectId != null && void loadDetail(selectedProjectId)}
        />
      )
    }
    if (!storeLaunchWorkflow) {
      return (
        <div className={styles.empty} data-testid="store-launch-empty">
          <span className={styles.emptyIcon}>
            <FolderOpen aria-hidden />
          </span>
          <strong>尚未启用店铺启动流程</strong>
          <p>
            每个项目可维护一条店铺启动流程（注册资料收集 → 收款账户 → 业务审核 →
            品牌备案 → UPC 豁免 → 收款账户绑定验证）。
          </p>
          <div className={styles.emptyActions}>
              <div className={styles.field}>
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
        </div>
      )
    }

    return (
      <div data-testid="store-launch-workflow" className={styles.stack}>
        <div className={styles.workflowHeader}>
          <span className={styles.workflowTitle}>{storeLaunchWorkflow.title}</span>
          <WorkflowStatusPill status={storeLaunchWorkflow.status} />
          <span className={styles.workflowProgress}>
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
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      )
    }
    if (detailError) {
      return (
        <InlineError
          title="项目流程加载失败"
          message={detailError}
          onRetry={() => selectedProjectId != null && void loadDetail(selectedProjectId)}
        />
      )
    }

    return (
      <div className={styles.stackLg}>
        <div className={styles.productActions}>
          <span className={styles.supportingText}>
            同一时间可并行推进多条产品流程，互不影响。
          </span>
          <Button
            type="button"
            variant="secondary"
            data-testid="open-create-workflow"
            disabled={selectedProjectId == null}
            onClick={() => setDialogOpen(true)}
          >
            <Plus aria-hidden />
            新增产品流程
          </Button>
        </div>

        {productWorkflows.length === 0 ? (
          <div className={styles.empty} data-testid="product-empty">
            <span className={styles.emptyIcon}>
              <FolderOpen aria-hidden />
            </span>
            <strong>还没有产品开发流程</strong>
            <p>选择产品模板（如「女士泳衣」）创建流程，任务清单会复制到本项目。</p>
          </div>
        ) : (
          productWorkflows.map((workflow) => (
            <section
              key={workflow.id}
              data-testid={`product-workflow-${workflow.id}`}
              className={styles.stack}
            >
              <div className={styles.workflowHeader}>
                <span className={styles.workflowTitle}>{workflow.title}</span>
                <WorkflowStatusPill status={workflow.status} />
                <span className={styles.workflowProgress}>
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
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      )
    }

    if (projectsError) {
      return (
        <InlineError
          testId="projects-error-detail"
          title="项目列表加载失败"
          message={projectsError}
          onRetry={() => void loadProjectsAndSummary({ force: true })}
        />
      )
    }

    if (noProjects) {
      return (
        <div className={styles.empty} data-testid="no-projects">
          <span className={styles.emptyIcon}>
            <FolderOpen aria-hidden />
          </span>
          <strong>没有可见项目</strong>
          <p>当前账号没有可管理的项目，请联系管理员确认项目权限。</p>
        </div>
      )
    }

    if (!selectedProject) {
      return (
        <div className={styles.empty} data-testid="no-pending-projects">
          <span className={styles.emptyIcon}>
            <FolderOpen aria-hidden />
          </span>
          <strong>暂无待启动项目</strong>
          <p>历史或已启动项目已收起，可展开查看全部项目。</p>
          {archivedProjectCount > 0 ? (
            <Button type="button" variant="outline" onClick={() => setShowArchivedProjects(true)}>
              显示历史/已启动项目（{archivedProjectCount}）
            </Button>
          ) : null}
        </div>
      )
    }

    return (
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)}>
        <TabsMotionGroup id="project-launch-tabs">
          <TabsList className={styles.tabsList}>
            {TABS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className={styles.tabTrigger}
              >
                {TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>
        </TabsMotionGroup>

        <DirectionalTabTransition value={activeTab} order={TABS} className={styles.tabTransition}>
          <TabsContent forceMount value={activeTab} className={styles.tabContent}>
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
    <main
      className={styles.page}
      data-testid="project-launch-warm-page"
      data-warm-surface="warm-ledger"
      aria-busy={projectsLoading || refreshing}
    >
      {/* 窄屏：项目选择器替代左侧列表 */}
      <div className={styles.mobilePicker}>
        <div className={styles.mobilePickerRow}>
          <Label htmlFor="project-launch-picker">
            项目
          </Label>
          <select
            id="project-launch-picker"
            data-testid="project-picker"
            className={styles.select}
            value={selectedProjectId == null ? '' : String(selectedProjectId)}
            disabled={displayedProjects.length === 0}
            onChange={(event) => setSelectedProjectId(Number(event.target.value) || null)}
          >
            {displayedProjects.length === 0 ? <option value="">暂无待启动项目</option> : null}
            {displayedProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        {archivedProjectCount > 0 ? (
          <button
            type="button"
            data-testid="toggle-archived-projects-mobile"
            className={styles.buttonQuiet}
            onClick={() => setShowArchivedProjects((value) => !value)}
          >
            {showArchivedProjects ? '收起历史/已启动项目' : `显示历史/已启动项目（${archivedProjectCount}）`}
          </button>
        ) : null}
      </div>

      {admin ? (
        <div className={styles.adminAction}>
          <Link className={styles.button} href="/dashboard/operations/project-launch/templates">
            流程模板管理
          </Link>
        </div>
      ) : null}

      <div className={styles.workspace}>
        {/* 桌面：左侧项目列表 */}
        <Panel
          title="项目"
          className={styles.projectPanel}
          bodyClassName={styles.projectPanelBody}
        >
          <div className={styles.projectListHeader}>
            <span>
              {projectsLoading ? '加载中…' : `显示 ${displayedProjects.length} / ${projects.length} 个项目`}
            </span>
            {archivedProjectCount > 0 ? (
              <button
                type="button"
                data-testid="toggle-archived-projects"
                className={styles.buttonQuiet}
                onClick={() => setShowArchivedProjects((value) => !value)}
              >
                {showArchivedProjects ? '收起历史/已启动项目' : `显示历史/已启动项目（${archivedProjectCount}）`}
              </button>
            ) : null}
            {refreshing ? (
              <Loader2 aria-hidden className={styles.spinner} />
            ) : null}
          </div>
          {projectsError ? (
            <InlineError
              title="项目列表加载失败"
              message={projectsError}
              onRetry={() => void loadProjectsAndSummary({ force: true })}
            />
          ) : projectsLoading ? (
            <div className={styles.loadingStack}>
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
            </div>
          ) : (
            <ul className={styles.projectList}>{displayedProjects.map(renderProjectRow)}</ul>
          )}
        </Panel>

        {/* 右侧：选中项目详情 */}
        <Panel
          title={selectedProject ? selectedProject.name : '项目详情'}
          className={styles.detailPanel}
          bodyClassName={styles.detailPanelBody}
        >
          {summaryError ? (
            <div className={styles.errorBanner}>
              <span
                role="alert"
                data-testid="summary-error"
                className={styles.errorText}
              >
                {summaryError}
              </span>
              <button
                type="button"
                className={styles.buttonQuiet}
                onClick={() => void refreshSummary()}
              >
                重试
              </button>
            </div>
          ) : null}

          {mutationError ? (
            <div className={styles.errorBanner}>
              <span
                role="alert"
                data-testid="mutation-error"
                className={styles.errorText}
              >
                {mutationError}
              </span>
              <button
                type="button"
                className={styles.buttonQuiet}
                onClick={() => setMutationError(null)}
              >
                关闭
              </button>
            </div>
          ) : null}

          {renderSelectedPane()}
        </Panel>
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
    </main>
  )
}
