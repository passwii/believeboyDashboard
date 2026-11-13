/**
 * 项目启动台页面级测试（BLF-1234，设计稿 §7 UX 契约）。
 *
 * 守卫的用户可观察契约：
 *  1. 左侧项目列表 + 右侧详情分栏；窄屏用项目选择器替代列表。
 *  2. 三个 Tab（概览 / 店铺启动 / 产品开发）。
 *  3. 无店铺启动流程时可「启用店铺启动流程」（创建 store-launch-v1）。
 *  4. 任务行状态控件写成功后同时刷新详情与概要；写失败回滚到上一次已保存值并
 *     展示服务端错误。
 *  5. 只有带 attachment_key 的任务才有下载按钮，且走受保护下载函数。
 *  6. 读失败显式呈现（不伪装成空态）。
 *
 * 数据获取不做逐项目详情 fan-out：只对选中项目请求 /projects/{id}/workflows。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { stableSession } = vi.hoisted(() => ({
  stableSession: { user: { id: '1', name: '测试用户', roleType: 'admin' } },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: stableSession, status: 'authenticated' as const }),
}))

const PROJECTS = [
  { id: 1, name: '项目A' },
  { id: 2, name: '项目B' },
]

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(() => Promise.resolve(PROJECTS)),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

vi.mock('@/lib/project-workflows-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/project-workflows-api')>(
    '@/lib/project-workflows-api'
  )
  return {
    ...actual,
    fetchWorkflowSummary: vi.fn(),
    fetchProjectWorkflows: vi.fn(),
    fetchWorkflowTemplates: vi.fn(),
    createProjectWorkflow: vi.fn(),
    updateProjectWorkflowTaskStatus: vi.fn(),
    downloadProjectWorkflowDocument: vi.fn(),
  }
})

import {
  STORE_LAUNCH_TEMPLATE_KEY,
  createProjectWorkflow,
  downloadProjectWorkflowDocument,
  fetchProjectWorkflows,
  fetchWorkflowSummary,
  fetchWorkflowTemplates,
  updateProjectWorkflowTaskStatus,
  type ProjectWorkflow,
} from '@/lib/project-workflows-api'

import ProjectLaunchClient from './project-launch-client'

// ── 数据构造 ─────────────────────────────────────────────────────────────────

function makeStoreLaunch(overrides: Partial<ProjectWorkflow> = {}): ProjectWorkflow {
  return {
    id: 101,
    project_id: 1,
    kind: 'store_launch',
    title: '店铺启动',
    template_key: STORE_LAUNCH_TEMPLATE_KEY,
    status: 'not_started',
    task_count: 3,
    completed_task_count: 0,
    start_date: null,
    schedule_start: null,
    schedule_end: null,
    schedule_days: null,
    tasks: [
      {
        id: 1001,
        workflow_id: 101,
        title: '店铺注册资料收集',
        description: '按收集表汇总注册资料',
        sort_order: 1,
        status: 'not_started',
        attachment_key: 'amazon_registration_form',
        duration_days: 1,
        start_date: '2026-10-05',
        end_date: '2026-10-05',
        span_days: 1,
        contents: [],
        attachments: [],
      },
      {
        id: 1002,
        workflow_id: 101,
        title: '万里汇收款账户注册',
        description: '完成海外收款账户注册',
        sort_order: 2,
        status: 'not_started',
        attachment_key: 'worldfirst_registration_guide',
        duration_days: 2,
        start_date: '2026-10-06',
        end_date: '2026-10-07',
        span_days: 2,
        contents: [],
        attachments: [],
      },
      {
        id: 1003,
        workflow_id: 101,
        title: '店铺业务审核',
        description: null,
        sort_order: 3,
        status: 'not_started',
        attachment_key: null,
        duration_days: null,
        start_date: null,
        end_date: null,
        span_days: null,
        contents: [],
        attachments: [],
      },
    ],
    ...overrides,
  }
}

const PRODUCT_WORKFLOW: ProjectWorkflow = {
  id: 202,
  project_id: 1,
  kind: 'product_development',
  title: '女士泳衣',
  template_key: 'product-womens-swimwear-v1',
  status: 'not_started',
  task_count: 1,
  completed_task_count: 0,
  start_date: null,
  schedule_start: null,
  schedule_end: null,
  schedule_days: null,
  tasks: [
    {
      id: 2001,
      workflow_id: 202,
      title: '产品选款对接',
      description: '确认款式与目标成本',
      sort_order: 1,
      status: 'not_started',
      attachment_key: null,
      duration_days: null,
      start_date: null,
      end_date: null,
      span_days: null,
      contents: [],
      attachments: [],
    },
  ],
}

const SUMMARY = {
  projects: [
    {
      project_id: 1,
      workflows: [
        {
          id: 101,
          kind: 'store_launch' as const,
          title: '店铺启动',
          template_key: STORE_LAUNCH_TEMPLATE_KEY,
          status: 'in_progress' as const,
          completed_task_count: 1,
          task_count: 3,
          start_date: '2026-10-05',
          schedule_start: '2026-10-05',
          schedule_end: '2026-10-07',
          schedule_days: 3,
        },
        {
          id: 202,
          kind: 'product_development' as const,
          title: '女士泳衣',
          template_key: 'product-womens-swimwear-v1',
          status: 'not_started' as const,
          completed_task_count: 0,
          task_count: 1,
          start_date: null,
          schedule_start: null,
          schedule_end: null,
          schedule_days: null,
        },
      ],
      schedule_start: '2026-10-05',
      schedule_end: '2026-10-07',
      schedule_days: 3,
    },
    { project_id: 2, workflows: [], schedule_start: null, schedule_end: null, schedule_days: null },
  ],
}

const DETAILS: Record<number, ProjectWorkflow[]> = {
  1: [makeStoreLaunch(), PRODUCT_WORKFLOW],
  2: [],
}

beforeEach(() => {
  vi.mocked(fetchWorkflowSummary).mockResolvedValue(SUMMARY)
  vi.mocked(fetchProjectWorkflows).mockImplementation((projectId: number) =>
    Promise.resolve({ project_id: projectId, workflows: DETAILS[projectId] ?? [] })
  )
  vi.mocked(fetchWorkflowTemplates).mockResolvedValue({
    templates: [
      { key: 'store-launch-v1', kind: 'store_launch', title: '店铺启动' },
      { key: 'product-womens-swimwear-v1', kind: 'product_development', title: '女士泳衣' },
    ],
  })
  vi.mocked(createProjectWorkflow).mockResolvedValue(makeStoreLaunch())
  vi.mocked(updateProjectWorkflowTaskStatus).mockResolvedValue(makeStoreLaunch())
  vi.mocked(downloadProjectWorkflowDocument).mockResolvedValue(undefined)
})

afterEach(() => {
  stableSession.user.roleType = 'admin'
  cleanup()
  vi.clearAllMocks()
})

async function renderPage() {
  render(<ProjectLaunchClient />)
  // 等首个项目详情就绪（店铺启动 Tab 需要点开后才有任务行）。
  await waitFor(() => {
    expect(fetchProjectWorkflows).toHaveBeenCalledWith(1, expect.anything())
  })
  await screen.findByRole('tab', { name: '概览' })
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('项目启动台 · 列表与分栏', () => {
  it('使用 Warm Ledger 页面壳且不混用 Terminal 表面', async () => {
    const { container } = render(<ProjectLaunchClient />)

    const page = await screen.findByTestId('project-launch-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('左侧列表渲染概要进度，且不对未选中项目拉详情', async () => {
    await renderPage()

    // 项目行（左侧列表）与面板标题各出现一次。
    expect(screen.getAllByText('项目A').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('project-row-2')).not.toBeInTheDocument()
    // 默认收起没有待处理流程的历史项目，可手动展开查看。
    const showArchived = screen.getByTestId('toggle-archived-projects')
    expect(showArchived).toHaveTextContent('显示历史/已启动项目（1）')
    // 项目A 的店铺启动进度来自概要（1/3）。
    expect(within(screen.getByTestId('project-row-1')).getByText('店铺启动：1/3')).toBeInTheDocument()
    // 展开后项目B 无流程 → 未启动 + 未启用。
    await userEvent.setup().click(showArchived)
    const rowB = within(await screen.findByTestId('project-row-2'))
    expect(rowB.getByText('未启动')).toBeInTheDocument()
    expect(rowB.getByText('店铺启动：未启用')).toBeInTheDocument()

    // 只对选中项目发详情请求（无逐项目 fan-out）。
    expect(fetchProjectWorkflows).toHaveBeenCalledTimes(1)
    expect(fetchProjectWorkflows).toHaveBeenCalledWith(1, expect.anything())
  })

  it('窄屏项目选择器切换项目后重新拉对应详情', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByTestId('toggle-archived-projects-mobile'))
    await user.selectOptions(screen.getByTestId('project-picker'), '2')

    await waitFor(() => {
      expect(fetchProjectWorkflows).toHaveBeenCalledWith(2, expect.anything())
    })
  })

  it('概览 Tab 展示项目状态与各流程第一个未完成任务', async () => {
    await renderPage()

    const overview = await screen.findByTestId('workflow-overview-101')
    expect(within(overview).getByText('下一步：店铺注册资料收集')).toBeInTheDocument()
    // 详情进度取自详情接口（概要行的 1/3 是另一份数据）。
    expect(within(overview).getByText('0/3')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-overview-202')).toBeInTheDocument()
  })

  it('概要请求失败显式呈现错误（不伪装成空态）', async () => {
    vi.mocked(fetchWorkflowSummary).mockRejectedValueOnce(new Error('概要服务不可用'))
    await renderPage()

    expect(screen.getByTestId('summary-error')).toHaveTextContent('概要服务不可用')
  })

  it('详情请求失败显式呈现错误并给重试入口', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchProjectWorkflows).mockRejectedValueOnce(new Error('详情服务不可用'))
    render(<ProjectLaunchClient />)

    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))

    expect(await screen.findByText('项目流程加载失败')).toBeInTheDocument()
    expect(screen.getByText('详情服务不可用')).toBeInTheDocument()
  })

  it('项目列表请求失败时右侧显示错误和重试，不显示空态或骨架屏', async () => {
    const user = userEvent.setup()
    const cache = await import('@/lib/project-client-cache')
    vi.mocked(cache.fetchManagedProjectsCached).mockRejectedValueOnce(
      new Error('项目服务暂不可用')
    )
    render(<ProjectLaunchClient />)

    const rightPaneError = await screen.findByTestId('projects-error-detail')
    expect(within(rightPaneError).getByText('项目列表加载失败')).toBeInTheDocument()
    expect(within(rightPaneError).getByText('项目服务暂不可用')).toBeInTheDocument()
    expect(screen.queryByTestId('no-projects')).not.toBeInTheDocument()
    expect(screen.queryByTestId('projects-loading')).not.toBeInTheDocument()

    vi.mocked(cache.fetchManagedProjectsCached).mockResolvedValueOnce(PROJECTS)
    await user.click(within(rightPaneError).getByRole('button', { name: '重试' }))

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '概览' })).toBeInTheDocument()
    })
    expect(screen.queryByTestId('projects-error-detail')).not.toBeInTheDocument()
  })

  it('没有可见项目时给出明确空态', async () => {
    const cache = await import('@/lib/project-client-cache')
    vi.mocked(cache.fetchManagedProjectsCached).mockResolvedValueOnce([])
    render(<ProjectLaunchClient />)

    expect(await screen.findByTestId('no-projects')).toBeInTheDocument()
  })
})

describe('项目启动台 · 店铺启动 Tab', () => {
  it('无店铺启动流程时「启用店铺启动流程」创建 store-launch-v1 并刷新详情与概要', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchProjectWorkflows).mockImplementation((projectId: number) =>
      Promise.resolve({ project_id: projectId, workflows: DETAILS[projectId] ?? [] })
    )
    render(<ProjectLaunchClient />)
    // 项目B（无流程）作为选中项目，先展开历史项目并切过去。
    await waitFor(() => expect(fetchProjectWorkflows).toHaveBeenCalled())
    await user.click(await screen.findByTestId('toggle-archived-projects-mobile'))
    await user.selectOptions(await screen.findByTestId('project-picker'), '2')

    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))

    const enable = await screen.findByTestId('enable-store-launch')
    const summaryCallsBefore = vi.mocked(fetchWorkflowSummary).mock.calls.length
    await user.click(enable)

    await waitFor(() => {
      expect(createProjectWorkflow).toHaveBeenCalledWith(
        2,
        { kind: 'store_launch', template_key: STORE_LAUNCH_TEMPLATE_KEY },
        expect.anything()
      )
    })
    // 创建成功后同时刷新详情与概要。
    await waitFor(() => {
      expect(vi.mocked(fetchWorkflowSummary).mock.calls.length).toBeGreaterThan(summaryCallsBefore)
    })
    expect(fetchProjectWorkflows).toHaveBeenLastCalledWith(2, expect.anything())
  })

  it('创建失败时展示服务端错误且不静默', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchProjectWorkflows).mockResolvedValue({ project_id: 2, workflows: [] })
    vi.mocked(createProjectWorkflow).mockRejectedValueOnce(new Error('无项目权限'))
    render(<ProjectLaunchClient />)
    await waitFor(() => expect(fetchProjectWorkflows).toHaveBeenCalled())
    await user.click(await screen.findByTestId('toggle-archived-projects-mobile'))
    await user.selectOptions(await screen.findByTestId('project-picker'), '2')
    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))

    await user.click(await screen.findByTestId('enable-store-launch'))

    expect(await screen.findByTestId('mutation-error')).toHaveTextContent('无项目权限')
  })
})

describe('项目启动台 · 任务状态与文档', () => {
  it('只有带附件键的任务才有下载按钮，点击走受保护下载', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))

    const withDoc = await screen.findByTestId('workflow-task-1001')
    const withoutDoc = screen.getByTestId('workflow-task-1003')
    expect(within(withDoc).getByTestId('task-download-1001')).toBeInTheDocument()
    expect(within(withoutDoc).queryByRole('button', { name: /下载/ })).toBeNull()

    await user.click(within(withDoc).getByTestId('task-download-1001'))
    await waitFor(() => {
      expect(downloadProjectWorkflowDocument).toHaveBeenCalledWith(
        1,
        'amazon_registration_form',
        expect.anything()
      )
    })
  })

  it('状态写成功：选中新状态并同时刷新概要', async () => {
    const user = userEvent.setup()
    vi.mocked(updateProjectWorkflowTaskStatus).mockResolvedValueOnce(
      makeStoreLaunch({
        status: 'in_progress',
        completed_task_count: 1,
        tasks: makeStoreLaunch().tasks.map((task) =>
          task.id === 1001 ? { ...task, status: 'completed' as const } : task
        ),
      })
    )
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))

    const summaryCallsBefore = vi.mocked(fetchWorkflowSummary).mock.calls.length
    await user.selectOptions(await screen.findByTestId('task-status-1001'), 'completed')

    await waitFor(() => {
      expect(updateProjectWorkflowTaskStatus).toHaveBeenCalledWith(
        1001,
        'completed',
        expect.anything()
      )
    })
    await waitFor(() => {
      expect(vi.mocked(fetchWorkflowSummary).mock.calls.length).toBeGreaterThan(summaryCallsBefore)
    })
    await waitFor(() => {
      expect(screen.getByTestId('task-status-1001')).toHaveValue('completed')
    })
  })

  it('状态写失败：回滚到上一次已保存值并展示服务端错误', async () => {
    const user = userEvent.setup()
    vi.mocked(updateProjectWorkflowTaskStatus).mockRejectedValueOnce(
      new Error('状态流转不被允许')
    )
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))

    const select = await screen.findByTestId('task-status-1001')
    await user.selectOptions(select, 'waiting_on_partner')

    expect(await screen.findByTestId('mutation-error')).toHaveTextContent('状态流转不被允许')
    await waitFor(() => {
      expect(screen.getByTestId('task-status-1001')).toHaveValue('not_started')
    })
  })
})

describe('项目启动台 · 产品开发 Tab', () => {
  it('新增产品流程对话框默认选中女士泳衣模板并创建', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '产品开发' }))

    await user.click(await screen.findByTestId('open-create-workflow'))

    const templateSelect = await screen.findByTestId('workflow-template-select')
    await waitFor(() => {
      expect(templateSelect).toHaveValue('product-womens-swimwear-v1')
    })
    expect(screen.getByTestId('workflow-title-input')).toHaveValue('女士泳衣')
    await user.type(screen.getByTestId('workflow-start-date-input'), '2026-10-05')

    await user.click(screen.getByRole('button', { name: '创建流程' }))

    await waitFor(() => {
      expect(createProjectWorkflow).toHaveBeenCalledWith(
        1,
        {
          kind: 'product_development',
          template_key: 'product-womens-swimwear-v1',
          title: '女士泳衣',
          start_date: '2026-10-05',
        },
        expect.anything()
      )
    })
  })

  it('创建失败在对话框内展示服务端错误且保持打开', async () => {
    const user = userEvent.setup()
    vi.mocked(createProjectWorkflow).mockRejectedValueOnce(new Error('模板与流程类型不匹配'))
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '产品开发' }))
    await user.click(await screen.findByTestId('open-create-workflow'))

    await user.click(await screen.findByRole('button', { name: '创建流程' }))

    expect(await screen.findByTestId('create-workflow-error')).toHaveTextContent(
      '模板与流程类型不匹配'
    )
    expect(screen.getByTestId('create-workflow-dialog')).toBeInTheDocument()
  })

  it('管理员可在项目节点维护排期与阶段内容，且附件/固定资料共存', async () => {
    const user = userEvent.setup()
    const workflow = makeStoreLaunch({
      tasks: [
        {
          ...makeStoreLaunch().tasks[0],
          contents: [{ id: 501, title: '收集说明', body: '填完整信息', sort_order: 0 }],
          attachments: [{ id: 601, filename: '样品清单.xlsx', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file_size: 2048, uploader: '运营A', created_at: '2026-10-05T10:00:00Z', origin: 'template' }],
        },
        ...makeStoreLaunch().tasks.slice(1),
      ],
    })
    vi.mocked(fetchProjectWorkflows).mockResolvedValueOnce({ project_id: 1, workflows: [workflow] })
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))
    const row = await screen.findByTestId('workflow-task-1001')
    expect(within(row).getByText('2026-10-05 ~ 2026-10-05')).toBeInTheDocument()
    expect(within(row).getByText('阶段内容')).toBeInTheDocument()
    expect(within(row).getByText('收集说明')).toBeInTheDocument()
    expect(within(row).getByText('模板附件')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '固定资料' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(within(row).getByText('2.0 KB')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '概览' }))
    expect(screen.getAllByText(/2026-10-05/).length).toBeGreaterThan(0)
  })

  it('管理员可编辑流程锚点，非管理员不显示管理控件', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '店铺启动' }))
    await screen.findByTestId('workflow-task-1001')
    expect(screen.getByLabelText('计划开始日期')).toBeInTheDocument()

    stableSession.user.roleType = 'operator'
    cleanup()
    render(<ProjectLaunchClient />)
    await screen.findByRole('tab', { name: '店铺启动' }).then((tab) => user.click(tab))
    await screen.findByTestId('workflow-task-1001')
    expect(screen.queryByLabelText('计划开始日期')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '流程模板管理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /编辑节点/ })).not.toBeInTheDocument()
  })

  it('产品 Tab 逐个产品实例独立分组', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('tab', { name: '产品开发' }))

    const section = await screen.findByTestId('product-workflow-202')
    expect(within(section).getByText('女士泳衣')).toBeInTheDocument()
    expect(within(section).getByTestId('workflow-task-2001')).toBeInTheDocument()
  })
})

describe('项目启动台 · 手机端适配契约（BLF-1505）', () => {
  it('样式文件覆盖手机端断点、触控尺寸与安全区吸底', () => {
    const css = readFileSync(join(__dirname, 'project-launch-warm.module.css'), 'utf8')

    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/)
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/@media\s*\(max-width:\s*380px\)/)
    expect(css).toMatch(/--warm-ledger-control-target-touch/)
    expect(css).toMatch(/safe-area-inset-top/)
    expect(css).toMatch(/safe-area-inset-bottom/)
  })

  it('手机端选择器与历史切换按钮具备完整无障碍与操作属性', async () => {
    await renderPage()

    const picker = screen.getByTestId('project-picker')
    expect(picker).toBeInTheDocument()
    expect(picker).toHaveValue('1')
    expect(screen.getByLabelText('项目')).toBe(picker)

    const toggleMobile = screen.getByTestId('toggle-archived-projects-mobile')
    expect(toggleMobile).toBeInTheDocument()
    expect(toggleMobile).toHaveTextContent('显示历史/已启动项目（1）')
  })
})
