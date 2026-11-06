import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const NOTIFY = { notify: vi.fn() }
const FETCH_PROJECT_CONTEXT = vi.fn()
const UPDATE_PROJECT_CONTEXT = vi.fn()
const START_GLOBAL_LOADING = vi.fn()
const END_GLOBAL_LOADING = vi.fn()
const CONFIRM = vi.fn()

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({
    startGlobalLoading: START_GLOBAL_LOADING,
    endGlobalLoading: END_GLOBAL_LOADING,
  }),
}))

vi.mock('@/lib/project-context', () => ({
  fetchProjectContext: (...args: unknown[]) => FETCH_PROJECT_CONTEXT(...args),
  updateProjectContext: (...args: unknown[]) => UPDATE_PROJECT_CONTEXT(...args),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: CONFIRM }),
}))

import { ProjectContextTab } from './project-context-tab'
import { ProjectContextDialog } from './project-context-dialog'
import { ProjectContextDrawer } from './project-context-drawer'
import { AiParseContextSheet } from './ai-parse-context-sheet'

const PROJECT_CONTEXT_SOURCE_ROOT = join(process.cwd(), 'components/dashboard/project-context')
const TERMINAL_VISUAL_RESIDUE = [
  { label: 'Terminal token', pattern: /--term-/g },
  { label: 'Terminal utility', pattern: /\bterm-[a-z0-9-]+/g },
  { label: 'Terminal zero-radius utility', pattern: /\brounded-none\b/g },
]

function collectProjectContextSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectProjectContextSourceFiles(path)
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return []
    return ['.css', '.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

describe('Project Context Warm Ledger 迁移', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    FETCH_PROJECT_CONTEXT.mockReset()
    UPDATE_PROJECT_CONTEXT.mockReset()
  })

  it('V4 Project Context 源文件不重新引入 Terminal 视觉残留', () => {
    const violations = collectProjectContextSourceFiles(PROJECT_CONTEXT_SOURCE_ROOT).flatMap(
      (path) => {
        const source = readFileSync(path, 'utf8')
        return TERMINAL_VISUAL_RESIDUE.flatMap(({ label, pattern }) =>
          Array.from(source.matchAll(pattern), (match) => ({
            path,
            label,
            match: match[0],
          }))
        )
      }
    )

    expect(violations).toEqual([])
  })

  it('保留 Tier 分组、排序和可打开的项目卡语义', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 2,
            name: '店铺乙',
            brand_name: '乙',
            project_tier: 'T2',
            sort_order: 2,
          },
          {
            id: 1,
            name: '店铺甲',
            brand_name: '甲',
            project_tier: 'T1',
            sort_order: 1,
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    FETCH_PROJECT_CONTEXT.mockResolvedValue({
      project_context: { 定位: '测试背景' },
    })

    const { container } = render(<ProjectContextTab />)

    expect(container.firstElementChild).toHaveAttribute('data-warm-project-context', 'true')
    expect(await screen.findByRole('button', { name: /店铺甲/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /店铺乙/ })).toBeInTheDocument()
    expect(screen.getByText('T1')).toBeInTheDocument()
    expect(screen.getByText('T2')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/backend/api/v1/projects/manage')
    expect(FETCH_PROJECT_CONTEXT).toHaveBeenCalledWith(2, null)
    expect(FETCH_PROJECT_CONTEXT).toHaveBeenCalledWith(1, null)
  })

  it('项目背景列表加载只显示本地忙碌状态，不启动全局阻塞层', async () => {
    START_GLOBAL_LOADING.mockClear()
    END_GLOBAL_LOADING.mockClear()

    let resolveProjects: (response: Response) => void = () => {}
    const pendingProjects = new Promise<Response>((resolve) => {
      resolveProjects = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockReturnValue(pendingProjects)

    render(<ProjectContextTab />)

    expect(START_GLOBAL_LOADING).not.toHaveBeenCalled()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('正在加载项目背景')
    expect(status.closest('[aria-busy="true"]')).toBeInTheDocument()

    resolveProjects(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    await screen.findByText('暂无项目数据')
    expect(END_GLOBAL_LOADING).not.toHaveBeenCalled()
  })

  it('编辑背景仍提交完整 project_context 并保留成功回调', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()
    START_GLOBAL_LOADING.mockClear()
    END_GLOBAL_LOADING.mockClear()
    FETCH_PROJECT_CONTEXT.mockResolvedValue({
      project_context: { 定位: '旧值' },
    })
    let resolveUpdate: (result: { project_context: Record<string, string> }) => void = () => {}
    UPDATE_PROJECT_CONTEXT.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve
      })
    )

    render(
      <ProjectContextDialog
        projectId={2}
        projectName="店铺乙"
        open
        onOpenChange={vi.fn()}
        onSuccess={onSuccess}
      />
    )

    await screen.findByText('店铺乙')
    await user.click(screen.getByRole('button', { name: '编辑背景' }))
    const description = await screen.findByLabelText('定位 描述')
    await user.clear(description)
    await user.type(description, '新值')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    const savingButton = await screen.findByRole('button', { name: '正在保存项目背景' })
    expect(savingButton).toBeDisabled()
    expect(savingButton).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByLabelText('定位 描述')).not.toBeInTheDocument()
    expect(START_GLOBAL_LOADING).not.toHaveBeenCalled()
    expect(END_GLOBAL_LOADING).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(UPDATE_PROJECT_CONTEXT).toHaveBeenCalledWith(
        2,
        { project_context: { 定位: '新值' } },
        null
      )
    )
    resolveUpdate({ project_context: { 定位: '新值' } })
    await screen.findByRole('button', { name: '已保存' })
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('保存项目背景时只显示局部按钮 loading', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    START_GLOBAL_LOADING.mockClear()
    END_GLOBAL_LOADING.mockClear()
    FETCH_PROJECT_CONTEXT.mockResolvedValue({
      project_context: { 定位: '旧值' },
    })

    let resolveUpdate: (result: { project_context: Record<string, string> }) => void = () => {}
    UPDATE_PROJECT_CONTEXT.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve
      })
    )

    render(
      <ProjectContextDrawer
        projectId={2}
        projectName="店铺乙"
        open
        onOpenChange={onOpenChange}
      />
    )

    const description = await screen.findByLabelText('定位 描述')
    await user.clear(description)
    await user.type(description, '新值')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    const savingButton = await screen.findByRole('button', { name: '正在保存项目背景' })
    expect(savingButton).toBeDisabled()
    expect(savingButton).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByLabelText('定位 描述')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AI 辅助' })).toBeDisabled()
    expect(START_GLOBAL_LOADING).not.toHaveBeenCalled()
    expect(END_GLOBAL_LOADING).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()

    resolveUpdate({ project_context: { 定位: '新值' } })
    await screen.findByRole('button', { name: '已保存' })
  })

  it('抽屉切换项目后忽略旧项目晚返回的背景', async () => {
    let resolveProjectA: (result: { project_context: Record<string, string> }) => void = () => {}
    let resolveProjectB: (result: { project_context: Record<string, string> }) => void = () => {}
    const projectARequest = new Promise<{ project_context: Record<string, string> }>((resolve) => {
      resolveProjectA = resolve
    })
    const projectBRequest = new Promise<{ project_context: Record<string, string> }>((resolve) => {
      resolveProjectB = resolve
    })
    FETCH_PROJECT_CONTEXT.mockImplementation((projectId: number) =>
      projectId === 1 ? projectARequest : projectBRequest
    )

    const drawerProps = {
      projectName: '店铺甲',
      open: true,
      onOpenChange: vi.fn(),
    }
    const { rerender } = render(<ProjectContextDrawer projectId={1} {...drawerProps} />)
    await waitFor(() => expect(FETCH_PROJECT_CONTEXT).toHaveBeenCalledWith(1, null))

    rerender(
      <ProjectContextDrawer
        projectId={2}
        {...drawerProps}
        projectName="店铺乙"
      />
    )
    await waitFor(() => expect(FETCH_PROJECT_CONTEXT).toHaveBeenCalledWith(2, null))

    resolveProjectB({ project_context: { 定位: '乙项目背景' } })
    const description = await screen.findByLabelText('定位 描述')
    await waitFor(() => expect(description).toHaveValue('乙项目背景'))

    await act(async () => {
      resolveProjectA({ project_context: { 定位: '甲项目背景' } })
      await projectARequest
    })
    expect(description).toHaveValue('乙项目背景')
    expect(screen.getByText('项目：店铺乙')).toBeInTheDocument()
  })

  it('AI 解析仍调用 context/parse 并把解析结果交给父表单', async () => {
    const user = userEvent.setup()
    const onParsed = vi.fn()
    const onClose = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { 定位: '华东供应商' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    render(
      <AiParseContextSheet
        open
        projectId={2}
        projectName="店铺乙"
        onClose={onClose}
        onParsed={onParsed}
      />
    )

    await user.type(screen.getByLabelText('项目背景描述'), '华东供应商')
    await user.click(screen.getByRole('button', { name: 'AI 解析' }))
    await screen.findByDisplayValue('定位')
    await user.click(screen.getByRole('button', { name: '填充到表单' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/projects/2/context/parse',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ description: '华东供应商' }),
      })
    )
    expect(onParsed).toHaveBeenCalledWith({ 定位: '华东供应商' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
