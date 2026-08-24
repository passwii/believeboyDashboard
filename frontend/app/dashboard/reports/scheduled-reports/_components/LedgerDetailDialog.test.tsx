import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'

// BLF-822：AI 摘要手动生成状态机——pending=待手动生成（按钮）、
// generating=生成中（loading+轮询）、failed=可重试、done=可重新生成。

const fetchLedgerItemByKeyMock = vi.fn()

vi.mock('./api', () => ({
  fetchLedgerItemByKey: (...args: unknown[]) => fetchLedgerItemByKeyMock(...args),
}))

vi.mock('next/image', () => ({
  default: function ImageMock() {
    return <span data-testid="next-image-stub" />
  },
}))

vi.mock('react-markdown', () => ({
  default: function ReactMarkdownMock({ children }: { children?: ReactNode }) {
    return <div>{children}</div>
  },
}))

vi.mock('remark-breaks', () => ({ default: () => [] }))

vi.mock('@/components/ui/image-preview-dialog', () => ({
  PortraitScreenshotDialog: () => null,
}))

vi.mock('./LedgerResendCell', () => ({
  LedgerResendCell: () => <button type="button">补发stub</button>,
}))

import { LedgerDetailDialog } from './LedgerDetailDialog'
import type { AiSummaryStatus, LedgerItem, Subscription } from './types'

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
    sent_at: '2026-08-24T15:05:00+08:00',
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

const subscriptions: Subscription[] = [
  {
    id: 7,
    user_id: 1,
    email: 'ops@example.com',
    project_ids: '1,2',
    country: 'US',
    frequency: 'weekly',
    dispatch_hour: 15,
    dispatch_minute: 0,
    dispatch_weekday: 0,
    dispatch_day: 2,
    ai_model: 'sub-preset-model',
    enabled: true,
    created_at: '',
    updated_at: '',
  },
]

function renderDialog(opts: {
  item: LedgerItem
  canTriggerResend?: boolean
  regeneratingAiSummary?: boolean
  onRegenerateAiSummary?: ReturnType<typeof vi.fn>
}) {
  const onRegenerateAiSummary =
    opts.onRegenerateAiSummary ?? vi.fn()
  render(
    <LedgerDetailDialog
      open
      onOpenChange={vi.fn()}
      item={opts.item}
      subscriptions={subscriptions}
      modelConfig={null}
      isLoadingModelConfig={false}
      resendingStage={undefined}
      regeneratingAiSummary={opts.regeneratingAiSummary ?? false}
      canTriggerResend={opts.canTriggerResend ?? true}
      onResend={vi.fn()}
      onResendLoading={vi.fn()}
      onRegenerateAiSummary={onRegenerateAiSummary}
      onCopy={vi.fn()}
    />
  )
  return { onRegenerateAiSummary }
}

beforeEach(() => {
  fetchLedgerItemByKeyMock.mockReset()
  fetchLedgerItemByKeyMock.mockResolvedValue(null)
})

describe('LedgerDetailDialog AI 摘要状态机（BLF-822）', () => {
  it('pending 记录显示「生成 AI 摘要」按钮，点击回调 regenerate（带订阅预设模型）', async () => {
    const item = makeItem()
    const { onRegenerateAiSummary } = renderDialog({ item })

    const buttons = screen.getAllByRole('button', { name: '生成 AI 摘要' })
    expect(buttons.length).toBeGreaterThanOrEqual(1)

    fireEvent.click(screen.getByTestId('generate-summary-cta'))
    expect(onRegenerateAiSummary).toHaveBeenCalledWith(item, 'sub-preset-model')
  })

  it('pending 不启动轮询（不会自行变化，轮询只会白等）', async () => {
    vi.useFakeTimers()
    try {
      renderDialog({ item: makeItem() })
      await vi.advanceTimersByTimeAsync(6000)
      expect(fetchLedgerItemByKeyMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('generating 显示「AI 摘要生成中」并提供卡死救援入口，且启动轮询刷新', async () => {
    vi.useFakeTimers()
    try {
      renderDialog({ item: makeItem({ ai_summary_status: 'generating' as AiSummaryStatus }) })

      expect(screen.getByText('AI 摘要生成中')).toBeInTheDocument()
      expect(screen.queryByTestId('generate-summary-cta')).toBeNull()
      expect(screen.getAllByRole('button', { name: '打断并重新生成' }).length).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(2600)
      expect(fetchLedgerItemByKeyMock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('failed 显示错误信息与「重新生成」重试按钮，点击回调 regenerate', () => {
    const item = makeItem({
      ai_summary_status: 'failed' as AiSummaryStatus,
      ai_summary_error: '模型超时',
    })
    const { onRegenerateAiSummary } = renderDialog({ item })

    expect(screen.getByText('模型超时')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('regenerate-summary-retry'))
    expect(onRegenerateAiSummary).toHaveBeenCalledWith(item, 'sub-preset-model')
  })

  it('done 渲染摘要内容，入口文案为「重新生成摘要」', () => {
    renderDialog({
      item: makeItem({ ai_summary_status: 'done' as AiSummaryStatus, ai_summary: '销售概要正文' }),
    })

    expect(screen.getByText('销售概要正文')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '重新生成摘要' }).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('generate-summary-cta')).toBeNull()
  })

  it('非管理员 pending 只显示提示，不显示生成按钮', () => {
    renderDialog({ item: makeItem(), canTriggerResend: false })

    expect(screen.queryByRole('button', { name: '生成 AI 摘要' })).toBeNull()
    expect(screen.queryByTestId('generate-summary-cta')).toBeNull()
    expect(screen.getByText('AI 摘要尚未生成')).toBeInTheDocument()
  })

  it('非 sent 状态（missing）不提供生成入口', () => {
    renderDialog({
      item: makeItem({ status: 'missing' }),
    })

    expect(screen.queryByTestId('generate-summary-cta')).toBeNull()
    // missing + pending：无摘要也不该出现任何生成入口
    expect(screen.queryAllByRole('button', { name: /生成/ }).length).toBe(0)
  })
})

afterEach(() => {
  cleanup()
})
