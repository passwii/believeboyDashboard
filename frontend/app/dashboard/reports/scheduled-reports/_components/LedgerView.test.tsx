import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

const sessionState = vi.hoisted(() => ({ roleType: null as string | null }))

vi.mock('next-auth/react', () => ({
  useSession: () =>
    sessionState.roleType
      ? stableSession({ user: { roleType: sessionState.roleType } })
      : stableSession({ data: null, status: 'unauthenticated' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: (...args: unknown[]) => projectsMock(...args),
}))

const fetchLedgerMock = vi.hoisted(() => vi.fn())
const projectsMock = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({
  fetchLedger: (...args: unknown[]) => fetchLedgerMock(...args),
  fetchLedgerItemByKey: vi.fn(async () => null),
  fetchModelConfig: vi.fn(),
  fetchSubscriptions: vi.fn(),
  pollDeliveryLogStatus: vi.fn(),
  pollLedgerAiSummaryStatus: vi.fn(),
  regenerateLedgerAiSummary: vi.fn(),
  resendLedgerEntry: vi.fn(),
}))

import LedgerView from './LedgerView'
import type { LedgerItem } from './types'

function makeItem(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: 1,
    ledger_key: 'lk-1',
    expected_date: '2026-11-18',
    expected_at: '2026-11-18T15:10:00+08:00',
    frequency: 'daily',
    subscription_id: 7,
    email: null,
    project_ids: '*',
    project_names: ['全部项目'],
    country: 'US',
    status: 'sent',
    latest_delivery_log_id: null,
    error_message: null,
    sent_at: null,
    email_sent: false,
    can_resend: true,
    last_checked_at: null,
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: null,
    ai_summary_status: 'pending',
    ai_summary_error: null,
    ai_summary_model: null,
    ai_summary_updated_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  sessionState.roleType = null
  fetchLedgerMock.mockReset()
  projectsMock.mockReset()
  projectsMock.mockResolvedValue([])
  fetchLedgerMock.mockImplementation(
    async (
      _params: unknown,
      onData: (items: LedgerItem[], summary: null, total: number) => void
    ) => {
      onData([], null, 0)
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LedgerView Warm 文案字体与状态分离', () => {
  it('空状态文案使用 sans，不把普通说明渲染为 mono', async () => {
    render(<LedgerView />)

    const emptyLabels = await screen.findAllByText('暂无台账记录')
    expect(emptyLabels.length).toBeGreaterThan(0)
    for (const label of emptyLabels) {
      expect(label).toHaveClass('font-sans')
      expect(label).not.toHaveClass('font-mono')
    }
  })

  it('加载中显示骨架，且不与空态混用', async () => {
    fetchLedgerMock.mockImplementation(() => new Promise<never>(() => {}))
    render(<LedgerView />)

    expect(screen.getByLabelText('台账加载中')).toBeInTheDocument()
    expect(screen.queryByText('暂无台账记录')).toBeNull()
  })

  it('加载失败时显示错误态与重试，不伪装成「暂无台账记录」空态', async () => {
    fetchLedgerMock.mockImplementation(
      async (
        _params: unknown,
        _onData: unknown,
        onError: (message: string) => void
      ) => {
        onError('定时报告服务未配置，请联系管理员')
      }
    )
    render(<LedgerView />)

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((alert) => alert.textContent?.includes('台账加载失败'))).toBe(true)
    expect(
      alerts.some((alert) => alert.textContent?.includes('定时报告服务未配置，请联系管理员'))
    ).toBe(true)
    expect(screen.queryByText('暂无台账记录')).toBeNull()
    expect(screen.getAllByRole('button', { name: '重新加载' }).length).toBeGreaterThan(0)
  })

  it('已有数据时刷新失败保留旧数据并就地提示错误', async () => {
    let call = 0
    fetchLedgerMock.mockImplementation(
      async (
        _params: unknown,
        onData: (items: LedgerItem[], summary: null, total: number) => void,
        onError: (message: string) => void
      ) => {
        call += 1
        if (call === 1) {
          onData([makeItem({ status: 'missing', email: null })], null, 1)
          return
        }
        onError('服务暂时不可用，请稍后重试')
      }
    )
    render(<LedgerView />)

    await screen.findAllByText('全部项目')
    const refresh = screen.getAllByRole('button', { name: '刷新台账' })[0]!
    await waitFor(() => expect(refresh).toBeEnabled())
    fireEvent.click(refresh)

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((alert) => alert.textContent?.includes('服务暂时不可用'))).toBe(true)
    expect(screen.queryByText('暂无台账记录')).toBeNull()
    expect(screen.getAllByText('全部项目').length).toBeGreaterThan(0)
  })
})

