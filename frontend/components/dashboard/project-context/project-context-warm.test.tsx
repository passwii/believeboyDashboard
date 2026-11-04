import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

  it('编辑背景仍提交完整 project_context 并保留成功回调', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()
    FETCH_PROJECT_CONTEXT.mockResolvedValue({
      project_context: { 定位: '旧值' },
    })
    UPDATE_PROJECT_CONTEXT.mockResolvedValue({
      project_context: { 定位: '新值' },
    })

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

    await waitFor(() =>
      expect(UPDATE_PROJECT_CONTEXT).toHaveBeenCalledWith(
        2,
        { project_context: { 定位: '新值' } },
        null
      )
    )
    expect(onSuccess).toHaveBeenCalledTimes(1)
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
