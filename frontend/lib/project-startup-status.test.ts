import { describe, expect, it } from 'vitest'

import { deriveProjectStartupStatus, hasActiveProjectWorkflow } from './project-startup-status'
import type { ProjectWorkflowSummaryWorkflow } from './project-workflows-api'

function workflow(
  kind: ProjectWorkflowSummaryWorkflow['kind'],
  status: ProjectWorkflowSummaryWorkflow['status']
): Pick<ProjectWorkflowSummaryWorkflow, 'kind' | 'status'> {
  return { kind, status }
}

describe('项目启动状态关联', () => {
  it('无店铺启动流程时视为未启动', () => {
    expect(deriveProjectStartupStatus([])).toBe('not_started')
  })

  it('店铺启动流程完成时视为已启动，否则视为正在启动', () => {
    expect(deriveProjectStartupStatus([workflow('store_launch', 'completed')])).toBe('launched')
    expect(deriveProjectStartupStatus([workflow('store_launch', 'in_progress')])).toBe('launching')
    expect(deriveProjectStartupStatus([workflow('store_launch', 'not_started')])).toBe('launching')
    expect(deriveProjectStartupStatus([workflow('store_launch', 'waiting_on_partner')])).toBe('launching')
  })

  it('产品开发流程不决定店铺启动状态', () => {
    expect(deriveProjectStartupStatus([workflow('product_development', 'completed')])).toBe('not_started')
    expect(
      deriveProjectStartupStatus([
        workflow('product_development', 'in_progress'),
        workflow('store_launch', 'completed'),
      ])
    ).toBe('launched')
  })

  it('历史空项目可收起，但未完成的任意流程仍然保留', () => {
    expect(hasActiveProjectWorkflow([])).toBe(false)
    expect(hasActiveProjectWorkflow([workflow('store_launch', 'completed')])).toBe(false)
    expect(hasActiveProjectWorkflow([workflow('store_launch', 'not_started')])).toBe(true)
    expect(hasActiveProjectWorkflow([workflow('product_development', 'in_progress')])).toBe(true)
    expect(
      hasActiveProjectWorkflow([
        workflow('store_launch', 'completed'),
        workflow('product_development', 'in_progress'),
      ])
    ).toBe(true)
  })
})
