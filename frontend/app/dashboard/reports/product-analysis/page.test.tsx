import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProductAnalysisPage from './page'

// BLF-836：产品分析页终端化渲染契约。

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

function mountWithTabs(ui: ReactNode) {
  // page.tsx 用受控 Tabs，默认激活 product-analysis
  return render(<ProductAnalysisPage />)
}

describe('产品分析页终端化（BLF-836）', () => {
  it('页面不再渲染 PageHeader 胶囊（标题由面包屑承载）', () => {
    const { container } = render(<ProductAnalysisPage />)

    expect(container.querySelector('.text-2xl')).toBeNull()
    expect(screen.getByText('产品分析核算')).toBeInTheDocument()
  })

  it('三个 Tab 触发器使用终端规格（零圆角 + term 色系）', () => {
    render(<ProductAnalysisPage />)

    for (const label of ['产品分析核算', '手动核算', '月度 SKU 分析']) {
      const trigger = screen.getByRole('tab', { name: label })
      expect(trigger.className).toContain('rounded-none')
      expect(trigger.className).toContain('text-term-muted')
    }
  })

  it('默认渲染产品分析核算面板（懒加载其余面板）', () => {
    render(<ProductAnalysisPage />)

    expect(screen.getByTestId('product-analysis-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('manual-panel')).toBeNull()
  })
})
