import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'

/**
 * 订阅管理页（方案 A）行为契约。
 *
 * 断言口径为「用户可观察的行为」：筛选 / 批量 / 启停 / 删除、空态分离、
 * 无邮箱文案、单条失败通知，以及桌面表格与手机卡片不重复渲染的结构契约。
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
  data: { user: { roleType: 'admin', name: '测试', id: '1' } },
  status: 'authenticated',
}))
vi.mock('next-auth/react', () => ({
  useSession: () => MOCK_SESSION,
}))

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
  SubscriptionDialogFrame: ({ children }: { children?: ReactNode }) => children,
}))
vi.mock('./EditSubscriptionDialog', () => ({
  EditSubscriptionDialog: () => null,
}))

import SubscriptionsView from './SubscriptionsView'
import { ensureConfigLoaded } from '@/lib/api/ai-chat-config-store'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import type { Subscription } from './types'
import styles from './subscriptions-warm.module.css'

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
function installFetch(
  failingIds: number[] = [],
  listResponse?: () => Response | Promise<Response>,
) {
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
        return listResponse
          ? await listResponse()
          : new Response(JSON.stringify({ items: SUBS }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }),
  )
}

async function renderView(onRefreshReady?: (refresh: () => Promise<void>) => void) {
  const view = render(<SubscriptionsView onRefreshReady={onRefreshReady} />)
  await screen.findByRole('table', { name: '订阅列表' })
  return view
}

function desktopTable() {
  return screen.getByRole('table', { name: '订阅列表' })
}

/** 桌面表格内某邮箱那一行的勾选框（按邮箱限定，避免与手机卡片重名） */
function rowCheckbox(email: string) {
  return within(desktopTable()).getByRole('checkbox', { name: new RegExp(email) })
}

/** 命令条在桌面/手机各有一份（同为一次选择态），取第一份断言即可 */
function bulkBar() {
  return within(screen.getAllByTestId('subscriptions-bulk-bar')[0]!)
}

const COMPONENT_DIR = join(
  process.cwd(),
  'app/dashboard/reports/scheduled-reports/_components'
)
const VIEW_SOURCE = readFileSync(join(COMPONENT_DIR, 'SubscriptionsView.tsx'), 'utf8')
const FORM_SOURCE = readFileSync(join(COMPONENT_DIR, 'SubscriptionForm.tsx'), 'utf8')
const CREATE_SOURCE = readFileSync(join(COMPONENT_DIR, 'CreateSubscriptionDialog.tsx'), 'utf8')
const EDIT_SOURCE = readFileSync(join(COMPONENT_DIR, 'EditSubscriptionDialog.tsx'), 'utf8')
const PAGE_CSS = readFileSync(join(COMPONENT_DIR, 'subscriptions-warm.module.css'), 'utf8')

