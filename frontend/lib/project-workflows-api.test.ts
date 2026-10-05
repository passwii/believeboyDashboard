/**
 * 项目启动台 API 客户端测试（BLF-1234）。
 *
 * 覆盖：HTTP 契约（路径 / 方法 / JSON body / 错误 detail）、文档下载白名单、
 * 以及四个状态派生工具（必须与后端 §4 状态机同规则）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadBlob } from '@/lib/download-blob'

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: vi.fn(),
}))

import {
  PROJECT_WORKFLOWS_API_BASE,
  applyTaskStatusLocally,
  createProjectWorkflow,
  deriveAggregateStatus,
  deriveProjectStatus,
  downloadProjectWorkflowDocument,
  fetchProjectWorkflows,
  fetchWorkflowSummary,
  fetchWorkflowTemplates,
  findFirstIncompleteTask,
  formatWorkflowProgress,
  resolveDocumentFilename,
  updateProjectWorkflowTaskStatus,
  type ProjectWorkflow,
  type ProjectWorkflowTask,
} from './project-workflows-api'

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    blob: () => Promise.resolve(new Blob(['x'])),
  } as unknown as Response
}

function errorResponse(detail: string, status = 422): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ detail }),
    text: () => Promise.resolve(JSON.stringify({ detail })),
    blob: () => Promise.resolve(new Blob([])),
  } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.mocked(downloadBlob).mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── 派生工具 ─────────────────────────────────────────────────────────────────

describe('状态派生（与后端 §4 同规则）', () => {
  it('全部完成 → completed（优先级最高，覆盖存在 in_progress 的输入顺序差异）', () => {
    expect(deriveAggregateStatus(['completed', 'completed'])).toBe('completed')
  })

  it('任一进行中 → in_progress（优先于等待对方）', () => {
    expect(deriveAggregateStatus(['waiting_on_partner', 'in_progress', 'not_started'])).toBe(
      'in_progress'
    )
  })

  it('无进行中但存在等待对方 → waiting_on_partner', () => {
    expect(deriveAggregateStatus(['not_started', 'waiting_on_partner'])).toBe(
      'waiting_on_partner'
    )
  })

  it('其余 → not_started；空数组 → null（无流程）', () => {
    expect(deriveAggregateStatus(['not_started', 'not_started'])).toBe('not_started')
    expect(deriveAggregateStatus([])).toBeNull()
    expect(deriveProjectStatus([])).toBeNull()
  })

  it('deriveProjectStatus 只看流程状态', () => {
    expect(deriveProjectStatus([{ status: 'completed' }, { status: 'completed' }])).toBe(
      'completed'
    )
  })

  it('findFirstIncompleteTask 取第一个非 completed 任务', () => {
    const tasks = [
      { id: 1, status: 'completed' },
      { id: 2, status: 'waiting_on_partner' },
      { id: 3, status: 'not_started' },
    ] as ProjectWorkflowTask[]
    expect(findFirstIncompleteTask(tasks)?.id).toBe(2)
    expect(findFirstIncompleteTask(tasks.slice(0, 1))).toBeNull()
  })

  it('formatWorkflowProgress / resolveDocumentFilename', () => {
    expect(formatWorkflowProgress({ completed_task_count: 2, task_count: 6 })).toBe('2/6')
    expect(resolveDocumentFilename('amazon_registration_form')).toBe('亚马逊_注册信息收集表.xlsx')
    expect(
      resolveDocumentFilename('worldfirst_registration_guide')
    ).toBe('万里汇海外收款注册流程.pdf')
    expect(resolveDocumentFilename('not_allowlisted')).toBeNull()
    expect(resolveDocumentFilename(null)).toBeNull()
  })

  it('applyTaskStatusLocally 重算流程状态与完成计数', () => {
    const workflow = {
      id: 9,
      project_id: 1,
      kind: 'store_launch',
      title: '店铺启动',
      template_key: 'store-launch-v1',
      status: 'not_started',
      task_count: 2,
      completed_task_count: 0,
      tasks: [
        { id: 11, workflow_id: 9, title: 'A', description: null, sort_order: 1, status: 'not_started', attachment_key: null },
        { id: 12, workflow_id: 9, title: 'B', description: null, sort_order: 2, status: 'not_started', attachment_key: null },
      ],
    } satisfies ProjectWorkflow

    const next = applyTaskStatusLocally(workflow, 11, 'completed')
    expect(next.tasks[0].status).toBe('completed')
    expect(next.completed_task_count).toBe(1)
    // 契约规则：未全完成、无进行中、无等待对方 → not_started（不是「进行中」）。
    expect(next.status).toBe('not_started')

    const withProgress = applyTaskStatusLocally(next, 12, 'in_progress')
    expect(withProgress.status).toBe('in_progress')
    expect(withProgress.completed_task_count).toBe(1)

    const bothDone = applyTaskStatusLocally(next, 12, 'completed')
    expect(bothDone.completed_task_count).toBe(2)
    expect(bothDone.status).toBe('completed')
    // 原对象不被改动（回滚快照依赖不可变更新）。
    expect(workflow.tasks[0].status).toBe('not_started')
  })
})

// ── HTTP 契约 ────────────────────────────────────────────────────────────────

describe('请求契约', () => {
  it('模板目录 / 概要 / 项目流程 走代理路径且 GET', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ templates: [] }))
    await fetchWorkflowTemplates(null)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PROJECT_WORKFLOWS_API_BASE}/project-workflows/templates`
    )
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')

    fetchMock.mockResolvedValueOnce(jsonResponse({ projects: [] }))
    await fetchWorkflowSummary(null)
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${PROJECT_WORKFLOWS_API_BASE}/project-workflows/summary`
    )

    fetchMock.mockResolvedValueOnce(jsonResponse({ project_id: 7, workflows: [] }))
    const detail = await fetchProjectWorkflows(7, null)
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${PROJECT_WORKFLOWS_API_BASE}/projects/7/workflows`
    )
    expect(detail).toEqual({ project_id: 7, workflows: [] })
  })

  it('创建流程 POST JSON body（title 可省）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }))
    await createProjectWorkflow(
      7,
      { kind: 'store_launch', template_key: 'store-launch-v1' },
      null
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PROJECT_WORKFLOWS_API_BASE}/projects/7/workflows`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(
      JSON.stringify({ kind: 'store_launch', template_key: 'store-launch-v1' })
    )
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json')
  })

  it('任务状态 PATCH 只发 status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 3 }))
    await updateProjectWorkflowTaskStatus(3, 'waiting_on_partner', null)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PROJECT_WORKFLOWS_API_BASE}/project-workflow-tasks/3`)
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe(JSON.stringify({ status: 'waiting_on_partner' }))
  })

  it('非 2xx 抛服务端 detail（写失败要能展示真实原因）', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse('任务不存在', 404))
    await expect(updateProjectWorkflowTaskStatus(3, 'completed', null)).rejects.toThrow(
      '任务不存在'
    )
  })
})

describe('文档下载', () => {
  it('走项目级白名单路径并用原始中文文件名落盘', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}))
    await downloadProjectWorkflowDocument(7, 'amazon_registration_form', null)

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PROJECT_WORKFLOWS_API_BASE}/projects/7/workflows/documents/amazon_registration_form`
    )
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(filename).toBe('亚马逊_注册信息收集表.xlsx')
  })

  it('未知键直接拒绝且不发请求（不拼路径）', async () => {
    await expect(
      downloadProjectWorkflowDocument(7, '../../etc/passwd', null)
    ).rejects.toThrow('未知的文档键')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('下载失败抛服务端 detail 且不落盘', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse('文档不存在', 404))
    await expect(
      downloadProjectWorkflowDocument(7, 'worldfirst_registration_guide', null)
    ).rejects.toThrow('文档不存在')
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
