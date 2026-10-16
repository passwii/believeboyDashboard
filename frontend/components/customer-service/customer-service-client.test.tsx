import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { CustomerServiceClient } from './customer-service-client'

const { ensureConfigLoadedMock, useHeaderRefreshMock } = vi.hoisted(() => ({
  ensureConfigLoadedMock: vi.fn(),
  useHeaderRefreshMock: vi.fn(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: useHeaderRefreshMock,
}))

vi.mock('@/lib/api/ai-chat-config-store', () => ({
  ensureConfigLoaded: ensureConfigLoadedMock,
}))

const CONFIG = {
  providerConfigured: true,
  webSearchConfigured: false,
  models: [],
  defaultModel: '',
  premiumModels: [],
  basicModels: [],
  reasoningModels: [],
  defaultReasoningEffort: 'medium',
  timeoutSeconds: 90,
  maxConversationTurns: 10,
  webSearchMaxResults: 5,
  overviewOptions: [],
  detailOptions: [],
  scenarios: [
    { id: 'ops-report', label: '运营汇报话术', description: 'x', mode: 'refine', disabled: false },
    { id: 'email-compose', label: '邮件撰写', description: 'y', mode: 'compose', disabled: true },
  ],
}

describe('CustomerServiceClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureConfigLoadedMock.mockResolvedValue(CONFIG)
  })

  it('渲染两个场景 tab 且邮件撰写标记即将上线', async () => {
    render(<CustomerServiceClient />)
    expect(await screen.findByRole('button', { name: '运营汇报话术' })).toBeTruthy()
    expect(await screen.findByText('邮件撰写（即将上线）')).toBeTruthy()
  })

  it('Head 刷新重新加载场景配置且保留仍可用的选中场景', async () => {
    const refreshedConfig = {
      ...CONFIG,
      scenarios: [
        ...CONFIG.scenarios,
        { id: 'new-scenario', label: '新场景', description: 'z', mode: 'refine', disabled: false },
      ],
    }
    ensureConfigLoadedMock.mockResolvedValueOnce(CONFIG).mockResolvedValueOnce(refreshedConfig)
    render(<CustomerServiceClient />)
    await screen.findByText('运营汇报话术')

    const handler = useHeaderRefreshMock.mock.calls.at(-1)?.[0] as () => Promise<void>
    await act(async () => handler())

    expect(ensureConfigLoadedMock).toHaveBeenLastCalledWith(true)
    expect(await screen.findByText('新场景')).toBeTruthy()
    expect(screen.getByRole('button', { name: '运营汇报话术' })).toHaveClass('bg-term-raised')
  })

  it('Head 刷新失败时保留原场景并显示可理解错误', async () => {
    render(<CustomerServiceClient />)
    await screen.findByRole('button', { name: '运营汇报话术' })
    ensureConfigLoadedMock.mockRejectedValueOnce(new Error('暂时不可用'))

    const handler = useHeaderRefreshMock.mock.calls.at(-1)?.[0] as () => Promise<void>
    await act(async () => handler())

    expect(screen.getByRole('alert')).toHaveTextContent('暂时不可用')
    expect(screen.getByRole('button', { name: '运营汇报话术' })).toBeTruthy()
  })
})
