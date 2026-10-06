import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionState } = vi.hoisted(() => ({
  sessionState: { data: { user: { roleType: 'admin' } }, status: 'authenticated' as const },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => sessionState,
}))

vi.mock('@/lib/project-workflows-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/project-workflows-api')>('@/lib/project-workflows-api')
  return {
    ...actual,
    fetchAdminTemplates: vi.fn(),
    fetchAdminTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    copyTemplate: vi.fn(),
    createTemplateTask: vi.fn(),
    updateTemplateTask: vi.fn(),
    deleteTemplateTask: vi.fn(),
    reorderTemplateTasks: vi.fn(),
    createTemplateContent: vi.fn(),
    updateTemplateContent: vi.fn(),
    deleteTemplateContent: vi.fn(),
    uploadTemplateTaskAttachment: vi.fn(),
    deleteTemplateTaskAttachment: vi.fn(),
  }
})

import {
  createTemplateTask,
  fetchAdminTemplate,
  fetchAdminTemplates,
  updateTemplate,
  type WorkflowTemplateDetail,
} from '@/lib/project-workflows-api'
import WorkflowTemplateEditor from './workflow-template-editor'

const DETAIL: WorkflowTemplateDetail = {
  id: 1,
  key: 'store-launch-v1',
  kind: 'store_launch',
  title: '店铺启动',
  description: '注册到上线',
  sort_order: 0,
  task_count: 1,
  tasks: [{
    id: 11,
    template_id: 1,
    title: '资料准备',
    description: '收齐注册资料',
    sort_order: 0,
    attachment_key: 'amazon_registration_form',
    duration_days: 3,
    contents: [{ id: 111, title: '收集要求', body: '确认法人信息', sort_order: 0 }],
    attachments: [],
  }],
}

const TEMPLATES = { templates: [DETAIL] }

beforeEach(() => {
  sessionState.data = { user: { roleType: 'admin' } }
  vi.mocked(fetchAdminTemplates).mockResolvedValue(TEMPLATES)
  vi.mocked(fetchAdminTemplate).mockResolvedValue(DETAIL)
  vi.mocked(updateTemplate).mockImplementation(async (_id, input) => ({ ...DETAIL, ...input }))
  vi.mocked(createTemplateTask).mockImplementation(async () => ({
    ...DETAIL,
    task_count: 2,
    tasks: [...DETAIL.tasks, {
      id: 12,
      template_id: 1,
      title: '样品验收',
      description: null,
      sort_order: 1,
      attachment_key: null,
      duration_days: null,
      contents: [],
      attachments: [],
    }],
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('项目启动台模板编辑器', () => {
  it('非管理员显示无权限态且不请求模板数据', () => {
    sessionState.data = { user: { roleType: 'operator' } }
    render(<WorkflowTemplateEditor />)
    expect(screen.getByTestId('template-editor-forbidden')).toBeInTheDocument()
    expect(fetchAdminTemplates).not.toHaveBeenCalled()
    expect(fetchAdminTemplate).not.toHaveBeenCalled()
  })

  it('管理员可编辑模板并保存模板详情', async () => {
    const user = userEvent.setup()
    render(<WorkflowTemplateEditor />)
    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备'))

    await user.clear(screen.getByLabelText('模板名称'))
    await user.type(screen.getByLabelText('模板名称'), '店铺开通')
    await user.click(screen.getByRole('button', { name: '保存模板' }))

    await waitFor(() => expect(updateTemplate).toHaveBeenCalledWith(1, {
      title: '店铺开通',
      description: '注册到上线',
      sort_order: 0,
    }, expect.anything()))
    expect(await screen.findByRole('status')).toHaveTextContent('模板已保存')
  })

  it('新建节点后使用服务端返回详情更新节点清单', async () => {
    const user = userEvent.setup()
    render(<WorkflowTemplateEditor />)
    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备'))

    await user.type(screen.getByLabelText('新增阶段'), '样品验收')
    await user.click(screen.getByRole('button', { name: '新增阶段' }))

    await waitFor(() => expect(createTemplateTask).toHaveBeenCalledWith(1, { title: '样品验收' }, expect.anything()))
    await waitFor(() => expect(screen.getAllByDisplayValue('样品验收').length).toBeGreaterThan(0))
    expect(within(screen.getByLabelText('模板列表')).getByText(/2 个阶段/)).toBeInTheDocument()
  })
})
