import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}))

import { CreateSubscriptionDialog } from './CreateSubscriptionDialog'
import type { AIModelConfig } from './types'

const MODEL_CONFIG: AIModelConfig = {
  providerConfigured: true,
  models: ['gpt-5'],
  defaultModel: 'gpt-5',
  premiumModels: ['gpt-5'],
  basicModels: [],
}

function installPortalRoot() {
  const root = document.createElement('div')
  root.id = 'warm-ledger-portal-root'
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  cleanup()
  document.getElementById('warm-ledger-portal-root')?.remove()
  vi.unstubAllGlobals()
})

const CSS = readFileSync(
  join(
    process.cwd(),
    'app/dashboard/reports/scheduled-reports/_components/subscription-dialog-warm.module.css'
  ),
  'utf8'
)

function cssBlock(selector: string): string {
  const start = CSS.indexOf(selector)
  expect(start, `missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const open = CSS.indexOf('{', start)
  const close = CSS.indexOf('}', open)
  return CSS.slice(open + 1, close)
}

describe('CreateSubscriptionDialog Warm 弹窗与无邮箱创建', () => {
  it('弹窗 portal 到 #warm-ledger-portal-root，继承 Warm token 而不是 body', async () => {
    const root = installPortalRoot()
    render(
      <CreateSubscriptionDialog
        open
        onOpenChange={vi.fn()}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        onSuccess={vi.fn()}
      />
    )

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(root.contains(dialog)).toBe(true))
    expect(screen.getByRole('heading', { name: '新增订阅' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })

  it('弹窗表面不透明（panel 色 + hairline + 16px 圆角），内容区滚动、footer 固定', () => {
    const surface = cssBlock('.dialog {')
    expect(surface).toContain('background: var(--warm-ledger-color-panel)')
    expect(surface).toContain('border: 1px solid var(--warm-ledger-color-hairline-strong)')
    expect(surface).toContain('border-radius: var(--warm-ledger-radius-panel)')
    expect(surface).toContain('overflow: hidden')
    expect(cssBlock('.formBody {')).toContain('overflow-y: auto')
    expect(cssBlock('.footer {')).toContain('height: 76px')
    expect(cssBlock('.footer {')).toContain('flex: 0 0 auto')
  })

  it('不填邮箱也能创建，请求体 email=null 且成功后关闭并刷新', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(async () => new Response('{"id":42}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const onOpenChange = vi.fn()
    const onSuccess = vi.fn()

    render(
      <CreateSubscriptionDialog
        open
        onOpenChange={onOpenChange}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        onSuccess={onSuccess}
      />
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '确认创建' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ email: null })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('非空无效邮箱给出内联错误并阻止提交', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(async () => new Response('{"id":42}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <CreateSubscriptionDialog
        open
        onOpenChange={vi.fn()}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        onSuccess={vi.fn()}
      />
    )

    const user = userEvent.setup()
    const email = screen.getByLabelText(/邮箱地址/)
    await user.type(email, 'jrway123@gmail')

    expect(screen.getByText('邮箱格式无效，请输入完整邮箱地址')).toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('指定项目但未选项目时给出内联错误并阻止创建', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(async () => new Response('{"id":42}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <CreateSubscriptionDialog
        open
        onOpenChange={vi.fn()}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        onSuccess={vi.fn()}
      />
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '指定项目' }))
    expect(screen.getByText('请至少选择 1 个项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('空邮箱时测试邮件按钮禁用并给出提示', () => {
    installPortalRoot()
    render(
      <CreateSubscriptionDialog
        open
        onOpenChange={vi.fn()}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        onSuccess={vi.fn()}
      />
    )
    const testButton = screen.getByRole('button', { name: '发送测试邮件' })
    expect(testButton).toBeDisabled()
    expect(testButton).toHaveAttribute('title', '请先填写邮箱地址后再发送测试邮件')
  })
})
