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
    email_sent: true,
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

function renderGroup(items: LedgerItem[], canTriggerResend = true) {
  const onRegenerateSummary = vi.fn()
  const onToggle = vi.fn()
  render(
    <table>
      <LedgerDayGroup
        date={items[0]?.expected_date ?? '2026-08-24'}
        items={items}
        expanded
        onToggle={onToggle}
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
    </table>
  )
  return { onRegenerateSummary, onToggle }
}

describe('LedgerDayGroup 行内 AI 摘要快捷操作（BLF-822）', () => {
  it('pending 记录显示「生成摘要」按钮，点击回调', () => {
    const item = makeItem()
    const { onRegenerateSummary } = renderGroup([item])

    fireEvent.click(screen.getByTestId('row-generate-summary'))
    expect(screen.getByText('生成摘要')).toBeInTheDocument()
    expect(onRegenerateSummary).toHaveBeenCalledWith(item)
  })

  it('failed 记录在 AI 摘要列显示「重新生成摘要」重试按钮', () => {
    renderGroup([makeItem({ ai_summary_status: 'failed' })])

    expect(screen.getByText('重新生成摘要')).toBeInTheDocument()
    expect(screen.getByTestId('row-generate-summary')).toBeInTheDocument()
  })

  it('generating 显示「处理中」而非生成按钮', () => {
    const { onRegenerateSummary } = renderGroup([makeItem({ ai_summary_status: 'generating' })])

    expect(screen.getByText('处理中')).toBeInTheDocument()
    expect(screen.queryByText('生成中')).toBeNull()
    expect(screen.queryByTestId('row-generate-summary')).toBeNull()
    expect(onRegenerateSummary).not.toHaveBeenCalled()
  })

  it('非管理员不显示快捷按钮', () => {
    renderGroup([makeItem()], false)

    expect(screen.queryByTestId('row-generate-summary')).toBeNull()
  })

  it('非 sent 状态（missing）即使 pending 也不显示快捷按钮', () => {
    renderGroup([makeItem({ status: 'missing' })])

    expect(screen.queryByTestId('row-generate-summary')).toBeNull()
  })
})

describe('LedgerDayGroup 无邮箱语义（含历史数据边界）', () => {
  it('sent 且无邮箱（即使历史 email_sent=true）显示「仅生成，不发送」与「仅生成」', () => {
    renderGroup([makeItem({ email: null, status: 'sent', email_sent: true })])

    expect(screen.getByText('仅生成，不发送')).toBeInTheDocument()
    expect(screen.getByText('仅生成')).toBeInTheDocument()
    expect(screen.queryByText('已发送')).toBeNull()
  })

  it('有邮箱但 email_sent=false（手动重新生成）也显示「仅生成」', () => {
    renderGroup([makeItem({ email: 'ops@example.com', status: 'sent', email_sent: false })])

    expect(screen.getByText('ops@example.com')).toBeInTheDocument()
    expect(screen.getByText('仅生成')).toBeInTheDocument()
    expect(screen.queryByText('已发送')).toBeNull()
  })

  it('有邮箱且 email_sent=true 才显示「已发送」', () => {
    renderGroup([makeItem({ email: 'ops@example.com', status: 'sent', email_sent: true })])

    expect(screen.getByText('已发送')).toBeInTheDocument()
    expect(screen.queryByText('仅生成')).toBeNull()
  })

  it('missing 且无邮箱仍渲染重新生成入口', () => {
    renderGroup([makeItem({ email: null, status: 'missing', can_resend: true })])

    expect(screen.getByText('仅生成，不发送')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '补发stub' })).toBeInTheDocument()
  })

  it('can_resend=true 但当前用户无管理员权限时不显示重新生成入口', () => {
    renderGroup([makeItem({ can_resend: true })], false)

    expect(screen.queryByRole('button', { name: '补发stub' })).toBeNull()
  })
})

describe('LedgerDayGroup 北京时间展示', () => {
  it('expected_at 按 Asia/Shanghai 显示：TZ=UTC 下 +08:00 15:10 仍显示 15:10', () => {
    vi.stubEnv('TZ', 'UTC')
    try {
      renderGroup([
        makeItem({
          expected_date: '2026-11-13',
          expected_at: '2026-11-13T15:10:00+08:00',
        }),
      ])

      const timeCell = screen.getByText('15:10')
      expect(timeCell).toBeInTheDocument()
      expect(timeCell).toHaveAttribute('title', '15:10:00')
      expect(screen.queryByText('07:10')).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('LedgerDayGroup 日组头与当天计数', () => {
  it('展示日期、星期与「已完成 / 失败 / 缺失」真实计数', () => {
    renderGroup([
      makeItem({ ledger_key: 'a', status: 'sent', email_sent: true }),
      makeItem({ ledger_key: 'b', status: 'sent', email_sent: false }),
      makeItem({ ledger_key: 'c', status: 'failed', email: null }),
      makeItem({ ledger_key: 'd', status: 'missing' }),
    ])

    expect(screen.getByText('2026-08-24')).toBeInTheDocument()
    expect(screen.getByText('周一')).toBeInTheDocument()
    expect(screen.getByText('4 条')).toBeInTheDocument()
    expect(screen.getByText('已完成 2')).toBeInTheDocument()
    expect(screen.getByText('失败 1')).toBeInTheDocument()
    expect(screen.getByText('缺失 1')).toBeInTheDocument()
  })

  it('日组头可折叠，保留 aria-expanded 与 toggle 回调', () => {
    const { onToggle } = renderGroup([makeItem()])

    const head = screen.getByRole('button', { name: /2026-08-24/ })
    expect(head).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(head)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('项目列展示项目名与站点副标题，截图列在有 URL 时渲染缩略图', () => {
    renderGroup([
      makeItem({
        project_names: ['believeboy', 'car&smo-卡斯摩', '第三个项目'],
        country: 'US,DE',
        screenshot_r2_url: 'https://example.com/shot.png',
      }),
    ])

    expect(screen.getByText('believeboy · car&smo-卡斯摩 +1')).toBeInTheDocument()
    expect(screen.getByText('美国站 · 德国站')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '报告截图缩略图' })).toBeInTheDocument()
  })
})
