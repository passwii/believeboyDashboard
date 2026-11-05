import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

// 稳定引用：避免每次渲染产生新对象导致 fetchStores identity 抖动、
// useEffect 重复触发（真实 useSession 返回稳定引用）
const { stableSession } = vi.hoisted(() => ({
  stableSession: { user: { id: 'user-1', roleType: 'admin' } },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
}))

// 捕获 header 刷新回调与 loading 上报
let capturedRefreshHandler: (() => void) | null = null
let capturedRefreshLoading: boolean | undefined
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
  },
  useHeaderSlot: () => null,
}))

let lastForce: boolean | undefined
let fetchCallCount = 0
vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(
    (_session?: unknown, _showInactive?: boolean, options?: { force?: boolean }) => {
      lastForce = options?.force
      fetchCallCount += 1
      return Promise.resolve([
        { id: 1, name: '店铺A', brand_name: 'BrandA', store_address: 'https://a.example.com' },
        { id: 2, name: '店铺B', brand_name: null, store_address: null },
      ])
    }
  ),
}))

import StoreNavigationPage from './page'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  lastForce = undefined
  fetchCallCount = 0
})

describe('StoreNavigationPage header 化契约（operations header migration Batch C）', () => {
  it('使用 Warm Ledger 导航壳且不混用 Terminal 表面', async () => {
    const { container } = render(<StoreNavigationPage />)

    const page = await screen.findByTestId('store-navigation-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('渲染不崩溃：店铺卡片与统计出现', async () => {
    render(<StoreNavigationPage />)
    expect(await screen.findByText('店铺A')).toBeInTheDocument()
    expect(screen.getByText('店铺B')).toBeInTheDocument()
    expect(screen.getByText('店铺总数')).toBeInTheDocument()
  })

  it('保留真实店铺外链并对无链接店铺禁用跳转', async () => {
    render(<StoreNavigationPage />)

    const storeA = await screen.findByRole('link', { name: /店铺A/ })
    const storeB = screen.getByRole('link', { name: /店铺B/ })
    expect(storeA).toHaveAttribute('href', 'https://a.example.com')
    expect(storeA).toHaveAttribute('target', '_blank')
    expect(storeA).toHaveAttribute('rel', 'noreferrer')
    expect(storeB).toHaveAttribute('href', '#')
  })

  it('初始加载不带 force（走缓存）', async () => {
    render(<StoreNavigationPage />)
    await screen.findByText('店铺A')
    expect(fetchCallCount).toBe(1)
    expect(lastForce).toBe(false)
  })

  it('头部刷新回调触发 force:true 重拉——跳项目缓存', async () => {
    render(<StoreNavigationPage />)
    await screen.findByText('店铺A')
    expect(capturedRefreshHandler).not.toBeNull()

    // 用受控 Promise 挂起本次重拉，确定性断言 force 语义与 loading 上报
    let resolveFetch: ((value: unknown) => void) | undefined
    vi.mocked(fetchManagedProjectsCached).mockImplementationOnce(
      (_session?: unknown, _showInactive?: boolean, options?: { force?: boolean }) => {
        lastForce = options?.force
        fetchCallCount += 1
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      }
    )

    capturedRefreshHandler?.()
    await vi.waitFor(() => expect(lastForce).toBe(true))
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落
    resolveFetch?.([
      { id: 1, name: '店铺A', brand_name: 'BrandA', store_address: 'https://a.example.com' },
    ])
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })
})
