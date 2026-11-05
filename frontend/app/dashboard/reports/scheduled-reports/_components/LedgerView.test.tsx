import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ data: null, status: 'unauthenticated' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('./api', () => ({
  fetchLedger: vi.fn(
    async (
      _params: unknown,
      onData: (items: never[], summary: null, total: number) => void
    ) => {
      onData([], null, 0)
    }
  ),
  fetchLedgerItemByKey: vi.fn(async () => null),
  fetchModelConfig: vi.fn(),
  fetchSubscriptions: vi.fn(),
  pollDeliveryLogStatus: vi.fn(),
  pollLedgerAiSummaryStatus: vi.fn(),
  regenerateLedgerAiSummary: vi.fn(),
  resendLedgerEntry: vi.fn(),
}))

import LedgerView from './LedgerView'

describe('LedgerView Warm 文案字体', () => {
  it('空状态文案使用 sans，不把普通说明渲染为 mono', async () => {
    render(<LedgerView />)

    const emptyLabels = await screen.findAllByText('暂无台账记录')
    expect(emptyLabels.length).toBeGreaterThan(0)
    for (const label of emptyLabels) {
      expect(label).toHaveClass('font-sans')
      expect(label).not.toHaveClass('font-mono')
    }
  })
})
