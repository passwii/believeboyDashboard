import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// BEL-424 契约测试：
// 1) projects/manage + operator-options 走 2min 客户端缓存（不再 mount 即裸 fetch）；
// 2) performance / commission 两个 tab 的数据首次激活才拉 —— mount 只拉
//    role-info（运营信息）一个业务端点。

const mockSession = {
  user: { id: 'user-1', roleType: 'admin', operatorNameZh: '张三' },
}
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: 'authenticated' }),
}))

// 注意：notify 必须返回稳定引用（生产实现是 useCallback([])）——
// 若每次渲染返回新函数，mount effect 的 [.., notify] 依赖会无限重跑。
const notifyMock = vi.fn()
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: notifyMock }),
  NotificationsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const fetchManagedProjectsCached = vi.fn()
const fetchProjectOperatorOptionsCached = vi.fn()
vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: (...args: unknown[]) => fetchManagedProjectsCached(...args),
  fetchProjectOperatorOptionsCached: (...args: unknown[]) =>
    fetchProjectOperatorOptionsCached(...args),
  clearProjectClientCaches: vi.fn(),
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
  useHeaderSlot: () => null,
  useMobileFilterStrip: () => null,
}))

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

import OperatorManagementPage from './page'

describe('OperatorManagementPage mount 请求行为（BEL-424）', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchManagedProjectsCached.mockResolvedValue([{ id: 1, name: '测试项目' }])
    fetchProjectOperatorOptionsCached.mockResolvedValue(['张三', '李四'])
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('commission-management/role-assignments')) {
        return jsonResponse({ items: [] })
      }
      if (url.includes('operator-management/performance')) {
        return jsonResponse({ items: [] })
      }
      if (url.includes('commission-management/records')) {
        return jsonResponse({ items: [] })
      }
      if (url.includes('commission-management/ratio-overrides')) {
        return jsonResponse({ items: [] })
      }
      return jsonResponse({})
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    fetchManagedProjectsCached.mockReset()
    fetchProjectOperatorOptionsCached.mockReset()
  })

  const callsTo = (substr: string) =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes(substr))

  it('mount 走缓存取项目/运营者选项，不裸 fetch 这两个共享端点', async () => {
    render(<OperatorManagementPage />)
    await waitFor(() => expect(fetchManagedProjectsCached).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(fetchProjectOperatorOptionsCached).toHaveBeenCalledTimes(1))

    expect(callsTo('/api/v1/projects/manage')).toHaveLength(0)
    expect(callsTo('/api/v1/projects/operator-options')).toHaveLength(0)
  })

  it('mount 只拉 role-info 数据；performance / commission 首次激活前不拉', async () => {
    render(<OperatorManagementPage />)
    await waitFor(() => expect(callsTo('commission-management/role-assignments')).toHaveLength(1))

    // 等一个微任务窗口，确认没有偷跑
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(callsTo('operator-management/performance')).toHaveLength(0)
    expect(callsTo('commission-management/records')).toHaveLength(0)
    expect(callsTo('commission-management/ratio-overrides')).toHaveLength(0)
  })

  it('首次切到运营绩效 / 运营佣金 tab 才各自拉数', async () => {
    const user = userEvent.setup()
    render(<OperatorManagementPage />)
    await waitFor(() => expect(callsTo('commission-management/role-assignments')).toHaveLength(1))

    await user.click(screen.getByRole('tab', { name: '运营绩效' }))
    await waitFor(() => expect(callsTo('operator-management/performance')).toHaveLength(1))

    await user.click(screen.getByRole('tab', { name: '运营佣金' }))
    await waitFor(() => expect(callsTo('commission-management/records')).toHaveLength(1))
    await waitFor(() => expect(callsTo('commission-management/ratio-overrides')).toHaveLength(1))
  })
})
