import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import FinanceLoading from './loading'

afterEach(cleanup)

describe('FinanceLoading Warm Ledger 状态', () => {
  it('渲染 finance 本地 Warm loading 标记与可访问状态', () => {
    const { container } = render(<FinanceLoading />)

    expect(container.querySelector('[data-warm-finance-loading="true"]')).toBeInTheDocument()
    expect(
      container.querySelector('[data-warm-finance-loading-panel="true"]')
    ).toBeInTheDocument()
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在加载财务数据')
    expect(screen.queryByTestId('page-skeleton-table')).not.toBeInTheDocument()
  })
})
