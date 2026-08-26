import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TERMINAL_TOP_STRIP_HEIGHT } from './terminal-constants'
import { TerminalInspector } from './terminal-inspector'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn() }),
}))

// RouteLoadingLink 依赖 GlobalLoadingProvider，打平为普通链接
vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({
    href,
    children,
    className,
  }: {
    href: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className} data-testid={`link-${href}`}>
      {children}
    </a>
  ),
}))

describe('TerminalInspector', () => {
  it('BLF-832 标题条高度引用顶部基准带常量（不再用 h-10 字面量）', () => {
    const { container } = render(<TerminalInspector open onClose={vi.fn()} />)
    const aside = container.querySelector('aside')!
    const titleBar = aside.querySelector('div:first-child') as HTMLElement
    expect(titleBar.style.height).toBe(`${TERMINAL_TOP_STRIP_HEIGHT}px`)
  })

  it('BLF-832 二级标题带 font-semibold 四件套（A2 收编）', () => {
    render(<TerminalInspector open onClose={vi.fn()} />)
    for (const label of ['快捷操作', /最近访问/]) {
      const h3 = screen.getByText(label)
      expect(h3.className).toContain('font-semibold')
      expect(h3.className).toContain('uppercase')
      expect(h3.className).toContain('tracking-wider')
    }
  })
})
