import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TERMINAL_TOP_STRIP_HEIGHT } from './terminal-constants'
import { TerminalInspector, type LiveStreamItem } from './terminal-inspector'

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
    for (const label of ['快捷操作', /最近访问/, /Live Stream · 今日出单/]) {
      const h3 = screen.getByText(label)
      expect(h3.className).toContain('font-semibold')
      expect(h3.className).toContain('uppercase')
      expect(h3.className).toContain('tracking-wider')
    }
  })

  describe('BLF-839 Live Stream 可配置数据源', () => {
    const items: LiveStreamItem[] = [
      { id: 'o1', title: '订单 #A-1024 · $59.90', timeLabel: '2 分钟前' },
      { id: 'o2', title: '订单 #A-1025 · €42.00', timeLabel: '11 分钟前' },
    ]

    it('未传 items 时渲染空态 + 同步中骨架，不硬编码假数据', () => {
      render(<TerminalInspector open onClose={vi.fn()} />)
      expect(screen.getByTestId('live-stream-empty')).toBeInTheDocument()
      expect(screen.getByText('暂无今日出单事件')).toBeInTheDocument()
      expect(screen.getByRole('status', { name: '同步中' })).toBeInTheDocument()
    })

    it('空数组同样走空态分支', () => {
      render(<TerminalInspector open onClose={vi.fn()} liveStreamItems={[]} />)
      expect(screen.getByTestId('live-stream-empty')).toBeInTheDocument()
    })

    it('传入 items 时逐条渲染标题 + mono 时间，无骨架', () => {
      render(<TerminalInspector open onClose={vi.fn()} liveStreamItems={items} />)
      expect(screen.queryByTestId('live-stream-empty')).not.toBeInTheDocument()
      expect(screen.getByText('订单 #A-1024 · $59.90')).toBeInTheDocument()
      expect(screen.getByText('2 分钟前').className).toContain('font-mono')
      expect(screen.getByText('11 分钟前').className).toContain('tabular-nums')
    })
  })
})
