import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

// ── mocks（组件 mount 即拉数据，测试只关注渲染契约，拦截全部网络） ─────────────

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', isAdmin: true } }),
}))

vi.mock('next/image', () => ({
  default: (props: { alt?: string }) => <span>{props.alt ?? 'image'}</span>,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => vi.fn(),
  useHeaderSlot: (node: React.ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

const REVENUE = {
  id: 1,
  project_id: 1,
  project_name: '项目A',
  country: 'US',
  received_date: '2026-08-01',
  amount: '11693.69',
  currency: 'USD',
  revenue_type: '订单回款',
  note: null,
  attachments: [],
  created_by: 'u1',
  created_at: '',
  updated_at: '',
}

type FetchStub = (url: string) => Promise<Response>

/** 构造拦截 /platform-revenues 的 fetch 桩（jsdom 无真实网络） */
function makeFetch(ok = true, body?: unknown): FetchStub {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/platform-revenues')) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            body ?? {
              items: [REVENUE],
              page: 1,
              page_size: 20,
              total: 1,
              total_pages: 1,
            }
          ),
          { status: ok ? 200 : 500 }
        )
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: ok ? 200 : 500 }))
  })
}

import PlatformRevenuePage from './page'

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', makeFetch())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('PlatformRevenuePage Warm Ledger 渲染契约', () => {
  it('渲染 Warm 路由标记、数据行与当前页合计', async () => {
    const { container } = render(<PlatformRevenuePage />)
    await screen.findByText('项目A')
    expect(container.querySelector('[data-warm-platform-revenue="true"]')).toBeInTheDocument()
    expect(
      container.querySelector('[data-warm-platform-revenue-panel="true"]')
    ).toBeInTheDocument()
    expect(container.querySelector('[data-warm-platform-revenue-table="true"]')).toBeInTheDocument()
    expect(screen.getAllByText('$11,693.69').length).toBeGreaterThan(0)
    expect(screen.getByTitle('USD - 美元')).toHaveTextContent('$ USD')
    expect(screen.getByText('合计（当前页）')).toBeInTheDocument()
  })

  it('保留五个筛选控件与导出 / 新增回款操作', async () => {
    render(<PlatformRevenuePage />)
    await screen.findByText('平台回款')
    expect(screen.getAllByRole('combobox')).toHaveLength(5)
    expect(screen.getByRole('combobox', { name: '项目' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '年份' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '月份' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '币种' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '回款类型' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重置筛选' })).toBeInTheDocument()
    expect(screen.getByText('新增回款')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出 Excel/ })).toBeInTheDocument()
  })

  it('列表请求保留默认年份与分页 query 语义', async () => {
    render(<PlatformRevenuePage />)
    await screen.findByText('项目A')

    const revenueCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes('/platform-revenues?'))
    expect(revenueCall).toBeDefined()

    const url = new URL(String(revenueCall?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/api/backend/api/v1/platform-revenues')
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('page_size')).toBe('20')
    expect(url.searchParams.get('year')).toBe(String(new Date().getFullYear()))
  })

  it('空数据时展示空态占位而非崩溃', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(true, { items: [], page: 1, page_size: 20, total: 0, total_pages: 1 })
    )
    render(<PlatformRevenuePage />)
    await screen.findByText(/暂无回款数据/)
  })

  it('加载失败时展示 error 行内提示态', async () => {
    vi.stubGlobal('fetch', makeFetch(false))
    render(<PlatformRevenuePage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to fetch revenues/)
  })

  it('数据表不混入 Terminal 表面与 emoji 站点旗', async () => {
    const { container } = render(<PlatformRevenuePage />)
    await screen.findByText('项目A')
    expect(container.querySelector('.bg-gradient-to-r')).toBeNull()
    expect(container.querySelector('[class*="term-panel"]')).toBeNull()
    expect(container.querySelector('[class*="rounded-none"]')).toBeNull()
    expect(container.querySelector('.shadow-md, .shadow-lg, .shadow-xl')).toBeNull()
    expect(container.textContent).not.toContain('🇺🇸')
  })

  it('点击分页时保留当前筛选 scope', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(true, {
        items: [REVENUE],
        page: 1,
        page_size: 20,
        total: 21,
        total_pages: 2,
      })
    )
    render(<PlatformRevenuePage />)
    await screen.findByText('项目A')

    screen.getByRole('button', { name: '下一页' }).click()

    await waitFor(() => {
      const pageTwoCall = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => {
          const requestUrl = new URL(String(url), 'http://localhost')
          return (
            requestUrl.pathname === '/api/backend/api/v1/platform-revenues' &&
            requestUrl.searchParams.get('page') === '2'
          )
        })
      expect(pageTwoCall).toBeDefined()
      const requestUrl = new URL(String(pageTwoCall?.[0]), 'http://localhost')
      expect(requestUrl.searchParams.get('page_size')).toBe('20')
      expect(requestUrl.searchParams.get('year')).toBe(String(new Date().getFullYear()))
    })
  })

  it('点击附件时打开 Warm 图片预览', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(true, {
        items: [
          {
            ...REVENUE,
            attachments: [
              {
                id: 'attachment-1',
                filename: 'receipt.png',
                stored_path: 'receipts/receipt.png',
                url: 'https://example.com/receipt.png',
                size: 2048,
                created_at: '2026-08-01T00:00:00Z',
              },
            ],
          },
        ],
        page: 1,
        page_size: 20,
        total: 1,
        total_pages: 1,
      })
    )
    render(<PlatformRevenuePage />)

    const previewButton = await screen.findByRole('button', {
      name: '预览附件 receipt.png',
    })
    previewButton.click()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('data-warm-attachment-preview', 'true')
    expect(screen.getByRole('img', { name: '图片预览' })).toHaveAttribute(
      'src',
      'https://example.com/receipt.png'
    )
  })
})
