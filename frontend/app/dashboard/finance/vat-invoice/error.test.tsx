import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import VatInvoiceError from './error'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VAT invoice error page', () => {
  it('keeps compact layout and connects retry to the route reset action', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reset = vi.fn()
    const { container } = render(
      <VatInvoiceError error={new Error('invoice route failed')} reset={reset} />
    )

    expect(screen.getByRole('heading', { name: 'VAT 发票生成器暂不可用' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/dashboard')
    const retry = screen.getByRole('button', { name: '重新加载' })
    expect(retry).toHaveClass('warm-ledger__button--secondary')
    expect(container.querySelector('[data-status-kind="error"]')).toHaveClass('warm-ledger')
    expect(screen.getByRole('alert')).toHaveTextContent('VAT 发票生成器暂不可用')

    fireEvent.click(retry)
    expect(reset).toHaveBeenCalledOnce()
  })
})
