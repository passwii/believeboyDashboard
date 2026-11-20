import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AppErrorPage from './error'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('app error page', () => {
  it('offers home and retry actions, with retry calling reset', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reset = vi.fn()
    const { container } = render(
      <AppErrorPage error={new Error('render failed')} reset={reset} />
    )

    expect(screen.getByRole('heading', { name: '页面暂时不可用' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveClass(
      'warm-ledger__button--primary'
    )
    const retry = screen.getByRole('button', { name: '重新加载' })
    expect(retry).toHaveClass('warm-ledger__button--secondary')
    expect(container.querySelector('[data-status-kind="error"]')).toHaveClass('warm-ledger')
    expect(screen.getByRole('alert')).toHaveTextContent('页面暂时不可用')

    fireEvent.click(retry)
    expect(reset).toHaveBeenCalledOnce()
  })
})
