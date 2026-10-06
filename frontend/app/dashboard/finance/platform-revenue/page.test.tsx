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

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => vi.fn(),
  useHeaderSlot: (node: React.ReactNode) => null,
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

describe('PlatformRevenuePage 终端化渲染契约（BLF-835）', () => {
  it('渲染 TermTable 数据行与合计行，金额走千分位等宽格式', async () => {
    render(<PlatformRevenuePage />)
    await screen.findByText('项目A')
    expect(screen.getAllByText('$11,693.69').length).toBeGreaterThan(0)
    expect(screen.getByText('$ USD')).toBeInTheDocument()
    expect(screen.getByText('合计（当前页）')).toBeInTheDocument()
  })

  it('面板标题与操作按钮齐全（导出 / 新增回款）', async () => {
    render(<PlatformRevenuePage />)
    await screen.findByText('平台回款')
    expect(screen.getByText('新增回款')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出 Excel/ })).toBeInTheDocument()
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
    await screen.findByText(/Failed to fetch revenues/)
  })

  it('无旧风格残留：无渐变 Badge 类 / 无阴影类 / 无 emoji 站点旗', async () => {
    const { container } = render(<PlatformRevenuePage />)
    await screen.findByText('项目A')
    expect(container.querySelector('.bg-gradient-to-r')).toBeNull()
    expect(container.querySelector('.shadow-md, .shadow-lg, .shadow-xl')).toBeNull()
    expect(container.textContent).not.toContain('🇺🇸')
  })
})
