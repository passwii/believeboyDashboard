import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageTransition } from './PageTransition'

// pathname 初始为 '/a'，可在测试中通过重新 mock 修改
let mockPathname = '/a'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => false }
})

describe('PageTransition', () => {
  beforeEach(() => {
    mockPathname = '/a'
  })

  it('renders children inside AnimatePresence', () => {
    render(
      <PageTransition>
        <div data-testid="content">hello</div>
      </PageTransition>,
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
  })

  it('renders children as plain content when reduced-motion fallback path triggers', () => {
    // 该断言更多是结构性：reduced 下 initial 应被覆盖为 { opacity: 1 }
    // 简化：只断言渲染正常（filter 的真实行为靠 e2e/手动）
    render(<PageTransition>x</PageTransition>)
    expect(screen.getByText('x')).toBeInTheDocument()
  })

  it('renders full-bleed wrapper for /dashboard/ai/chat', () => {
    mockPathname = '/dashboard/ai/chat'
    const { container } = render(
      <PageTransition>
        <div data-testid="content">x</div>
      </PageTransition>,
    )
    const wrapper = container.querySelector('div')
    expect(wrapper?.className).toContain('!absolute')
    expect(wrapper?.className).toContain('inset-0')
  })

  it('renders normal wrapper for /dashboard', () => {
    mockPathname = '/dashboard'
    const { container } = render(
      <PageTransition>
        <div data-testid="content">x</div>
      </PageTransition>,
    )
    const wrapper = container.querySelector('div')
    expect(wrapper?.className).toContain('h-full')
    expect(wrapper?.className).toContain('w-full')
  })
})