import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CustomerServiceClient } from './customer-service-client'

vi.mock('@/lib/api/ai-chat-config-store', () => ({
  ensureConfigLoaded: vi.fn(() => Promise.resolve()),
  getConfig: () => ({
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
  }),
}))

describe('CustomerServiceClient', () => {
  beforeEach(() => vi.clearAllMocks())
  it('渲染两个场景 tab 且邮件撰写标记即将上线', async () => {
    render(<CustomerServiceClient />)
    expect(await screen.findByText('运营汇报话术')).toBeTruthy()
    expect(await screen.findByText('邮件撰写（即将上线）')).toBeTruthy()
  })
})
