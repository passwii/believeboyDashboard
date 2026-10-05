/**
 * 项目启动台 API 客户端（BLF-1234）。
 *
 * 契约权威：`docs/superpowers/specs/2026-10-05-project-launch-dashboard-design.md` §5
 * + `backend/app/schemas/project_workflow.py`。后端 JSON 为 snake_case，本文件
 * 的类型沿用 snake_case（不转换），保证与契约逐字对齐。
 *
 * 路径经 Next 代理 `/api/backend/api/v1/...` 访问；代理注入 API Key 与会话上下文。
 * 文档下载走受保护 GET，返回 blob 后交 `downloadBlob` 落盘 —— 前端不拼任何
 * 文件系统路径，文件名只从下方白名单常量取。
 */

import type { Session } from 'next-auth'

import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { downloadBlob } from '@/lib/download-blob'
import { parseResponseError } from '@/lib/error-utils'
import { fetchWithTimeout } from '@/lib/fetch-with-timeout'

export const PROJECT_WORKFLOWS_API_BASE = '/api/backend/api/v1'

/** 普通读写的超时（与项目列表缓存同档，5s 太紧，取 10s）。 */
const REQUEST_TIMEOUT_MS = 10_000
/** 文档下载体积较大（xlsx 约 4MB），单独放宽。 */
const DOWNLOAD_TIMEOUT_MS = 30_000

// ============================================================================
// 契约类型
// ============================================================================

export type WorkflowKind = 'store_launch' | 'product_development'

/** 任务四态（唯一权威取值，前端不得自造）。 */
export type WorkflowStatus = 'not_started' | 'in_progress' | 'waiting_on_partner' | 'completed'

export const WORKFLOW_KIND_LABELS: Record<WorkflowKind, string> = {
  store_launch: '店铺启动',
  product_development: '产品开发',
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  waiting_on_partner: '等待对方',
  completed: '已完成',
}

/** 状态控件的选项顺序 = 状态机推进顺序。 */
export const WORKFLOW_STATUS_OPTIONS: ReadonlyArray<{ value: WorkflowStatus; label: string }> = [
  { value: 'not_started', label: WORKFLOW_STATUS_LABELS.not_started },
  { value: 'in_progress', label: WORKFLOW_STATUS_LABELS.in_progress },
  { value: 'waiting_on_partner', label: WORKFLOW_STATUS_LABELS.waiting_on_partner },
  { value: 'completed', label: WORKFLOW_STATUS_LABELS.completed },
]

/** 无任何流程时的项目状态文案（不落库，纯展示）。 */
export const PROJECT_NOT_STARTED_LABEL = '未启动'

export const STORE_LAUNCH_TEMPLATE_KEY = 'store-launch-v1'
export const PRODUCT_SWIMWEAR_TEMPLATE_KEY = 'product-womens-swimwear-v1'
export const DEFAULT_PRODUCT_WORKFLOW_TITLE = '女士泳衣'

/**
 * 文档键白名单：键 → 原始中文文件名。
 * 只有这里登记的键才允许进下载流程（与后端白名单一一对应）。
 */
export const WORKFLOW_DOCUMENTS: Record<string, { label: string; filename: string }> = {
  amazon_registration_form: {
    label: '亚马逊注册信息收集表',
    filename: '亚马逊_注册信息收集表.xlsx',
  },
  worldfirst_registration_guide: {
    label: '万里汇海外收款注册流程',
    filename: '万里汇海外收款注册流程.pdf',
  },
}

export type ProjectWorkflowTemplateOption = {
  key: string
  kind: WorkflowKind
  title: string
}

export type ProjectWorkflowTemplatesResponse = {
  templates: ProjectWorkflowTemplateOption[]
}

export type ProjectWorkflowTask = {
  id: number
  workflow_id: number
  title: string
  description: string | null
  sort_order: number
  status: WorkflowStatus
  attachment_key: string | null
}

export type ProjectWorkflow = {
  id: number
  project_id: number
  kind: WorkflowKind
  title: string
  template_key: string
  status: WorkflowStatus
  task_count: number
  completed_task_count: number
  tasks: ProjectWorkflowTask[]
}

export type ProjectWorkflowListResponse = {
  project_id: number
  workflows: ProjectWorkflow[]
}

export type ProjectWorkflowSummaryWorkflow = {
  id: number
  kind: WorkflowKind
  title: string
  template_key: string
  status: WorkflowStatus
  completed_task_count: number
  task_count: number
}

export type ProjectWorkflowSummaryItem = {
  project_id: number
  workflows: ProjectWorkflowSummaryWorkflow[]
}

export type ProjectWorkflowSummaryResponse = {
  projects: ProjectWorkflowSummaryItem[]
}

export type ProjectWorkflowCreateInput = {
  kind: WorkflowKind
  template_key: string
  title?: string
}

// ============================================================================
// 派生工具（与后端 §4 状态机同规则）
// ============================================================================

/**
 * 流程聚合状态派生（优先级从高到低）：
 * 1. 有任务且全部 completed → completed
 * 2. 任一 in_progress → in_progress
 * 3. 无进行中但存在 waiting_on_partner → waiting_on_partner
 * 4. 否则 not_started
 *
 * 空数组返回 null（调用方按「无流程」处理，不显示状态）。
 */
export function deriveAggregateStatus(
  statuses: readonly WorkflowStatus[]
): WorkflowStatus | null {
  if (statuses.length === 0) return null
  if (statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.some((status) => status === 'in_progress')) return 'in_progress'
  if (statuses.some((status) => status === 'waiting_on_partner')) return 'waiting_on_partner'
  return 'not_started'
}

