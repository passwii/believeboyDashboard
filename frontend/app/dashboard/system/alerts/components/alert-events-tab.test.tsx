import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

const { acknowledgeEvent, fetchAlertEvents, resolveEvent } = vi.hoisted(() => ({
  acknowledgeEvent: vi.fn().mockResolvedValue(undefined),
  resolveEvent: vi.fn().mockResolvedValue(undefined),
  fetchAlertEvents: vi.fn().mockResolvedValue({
    items: [
      {
        id: 41,
        metric: 'sales_amount',
        message: '销售额低于窗口均值',
        deviation_pct: -23.4,
        severity: 'critical',
        status: 'active',
        triggered_at: '2026-11-04T08:00:00Z',
      },
    ],
    total: 1,
  }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/alerts-api', () => ({
  acknowledgeEvent,
  fetchAlertEvents,
  resolveEvent,
}))

import { AlertEventsTab } from './alert-events-tab'

describe('AlertEventsTab Warm Ledger', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('使用 Warm 表格并保留确认 / 解决写入', async () => {
    const user = userEvent.setup()
    const { container } = render(<AlertEventsTab />)

    expect(
      container.querySelector('[data-warm-alert-events="true"]')
    ).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()

    expect(await screen.findByText('销售额低于窗口均值')).toBeTruthy()
    expect(within(screen.getByRole('table')).getByText('活跃')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(acknowledgeEvent).toHaveBeenCalledWith(41))

    await user.click(screen.getByRole('button', { name: '解决' }))
    await waitFor(() => expect(resolveEvent).toHaveBeenCalledWith(41))
  })
})