describe('LedgerView 汇总与后端 summary', () => {
  it('渲染后端 summary 的 5 个数字与「已完成含仅生成」说明', async () => {
    fetchLedgerMock.mockImplementation(
      async (
        _params: unknown,
        onData: (
          items: LedgerItem[],
          summary: { expected: number; sent: number; failed: number; missing: number; resendable: number },
          total: number
        ) => void
      ) => {
        onData(
          [makeItem()],
          { expected: 10, sent: 8, failed: 1, missing: 1, resendable: 2 },
          10
        )
      }
    )
    render(<LedgerView />)

    const summary = await screen.findByLabelText('当前筛选汇总')
    for (const label of ['应发', '已完成', '失败', '缺失', '可重新生成']) {
      expect(within(summary).getByText(label)).toBeInTheDocument()
    }
    expect(within(summary).getByText('10')).toBeInTheDocument()
    expect(screen.getByText('已完成含「仅生成」')).toBeInTheDocument()
    expect(screen.getByTestId('ledger-total-count')).toHaveTextContent('共 10 条')
  })
})

describe('LedgerView 无邮箱 / 状态语义', () => {
  it('历史 email=null + email_sent=true 和 email 有值 + email_sent=false 都显示「仅生成」', async () => {
    fetchLedgerMock.mockImplementation(
      async (_params: unknown, onData: (items: LedgerItem[], summary: null, total: number) => void) => {
        onData(
          [
            makeItem({
              ledger_key: 'historical',
              project_names: ['历史项目'],
              email: null,
              email_sent: true,
              status: 'sent',
            }),
            makeItem({
              ledger_key: 'regenerated',
              project_names: ['重新生成项目'],
              email: 'ops@example.com',
              email_sent: false,
              status: 'sent',
            }),
          ],
          null,
          2
        )
      }
    )
    render(<LedgerView />)

    await screen.findAllByText('历史项目')
    expect(screen.getAllByText('仅生成，不发送').length).toBeGreaterThan(0)
    // 桌面表格 + 手机卡片都会渲染状态，这里只要求不存在误导性的「已发送」。
    expect(screen.getAllByText('仅生成').length).toBeGreaterThan(0)
    expect(screen.queryByText('已发送')).toBeNull()
    expect(screen.getByText('ops@example.com')).toBeInTheDocument()
  })

  it('错误态与空态不会同时出现', async () => {
    fetchLedgerMock.mockImplementation(
      async (_params: unknown, _onData: unknown, onError: (message: string) => void) => {
        onError('HTTP 503')
      }
    )
    render(<LedgerView />)

    await screen.findByText('台账加载失败')
    expect(screen.queryByText('暂无台账记录')).toBeNull()
  })
})

describe('LedgerView 项目筛选', () => {
  it('选择项目后按 project_id 重新请求台账', async () => {
    sessionState.roleType = 'admin'
    projectsMock.mockResolvedValue([{ id: 5, name: '项目E' }])
    const user = userEvent.setup()

    render(<LedgerView />)
    await waitFor(() => expect(projectsMock).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('combobox', { name: '按项目筛选' }))
    await user.click(await screen.findByRole('option', { name: '项目E' }))

    await waitFor(() => {
      const calls = fetchLedgerMock.mock.calls as Array<[Record<string, unknown>]>
      expect(calls.some((call) => call[0]?.projectId === '5')).toBe(true)
    })
    const calls = fetchLedgerMock.mock.calls as Array<[Record<string, unknown>]>
    expect(calls[0]?.[0]?.projectId).toBe('')
  })

  it('fetchLedger 把项目筛选写入请求 URL 的 project_id', async () => {
    const actual = await vi.importActual<typeof import('./api')>('./api')
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [],
            summary: { expected: 0, sent: 0, failed: 0, missing: 0, resendable: 0 },
            total: 0,
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const onData = vi.fn()
    const onError = vi.fn()

    await actual.fetchLedger(
      {
        startDate: '2026-11-12',
        endDate: '2026-11-18',
        frequency: 'all',
        statusFilter: 'all',
        email: '',
        projectId: '42',
      },
      onData,
      onError
    )

    expect(onError).not.toHaveBeenCalled()
    expect(onData).toHaveBeenCalled()
    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('project_id=42')
  })
})

