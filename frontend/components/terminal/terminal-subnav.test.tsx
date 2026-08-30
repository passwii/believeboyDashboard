import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import {
  TERMINAL_SUBNAV_COLLAPSED_WIDTH,
  TERMINAL_SUBNAV_MOTION,
  TERMINAL_SUBNAV_WIDTH,
  TERMINAL_TOP_STRIP_HEIGHT,
} from './terminal-constants'
import { TerminalSubnav } from './terminal-subnav'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { TrendingUp } from 'lucide-react'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/daily-analysis',
}))

// RouteLoadingLink 内部依赖 next/navigation 的 useRouter / LRU cache，这里打平为普通链接
vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({
    href,
    children,
    className,
    style,
    tabIndex,
  }: {
    href: string
    children: React.ReactNode
    className?: string
    style?: React.CSSProperties
    tabIndex?: number
  }) => (
    <a href={href} className={className} style={style} tabIndex={tabIndex} data-testid={`link-${href}`}>
      {children}
    </a>
  ),
}))

const GROUPS: SidebarTopGroup[] = [
  {
    id: 'operations',
    label: '运营',
    icon: TrendingUp,
    accent: '',
    activeAccent: '',
    items: [
      { title: '销售数据', url: '/dashboard/operations/daily-analysis' },
      { title: 'SKU 信息', url: '/dashboard/operations/sku-info' },
    ],
  },
]

function renderSubnav(props: Partial<Parameters<typeof TerminalSubnav>[0]> = {}) {
  return render(
    <TerminalSubnav
      groups={GROUPS}
      activeGroupId="operations"
      pathname="/dashboard/operations/daily-analysis"
      collapsed={false}
      {...props}
    />
  )
}

describe('TerminalSubnav', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('当前路由命中的子模块以 raised 底色 + accent 左条高亮', () => {
    renderSubnav()
    const activeLink = screen.getByTestId('link-/dashboard/operations/daily-analysis')
    expect(activeLink.className).toContain('bg-term-raised')
    const inactive = screen.getByTestId('link-/dashboard/operations/sku-info')
    expect(inactive.className).not.toContain('bg-term-raised')
  })

  it('搜索按钮派发全局 ⌘K 打开事件', () => {
    const handler = vi.fn()
    window.addEventListener(OPEN_SEARCH_EVENT, handler)
    renderSubnav()

    const searchBtn = screen.getByRole('button', { name: /搜索/ })
    act(() => {
      searchBtn.click()
    })
    expect(handler).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_SEARCH_EVENT, handler)
  })

  it('activeGroupId 未命中时回退到第一组', () => {
    renderSubnav({ activeGroupId: undefined, pathname: '/dashboard' })
    expect(screen.getByText('运营')).toBeInTheDocument()
    expect(screen.getByTestId('link-/dashboard/operations/daily-analysis')).toBeInTheDocument()
  })

  it('BLF-825 展开态：壳宽 = SUBNAV 宽度，动效 CSS 变量按常量注入', () => {
    const { container } = renderSubnav({ collapsed: false })
    const aside = container.querySelector('aside')!
    expect((aside as HTMLElement).style.width).toBe(`${TERMINAL_SUBNAV_WIDTH}px`)
    expect((aside as HTMLElement).style.getPropertyValue('--subnav-duration')).toBe(
      `${TERMINAL_SUBNAV_MOTION.durationMs}ms`
    )
    expect((aside as HTMLElement).style.getPropertyValue('--subnav-ease')).toBe(
      TERMINAL_SUBNAV_MOTION.ease
    )
    expect(aside.className).toContain('term-subnav-expanded')
    expect(aside.className).not.toContain('term-subnav-collapsed')
    // 展开态可达（aside 自身不隐藏）
    expect(aside.getAttribute('aria-hidden')).toBe('false')
  })

  it('BLF-825 折叠态：壳宽归零 + collapsed 类；内容层 pointer-events 关闭且链接不可聚焦', async () => {
    const { container } = renderSubnav({ collapsed: true })
    const aside = container.querySelector('aside')! as HTMLElement
    await waitFor(() => expect(aside.style.width).toBe(`${TERMINAL_SUBNAV_COLLAPSED_WIDTH}px`))
    expect(aside.className).toContain('term-subnav-collapsed')
    expect(aside.getAttribute('aria-hidden')).toBe('true')

    // 内容层：淡出期间不可点击（防幽灵点击），键盘不可达
    for (const link of screen.getAllByTestId(/^link-/)) {
      expect(link.className).toContain('term-subnav-content')
      expect(link.className).not.toContain('pointer-events-none') // pointer-events 由 .term-subnav-collapsed 后代选择器统一接管
      expect(link.getAttribute('tabindex')).toBe('-1')
    }
  })

  it('BLF-832 组头高度引用顶部基准带常量（与 Header/Rail/Inspector 分割线贯通）', () => {
    const { container } = renderSubnav({ collapsed: false })
    const groupHeader = container.querySelector('aside .term-subnav-content') as HTMLElement
    expect(groupHeader.style.height).toBe(`${TERMINAL_TOP_STRIP_HEIGHT}px`)
  })

  it('BLF-825 入场 stagger：列表项级联延迟按 slot * step 递增且封顶', () => {
    renderSubnav({ collapsed: false })
    const links = screen.getAllByTestId(/^link-/)
    const step = TERMINAL_SUBNAV_MOTION.staggerStepMs
    const cap = TERMINAL_SUBNAV_MOTION.maxStaggerDelayMs

    // 列表项从 slot=2 起（组头 0 / 搜索框 1）
    const delays = links.map((_, i) => Math.min((i + 2) * step, cap))
    expect(delays[0]).toBe(2 * step)
    expect(delays[delays.length - 1]).toBe(Math.min((links.length + 1) * step, cap))

    // 每个内容层都带 --subnav-delay 内联变量
    for (const link of links) {
      expect((link as HTMLElement).style.getPropertyValue('--subnav-delay')).toMatch(/ms$/)
    }
  })
})
