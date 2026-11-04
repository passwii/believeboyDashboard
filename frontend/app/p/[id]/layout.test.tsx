import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import PublicPageLayout from './layout'

describe('PublicPageLayout', () => {
  it('keeps the public surface outside the dashboard shell while applying Warm Ledger tokens', () => {
    const { container } = render(
      <PublicPageLayout>
        <article>公开文档</article>
      </PublicPageLayout>
    )

    expect(container.firstElementChild).toHaveClass('warm-ledger')
    expect(screen.getByText('believeboy Dashboard')).toBeInTheDocument()
    expect(screen.getByText('公开页面')).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveTextContent('公开文档')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})