describe('SubscriptionsView 批量操作（BLF-1032）', () => {
  beforeEach(() => {
    requests = []
    notifyMock.mockClear()
    confirmMock.mockReset()
    confirmMock.mockResolvedValue(true)
    MOCK_SESSION.data.user.roleType = 'admin'
    vi.mocked(ensureConfigLoaded).mockReset()
    vi.mocked(ensureConfigLoaded).mockResolvedValue({
      providerConfigured: true,
      models: ['gpt-5', 'gpt-5-mini'],
      defaultModel: 'gpt-5',
      premiumModels: ['gpt-5'],
      basicModels: ['gpt-5-mini'],
      webSearchConfigured: false,
      reasoningModels: [],
      defaultReasoningEffort: 'medium',
      timeoutSeconds: 60,
      maxConversationTurns: 20,
      webSearchMaxResults: 5,
      overviewOptions: [],
      detailOptions: [],
      scenarios: [],
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

  it('首次加载失败时显示错误态与重试，不伪装成「暂无订阅配置」', async () => {
    installFetch([], () => new Response('服务暂不可用', { status: 503 }))
    render(<SubscriptionsView />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('订阅列表加载失败')).toBeInTheDocument()
    expect(within(alert).getByText('订阅列表请求失败（HTTP 503）')).toBeInTheDocument()
    expect(screen.queryByText('暂无订阅配置')).toBeNull()
    // 首次失败走页面错误态，不弹「订阅数据刷新失败」toast
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('错误态重试成功后恢复订阅表格并清除错误', async () => {
    let listRequest = 0
    installFetch([], () => {
      listRequest += 1
      return listRequest === 1
        ? new Response('服务暂不可用', { status: 503 })
        : new Response(JSON.stringify({ items: SUBS }), { status: 200 })
    })
    render(<SubscriptionsView />)

    const alert = await screen.findByRole('alert')
    const user = userEvent.setup()
    await user.click(within(alert).getByRole('button', { name: '重试' }))

    const table = await screen.findByRole('table', { name: '订阅列表' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(table).getByText('u1@example.com')).toBeInTheDocument()
  })

  it('接口成功返回空列表时仍显示「暂无订阅配置」空态', async () => {
    installFetch([], () => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    render(<SubscriptionsView />)

    await screen.findByText('暂无订阅配置')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('table', { name: '订阅列表' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '新增订阅' }).length).toBeGreaterThan(0)
  })

  it('项目清单请求失败不影响订阅列表展示（名称退化为项目 ID）', async () => {
    vi.mocked(fetchManagedProjectsCached).mockRejectedValueOnce(new Error('项目接口不可用'))
    installFetch()
    render(<SubscriptionsView />)

    await screen.findByRole('table', { name: '订阅列表' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByText('项目3').length).toBeGreaterThan(0)
  })

  it('订阅面板与表格使用 Warm Ledger 本地表面，宽表在自身容器内滚动', async () => {
    installFetch()
    const { container } = await renderView()

    expect(container.querySelector('[data-warm-scheduled-subscriptions="true"]')).toBeInTheDocument()
    const table = desktopTable()
    expect(table.parentElement).toHaveAttribute(
      'data-scheduled-subscriptions-table-scroll',
      'true'
    )
    expect(table.className).not.toMatch(/term-|rounded-none/)
    expect(PAGE_CSS).toMatch(/\.table\s*\{[^}]*min-width:\s*1080px/)
    expect(PAGE_CSS).toMatch(/\.tableScroller\s*\{[^}]*overflow-x:\s*auto/)
  })

  it('桌面视口只显示表格：手机卡片保留但由桌面断点 display:none', async () => {
    installFetch()
    const { container } = await renderView()

    const mobileList = screen.getByTestId('subscriptions-mobile-list')
    expect(mobileList).toHaveClass('md:hidden')
    const tableScroller = container.querySelector(
      '[data-scheduled-subscriptions-table-scroll="true"]'
    )!
    expect(tableScroller).toHaveClass('hidden', 'md:block')
    expect(PAGE_CSS).toMatch(
      /@media \(min-width: 768px\)[\s\S]*\.mobileList\s*\{[^}]*display:\s*none/
    )
    // DOM 中两侧都在（jsdom 不跑断点），但桌面断言只看表格；二者不共用同一渲染分支。
    expect(mobileList).toBeInTheDocument()
  })

  it('订阅行按方案 A 呈现项目/站点、北京时间+频率、邮箱与模型', async () => {
    installFetch()
    await renderView()
    const table = desktopTable()

    expect(within(table).getAllByText('铨富 US').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('美国站').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('09:00').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('每日').length).toBeGreaterThan(0)
    expect(within(table).getByText('u1@example.com')).toBeInTheDocument()
    expect(within(table).getAllByText('gpt-5').length).toBeGreaterThan(0)
    expect(
      within(table).getAllByRole('switch', { name: /暂停订阅：铨富 US/ }).length
    ).toBeGreaterThan(0)
  })

  it('只读权限（canManage=false）不渲染新增/编辑/删除/启停控件', async () => {
    MOCK_SESSION.data.user.roleType = 'viewer'
    installFetch()
    await renderView()
    const table = desktopTable()

    expect(screen.queryByRole('button', { name: '新增订阅' })).toBeNull()
    const row = within(table).getByText('u1@example.com').closest('tr')!
    expect(within(row).queryByRole('switch')).toBeNull()
    expect(within(row).queryByRole('button', { name: '编辑订阅' })).toBeNull()
    expect(within(row).queryByRole('button', { name: '删除订阅' })).toBeNull()
    expect(within(row).getByText('启用')).toBeInTheDocument()
  })

  it('Head 刷新遇到 HTTP 错误时保留现有订阅并提示错误', async () => {
    let listRequest = 0
    installFetch([], () => {
      listRequest += 1
      return listRequest === 1
        ? new Response(JSON.stringify({ items: SUBS }), { status: 200 })
        : new Response('服务暂不可用', { status: 503 })
    })
    let refresh = async () => {}
    await renderView((handler) => {
      refresh = handler
    })

    await act(async () => {
      await refresh()
    })

    expect(within(desktopTable()).getByText('u1@example.com')).toBeInTheDocument()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: '订阅数据刷新失败',
        message: '订阅列表请求失败（HTTP 503）',
      })
    )
  })

  it('Head 刷新遇到网络错误时保留现有订阅并提示错误', async () => {
    let listRequest = 0
    installFetch([], () => {
      listRequest += 1
      if (listRequest === 1) return new Response(JSON.stringify({ items: SUBS }), { status: 200 })
      throw new Error('network offline')
    })
    let refresh = async () => {}
    await renderView((handler) => {
      refresh = handler
    })

    await act(async () => {
      await refresh()
    })

    expect(within(desktopTable()).getByText('u1@example.com')).toBeInTheDocument()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: '订阅数据刷新失败',
        message: 'network offline',
      })
    )
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
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: '已暂停' })
    )
    await waitFor(() => expect(screen.queryByTestId('subscriptions-bulk-bar')).toBeNull())
  })

  it('批量修改模型：请求体只带 ai_model', async () => {
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u1@example.com'))
    await waitFor(() =>
      expect(bulkBar().getByRole('combobox', { name: '批量修改 AI 模型' })).toBeEnabled()
    )
    await user.click(bulkBar().getByRole('combobox', { name: '批量修改 AI 模型' }))
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
      })
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
    expect(desktopTable()).toBeInTheDocument()
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

  // 该用例含 3 次勾选交互 + 2 轮配置请求 + 下拉展开，jsdom 高负载下 5s 默认超时不够
  it('模型配置请求失败后可重试：再次勾选行时重新发起配置请求', { timeout: 15000 }, async () => {
    const ensureMock = vi.mocked(ensureConfigLoaded)
    ensureMock.mockRejectedValueOnce(new Error('config down')).mockResolvedValueOnce({
      providerConfigured: true,
      models: ['gpt-5', 'gpt-5-mini'],
      defaultModel: 'gpt-5',
      premiumModels: ['gpt-5'],
      basicModels: ['gpt-5-mini'],
      webSearchConfigured: false,
      reasoningModels: [],
      defaultReasoningEffort: 'medium',
      timeoutSeconds: 60,
      maxConversationTurns: 20,
      webSearchMaxResults: 5,
      overviewOptions: [],
      detailOptions: [],
      scenarios: [],
    })
    installFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(rowCheckbox('u1@example.com'))
    await waitFor(() => expect(ensureMock).toHaveBeenCalledTimes(1))
    const bar1 = screen.getAllByTestId('subscriptions-bulk-bar')[0]!
    expect(within(bar1).getByRole('combobox', { name: '批量修改 AI 模型' })).toHaveTextContent(
      '选择 AI 模型'
    )

    await user.click(within(bar1).getByRole('button', { name: '清空选择' }))
    await user.click(rowCheckbox('u1@example.com'))
    await waitFor(() => expect(ensureMock).toHaveBeenCalledTimes(2))
    const trigger = within(screen.getAllByTestId('subscriptions-bulk-bar')[0]!).getByRole(
      'combobox',
      { name: '批量修改 AI 模型' }
    )
    await user.click(trigger)
    expect(await screen.findByRole('option', { name: 'gpt-5-mini' })).toBeInTheDocument()
  })

  it('桌面视口下筛选器保持完整文案「全部频率」', async () => {
    installFetch()
    await renderView()
    expect(screen.getByRole('combobox', { name: '按频率筛选' })).toHaveTextContent(
      '全部频率'
    )
    expect(screen.getByRole('combobox', { name: '按国家筛选' })).toHaveTextContent('全部国家')
    expect(screen.getByRole('combobox', { name: '按项目筛选' })).toHaveTextContent('全部项目')
  })
})

