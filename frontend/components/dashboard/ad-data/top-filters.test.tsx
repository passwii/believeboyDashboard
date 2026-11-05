import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stableSession } from '@/test-utils/stable-mocks'
import styles from './ad-data-explorer.module.css'

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}))
const requestRefreshMock = vi.hoisted(() => vi.fn())
const headerRefresh = vi.hoisted(() => ({ handler: null as null | (() => void | Promise<void>) }))
const searchParams = vi.hoisted(() => new URLSearchParams('country=US'))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/advertising/ad-data',
  useRouter: () => routerMock,
  useSearchParams: () => searchParams,
}))

vi.mock('next-auth/react', () => ({
  useSession: () =>
    stableSession({
      user: { id: 'user-1', roleType: 'admin', name: '张三' },
    }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(async () => [
    { id: 7, name: '项目 A' },
    { id: 8, name: '项目 B' },
  ]),
}))

vi.mock('@/components/dashboard/ad-refresh', () => ({
  requestAdClientRefresh: requestRefreshMock,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderSlot: (node: ReactNode) => <div data-testid="header-slot">{node}</div>,
  useMobileFilterStrip: (node: ReactNode) => (
    <div data-testid="mobile-slot">{node}</div>
  ),
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    headerRefresh.handler = handler
    return { setLoading: vi.fn() }
  },
}))

import { AdDataTopFilters } from './top-filters'

const CSS_SOURCE = readFileSync(
  join(process.cwd(), 'components/dashboard/ad-data/ad-data-explorer.module.css'),
  'utf8'
)

describe('AdDataTopFilters Warm 筛选', () => {
  beforeEach(() => {
    routerMock.replace.mockClear()
    routerMock.refresh.mockClear()
    routerMock.push.mockClear()
    requestRefreshMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('自动选择首个项目并保留 URL 筛选契约', async () => {
    render(<AdDataTopFilters />)

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        '/dashboard/advertising/ad-data?country=US&projectId=7',
        { scroll: false }
      )
    )
    expect(await screen.findByRole('combobox', { name: '项目筛选' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '站点筛选' })).toBeInTheDocument()
  })

  it('Header 刷新同时清缓存并刷新路由', async () => {
    render(<AdDataTopFilters />)
    await screen.findByRole('combobox', { name: '项目筛选' })

    await headerRefresh.handler?.()

    expect(requestRefreshMock).toHaveBeenCalledTimes(1)
    expect(routerMock.refresh).toHaveBeenCalledTimes(1)
  })

  it('恢复站点时区 date-range presets 并保留 URL 契约', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
    render(<AdDataTopFilters />)

    fireEvent.click(
      screen.getByRole('button', { name: '2026-10-29 ~ 2026-11-04' })
    )

    const popover = document.querySelector('.warm-ledger__date-picker-content')
    expect(popover).toBeInTheDocument()
    expect(popover).toHaveClass(styles.headerDatePopover)
    expect(popover?.className).toContain('warm-ledger__date-picker-content')
    expect(screen.getByText('近7天')).toBeInTheDocument()
    expect(screen.getByText('上个月')).toBeInTheDocument()
    expect(screen.getByText('本年度至今')).toBeInTheDocument()

    fireEvent.click(screen.getByText('上个月'))
    expect(routerMock.replace).toHaveBeenCalledWith(
      '/dashboard/advertising/ad-data?country=US&dateFrom=2026-10-01&dateTo=2026-10-31',
      { scroll: false }
    )
  })

  it('日期弹层挂共享 Warm class，并由本地类覆盖内部 term/零圆角视觉', () => {
    expect(CSS_SOURCE).toContain(
      ".headerDatePopover :global([class~='rounded-none'])"
    )
    expect(CSS_SOURCE).toContain(
      ".headerDatePopover :global([class~='border-term-border'])"
    )
    expect(CSS_SOURCE).toContain(
      ".headerDatePopover :global([class~='bg-term-panel'])"
    )
    expect(CSS_SOURCE).toContain(
      ".headerDatePopover :global([class~='text-term-text'])"
    )
  })

  it('注册移动筛选条，展开后项目/站点/日期筛选仍可用', async () => {
    render(<AdDataTopFilters />)

    expect(await screen.findByTestId('mobile-filter-strip')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换页面筛选' }))

    expect(screen.getByRole('combobox', { name: '移动项目筛选' })).toBeInTheDocument()
    expect(screen.getAllByRole('combobox', { name: '站点筛选' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /2026-/ })).toHaveLength(2)
  })
})
