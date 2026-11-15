import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/brand/glass-reveal-21st.demo', () => ({
  GlassReveal21stDemo: () => <div data-testid="upstream-glass" />,
}))

vi.mock('@/components/brand/believeboy-glass-reveal', () => ({
  BelieveboyGlassReveal: (props: { variant: string; tone: string; mark: string }) => (
    <div data-testid="glass" data-variant={props.variant} data-tone={props.tone} data-mark={props.mark} />
  ),
}))

import BrandDraftPage from './page'

describe('BrandDraftPage', () => {
  it('默认选中 A 与 wing-cut，并渲染三个方向说明', () => {
    render(<BrandDraftPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Believeboy LOGO 重设计' })).toBeVisible()
    expect(screen.getByRole('button', { name: /A · Wing-cut B/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('glass')).toHaveAttribute('data-variant', 'wing-cut')
    expect(screen.getByTestId('glass')).toHaveAttribute('data-tone', 'light')
    expect(screen.getByRole('tab', { name: '收束成应用图标' })).toHaveAttribute('aria-selected', 'true')
  })

  it('切换方向会同步尺寸区与玻璃组件', () => {
    render(<BrandDraftPage />)
    fireEvent.click(screen.getByRole('button', { name: /B · Ledger B/ }))
    expect(screen.getByRole('button', { name: /B · Ledger B/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('glass')).toHaveAttribute('data-mark', 'ledger')
  })

  it('切换变体与明暗会重挂玻璃组件', () => {
    render(<BrandDraftPage />)
    fireEvent.click(screen.getByRole('tab', { name: '极简擦亮' }))
    expect(screen.getByTestId('glass')).toHaveAttribute('data-variant', 'bare')

    fireEvent.click(screen.getByRole('button', { name: '切到暗色' }))
    expect(screen.getByTestId('glass')).toHaveAttribute('data-tone', 'dark')
    expect(screen.getByRole('button', { name: '切到浅色' })).toBeVisible()
  })

  it('上游默认作为对照选项，不传 Believeboy mark', () => {
    render(<BrandDraftPage />)
    fireEvent.click(screen.getByRole('tab', { name: '上游默认（对照）' }))
    expect(screen.queryByTestId('glass')).not.toBeInTheDocument()
  })

  it('尺寸区默认不含放大审计，点击后出现', () => {
    render(<BrandDraftPage />)
    expect(screen.queryByText(/临界尺寸放大/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '放大 16px 检查' }))
    expect(screen.getByText(/临界尺寸放大/)).toBeVisible()
    expect(screen.getByRole('button', { name: '收起 16px 以下放大' })).toBeVisible()
  })
})
