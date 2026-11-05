import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableSession } from '@/test-utils/stable-mocks'

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
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    headerRefresh.handler = handler
    return { setLoading: vi.fn() }
  },
}))

import { AdDataTopFilters } from './top-filters'

describe('AdDataTopFilters Warm 筛选', () => {
  beforeEach(() => {
    routerMock.replace.mockClear()
    routerMock.refresh.mockClear()
    routerMock.push.mockClear()
    requestRefreshMock.mockClear()
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

  it('日期输入继续写入 dateFrom/dateTo URL 契约', async () => {
    render(<AdDataTopFilters />)

    fireEvent.change(await screen.findByLabelText('开始日期'), {
      target: { value: '2026-01-01' },
    })
    fireEvent.change(screen.getByLabelText('结束日期'), {
      target: { value: '2026-01-31' },
    })

    expect(routerMock.replace).toHaveBeenCalledWith(
      '/dashboard/advertising/ad-data?country=US&dateFrom=2026-01-01',
      { scroll: false }
    )
    expect(routerMock.replace).toHaveBeenCalledWith(
      '/dashboard/advertising/ad-data?country=US&dateTo=2026-01-31',
      { scroll: false }
    )
  })
})
