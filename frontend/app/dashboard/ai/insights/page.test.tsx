import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

// BEL-424 契约测试：AI 洞察页的模型配置不再 mount 即拉 ——
// 推迟到生成弹窗首次打开，且复用 ai-chat 配置 store（跨页共享、在途去重）。

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('project_id=1'),
  usePathname: () => '/dashboard/ai/insights',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

const mockSession = { user: { id: 'user-1', name: '张三', roleType: 'admin' } }
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: 'authenticated' }),
}))

// notify 必须返回稳定引用（生产实现是 useCallback([])），否则依赖 notify 的
// effect 会在每次渲染重跑，制造假死循环。
const notifyMock = vi.fn()
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: notifyMock }),
  NotificationsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(false) }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '测试项目' }]),
}))

const ensureConfigLoaded = vi.fn()
vi.mock('@/lib/api/ai-chat-config-store', () => ({
  ensureConfigLoaded: (...args: unknown[]) => ensureConfigLoaded(...args),
  getConfig: () => null,
}))

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

class EventSourceStub {
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, Array<(e: { data: string }) => void>>()
  addEventListener(type: string, handler: (e: { data: string }) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: (e: { data: string }) => void) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((h) => h !== handler)
    )
  }
  close() {}
}

import AiInsightsPage from './page'

describe('AiInsightsPage 模型配置懒加载（BEL-424）', () => {
  beforeEach(() => {
    ensureConfigLoaded.mockResolvedValue({
      providerConfigured: true,
      models: ['gpt-test'],
      defaultModel: 'gpt-test',
      premiumModels: [],
      basicModels: ['gpt-test'],
    })
    vi.stubGlobal('EventSource', EventSourceStub)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/api/backend/v1/ai-insights/generate')) {
        return jsonResponse({ insight_id: 99 })
      }
      if (url.includes('/api/backend/v1/ai-insights/schedules')) {
        return jsonResponse({ items: [] })
      }
      if (url.includes('/api/backend/v1/ai-insights')) {
        return jsonResponse({ items: [] })
      }
      return jsonResponse({})
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ensureConfigLoaded.mockReset()
  })

  it('mount 不拉模型配置（/api/ai-chat/config 0 请求、store 不调用）', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    render(<AiInsightsPage />)

    // 等 mount 侧 effect 都跑完（insights 列表请求会发出）
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/backend/v1/ai-insights?'))
      ).toBe(true)
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(ensureConfigLoaded).not.toHaveBeenCalled()
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/ai-chat/config'))
    ).toHaveLength(0)
  })

  it('首次打开生成弹窗才经共享 store 拉模型配置（仅 1 次）', async () => {
    const user = userEvent.setup()
    render(<AiInsightsPage />)

    const generateButton = await screen.findByRole('button', { name: '生成洞察' })
    await user.click(generateButton)

    await waitFor(() => expect(ensureConfigLoaded).toHaveBeenCalledTimes(1))
  })
})
