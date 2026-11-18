import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EditSubscriptionDialog } from './EditSubscriptionDialog'
import type { AIModelConfig, Subscription } from './types'

const MODEL_CONFIG: AIModelConfig = {
  providerConfigured: true,
  models: ['gpt-5', 'gpt-5-mini'],
  defaultModel: 'gpt-5',
  premiumModels: ['gpt-5'],
  basicModels: ['gpt-5-mini'],
}

const PROJECTS = [
  { id: 3, name: '铨富 US' },
  { id: 4, name: '铨富 UK' },
]

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 42,
    user_id: null,
    email: null,
    project_ids: '*',
    country: 'US',
    frequency: 'daily',
    dispatch_hour: 15,
    dispatch_minute: 10,
    dispatch_weekday: null,
    dispatch_day: null,
    ai_model: 'gpt-5',
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function installPortalRoot() {
  const root = document.createElement('div')
  root.id = 'warm-ledger-portal-root'
  document.body.appendChild(root)
  return root
}

function renderEdit(subscription: Subscription, onSuccess = vi.fn()) {
  render(
    <EditSubscriptionDialog
      subscription={subscription}
      open
      onOpenChange={vi.fn()}
      projects={PROJECTS}
      modelConfig={MODEL_CONFIG}
      isLoadingModelConfig={false}
      onSuccess={onSuccess}
    />
  )
  return onSuccess
}

afterEach(() => {
  cleanup()
  document.getElementById('warm-ledger-portal-root')?.remove()
  vi.unstubAllGlobals()
})

describe('EditSubscriptionDialog 无邮箱与 Warm 弹窗', () => {
  it('弹窗 portal 到 #warm-ledger-portal-root，继承 Warm token', async () => {
    const root = installPortalRoot()
    renderEdit(makeSubscription())

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(root.contains(dialog)).toBe(true))
    expect(screen.getByRole('heading', { name: '编辑订阅' })).toBeInTheDocument()
  })

  it('无邮箱订阅保存时 email=null，且不被前端阻止提交', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"id":42}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const onSuccess = renderEdit(makeSubscription())

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({ email: null })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })

  it('编辑回填邮箱、国家、项目、频率、星期、时间与模型，保存时字段语义不变', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"id":42}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    renderEdit(
      makeSubscription({
        email: 'jrway123@gmail.com',
        project_ids: '3,4',
        country: 'US,DE',
        frequency: 'weekly',
        dispatch_hour: 16,
        dispatch_minute: 30,
        dispatch_weekday: 0,
        dispatch_day: null,
        ai_model: 'gpt-5-mini',
      })
    )

    expect(screen.getByLabelText(/邮箱地址/)).toHaveValue('jrway123@gmail.com')
    expect(screen.getByText('美国站')).toBeInTheDocument()
    expect(screen.getByText('德国站')).toBeInTheDocument()
    expect(screen.getByText('铨富 US')).toBeInTheDocument()
    expect(screen.getByText('铨富 UK')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '每周' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('combobox', { name: '发送星期' })).toHaveTextContent(
      '周一（最早 16:00）'
    )
    expect(screen.getByRole('combobox', { name: '发送小时' })).toHaveTextContent('16')
    expect(screen.getByRole('combobox', { name: '发送分钟' })).toHaveTextContent('30')
    expect(screen.getByRole('combobox', { name: 'AI 模型' })).toHaveTextContent('gpt-5-mini')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/subscriptions/42')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'jrway123@gmail.com',
      project_ids: '3,4',
      country: 'US,DE',
      frequency: 'weekly',
      dispatch_hour: 16,
      dispatch_minute: 30,
      dispatch_weekday: 0,
      dispatch_day: null,
      ai_model: 'gpt-5-mini',
    })
  })

  it('国家回填为空时回退到 US，保存不会静默提交空国家', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"id":42}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    renderEdit(makeSubscription({ country: '' }))

    expect(screen.getByText('美国站')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({ country: 'US' })
  })

  it('月频订阅回填发送日期', () => {
    installPortalRoot()
    renderEdit(
      makeSubscription({
        frequency: 'monthly',
        dispatch_day: 2,
        dispatch_weekday: null,
      })
    )
    expect(screen.getByRole('combobox', { name: '发送日期' })).toHaveTextContent('2 日')
    expect(screen.queryByRole('combobox', { name: '发送星期' })).toBeNull()
  })

  it('非空无效邮箱给出内联错误并阻止保存', async () => {
    installPortalRoot()
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"id":42}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    renderEdit(makeSubscription({ email: 'jrway123@example.com' }))

    const user = userEvent.setup()
    const email = screen.getByLabelText(/邮箱地址/)
    await user.clear(email)
    await user.type(email, 'jrway123@gmail')

    expect(screen.getByText('邮箱格式无效，请输入完整邮箱地址')).toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
