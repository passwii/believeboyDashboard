import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// BLF-822：台账行内 AI 摘要快捷操作——管理员 + sent + pending/failed 才出现。

vi.mock('./LedgerResendCell', () => ({
  LedgerResendCell: () => <button type="button">补发stub</button>,
}))

import { LedgerDayGroup } from './LedgerDayGroup'
import type { LedgerItem } from './types'

function makeItem(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: 11,
    ledger_key: 'lk-1',
    expected_date: '2026-08-24',
    expected_at: '2026-08-24T15:00:00+08:00',
    frequency: 'weekly',
    subscription_id: 7,
    email: 'ops@example.com',
    project_ids: '1,2',
    project_names: ['项目A'],
    country: 'US',
    status: 'sent',
    latest_delivery_log_id: 99,
    error_message: null,
    sent_at: null,
    can_resend: false,
    last_checked_at: null,
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: null,
    ai_summary_status: 'pending',
    ai_summary_error: null,
    ai_summary_model: null,
    ai_summary_updated_at: null,
    ...overrides,
  }
}

function renderGroup(item: LedgerItem, canTriggerResend = true) {
  const onRegenerateSummary = vi.fn()
  render(
    <LedgerDayGroup
      date={item.expected_date}
      items={[item]}
      expanded
      onToggle={vi.fn()}
      isAnchor={false}
      isToday={false}
      subscriptions={[]}
      modelConfig={null}
      isLoadingModelConfig={false}
      onRequestModelConfig={vi.fn()}
      resendingStates={{}}
      regeneratingSummaryKeys={new Set()}
      onRegenerateSummary={onRegenerateSummary}
      onRowClick={vi.fn()}
      onResend={vi.fn()}
      onResendLoading={vi.fn()}
      canTriggerResend={canTriggerResend}
    />
  )
  return { onRegenerateSummary }
}

describe('LedgerDayGroup 行内 AI 摘要快捷操作（BLF-822）', () => {
  it('pending 记录显示「生成摘要」按钮，点击回调', () => {
    const item = makeItem()
    const { onRegenerateSummary } = renderGroup(item)

    fireEvent.click(screen.getByTestId('row-generate-summary'))
    expect(screen.getByText('生成摘要')).toBeInTheDocument()
    expect(onRegenerateSummary).toHaveBeenCalledWith(item)
  })

  it('failed 记录显示「重新生成」重试按钮', () => {
    const item = makeItem({ ai_summary_status: 'failed' })
    renderGroup(item)

    expect(screen.getByText('重新生成')).toBeInTheDocument()
  })

  it('generating 显示「生成中」loading 而非按钮', () => {
    const item = makeItem({ ai_summary_status: 'generating' })
    const { onRegenerateSummary } = renderGroup(item)

    expect(screen.getByText('生成中')).toBeInTheDocument()
    expect(screen.queryByTestId('row-generate-summary')).toBeNull()
    expect(onRegenerateSummary).not.toHaveBeenCalled()
  })

  it('非管理员不显示快捷按钮', () => {
    renderGroup(makeItem(), false)

    expect(screen.queryByTestId('row-generate-summary')).toBeNull()
  })

  it('非 sent 状态（missing）即使 pending 也不显示快捷按钮', () => {
    renderGroup(makeItem({ status: 'missing' }))

    expect(screen.queryByTestId('row-generate-summary')).toBeNull()
  })
})
