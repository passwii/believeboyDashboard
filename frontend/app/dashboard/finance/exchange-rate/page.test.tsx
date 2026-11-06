import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

// ── mocks（组件 mount 即拉数据，测试只关注渲染契约，拦截全部网络） ─────────────

const authState = vi.hoisted(() => ({ isAdmin: true }))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', isAdmin: authState.isAdmin } }),
}))

vi.mock('next/image', () => ({
  default: (props: { alt?: string }) => <span>{props.alt ?? 'image'}</span>,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => vi.fn(),
  useHeaderSlot: (node: React.ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

const RATE = {
  id: 1,
  currency: 'USD',
  currencyName: '美元',
  year: 2026,
  month: 8,
  rate: 7.2345,
  description: null,
  noteImages: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
}

type FetchStub = (url: string) => Promise<Response>

function makeFetch(ok = true, body?: unknown): FetchStub {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/exchange-rates')) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            body ?? { data: [RATE], pagination: { page: 1, pageSize: 12, total: 1, totalPages: 1 } }
          ),
          { status: ok ? 200 : 500 }
        )
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: ok ? 200 : 500 }))
  })
}

import ExchangeRatePage from './page'

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  authState.isAdmin = true
  vi.stubGlobal('fetch', makeFetch())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ExchangeRatePage Warm Ledger 渲染契约', () => {
  it('渲染 Warm 路由标记、货币行与 6 位小数汇率', async () => {
    const { container } = render(<ExchangeRatePage />)
    await screen.findByText('7.234500')
    expect(container.querySelector('[data-warm-exchange-rate="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-exchange-rate-panel="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-exchange-rate-table="true"]')).toBeInTheDocument()
    expect(screen.getByTitle('USD - 美元')).toHaveTextContent('$ USD')
    expect(screen.getByText('美元')).toBeInTheDocument()
    expect(screen.getByText('2026')).toBeInTheDocument()
    expect(screen.getByText('8月')).toBeInTheDocument()
  })

  it('保留三个筛选控件与 admin 新增入口', async () => {
    render(<ExchangeRatePage />)
    await screen.findByText('汇率管理')
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    expect(screen.getByRole('combobox', { name: '货币' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '年份' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '月份' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重置筛选' })).toBeInTheDocument()
    expect(screen.getByText('新增汇率')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /编辑/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /删除/ })).toBeInTheDocument()
  })

  it('非 admin 不显示写操作', async () => {
    authState.isAdmin = false
    render(<ExchangeRatePage />)
    await screen.findByText('7.234500')
    expect(screen.queryByText('新增汇率')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /编辑/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument()
  })

  it('列表请求保留分页 query 语义', async () => {
    render(<ExchangeRatePage />)
    await screen.findByText('7.234500')

    const rateCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes('/api/exchange-rates?'))
    expect(rateCall).toBeDefined()

    const url = new URL(String(rateCall?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/api/exchange-rates')
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('pageSize')).toBe('12')
  })

  it('空数据时展示空态占位而非崩溃', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(true, { data: [], pagination: { page: 1, pageSize: 12, total: 0, totalPages: 0 } })
    )
    render(<ExchangeRatePage />)
    await screen.findByText(/暂无汇率数据/)
  })

  it('加载失败时展示 error 行内提示态', async () => {
    vi.stubGlobal('fetch', makeFetch(false))
    render(<ExchangeRatePage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/汇率数据加载失败/)
  })

  it('数据表不混入 Terminal 表面与 emoji 货币符号', async () => {
    const { container } = render(<ExchangeRatePage />)
    await screen.findByText('7.234500')
    expect(container.querySelector('.bg-gradient-to-r')).toBeNull()
    expect(container.querySelector('[class*="term-panel"]')).toBeNull()
    expect(container.querySelector('[class*="rounded-none"]')).toBeNull()
    expect(container.querySelector('.shadow-md, .shadow-lg, .shadow-xl')).toBeNull()
  })

  it('分页按钮按现有分页状态请求下一页', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(true, {
        data: [RATE],
        pagination: { page: 1, pageSize: 12, total: 13, totalPages: 2 },
      })
    )
    render(<ExchangeRatePage />)
    await screen.findByText('7.234500')

    screen.getByRole('button', { name: '下一页' }).click()

    await waitFor(() => {
      const pageTwoCall = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => {
          const requestUrl = new URL(String(url), 'http://localhost')
          return (
            requestUrl.pathname === '/api/exchange-rates' &&
            requestUrl.searchParams.get('page') === '2'
          )
        })
      expect(pageTwoCall).toBeDefined()
      const requestUrl = new URL(String(pageTwoCall?.[0]), 'http://localhost')
      expect(requestUrl.searchParams.get('pageSize')).toBe('12')
    })
  })
})