/** 流程列表 → 项目聚合状态；无流程 → null（展示「未启动」）。 */
export function deriveProjectStatus(
  workflows: ReadonlyArray<{ status: WorkflowStatus }>
): WorkflowStatus | null {
  return deriveAggregateStatus(workflows.map((workflow) => workflow.status))
}

/** 每个流程的「第一个未完成任务」（概览 Tab 用）。 */
export function findFirstIncompleteTask(
  tasks: readonly ProjectWorkflowTask[]
): ProjectWorkflowTask | null {
  return tasks.find((task) => task.status !== 'completed') ?? null
}

/** 进度文案：`已完成/总数`。 */
export function formatWorkflowProgress(workflow: {
  completed_task_count: number
  task_count: number
}): string {
  return `${workflow.completed_task_count}/${workflow.task_count}`
}

/**
 * 本地乐观更新单个任务状态，并按同一派生规则重算流程状态与计数。
 * 写失败时调用方用保存前的 workflow 对象整体回滚。
 */
export function applyTaskStatusLocally(
  workflow: ProjectWorkflow,
  taskId: number,
  status: WorkflowStatus
): ProjectWorkflow {
  const tasks = workflow.tasks.map((task) =>
    task.id === taskId ? { ...task, status } : task
  )
  return {
    ...workflow,
    tasks,
    status: deriveAggregateStatus(tasks.map((task) => task.status)) ?? 'not_started',
    task_count: tasks.length,
    completed_task_count: tasks.filter((task) => task.status === 'completed').length,
  }
}

/** 文档下载文件名（未知键返回 null —— 调用方不应渲染下载按钮）。 */
export function resolveDocumentFilename(attachmentKey: string | null | undefined): string | null {
  if (!attachmentKey) return null
  return WORKFLOW_DOCUMENTS[attachmentKey]?.filename ?? null
}

// ============================================================================
// 请求实现
// ============================================================================

type RequestOptions = {
  session?: Session | null
  method?: 'GET' | 'POST' | 'PATCH'
  body?: unknown
  fallbackError: string
  timeoutMs?: number
}

async function requestJson<T>(path: string, options: RequestOptions): Promise<T> {
  const hasBody = options.body !== undefined
  const response = await fetchWithTimeout(`${PROJECT_WORKFLOWS_API_BASE}${path}`, {
    method: options.method ?? 'GET',
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    cache: 'no-store',
    headers: buildBackendClientHeaders(options.session ?? null, {
      contentType: hasBody ? 'application/json' : undefined,
      accept: 'application/json',
    }),
    body: hasBody ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    throw new Error(await parseResponseError(response, options.fallbackError))
  }

  return (await response.json()) as T
}

/** 模板目录（只含元数据，不含任务正文）。 */
export async function fetchWorkflowTemplates(
  session?: Session | null
): Promise<ProjectWorkflowTemplatesResponse> {
  return requestJson<ProjectWorkflowTemplatesResponse>('/project-workflows/templates', {
    session,
    fallbackError: '流程模板加载失败',
  })
}

/** 全部可见项目的流程概要（一次批量查询，无逐项目 fan-out）。 */
export async function fetchWorkflowSummary(
  session?: Session | null
): Promise<ProjectWorkflowSummaryResponse> {
  return requestJson<ProjectWorkflowSummaryResponse>('/project-workflows/summary', {
    session,
    fallbackError: '流程概要加载失败',
  })
}

/** 单项目流程 + 有序任务。 */
export async function fetchProjectWorkflows(
  projectId: number,
  session?: Session | null
): Promise<ProjectWorkflowListResponse> {
  return requestJson<ProjectWorkflowListResponse>(`/projects/${projectId}/workflows`, {
    session,
    fallbackError: '项目流程加载失败',
  })
}

/** 创建流程（模板任务快照复制）。重复创建店铺启动流程返回已存在的那条。 */
export async function createProjectWorkflow(
  projectId: number,
  input: ProjectWorkflowCreateInput,
  session?: Session | null
): Promise<ProjectWorkflow> {
  return requestJson<ProjectWorkflow>(`/projects/${projectId}/workflows`, {
    session,
    method: 'POST',
    body: input,
    fallbackError: '创建流程失败',
  })
}

/** 更新任务状态，返回其所属流程（含重新派生的状态）。 */
export async function updateProjectWorkflowTaskStatus(
  taskId: number,
  status: WorkflowStatus,
  session?: Session | null
): Promise<ProjectWorkflow> {
  return requestJson<ProjectWorkflow>(`/project-workflow-tasks/${taskId}`, {
    session,
    method: 'PATCH',
    body: { status },
    fallbackError: '更新任务状态失败',
  })
}

/**
 * 下载白名单文档。
 *
 * 鉴权 blob 请求：`response.ok` 校验通过后交给 `downloadBlob`；
 * 文件名只从 `WORKFLOW_DOCUMENTS` 取，绝不从响应头或路径拼接（防注入 + 与后端
 * 白名单保持单一真相源）。
 */
export async function downloadProjectWorkflowDocument(
  projectId: number,
  documentKey: string,
  session?: Session | null
): Promise<void> {
  const entry = WORKFLOW_DOCUMENTS[documentKey]
  if (!entry) {
    throw new Error('未知的文档键')
  }

  const response = await fetchWithTimeout(
    `${PROJECT_WORKFLOWS_API_BASE}/projects/${projectId}/workflows/documents/${encodeURIComponent(
      documentKey
    )}`,
    {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      cache: 'no-store',
      headers: buildBackendClientHeaders(session ?? null),
    }
  )

  if (!response.ok) {
    throw new Error(await parseResponseError(response, '文档下载失败'))
  }

  const blob = await response.blob()
  downloadBlob(blob, entry.filename)
}
