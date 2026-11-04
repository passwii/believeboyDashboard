import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import ProductAnalysisPage from './page'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '店铺A' }]),
}))

vi.mock('./components/manual-calculation-panel', () => ({
  default: () => <div data-testid="manual-panel">manual</div>,
}))
vi.mock('./components/monthly-sku-analysis-panel', () => ({
  default: () => <div data-testid="monthly-sku-panel">monthly</div>,
}))
vi.mock('./components/product-analysis-panel', () => ({
  default: () => <div data-testid="product-analysis-panel">panel</div>,
}))

describe('产品分析页 Warm Ledger 外壳', () => {
  it('页面不再渲染 PageHeader 胶囊（标题由面包屑承载）', () => {
    const { container } = render(<ProductAnalysisPage />)

    expect(container.querySelector('.text-2xl')).toBeNull()
    expect(screen.getByText('产品分析核算')).toBeInTheDocument()
  })

  it('三个 Tab 使用 Warm 本地样式并保留可访问的选中态', async () => {
    const user = userEvent.setup()
    const { container } = render(<ProductAnalysisPage />)
    const page = container.firstElementChild
    const tabList = screen.getByRole('tablist')

    for (const label of ['产品分析核算', '手动核算', '月度 SKU 分析']) {
      const trigger = screen.getByRole('tab', { name: label })
      expect(trigger.className).not.toContain('rounded-none')
      expect(trigger.className).not.toContain('text-term-muted')
    }

    expect(page).toHaveAttribute('data-warm-product-analysis', 'true')
    expect(tabList).toHaveAttribute('data-warm-tablist', 'true')

    await user.click(screen.getByRole('tab', { name: '手动核算' }))
    expect(screen.getByRole('tab', { name: '手动核算' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('manual-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('product-analysis-panel')).toBeNull()

    await user.click(screen.getByRole('tab', { name: '月度 SKU 分析' }))
    expect(screen.getByRole('tab', { name: '月度 SKU 分析' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('monthly-sku-panel')).toBeInTheDocument()
  })

  it('默认渲染产品分析核算面板（懒加载其余面板）', () => {
    render(<ProductAnalysisPage />)

    expect(screen.getByTestId('product-analysis-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('manual-panel')).toBeNull()
  })
})