describe('LedgerView 重新生成入口与权限', () => {
  it('管理员可对无邮箱行打开重新生成入口，并明确不会发送邮件', async () => {
    sessionState.roleType = 'admin'
    fetchLedgerMock.mockImplementation(
      async (_params: unknown, onData: (items: LedgerItem[], summary: null, total: number) => void) => {
        onData([makeItem({ status: 'missing', email: null })], null, 1)
      }
    )
    render(<LedgerView />)

    await screen.findAllByText('仅生成，不发送')
    const triggers = screen.getAllByRole('button', { name: '重新生成' })
    expect(triggers.length).toBeGreaterThan(0)
    expect(triggers[0]).toBeEnabled()

    fireEvent.click(triggers[0]!)
    expect(await screen.findByText(/不会发送邮件/)).toBeInTheDocument()
  })

  it('非管理员不显示重新生成入口', async () => {
    fetchLedgerMock.mockImplementation(
      async (_params: unknown, onData: (items: LedgerItem[], summary: null, total: number) => void) => {
        onData([makeItem({ status: 'missing', email: null })], null, 1)
      }
    )
    render(<LedgerView />)

    await screen.findAllByText('仅生成，不发送')
    expect(screen.queryAllByRole('button', { name: '重新生成' }).length).toBe(0)
  })
})

describe('LedgerView 日组默认展开', () => {
  it('endDate 当天无数据时仍默认展开有记录的日组（11-13 行可见），手动折叠在刷新后保持', async () => {
    fetchLedgerMock.mockImplementation(
      async (_params: unknown, onData: (items: LedgerItem[], summary: null, total: number) => void) => {
        onData(
          [
            makeItem({
              ledger_key: 'older-day',
              expected_date: '2026-11-13',
              expected_at: '2026-11-13T15:10:00+08:00',
              project_names: ['历史日项目'],
            }),
          ],
          null,
          1
        )
      }
    )
    render(<LedgerView />)

    const table = await screen.findByRole('table', { name: '台账明细' })
    expect(within(table).getByText('历史日项目')).toBeInTheDocument()
    const dayHead = screen.getByRole('button', { name: /2026-11-13/ })
    expect(dayHead).toHaveAttribute('aria-expanded', 'true')

    // 用户手动折叠后，常规刷新（同一日期/筛选）不再强制展开。
    fireEvent.click(dayHead)
    expect(within(table).queryByText('历史日项目')).toBeNull()

    const refresh = screen.getAllByRole('button', { name: '刷新台账' })[0]!
    await waitFor(() => expect(refresh).toBeEnabled())
    fireEvent.click(refresh)
    await waitFor(() => expect(fetchLedgerMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /2026-11-13/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(within(table).queryByText('历史日项目')).toBeNull()
  })
})

describe('LedgerView 页脚范围与查看更早', () => {
  it('「查看更早 7 天」移动日期范围并复用 loadLedger', async () => {
    fetchLedgerMock.mockImplementation(
      async (_params: unknown, onData: (items: LedgerItem[], summary: null, total: number) => void) => {
        onData([], null, 0)
      }
    )
    render(<LedgerView />)

    await waitFor(() => expect(fetchLedgerMock).toHaveBeenCalledTimes(1))
    const firstParams = fetchLedgerMock.mock.calls[0]![0] as {
      startDate: string
      endDate: string
    }

    fireEvent.click(screen.getByRole('button', { name: '查看更早 7 天' }))

    await waitFor(() => expect(fetchLedgerMock).toHaveBeenCalledTimes(2))
    const secondParams = fetchLedgerMock.mock.calls[1]![0] as {
      startDate: string
      endDate: string
    }
    expect(secondParams.endDate < firstParams.startDate).toBe(true)
    expect(secondParams.startDate < secondParams.endDate).toBe(true)
  })
})
