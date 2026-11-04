import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { SESSION, NOTIFY } = vi.hoisted(() => ({
  SESSION: { user: { id: 'u1', roleType: 'admin', isAdmin: true, full_name: '测试' } },
  NOTIFY: { notify: vi.fn() },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: SESSION, status: 'authenticated' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import ResearchAnalysisPage, {
  EmptyChartState,
  RESEARCH_WARM_PALETTE,
} from './page'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ResearchAnalysisPage Warm Ledger 契约', () => {
  it('使用 Warm Ledger 页面壳且不混用 Terminal 表面', () => {
    const { container } = render(<ResearchAnalysisPage />)

    const page = screen.getByTestId('research-analysis-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('空图表按传入高度保留统一几何', () => {
    render(<EmptyChartState message="暂无数据" height={360} />)

    const empty = screen.getByText('暂无数据')
    expect(empty).toHaveAttribute('data-height', '360')
    expect(empty).toHaveStyle({ '--empty-chart-height': '360px' })
  })

  it('使用 route-local Warm 图表色板，不依赖全局 chart token', () => {
    expect(Object.values(RESEARCH_WARM_PALETTE).length).toBeGreaterThan(0)
    for (const color of Object.values(RESEARCH_WARM_PALETTE)) {
      expect(color).toMatch(/^var\(--research-chart-/)
      expect(color).not.toContain('--chart-')
    }
  })

  it('关键词和版本列表为空时显示明确占位项', async () => {
    const user = userEvent.setup()
    render(<ResearchAnalysisPage />)

    await user.click(screen.getByRole('tab', { name: '分析' }))

    const keywordSelect = await screen.findByRole('combobox', {
      name: '选择已有调研关键词',
    })
    expect(
      within(keywordSelect).getByRole('option', { name: '选择已有调研关键词' })
    ).toBeInTheDocument()

    const versionSelect = await screen.findByRole('combobox', { name: '请选择版本' })
    expect(
      within(versionSelect).getByRole('option', { name: '请选择版本' })
    ).toBeInTheDocument()
  })
})
