import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { LedgerResendCell } from './LedgerResendCell'
import type { LedgerItem } from './types'

function makeItem(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: 11,
    ledger_key: 'lk-1',
    expected_date: '2026-11-18',
    expected_at: '2026-11-18T15:10:00+08:00',
    frequency: 'daily',
    subscription_id: 7,
    email: null,
    project_ids: '*',
    project_names: ['全部项目'],
    country: 'US',
    status: 'missing',
    latest_delivery_log_id: null,
    error_message: null,
    sent_at: null,
    email_sent: false,
    can_resend: true,
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

function renderCell(
  item: LedgerItem,
  overrides: Partial<Parameters<typeof LedgerResendCell>[0]> = {}
) {
  const onSubmit = vi.fn()
  const onLoading = vi.fn()
  render(
    <LedgerResendCell
      item={item}
      resendingStage={undefined}
      canResend
      modelConfig={null}
      isLoadingModelConfig={false}
      fallbackModel="gpt-5"
      onSubmit={onSubmit}
      onLoading={onLoading}
      {...overrides}
    />
  )
    return { onSubmit, onLoading }
}

describe('LedgerResendCell 无邮箱契约', () => {
  it('email=null 的行仍显示可点击「重新生成」，不被邮箱条件禁用', () => {
    renderCell(makeItem({ email: null }))

    const trigger = screen.getByRole('button', { name: '重新生成' })
    expect(trigger).toBeEnabled()
  })

  it('说明文案统一为不发送邮件，不含「发送到订阅邮箱」', () => {
    renderCell(makeItem({ email: null }))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))

    expect(
      screen.getByText(/重新生成报告（数据 \/ 截图 \/ AI 摘要），不会发送邮件。/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/发送到订阅邮箱/)).toBeNull()
  })

  it('email=null 的行可确认提交重新生成', () => {
    const { onSubmit, onLoading } = renderCell(makeItem({ email: null }))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重新生成' }))

    expect(onLoading).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('gpt-5')
  })

  it('有邮箱的行文案同样是「不会发送邮件」', () => {
    renderCell(makeItem({ email: 'ops@example.com' }))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))

    expect(screen.getByText(/不会发送邮件/)).toBeInTheDocument()
    expect(screen.queryByText(/发送到订阅邮箱/)).toBeNull()
  })

  it('failed 行入口为「重试生成」，仍不发邮件', () => {
    renderCell(makeItem({ status: 'failed', email: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试生成' }))

    expect(screen.getByText(/不会发送邮件/)).toBeInTheDocument()
  })

  it('轮询进行中显示可读阶段文案而不是按钮', () => {
    renderCell(makeItem({ email: null }), { resendingStage: 'preparing' })

    expect(screen.getByRole('status')).toHaveTextContent('准备中')
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
  })

  it('阶段文案不出现「发送邮件」，与「不会发送邮件」保持一致', () => {
    renderCell(makeItem({ email: null }), { resendingStage: 'sending' })

    expect(screen.getByRole('status')).toHaveTextContent('完成处理')
    expect(screen.getByRole('status')).not.toHaveTextContent('发送邮件')
  })
})
