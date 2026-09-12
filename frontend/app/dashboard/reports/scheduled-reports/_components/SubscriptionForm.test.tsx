import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SubscriptionForm } from './SubscriptionForm'
import type { AIModelConfig } from './types'

/**
 * BLF-1032：AI 模型区此前默认折叠，改模型要先点一次展开 —— 高频路径上的固定损耗。
 * 断言口径：渲染后不点任何东西就能看到模型选择控件、并且能直接选出模型。
 */

vi.mock('@/components/project-scope-select', () => ({
  ProjectScopeSelect: () => <div data-testid="project-scope" />,
}))

const MODEL_CONFIG: AIModelConfig = {
  providerConfigured: true,
  models: ['gpt-5', 'gpt-5-mini'],
  defaultModel: 'gpt-5',
  premiumModels: ['gpt-5'],
  basicModels: ['gpt-5-mini'],
}

function renderForm(overrides: Partial<Parameters<typeof SubscriptionForm>[0]> = {}) {
  const props = {
    mode: 'create' as const,
    formEmail: 'ops@example.com',
    setFormEmail: vi.fn(),
    formProjectIds: '*',
    setFormProjectIds: vi.fn(),
    formSelectedProjectIds: [],
    setFormSelectedProjectIds: vi.fn(),
    formCountries: [],
    setFormCountries: vi.fn(),
    formFrequency: 'daily' as const,
    setFormFrequency: vi.fn(),
    formDispatchHour: 9,
    setFormDispatchHour: vi.fn(),
    formDispatchMinute: 0,
    setFormDispatchMinute: vi.fn(),
    formDispatchWeekday: 0,
    setFormDispatchWeekday: vi.fn(),
    formDispatchDay: 1,
    setFormDispatchDay: vi.fn(),
    formAiModel: '',
    setFormAiModel: vi.fn(),
    projects: [{ id: 3, name: '铨富 US' }],
    modelConfig: MODEL_CONFIG,
    isLoadingModelConfig: false,
    formError: null,
    testResult: null,
    formSubmitting: false,
    testingEmail: false,
    onTestEmail: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  render(<SubscriptionForm {...props} />)
  return props
}

describe('SubscriptionForm AI 模型区（BLF-1032）', () => {
  it('默认展开：零点击即可看到模型下拉并选中模型', async () => {
    const props = renderForm()

    // 未点任何折叠标题，模型下拉就应可见可交互
    const trigger = screen.getByRole('combobox', { name: '选择 AI 模型' })
    expect(trigger).toBeEnabled()

    const user = userEvent.setup()
    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: 'gpt-5-mini' }))
    expect(props.setFormAiModel).toHaveBeenCalledWith('gpt-5-mini')
  })

  it('模型清单按 高级 / 基础 分组呈现', async () => {
    renderForm()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: '选择 AI 模型' }))

    expect(await screen.findByRole('option', { name: 'gpt-5' })).toBeInTheDocument()
    expect(screen.getByText('高级模型')).toBeInTheDocument()
    expect(screen.getByText('基础模型')).toBeInTheDocument()
  })

  it('模型清单为空时下拉禁用并提示加载中占位', () => {
    renderForm({
      modelConfig: { ...MODEL_CONFIG, models: [] },
      isLoadingModelConfig: true,
    })
    expect(screen.getByRole('combobox', { name: '选择 AI 模型' })).toBeDisabled()
    expect(screen.getByText('加载模型中...')).toBeInTheDocument()
  })
})
