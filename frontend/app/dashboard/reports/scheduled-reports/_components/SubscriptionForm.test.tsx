import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import userEvent from '@testing-library/user-event'

import { SubscriptionForm } from './SubscriptionForm'
import type { AIModelConfig } from './types'

/**
 * 方案 A 订阅表单契约：
 * - 四段（接收 / 范围 / 调度 / 模型）不再折叠，打开即见；
 * - 邮箱可空提交，非空无效邮箱给内联错误并阻止提交；
 * - 国家 / 项目使用页面本地 warm chips + Popover，不再复用 V3 MultiSelect；
 * - AI 模型压平为 WarmSelect 选项，不保留旧分组标题。
 */

const MODEL_CONFIG: AIModelConfig = {
  providerConfigured: true,
  models: ['gpt-5', 'gpt-5-mini'],
  defaultModel: 'gpt-5',
  premiumModels: ['gpt-5'],
  basicModels: ['gpt-5-mini'],
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
})

function renderForm(
  overrides: Partial<Parameters<typeof SubscriptionForm>[0]> = {}
) {
  const props: Parameters<typeof SubscriptionForm>[0] = {
    mode: 'create',
    formEmail: 'ops@example.com',
    setFormEmail: vi.fn(),
    formProjectIds: '*',
    setFormProjectIds: vi.fn(),
    formSelectedProjectIds: [],
    setFormSelectedProjectIds: vi.fn(),
    formCountries: ['US'],
    setFormCountries: vi.fn(),
    formFrequency: 'daily',
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
    projects: [
      { id: 3, name: '铨富 US' },
      { id: 4, name: '铨富 UK' },
    ],
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

describe('SubscriptionForm Warm 表单结构', () => {
  it('使用 Warm Ledger 本地表单契约，四段默认可见且不折叠', () => {
    renderForm()

    expect(screen.getByTestId('subscription-form')).toHaveAttribute(
      'data-warm-ledger-form',
      'true'
    )
    expect(screen.getByTestId('subscription-form').className).not.toMatch(
      /term-|rounded-none/
    )
    for (const heading of ['接收', '范围', '调度', '模型']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    // 旧 Accordion 折叠触发器不应残留。
    expect(screen.queryByRole('button', { name: /基础设置/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /范围设置/ })).toBeNull()
  })

  it('正文标签 14px、辅助文案至少 12px（源码契约）', () => {
    const css = readFileSync(
      join(
        process.cwd(),
        'app/dashboard/reports/scheduled-reports/_components/subscription-dialog-warm.module.css'
      ),
      'utf8'
    )
    expect(css).toMatch(/\.label\s*\{[^}]*font-size:\s*var\(--warm-ledger-font-size-body\)/)
    expect(css).toMatch(/\.help\s*\{[^}]*font-size:\s*var\(--warm-ledger-font-size-control\)/)
    expect(css).toMatch(/\.footer\s*\{[^}]*height:\s*76px/)
    expect(css).toMatch(/\.formBody\s*\{[^}]*overflow-y:\s*auto/)
  })
})

describe('SubscriptionForm 邮箱与测试邮件', () => {
  it('邮箱输入与 label 绑定，空值不显示内联错误', () => {
    renderForm({ formEmail: '' })
    const input = screen.getByLabelText(/邮箱地址/)
    expect(input).toHaveAttribute('id', 'subscription-email')
    expect(input).toHaveAttribute('type', 'email')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('邮箱格式无效，请输入完整邮箱地址')).toBeNull()
  })

  it('无邮箱时提交仍可用，不阻止创建（后端允许 email=null）', async () => {
    const props = renderForm({ formEmail: '' })
    const submit = screen.getByRole('button', { name: '确认创建' })
    expect(submit).toBeEnabled()

    await userEvent.setup().click(submit)
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('非空无效邮箱显示内联错误并禁用提交', () => {
    renderForm({ formEmail: 'jrway123@gmail' })
    const input = screen.getByLabelText(/邮箱地址/)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText('邮箱格式无效，请输入完整邮箱地址')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
  })

  it('空邮箱时测试邮件按钮禁用并给出提示文案', () => {
    renderForm({ formEmail: '' })
    const testButton = screen.getByRole('button', { name: '发送测试邮件' })
    expect(testButton).toBeDisabled()
    expect(testButton).toHaveAttribute('title', '请先填写邮箱地址后再发送测试邮件')
    expect(screen.getByText('留空时只生成报告，不发送邮件。')).toBeInTheDocument()
  })

  it('测试邮件失败用 role=alert 暴露，成功用 status', () => {
    const { rerender } = render(
      <SubscriptionForm
        mode="create"
        formEmail="ops@example.com"
        setFormEmail={vi.fn()}
        formProjectIds="*"
        setFormProjectIds={vi.fn()}
        formSelectedProjectIds={[]}
        setFormSelectedProjectIds={vi.fn()}
        formCountries={['US']}
        setFormCountries={vi.fn()}
        formFrequency="daily"
        setFormFrequency={vi.fn()}
        formDispatchHour={9}
        setFormDispatchHour={vi.fn()}
        formDispatchMinute={0}
        setFormDispatchMinute={vi.fn()}
        formDispatchWeekday={0}
        setFormDispatchWeekday={vi.fn()}
        formDispatchDay={1}
        setFormDispatchDay={vi.fn()}
        formAiModel=""
        setFormAiModel={vi.fn()}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        formError={null}
        testResult={{ success: false, message: '请填写邮箱地址后再发送测试邮件' }}
        formSubmitting={false}
        testingEmail={false}
        onTestEmail={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('请填写邮箱地址后再发送测试邮件')

    rerender(
      <SubscriptionForm
        mode="create"
        formEmail="ops@example.com"
        setFormEmail={vi.fn()}
        formProjectIds="*"
        setFormProjectIds={vi.fn()}
        formSelectedProjectIds={[]}
        setFormSelectedProjectIds={vi.fn()}
        formCountries={['US']}
        setFormCountries={vi.fn()}
        formFrequency="daily"
        setFormFrequency={vi.fn()}
        formDispatchHour={9}
        setFormDispatchHour={vi.fn()}
        formDispatchMinute={0}
        setFormDispatchMinute={vi.fn()}
        formDispatchWeekday={0}
        setFormDispatchWeekday={vi.fn()}
        formDispatchDay={1}
        setFormDispatchDay={vi.fn()}
        formAiModel=""
        setFormAiModel={vi.fn()}
        projects={[]}
        modelConfig={MODEL_CONFIG}
        isLoadingModelConfig={false}
        formError={null}
        testResult={{ success: true, message: '测试报告已发送' }}
        formSubmitting={false}
        testingEmail={false}
        onTestEmail={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('测试报告已发送')
  })

  it('表单错误用 role=alert 暴露', () => {
    renderForm({ formError: '创建失败：邮箱格式无效，请输入完整邮箱地址' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      '创建失败：邮箱格式无效，请输入完整邮箱地址'
    )
  })
})

describe('SubscriptionForm 调度与模型', () => {
  it('频率用 Warm 分段控件切换并写入 setter', async () => {
    const props = renderForm()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '每周' }))
    expect(props.setFormFrequency).toHaveBeenCalledWith('weekly')
  })

  it('周频显示发送星期，月频显示发送日期', () => {
    renderForm({ formFrequency: 'weekly', formDispatchWeekday: 0 })
    expect(screen.getByRole('combobox', { name: '发送星期' })).toBeInTheDocument()

    cleanup()
    renderForm({ formFrequency: 'monthly', formDispatchDay: 2 })
    expect(screen.getByRole('combobox', { name: '发送日期' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '发送星期' })).toBeNull()
  })

  it('发送时间用两个 WarmSelect（小时/分钟），周一限制只列出 16:00 之后', async () => {
    const user = userEvent.setup()
    const props = renderForm({
      formFrequency: 'weekly',
      formDispatchWeekday: 0,
      formDispatchHour: 16,
      formDispatchMinute: 30,
    })

    await user.click(screen.getByRole('combobox', { name: '发送小时' }))
    expect(screen.getByRole('option', { name: '16' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '23' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '09' })).toBeNull()
    await user.click(screen.getByRole('option', { name: '17' }))
    expect(props.setFormDispatchHour).toHaveBeenCalledWith(17)

    await user.click(screen.getByRole('combobox', { name: '发送分钟' }))
    await user.click(await screen.findByRole('option', { name: '45' }))
    expect(props.setFormDispatchMinute).toHaveBeenCalledWith(45)
  })

  it('模型下拉压平 premium/basic 选项，零点击可见并可直接选择', async () => {
    const props = renderForm()
    const trigger = screen.getByRole('combobox', { name: 'AI 模型' })
    expect(trigger).toBeEnabled()

    const user = userEvent.setup()
    await user.click(trigger)
    expect(await screen.findByRole('option', { name: 'gpt-5' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'gpt-5-mini' })).toBeInTheDocument()
    expect(screen.queryByText('高级模型')).toBeNull()
    expect(screen.queryByText('基础模型')).toBeNull()
    await user.click(screen.getByRole('option', { name: 'gpt-5-mini' }))
    expect(props.setFormAiModel).toHaveBeenCalledWith('gpt-5-mini')
  })

  it('模型清单为空时下拉禁用并提示加载中占位', () => {
    renderForm({
      modelConfig: { ...MODEL_CONFIG, models: [] },
      isLoadingModelConfig: true,
    })
    expect(screen.getByRole('combobox', { name: 'AI 模型' })).toBeDisabled()
    expect(screen.getByText('加载模型中...')).toBeInTheDocument()
  })
})

describe('SubscriptionForm 范围校验（指定项目 / 国家）', () => {
  it('指定项目但未选项目时显示内联错误并禁用提交', () => {
    renderForm({ formProjectIds: '', formSelectedProjectIds: [] })
    expect(screen.getByText('请至少选择 1 个项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('1 项待修正')
  })

  it('国家为空时显示内联错误并禁用提交', () => {
    renderForm({ formCountries: [] })
    expect(screen.getByText('请至少保留 1 个站点')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
  })
})

describe('SubscriptionForm 国家 / 项目 warm chips', () => {
  it('国家站点以 chips 展示；单站点不可移除，添加按钮打开 Warm Popover', async () => {
    const root = installPortalRoot()
    const props = renderForm({ formCountries: ['US'] })

    expect(screen.getByText('美国站')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移除美国站' })).toBeDisabled()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加站点' }))
    expect(root.contains(screen.getByRole('listbox', { name: '选择国家站点' }))).toBe(true)
    await user.click(await screen.findByRole('option', { name: /德国站/ }))
    expect(props.setFormCountries).toHaveBeenCalledWith(['US', 'DE'])
  })

  it('项目范围分段切换，指定项目用 chips + 添加项目 Popover，不复用 V3 MultiSelect', async () => {
    const root = installPortalRoot()
    const props = renderForm({
      formProjectIds: '3',
      formSelectedProjectIds: ['3'],
    })

    expect(screen.getByText('铨富 US')).toBeInTheDocument()
    expect(screen.queryByTestId('project-scope')).toBeNull()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    expect(root.contains(screen.getByRole('listbox', { name: '选择项目' }))).toBe(true)
    await user.click(await screen.findByRole('option', { name: '铨富 UK' }))
    expect(props.setFormProjectIds).toHaveBeenCalledWith('3,4')
    expect(props.setFormSelectedProjectIds).toHaveBeenCalledWith(['3', '4'])

    await user.click(screen.getByRole('button', { name: '全部项目' }))
    expect(props.setFormProjectIds).toHaveBeenCalledWith('*')
    expect(props.setFormSelectedProjectIds).toHaveBeenCalledWith([])
  })

  it('项目列表为空时 Popover 给出可读空态，不渲染假选项', async () => {
    installPortalRoot()
    renderForm({
      formProjectIds: '3',
      formSelectedProjectIds: ['3'],
      projects: [],
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    expect(await screen.findByText('暂无可选项目')).toBeInTheDocument()
  })
})
