import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
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

// 子组件打桩：只关心 periodId / refreshKey 透传
vi.mock('./components/inspection-overview', () => ({
  default: ({ periodId, refreshKey }: { periodId: number; refreshKey?: number }) => (
    <div data-testid="inspection-overview" data-period-id={periodId} data-refresh-key={refreshKey} />
  ),
}))
vi.mock('./components/inspection-history', () => ({
  default: ({ periodId, refreshKey }: { periodId: number; refreshKey?: number }) => (
    <div data-testid="inspection-history" data-period-id={periodId} data-refresh-key={refreshKey} />
  ),
}))
vi.mock('./components/inspection-form', () => ({
  default: () => null,
}))

let periodFetchCount = 0
vi.mock('@/lib/inspection-api', () => ({
  fetchCurrentPeriod: vi.fn(() => {
    periodFetchCount += 1
    return Promise.resolve({ id: 7 })
  }),
}))

import InspectionClient from './inspection-client'
import { fetchCurrentPeriod } from '@/lib/inspection-api'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  periodFetchCount = 0
})

describe('InspectionClient header 化契约（operations header migration Batch C）', () => {
  it('renders the route inside a Warm Ledger page surface', async () => {
    const { container } = render(<InspectionClient />)

    const page = await screen.findByTestId('platform-inspection-page')
    expect(page).toHaveAttribute('data-warm-platform-inspection', 'true')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('渲染不崩溃：概览 tab 拿到当前周期', async () => {
    render(<InspectionClient />)
    const overview = await screen.findByTestId('inspection-overview')
    expect(overview).toHaveAttribute('data-period-id', '7')
  })

  it('头部刷新回调：bump refreshKey + 重取 currentPeriod', async () => {
    render(<InspectionClient />)
    const overview = await screen.findByTestId('inspection-overview')
    expect(overview).toHaveAttribute('data-refresh-key', '0')
    expect(periodFetchCount).toBe(1)
    expect(capturedRefreshHandler).not.toBeNull()

    // 受控 Promise 挂起周期重取，确定性断言 loading 上报
    let resolvePeriod:
      | ((value: Awaited<ReturnType<typeof fetchCurrentPeriod>>) => void)
      | undefined
    vi.mocked(fetchCurrentPeriod).mockImplementationOnce(() => {
      periodFetchCount += 1
      return new Promise<Awaited<ReturnType<typeof fetchCurrentPeriod>>>((resolve) => {
        resolvePeriod = resolve
      })
    })

    capturedRefreshHandler?.()
    // refreshKey 立即 bump（概览子组件随之重拉数据集）
    await vi.waitFor(() =>
      expect(screen.getByTestId('inspection-overview')).toHaveAttribute('data-refresh-key', '1')
    )
    // currentPeriod 重取发生且 loading 上报
    await vi.waitFor(() => expect(periodFetchCount).toBe(2))
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行后 loading 回落
    resolvePeriod?.({ id: 7 } as Awaited<ReturnType<typeof fetchCurrentPeriod>>)
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })

  it('周期加载失败时 notify 报错且不崩溃', async () => {
    vi.mocked(fetchCurrentPeriod).mockRejectedValueOnce(new Error('boom'))
    render(<InspectionClient />)
    await vi.waitFor(() => expect(mockNotify).toHaveBeenCalled())
    // 周期未就绪 → 概览内容不渲染
    expect(screen.queryByTestId('inspection-overview')).not.toBeInTheDocument()
  })
})
