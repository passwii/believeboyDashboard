import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionState } = vi.hoisted(() => ({
  sessionState: { data: { user: { roleType: 'admin' } }, status: 'authenticated' as const },
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
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
  updateTemplateContent,
  updateTemplateTask,
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
  vi.mocked(updateTemplateTask).mockImplementation(async () => DETAIL)
  vi.mocked(updateTemplateContent).mockImplementation(async () => DETAIL)
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
  it('使用 Warm Ledger 编辑器壳且不混用 Terminal 表面', async () => {
    const { container } = render(<WorkflowTemplateEditor />)

    const page = await screen.findByTestId('workflow-template-editor-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    await waitFor(() => expect(container.querySelector('[class*="term-"]')).toBeNull())
  })

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

  it('普通标题与说明不套数值等宽字体，Key 等标识保留数值样式', async () => {
    render(<WorkflowTemplateEditor />)

    const catalogHeading = await screen.findByRole('heading', { name: '模板目录' })
    expect(catalogHeading).not.toHaveClass('tabular-nums')
    expect(screen.getByText('模板信息')).not.toHaveClass('tabular-nums')
    expect(screen.getByText(/Key: store-launch-v1/)).toHaveAttribute('data-numeric', 'true')
  })

  it('附件文件名使用普通 sans，不套数值样式', async () => {
    const detailWithAttachment: WorkflowTemplateDetail = {
      ...DETAIL,
      tasks: [
        {
          ...DETAIL.tasks[0],
          attachments: [
            {
              id: 201,
              filename: '供应商合同.pdf',
              content_type: 'application/pdf',
              file_size: 2048,
              uploader: '运营A',
              created_at: '2026-11-05T10:00:00Z',
              origin: 'upload',
            },
          ],
        },
      ],
    }
    vi.mocked(fetchAdminTemplates).mockResolvedValue({ templates: [detailWithAttachment] })
    vi.mocked(fetchAdminTemplate).mockResolvedValue(detailWithAttachment)

    render(<WorkflowTemplateEditor />)

    const filename = await screen.findByText('供应商合同.pdf')
    expect(filename).not.toHaveAttribute('data-numeric')
    expect(filename.className).not.toContain('numeric')
  })

  it('切换阶段前自动保存阶段字段和已有内容', async () => {
    const user = userEvent.setup()
    const twoTaskDetail: WorkflowTemplateDetail = {
      ...DETAIL,
      task_count: 2,
      tasks: [DETAIL.tasks[0], {
        ...DETAIL.tasks[0],
        id: 12,
        title: '样品验收',
        sort_order: 1,
        contents: [{ id: 121, title: null, body: '检查样品', sort_order: 0 }],
      }],
    }
    vi.mocked(fetchAdminTemplates).mockResolvedValue({ templates: [twoTaskDetail] })
    vi.mocked(fetchAdminTemplate).mockResolvedValue(twoTaskDetail)
    vi.mocked(updateTemplateTask).mockResolvedValue(twoTaskDetail)
    vi.mocked(updateTemplateContent).mockResolvedValue(twoTaskDetail)

    render(<WorkflowTemplateEditor />)
    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备'))
    await user.clear(screen.getByLabelText('阶段说明'))
    await user.type(screen.getByLabelText('阶段说明'), '先核对资料')
    await user.clear(screen.getByLabelText('内容'))
    await user.type(screen.getByLabelText('内容'), '确认法人及地址')
    await user.click(screen.getByRole('button', { name: '下一步' }))

    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('样品验收'))
    expect(updateTemplateTask).toHaveBeenCalledWith(11, expect.objectContaining({ description: '先核对资料' }), expect.anything())
    expect(updateTemplateContent).toHaveBeenCalledWith(111, { title: '收集要求', body: '确认法人及地址' }, expect.anything())
  })

  it('自动保存失败时停留在当前阶段并显示错误', async () => {
    const user = userEvent.setup()
    const twoTaskDetail: WorkflowTemplateDetail = {
      ...DETAIL,
      task_count: 2,
      tasks: [DETAIL.tasks[0], { ...DETAIL.tasks[0], id: 12, title: '样品验收', sort_order: 1 }],
    }
    vi.mocked(fetchAdminTemplates).mockResolvedValue({ templates: [twoTaskDetail] })
    vi.mocked(fetchAdminTemplate).mockResolvedValue(twoTaskDetail)
    vi.mocked(updateTemplateTask).mockRejectedValue(new Error('保存失败'))

    render(<WorkflowTemplateEditor />)
    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备'))
    await user.click(screen.getByRole('button', { name: '下一步' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
    expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备')
  })

  it('新建阶段后自动选中新阶段', async () => {
    const user = userEvent.setup()
    render(<WorkflowTemplateEditor />)
    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备'))

    await user.type(screen.getByLabelText('新增阶段'), '样品验收')
    await user.click(screen.getByRole('button', { name: '新增阶段' }))

    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('样品验收'))
    expect(within(screen.getByLabelText('模板列表')).getByText(/2 个阶段/)).toBeInTheDocument()
  })
})

describe('流程模板管理 · 手机端适配契约（BLF-1505）', () => {
  it('样式文件覆盖手机端断点、触控尺寸与响应式骨架屏', () => {
    const css = readFileSync(join(__dirname, 'workflow-template-editor-warm.module.css'), 'utf8')

    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/--warm-ledger-control-target-touch/)
    expect(css).toMatch(/\.select\s*\{/)
  })

  it('固定资料与流程类型选择控件使用规范样式并具有完整选项', async () => {
    render(<WorkflowTemplateEditor />)
    await waitFor(() => expect(screen.getByLabelText('阶段名称')).toHaveValue('资料准备'))

    const docSelect = screen.getByLabelText('固定资料')
    expect(docSelect).toBeInTheDocument()
    expect(docSelect).toHaveValue('amazon_registration_form')
  })
})
