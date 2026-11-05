import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/dashboard/ad-data/top-filters', () => ({
  AdDataTopFilters: () => <div data-testid="ad-data-top-filters" />,
}))

import AdDataLayout from './layout'
import AdDataLoading from './loading'

describe('广告数据 Warm 页面壳', () => {
  it('layout 使用页面本地 Warm 容器并保留筛选宿主', () => {
    const { container } = render(
      <AdDataLayout>
        <div data-testid="page-content" />
      </AdDataLayout>
    )

    expect(container.querySelector('[data-warm-ad-data-layout="true"]')).toBeInTheDocument()
    expect(screen.getByTestId('ad-data-top-filters')).toBeInTheDocument()
    expect(screen.getByTestId('page-content')).toBeInTheDocument()
  })

  it('loading 使用 Warm 静态骨架且保持 aria-busy', () => {
    const { container } = render(<AdDataLoading />)

    const loading = container.querySelector('[data-warm-ad-data-loading="true"]')
    expect(loading).toHaveAttribute('aria-busy', 'true')
    expect(loading?.className).not.toMatch(/term-|rounded-none/)
  })
})
