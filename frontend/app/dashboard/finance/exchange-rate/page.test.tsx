import { render, screen, cleanup } from '@testing-library/react'
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

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => vi.fn(),
  useHeaderSlot: (node: React.ReactNode) => null,
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
  vi.stubGlobal('fetch', makeFetch())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ExchangeRatePage 终端化渲染契约（BLF-835）', () => {
  it('渲染 TermTable 数据行：货币 mono 符号 + 汇率值 6 位小数等宽', async () => {
    render(<ExchangeRatePage />)
    await screen.findByText('7.234500')
    expect(screen.getByText('$ USD')).toBeInTheDocument()
    expect(screen.getByText('美元')).toBeInTheDocument()
    expect(screen.getByText('2026')).toBeInTheDocument()
    expect(screen.getByText('8月')).toBeInTheDocument()
  })

  it('admin 可见面板标题与新增按钮齐全', async () => {
    render(<ExchangeRatePage />)
    await screen.findByText('汇率管理')
    expect(screen.getByText('新增汇率')).toBeInTheDocument()
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
    await screen.findByText(/Failed to fetch exchange rates/)
  })

  it('无旧风格残留：无渐变 Badge 类 / 无阴影类 / 无 emoji 货币符号', async () => {
    const { container } = render(<ExchangeRatePage />)
    await screen.findByText('$ USD')
    expect(container.querySelector('.bg-gradient-to-r')).toBeNull()
    expect(container.querySelector('.shadow-md, .shadow-lg, .shadow-xl')).toBeNull()
  })
})
