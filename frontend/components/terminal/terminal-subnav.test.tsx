import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import { TerminalSubnav } from './terminal-subnav'
import type { SidebarTopGroup } from '@/lib/sidebar-config'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/daily-analysis',
}))

// RouteLoadingLink 内部依赖 next/navigation 的 useRouter / LRU cache，这里打平为普通链接
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

const GROUPS: SidebarTopGroup[] = [
  {
    id: 'operations',
    label: '运营',
    icon: () => null,
    accent: '',
    activeAccent: '',
    items: [
      { title: '销售数据', url: '/dashboard/operations/daily-analysis' },
      { title: 'SKU 信息', url: '/dashboard/operations/sku-info' },
    ],
  },
]

describe('TerminalSubnav', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('当前路由命中的子模块以 raised 底色 + accent 左条高亮', () => {
    render(<TerminalSubnav groups={GROUPS} activeGroupId="operations" pathname="/dashboard/operations/daily-analysis" onCollapse={vi.fn()} />)
    const activeLink = screen.getByTestId('link-/dashboard/operations/daily-analysis')
    expect(activeLink.className).toContain('bg-term-raised')
    const inactive = screen.getByTestId('link-/dashboard/operations/sku-info')
    expect(inactive.className).not.toContain('bg-term-raised')
  })

  it('搜索按钮派发全局 ⌘K 打开事件；折叠按钮回调 onCollapse', () => {
    const onCollapse = vi.fn()
    const handler = vi.fn()
    window.addEventListener(OPEN_SEARCH_EVENT, handler)
    render(<TerminalSubnav groups={GROUPS} activeGroupId="operations" pathname="/dashboard" onCollapse={onCollapse} />)

    const searchBtn = screen.getByRole('button', { name: /搜索/ })
    act(() => {
      searchBtn.click()
    })
    expect(handler).toHaveBeenCalledTimes(1)

    const collapseBtn = screen.getByRole('button', { name: '折叠侧栏' })
    act(() => {
      collapseBtn.click()
    })
    expect(onCollapse).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_SEARCH_EVENT, handler)
  })

  it('activeGroupId 未命中时回退到第一组', () => {
    render(<TerminalSubnav groups={GROUPS} pathname="/dashboard" onCollapse={vi.fn()} />)
    expect(screen.getByText('运营')).toBeInTheDocument()
    expect(screen.getByTestId('link-/dashboard/operations/daily-analysis')).toBeInTheDocument()
  })
})