describe('SubscriptionsView 状态筛选 / 启停 / 单条失败', () => {
  beforeEach(() => {
    requests = []
    notifyMock.mockClear()
    confirmMock.mockReset()
    confirmMock.mockResolvedValue(true)
    MOCK_SESSION.data.user.roleType = 'admin'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const STATUS_SUBS = [
    makeSub({ id: 1 }),
    makeSub({ id: 4, email: null }),
    makeSub({ id: 5, enabled: false }),
  ]

  function installStatusFetch() {
    installFetch([], () =>
      new Response(JSON.stringify({ items: STATUS_SUBS }), { status: 200 })
    )
  }

  it('状态筛选：全部 / 启用 / 已暂停 / 仅生成 语义正确，重置恢复全量', async () => {
    installStatusFetch()
    await renderView()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '启用' }))
    expect(within(desktopTable()).queryByText('u5@example.com')).toBeNull()
    expect(within(desktopTable()).getByText('u1@example.com')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '已暂停' }))
    expect(within(desktopTable()).queryByText('u1@example.com')).toBeNull()
    expect(within(desktopTable()).getByText('u5@example.com')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '仅生成' }))
    expect(within(desktopTable()).queryByText('u1@example.com')).toBeNull()
    expect(within(desktopTable()).getByText('仅生成，不发送')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: '重置筛选' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '重置筛选' }))
    expect(screen.getByRole('button', { name: '重置筛选' })).toBeDisabled()
    expect(within(desktopTable()).getByText('u1@example.com')).toBeInTheDocument()
    expect(within(desktopTable()).getByText('u5@example.com')).toBeInTheDocument()
  })

  it('无邮箱订阅显示「仅生成，不发送」，不再显示「未填写」', async () => {
    installFetch([], () =>
      new Response(JSON.stringify({ items: [makeSub({ id: 4, email: null })] }), { status: 200 })
    )
    await renderView()

    expect(screen.getAllByText('仅生成，不发送').length).toBeGreaterThan(0)
    expect(screen.queryByText('未填写邮箱')).toBeNull()
    expect(screen.queryByText('未填写')).toBeNull()
  })

  it('状态 toggle 使用 role=switch + aria-checked，点击后 PUT enabled=false 并更新文案', async () => {
    installStatusFetch()
    await renderView()
    const user = userEvent.setup()
    const row = within(desktopTable()).getByText('u1@example.com').closest('tr')!
    const toggle = within(row).getByRole('switch', { name: /暂停订阅/ })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ method: 'PUT', id: '1', body: { enabled: false } })
    await waitFor(() =>
      expect(within(row).getByRole('switch', { name: /启用订阅/ })).toHaveAttribute(
        'aria-checked',
        'false'
      )
    )
    expect(within(row).getByText('已暂停')).toBeInTheDocument()
  })

  it('单条删除失败时提示可读错误，不静默吞掉', async () => {
    installFetch([2])
    await renderView()
    const user = userEvent.setup()
    const table = desktopTable()
    const row = within(table).getByRole('checkbox', { name: /u2@example.com/ }).closest('tr')!
    await user.click(within(row).getByRole('button', { name: '删除订阅' }))

    await waitFor(() =>
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: '删除订阅失败',
          message: '后端拒绝',
        })
      )
    )
    expect(within(table).getByText('u2@example.com')).toBeInTheDocument()
  })

  it('不再依赖 components/ui/select 或 V3 TimePicker（源码契约）', () => {
    for (const source of [VIEW_SOURCE, FORM_SOURCE, CREATE_SOURCE, EDIT_SOURCE]) {
      expect(source).not.toContain('@/components/ui/select')
      expect(source).not.toContain('components/ui/time-picker')
      expect(source).not.toContain('TimePicker')
    }
    expect(FORM_SOURCE).toContain('WarmSelect')
    expect(FORM_SOURCE).toContain('WarmSegmentedControl')
    expect(VIEW_SOURCE).toContain('WarmSegmentedControl')
  })

  it('筛选下拉单行省略、频率宽度 ≥120px，表格 100% 填满面板内容区', () => {
    // 104px 曾把「全部频率」折成两行；用 > span + nowrap/ellipsis 锁住回归。
    expect(PAGE_CSS).toMatch(/white-space:\s*nowrap/)
    expect(PAGE_CSS).toMatch(/text-overflow:\s*ellipsis/)
    expect(PAGE_CSS).toMatch(
      /@media \(min-width: 768px\)[\s\S]*\.filterField\s*\{[^}]*width:\s*120px/
    )
    expect(PAGE_CSS).toMatch(/@media \(min-width: 768px\)[\s\S]*\.filterFieldCountry\s*\{[^}]*width:\s*120px/)
    expect(PAGE_CSS).toMatch(/\.table\s*\{[^}]*width:\s*100%/)
  })

  it('新样式模块只使用 Warm Ledger token，不混入 term / 字面色值', () => {
    for (const css of [
      PAGE_CSS,
      readFileSync(join(COMPONENT_DIR, 'subscription-dialog-warm.module.css'), 'utf8'),
    ]) {
      expect(css).not.toMatch(/--term-/)
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
      expect(css).not.toMatch(/rgb\(|rgba\(|hsl\(|hsla\(/)
      expect(css).not.toMatch(/linear-gradient|radial-gradient/)
    }
    expect(styles.table).toBeTruthy()
  })
})
