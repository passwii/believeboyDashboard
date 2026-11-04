import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

const RULE = {
  id: 7,
  name: 'US 销售额骤降',
  project_id: 1,
  country: 'US',
  metric: 'sales_amount',
  trigger_type: 'threshold',
  condition: 'drop_pct',
  threshold: 20,
  window_days: 7,
  severity: 'warning',
  notification_channels: 'in_app',
  is_active: true,
}

const {
  createAlertRule,
  deleteAlertRule,
  fetchAlertRules,
  fetchMetricOptions,
  updateAlertRule,
} = vi.hoisted(() => ({
  createAlertRule: vi.fn().mockResolvedValue(undefined),
  deleteAlertRule: vi.fn().mockResolvedValue(undefined),
  updateAlertRule: vi.fn().mockResolvedValue(undefined),
  fetchAlertRules: vi.fn().mockResolvedValue([
    {
      id: 7,
      name: 'US 销售额骤降',
      project_id: 1,
      country: 'US',
      metric: 'sales_amount',
      trigger_type: 'threshold',
      condition: 'drop_pct',
      threshold: 20,
      window_days: 7,
      severity: 'warning',
      notification_channels: 'in_app',
      is_active: true,
    },
  ]),
  fetchMetricOptions: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/alerts-api', () => ({
  createAlertRule,
  deleteAlertRule,
  fetchAlertRules,
  fetchMetricOptions,
  updateAlertRule,
}))

import { AlertRulesTab } from './alert-rules-tab'

describe('AlertRulesTab Warm Ledger', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('使用 Warm 表格，并保留新建 / 启停 / 删除行为', async () => {
    const user = userEvent.setup()
    const { container } = render(<AlertRulesTab projects={[{ id: 1, name: '测试项目' }]} />)

    expect(
      container.querySelector('[data-warm-alert-rules="true"]')
    ).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
    expect(await screen.findByText('US 销售额骤降')).toBeTruthy()

    await user.click(screen.getByRole('switch'))
    await waitFor(() =>
      expect(updateAlertRule).toHaveBeenCalledWith(7, { is_active: false })
    )

    await user.click(screen.getByRole('button', { name: '新建规则' }))
    const createDialog = await screen.findByRole('dialog')
    expect(createDialog.querySelectorAll('[class*="term-"]')).toHaveLength(0)
    expect(createDialog.querySelectorAll('.rounded-none')).toHaveLength(0)
    await user.type(
      within(createDialog).getByPlaceholderText('如：US 销售额骤降'),
      '新规则'
    )
    await user.click(within(createDialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(createAlertRule).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 1 })
      )
    )

    await user.click(screen.getByRole('button', { name: '编辑' }))
    const editDialog = await screen.findByRole('dialog')
    const nameInput = within(editDialog).getByLabelText('名称')
    await user.clear(nameInput)
    await user.type(nameInput, '改后规则')
    await user.click(within(editDialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(updateAlertRule).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ name: '改后规则' })
      )
    )

    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(window.confirm).toHaveBeenCalledWith('确认删除规则「US 销售额骤降」？')
    await waitFor(() => expect(deleteAlertRule).toHaveBeenCalledWith(RULE.id))
  })
})
