import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { LedgerSummaryCards } from './LedgerSummaryCards'

describe('LedgerSummaryCards 语义', () => {
  it('sent 用「已完成」而不是「已发送」，避免把仅生成的行说成发了邮件', () => {
    render(
      <LedgerSummaryCards
        summary={{ expected: 10, sent: 8, failed: 1, missing: 1, resendable: 2 }}
      />
    )

    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText('可重新生成')).toBeInTheDocument()
    expect(screen.queryByText('成功')).toBeNull()
    expect(screen.queryByText('可补发')).toBeNull()
  })

  it('渲染后端 summary 的 5 个数字，并标注「已完成含仅生成」', () => {
    render(
      <LedgerSummaryCards
        summary={{ expected: 10, sent: 8, failed: 1, missing: 1, resendable: 2 }}
      />
    )

    const summary = screen.getByLabelText('当前筛选汇总')
    for (const label of ['应发', '已完成', '失败', '缺失', '可重新生成']) {
      expect(within(summary).getByText(label)).toBeInTheDocument()
    }
    expect(within(summary).getByText('10')).toBeInTheDocument()
    expect(within(summary).getByText('8')).toBeInTheDocument()
    expect(within(summary).getByText('2')).toBeInTheDocument()
    expect(screen.getByText('已完成含「仅生成」')).toBeInTheDocument()
  })

  it('无 summary 且非 loading 时不渲染，避免伪造 0 统计', () => {
    render(<LedgerSummaryCards summary={null} />)

    expect(screen.queryByLabelText('当前筛选汇总')).toBeNull()
  })

  it('首次加载时显示占位而不是捏造统计', () => {
    render(<LedgerSummaryCards summary={null} loading />)

    const summary = screen.getByLabelText('当前筛选汇总')
    expect(summary).toHaveAttribute('aria-busy', 'true')
    expect(within(summary).getAllByText('—').length).toBe(5)
  })
})
