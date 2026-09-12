import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * BLF-1032：订阅管理页的批量操作与筛选空态。
 *
 * 断言口径为「用户可观察的行为」：勾选后命令条出现及计数、点击批量按钮实际发出的请求
 * （方法 + 目标 id + 请求体）、部分失败时失败行的保留策略、筛选无结果时的出口。
 * 不断言 class，也不断言调用了哪个内部函数。
 *
 * 注意：桌面表格与手机卡片同时存在于 DOM（断点由 CSS 控制，jsdom 不生效），所以所有
 * 行内查询都必须限定作用域。
 */

const notifyMock = vi.fn()
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: notifyMock }),
}))

const confirmMock = vi.fn(async () => true)
vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}))

// 注意：mock 必须返回**稳定引用**——组件内 fetch effect 依赖 [session]，
// 每次渲染新对象会形成「新 session → 重新拉数 → setState → 新 session」死循环。
const MOCK_SESSION = vi.hoisted(() => ({
  data: { user: { roleType: 'admin', operatorNameZh: '测试', id: '1' } },
  status: 'authenticated',
}))
vi.mock('next-auth/react', () => ({
  useSession: () => MOCK_SESSION,
}))

// mock 句柄用静态导入 + vi.mocked 提取（模块路径在编写期已知，无需动态 import）
vi.mock('@/lib/api/ai-chat-config-store', () => ({
  ensureConfigLoaded: vi.fn(async () => ({
    providerConfigured: true,
    models: ['gpt-5', 'gpt-5-mini'],
    defaultModel: 'gpt-5',
    premiumModels: ['gpt-5'],
    basicModels: ['gpt-5-mini'],
  })),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(async () => [
    { id: 3, name: '铨富 US' },
    { id: 4, name: '铨富 UK' },
  ]),
}))

vi.mock('./CreateSubscriptionDialog', () => ({
  CreateSubscriptionDialog: () => null,
}))
vi.mock('./EditSubscriptionDialog', () => ({
  EditSubscriptionDialog: () => null,
}))

import SubscriptionsView from './SubscriptionsView'
import { ensureConfigLoaded } from '@/lib/api/ai-chat-config-store'
import type { Subscription } from './types'

