import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

// BEL-424 契约测试：
// 1) projects/manage + operator-options 走 2min 客户端缓存（不再 mount 即裸 fetch）；
// 2) performance / commission 两个 tab 的数据首次激活才拉 —— mount 只拉
//    role-info（运营信息）一个业务端点。

const mockSession = {
  user: { id: 'user-1', roleType: 'admin', name: '张三' },
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

const OPERATOR_SOURCE_ROOT = join(process.cwd(), 'app/dashboard/system/operator-management')
const TERMINAL_VISUAL_RESIDUE = [
  { label: 'Terminal token', pattern: /--term-/g },
  { label: 'Terminal utility', pattern: /\bterm-[a-z0-9-]+/g },
  { label: 'Terminal zero-radius utility', pattern: /\brounded-none\b/g },
]

function collectOperatorSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectOperatorSourceFiles(path)
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return []
    return ['.css', '.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

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
    fetchMock.mock.calls.filter((call: Parameters<typeof fetch>) =>
      String(call[0]).includes(substr)
    )

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

  it('V4 Operator Management 源文件不重新引入 Terminal 视觉残留', () => {
    const violations = collectOperatorSourceFiles(OPERATOR_SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return TERMINAL_VISUAL_RESIDUE.flatMap(({ label, pattern }) =>
        Array.from(source.matchAll(pattern), (match) => ({
          path,
          label,
          match: match[0],
        }))
      )
    })

    expect(violations).toEqual([])
  })

  it('页面使用 Warm Ledger 表面并保留 24 个月核算范围', async () => {
    const user = userEvent.setup()
    const { container } = render(<OperatorManagementPage />)
    await waitFor(() => expect(callsTo('commission-management/role-assignments')).toHaveLength(1))

    expect(container.firstElementChild).toHaveAttribute('data-warm-operator-management', 'true')
    expect(screen.getByRole('tab', { name: '运营信息' })).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: '核算月份' }))
    expect(await screen.findAllByRole('option')).toHaveLength(24)
  })

  it('运营信息仍按原有 upsert 契约提交新增岗位', async () => {
    const user = userEvent.setup()
    render(<OperatorManagementPage />)
    await waitFor(() => expect(callsTo('commission-management/role-assignments')).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: '新增岗位' }))
    await user.click(screen.getByRole('button', { name: '保存运营信息' }))

    await waitFor(() =>
      expect(callsTo('commission-management/role-assignments/upsert')).toHaveLength(1)
    )
    const [input, init] = callsTo('commission-management/role-assignments/upsert')[0]
    expect(String(input)).toMatch(/\/commission-management\/role-assignments\/upsert$/)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [
        {
          id: null,
          project_id: 1,
          role_type: 'assistant',
          person_name: '张三',
          effective_from_month: expect.stringMatching(/^\d{4}-\d{2}$/),
          effective_to_month: null,
        },
      ],
    })
  })

  it('运营绩效仍按原有 upsert 契约提交周次与项目名', async () => {
    const user = userEvent.setup()
    render(<OperatorManagementPage />)
    await waitFor(() => expect(callsTo('commission-management/role-assignments')).toHaveLength(1))

    await user.click(screen.getByRole('tab', { name: '运营绩效' }))
    await waitFor(() => expect(callsTo('operator-management/performance')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: '新增绩效' }))
    await user.click(screen.getByRole('button', { name: '保存绩效' }))

    await waitFor(() =>
      expect(callsTo('operator-management/performance/upsert')).toHaveLength(1)
    )
    const [input, init] = callsTo('operator-management/performance/upsert')[0]
    expect(String(input)).toMatch(/\/operator-management\/performance\/upsert$/)
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [
        {
          id: null,
          report_month: expect.stringMatching(/^\d{4}-\d{2}$/),
          week_index: 1,
          project_id: 1,
          project_name: '测试项目',
          person_name: '张三',
          role_type: 'assistant',
          score: 0,
          note: null,
        },
      ],
    })
  })

  it('佣金调整仍按百分比转小数提交 ratio override', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('commission-management/role-assignments')) {
        return jsonResponse({ items: [] })
      }
      if (url.includes('commission-management/records')) {
        return jsonResponse({
          report_month: '2026-10',
          items: [
            {
              id: 9,
              report_month: '2026-10',
              project_id: 1,
              project_name: '测试项目',
              person_name: '张三',
              income_category: 'operator',
              income_total_usd: 10000,
              factory_commission_rate: 0.14,
              operator_bonus_ratio: 0.12,
              bonus_amount_usd: 1200,
              usd_to_rmb_rate: 7,
              bonus_amount_rmb: 8400,
              bonus_ratio_source: 'rule',
              manual_bonus_ratio: null,
              payment_status: 'unpaid',
            },
          ],
        })
      }
      if (url.includes('commission-management/ratio-overrides')) {
        return jsonResponse({ report_month: '2026-10', items: [] })
      }
      return jsonResponse({ items: [] })
    })

    const user = userEvent.setup()
    render(<OperatorManagementPage />)
    await waitFor(() => expect(callsTo('commission-management/role-assignments')).toHaveLength(1))
    await user.click(screen.getByRole('tab', { name: '运营佣金' }))
    await waitFor(() => expect(callsTo('commission-management/records')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: '保存佣金调整' }))

    await waitFor(() =>
      expect(callsTo('commission-management/ratio-overrides/upsert')).toHaveLength(1)
    )
    const [input, init] = callsTo('commission-management/ratio-overrides/upsert')[0]
    expect(String(input)).toMatch(/\/commission-management\/ratio-overrides\/upsert$/)
    expect(JSON.parse(String(init?.body))).toEqual({
      report_month: expect.stringMatching(/^\d{4}-\d{2}$/),
      items: [
        {
          project_id: 1,
          project_name: '测试项目',
          person_name: '张三',
          income_category: 'operator',
          override_ratio: 0.12,
          reason: null,
        },
      ],
    })
  })
})
