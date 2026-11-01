import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DailyLedgerTable } from './daily-ledger-table'

const rows = [
  {
    date: '2026-11-01',
    sales_amount: 1234.5,
    order_qty: 1234,
    ad_spend: 56.78,
    pending_order_qty: 3,
  },
]

describe('DailyLedgerTable', () => {
  it('labels pending as a daily snapshot and keeps the table in a horizontal scroll container', () => {
    const { container } = render(<DailyLedgerTable rows={rows} />)

    expect(screen.getByRole('columnheader', { name: '待处理（日快照）' })).toBeInTheDocument()
    expect(container.querySelector('[data-table-scroll]')).toHaveClass('overflow-x-auto')
  })

  it('formats date, money, orders, and daily pending values', () => {
    render(<DailyLedgerTable rows={rows} />)

    const table = screen.getByRole('table', { name: '日明细' })
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('Nov 1')
    expect(cells[1]).toHaveTextContent('$1,234.50')
    expect(cells[2]).toHaveTextContent('1,234')
    expect(cells[3]).toHaveTextContent('$56.78')
    expect(cells[4]).toHaveTextContent('3')
  })

  it('renders loading, empty, and error states', () => {
    const { container, rerender } = render(<DailyLedgerTable rows={[]} loading />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载日明细')
    expect(container.querySelector('table')).toHaveAttribute('aria-hidden', 'true')

    rerender(<DailyLedgerTable rows={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent('暂无日明细')

    rerender(<DailyLedgerTable rows={[]} error="服务暂不可用" />)
    expect(screen.getByRole('alert')).toHaveTextContent('日明细加载失败')
    expect(screen.getByRole('alert')).toHaveTextContent('服务暂不可用')
  })
})