function makeSub(overrides: Partial<Subscription> & { id: number }): Subscription {
  return {
    user_id: 1,
    email: `u${overrides.id}@example.com`,
    project_ids: '3',
    country: 'US',
    frequency: 'daily',
    dispatch_hour: 9,
    dispatch_minute: 0,
    dispatch_weekday: 0,
    dispatch_day: 1,
    ai_model: 'gpt-5',
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const SUBS = [makeSub({ id: 1 }), makeSub({ id: 2, country: 'UK' }), makeSub({ id: 3 })]

type Recorded = { method: string; id: string; body: unknown }

let requests: Recorded[] = []

/** 拦 fetch：记录写请求，GET 订阅列表返回固定数据 */
function installFetch(failingIds: number[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'PUT' || method === 'DELETE') {
        const id = url.split('/').pop() ?? ''
        requests.push({
          method,
          id,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        return new Response('后端拒绝', {
          status: failingIds.includes(Number(id)) ? 500 : 200,
        })
      }
      if (url.includes('/scheduled-reports/subscriptions')) {
        return new Response(JSON.stringify({ items: SUBS }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }),
  )
}

async function renderView() {
  render(<SubscriptionsView />)
  await screen.findByRole('table', { name: '订阅列表' })
}

/** 桌面表格内某邮箱那一行的勾选框（按邮箱限定，避免与手机卡片重名） */
function rowCheckbox(email: string) {
  const table = screen.getByRole('table', { name: '订阅列表' })
  return within(table).getByRole('checkbox', { name: new RegExp(email) })
}

/** 命令条在桌面/手机各有一份（同为一次选择态），取第一份断言即可 */
function bulkBar() {
  return within(screen.getAllByTestId('subscriptions-bulk-bar')[0]!)
}

describe('SubscriptionsView 批量操作（BLF-1032）', () => {
  beforeEach(() => {
    requests = []
    notifyMock.mockClear()
    confirmMock.mockReset()
    confirmMock.mockResolvedValue(true)
    // ensureConfigLoaded 默认走 vi.mock 工厂里的成功实现；失败注入只在需要的
    // 用例里 mockRejectedValueOnce，这里清掉上一条用例残留的一次性队列。
    vi.mocked(ensureConfigLoaded).mockReset()
    vi.mocked(ensureConfigLoaded).mockResolvedValue({
      providerConfigured: true,
      models: ['gpt-5', 'gpt-5-mini'],
      defaultModel: 'gpt-5',
      premiumModels: ['gpt-5'],
      basicModels: ['gpt-5-mini'],
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未勾选时不显示命令条，勾选 2 行后出现且计数为 2', async () => {
    installFetch()
    await renderView()
    expect(screen.queryByTestId('subscriptions-bulk-bar')).toBeNull()

    const user = userEvent.setup()
    await user.click(rowCheckbox('u1@example.com'))
    await user.click(rowCheckbox('u2@example.com'))

    expect(bulkBar().getByText('已选 2 条')).toBeInTheDocument()
  })

  it('批量暂停只对选中的行发 PUT，请求体为 {"enabled":false}', async () => {
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u1@example.com'))
    await user.click(rowCheckbox('u3@example.com'))
    await user.click(bulkBar().getByRole('button', { name: '暂停' }))

    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.map((r) => [r.method, r.id, r.body])).toEqual([
      ['PUT', '1', { enabled: false }],
      ['PUT', '3', { enabled: false }],
    ])
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', title: '已暂停' }))
    // 全部成功 → 选择集清空、命令条消失
    await waitFor(() => expect(screen.queryByTestId('subscriptions-bulk-bar')).toBeNull())
  })

  it('批量修改模型：请求体只带 ai_model', async () => {
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u1@example.com'))
    await user.click(bulkBar().getByLabelText('批量修改 AI 模型'))
    await user.click(await screen.findByRole('option', { name: 'gpt-5-mini' }))
    await user.click(bulkBar().getByRole('button', { name: '应用模型' }))

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      id: '1',
      body: { ai_model: 'gpt-5-mini' },
    })
  })

  it('部分失败时按「N 成功 / M 失败」提示，且保留选择以便重试', async () => {
    installFetch([2]) // id 2 后端拒绝
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u1@example.com'))
    await user.click(rowCheckbox('u2@example.com'))
    await user.click(bulkBar().getByRole('button', { name: '暂停' }))

    await waitFor(() => expect(requests).toHaveLength(2))
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        title: '已暂停：1 条成功 / 1 条失败',
      }),
    )
    expect(bulkBar().getByText('已选 2 条')).toBeInTheDocument()
  })

  it('批量删除先经确认，确认后按 DELETE 发请求并移除该行', async () => {
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u2@example.com'))
    await user.click(bulkBar().getByRole('button', { name: '删除' }))

    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ method: 'DELETE', id: '2' })
    await waitFor(() => expect(screen.queryAllByText('u2@example.com')).toHaveLength(0))
    expect(screen.getByRole('table', { name: '订阅列表' })).toBeInTheDocument()
  })

  it('取消确认后不发任何写请求', async () => {
    confirmMock.mockResolvedValue(false)
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u1@example.com'))
    await user.click(bulkBar().getByRole('button', { name: '删除' }))

    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(requests).toHaveLength(0)
  })

  it('筛选无结果时给出空态与「清空筛选条件」出口，且不显示空表格', async () => {
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('筛选邮箱'), 'nobody@nowhere.test')

    expect(await screen.findByText('没有符合筛选条件的订阅')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '订阅列表' })).toBeNull()
    expect(screen.getByText('0 / 3 条')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清空筛选条件' }))
    expect(await screen.findByRole('table', { name: '订阅列表' })).toBeInTheDocument()
  })

  // 该用例含 3 次勾选交互 + 2 轮配置请求 + 下拉展开，jsdom 高负载下 5s 默认超时不够（与前两条批量用例同理）
  it('模型配置请求失败后可重试：再次勾选行时重新发起配置请求（review 修复 2）', { timeout: 15000 }, async () => {
    const ensureMock = vi.mocked(ensureConfigLoaded)
    // 第 1 次失败 / 第 2 次成功
    ensureMock
      .mockRejectedValueOnce(new Error('config down'))
      .mockResolvedValueOnce({
        providerConfigured: true,
        models: ['gpt-5', 'gpt-5-mini'],
        defaultModel: 'gpt-5',
        premiumModels: ['gpt-5'],
        basicModels: ['gpt-5-mini'],
      })
    installFetch()
    await renderView()
    const user = userEvent.setup()
    // 第一次进入选择态 → 配置请求失败，命令条模型下拉无可用选项
    await user.click(rowCheckbox('u1@example.com'))
    await waitFor(() => expect(ensureMock).toHaveBeenCalledTimes(1))
    const bar1 = screen.getAllByTestId('subscriptions-bulk-bar')[0]!
    expect(within(bar1).getByRole('combobox', { name: '批量修改 AI 模型' })).toHaveTextContent(
      '选择 AI 模型',
    )

    // 清空选择再重新进入 → 哨兵已复位，配置请求重发且这次成功，下拉出现选项
    await user.click(within(bar1).getByRole('button', { name: '清空选择' }))
    await user.click(rowCheckbox('u1@example.com'))
    await waitFor(() => expect(ensureMock).toHaveBeenCalledTimes(2))
    const trigger = within(screen.getAllByTestId('subscriptions-bulk-bar')[0]!).getByRole(
      'combobox',
      { name: '批量修改 AI 模型' },
    )
    await user.click(trigger)
    expect(await screen.findByRole('option', { name: 'gpt-5-mini' })).toBeInTheDocument()
  })

  it('桌面视口（jsdom 默认 1024px）下筛选器的「全部」选项保持完整文案「全部频率」（review 修复 1 桌面回归）', async () => {
    installFetch()
    await renderView()
    // jsdom 视口 1024 ≥ md 断点 → useMobile() 为 false → 桌面分支；
    // 频率触发器没有独立 aria-label，用首个含「全部频率」的 combobox 断言
    expect(screen.getAllByRole('combobox').some((c) => c.textContent === '全部频率')).toBe(true)
  })
})
