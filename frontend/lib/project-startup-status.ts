import type { ProjectWorkflowSummaryWorkflow } from '@/lib/project-workflows-api'

export type ProjectStartupStatus = 'not_started' | 'launching' | 'launched'

type StartupWorkflow = Pick<ProjectWorkflowSummaryWorkflow, 'kind' | 'status'>

export const PROJECT_STARTUP_STATUS_LABELS: Record<ProjectStartupStatus, string> = {
  not_started: '未启动',
  launching: '正在启动',
  launched: '已启动',
}

/** Project Info 的启动状态从现有店铺启动流程派生，不另存一份可分叉的状态。 */
export function deriveProjectStartupStatus(
  workflows: readonly StartupWorkflow[]
): ProjectStartupStatus {
  const storeLaunch = workflows.find((workflow) => workflow.kind === 'store_launch')
  if (!storeLaunch) return 'not_started'
  return storeLaunch.status === 'completed' ? 'launched' : 'launching'
}

/** 启动台默认只展示仍有待处理工作的项目；历史空项目和已完成项目可手动展开。 */
export function hasActiveProjectWorkflow(workflows: readonly StartupWorkflow[]): boolean {
  return workflows.some((workflow) => workflow.status !== 'completed')
}
