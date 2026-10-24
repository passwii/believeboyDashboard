import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import DisplayTab, {
  type FinancialSeriesResponse,
  getBrowserDefaultMonthRange,
} from './display-client'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { clearClientCacheByPrefix } from '@/lib/client-cache'
import { readSharedReportProjectId, writeSharedReportProjectId } from '../shared-project'

import { stableSession } from '@/test-utils/stable-mocks'

// ── next/navigation：可控的 URL search param 存储 ────────────────────────────
// useUrlParam 从 useSearchParams 读、经 router.replace 写。这里用一个进程内
// URLSearchParams 模拟"已落定的 URL"（project/fromMonth/toMonth 都有值），
// 避免默认窗口写入 URL 的副作用干扰测试。
const nav = vi.hoisted(() => {
  let params = new URLSearchParams('project=1&fromMonth=2025-08&toMonth=2026-07')
  return {
    setParams(qs: string) {
      params = new URLSearchParams(qs)
    },
    get: (key: string) => params.get(key),
    toString: () => params.toString(),
    replace: (url: string) => {
      const qs = url.includes('?') ? (url.split('?')[1] ?? '') : ''
      params = new URLSearchParams(qs)
    },
  }
})

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: nav.get, toString: nav.toString }),
  usePathname: () => '/dashboard/reports/monthly-report/display',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}))

// 共享记忆按操作者身份隔离：这个身份就是测试里读写记忆用的身份
const TEST_OWNER = { id: 'user-1', roleType: 'admin', name: '张三', isAdmin: true }
vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: TEST_OWNER }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(),
}))

vi.mock('@/lib/operation-audit', () => ({
  logClientOperation: vi.fn().mockResolvedValue(undefined),
}))

// ── BLF-962 · head 插槽 mock：捕获刷新回调 / loading / 插槽节点 ───────────────
//（inventory-replenishment-client.test.tsx:75-91 同模式）
const headerCapture = vi.hoisted(() => ({
  refreshHandler: null as (() => void) | null,
  refreshLoading: undefined as boolean | undefined,
  slotNode: null as ReactNode,
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    headerCapture.refreshHandler = handler
    headerCapture.refreshLoading = opts?.loading
    return { setLoading: vi.fn() }
  },
  useHeaderSlot: (node: ReactNode) => {
    headerCapture.slotNode = node
    return null
  },
  useMobileFilterStrip: () => null,
}))

// ── 数据构造 ─────────────────────────────────────────────────────────────────

function makeRow(month: string) {
  return {
    report_month: month,
    income_sales: 100,
    income_refund: 0,
    income_adjustment: 0,
    income_other: 0,
    expense_selling_fee: 10,
    expense_fba_fee: 5,
    expense_inventory_fee: 0,
    expense_service_fee: 0,
    expense_advertising: 5,
    expense_other_fees: 0,
    income_total: 100,
    expense_total: -20,
    amazon_pay_back: 80,
    credit_card_deduction_usd: 0,
    fob_cost_rmb: 0,
    first_leg_cost_rmb: 0,
    has_source_report: true,
  }
}

function makePayload(months: string[]): FinancialSeriesResponse {
  const rows = months.map(makeRow)
  return {
    project_id: 1,
    project_name: '铨富',
    start_month: months[0],
    end_month: months[months.length - 1],
    rows,
    trend: {
      income_total_sum: rows.reduce((sum, row) => sum + row.income_total, 0),
      expense_total_sum: rows.reduce((sum, row) => sum + row.expense_total, 0),
      amazon_pay_back_sum: rows.reduce((sum, row) => sum + row.amazon_pay_back, 0),
      net_amount_sum: rows.reduce((sum, row) => sum + row.income_total + row.expense_total, 0),
      points: rows.map((row) => ({
        report_month: row.report_month,
        income_total: row.income_total,
        expense_total: row.expense_total,
        amazon_pay_back: row.amazon_pay_back,
        net_amount: row.income_total + row.expense_total,
        has_source_report: row.has_source_report,
      })),
    },
  }
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers(),
  } as unknown as Response
}

let financialPayload: FinancialSeriesResponse
// 模拟 financial-series 接口网络延迟：>0 时让陈旧缓存回放的状态先 commit，
// 再让最新响应到达（真实复现 stale-while-revalidate 的两段式时序）。
let financialDelayMs = 0

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/monthly-reports/financial-series/accounting-detail')) {
    return jsonResponse({
      project_id: 1,
      project_name: '铨富',
      report_month: '2026-06',
      rows: [],
    })
  }
  if (url.includes('/monthly-reports/financial-series')) {
    const payload = financialPayload
    if (financialDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, financialDelayMs))
    }
    // 与后端一致：按请求窗口过滤行，窗口外的月份不进入序列
    const qs = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '')
    const start = qs.get('start_month')
    const end = qs.get('end_month')
    const rows = payload.rows.filter(
      (row) => (!start || row.report_month >= start) && (!end || row.report_month <= end)
    )
    return jsonResponse({ ...payload, rows })
  }
  if (url.includes('/api/exchange-rates')) {
    return jsonResponse({ data: [], pagination: { totalPages: 1 } })
  }
  return jsonResponse({})
})

const SERIES_CACHE_KEY = 'bb-dashboard-cache:financial:series:1:US:2025-08:2026-07'

beforeEach(() => {
  vi.clearAllMocks()
  headerCapture.refreshHandler = null
  headerCapture.refreshLoading = undefined
  headerCapture.slotNode = null
  ;(fetchManagedProjectsCached as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 1, name: '铨富' },
  ])
  vi.stubGlobal('fetch', fetchMock)
  clearClientCacheByPrefix('financial:')
  window.sessionStorage.clear()
  window.localStorage.clear()
  nav.setParams('project=1&fromMonth=2025-08&toMonth=2026-07')
  financialPayload = makePayload(['2026-05', '2026-06'])
  financialDelayMs = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── 断言辅助 ─────────────────────────────────────────────────────────────────

// Radix Select 打开时会把页面其余部分标记 aria-hidden，byRole 默认会将其过滤；
// 这里统一用 hidden: true 查询，保证无论下拉框开合都能读到触发器文本。
function monthSelectTexts(): string[] {
  return screen.queryAllByRole('combobox', { hidden: true }).map((el) => el.textContent ?? '')
}

async function waitForMonthInSelect(monthLabel: string) {
  await waitFor(() => {
    expect(monthSelectTexts().some((text) => text.includes(monthLabel))).toBe(true)
  })
}

async function switchToAccountingTab() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: '月度明细' }))
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('月度明细 tab 默认月份选择', () => {
  it('使用统一 tab 样式并明确标记当前视图', async () => {
    render(<DisplayTab />)
    const user = userEvent.setup()

    const summaryTab = await screen.findByRole('tab', { name: '月度汇总' })
    const detailTab = screen.getByRole('tab', { name: '月度明细' })

    expect(summaryTab).toHaveAttribute('aria-selected', 'true')
    expect(detailTab).toHaveAttribute('aria-selected', 'false')

    await user.click(detailTab)

    await waitFor(() => {
      expect(summaryTab).toHaveAttribute('aria-selected', 'false')
      expect(detailTab).toHaveAttribute('aria-selected', 'true')
    })
  })

  it('页面加载后默认选中最新有源报表的月份', async () => {
    render(<DisplayTab />)
    await switchToAccountingTab()
    await waitForMonthInSelect('2026年6月')
  })

  it('刷新后出现新月份数据时，默认月份跟随到最新月份', async () => {
    render(<DisplayTab />)
    await switchToAccountingTab()
    await waitForMonthInSelect('2026年6月')

    // 7 月源报表上传并核算完成，接口返回含 7 月的最新数据
    // BLF-962：刷新按钮已上移 Top Header，此处调用头部注册的刷新回调
    financialPayload = makePayload(['2026-05', '2026-06', '2026-07'])
    expect(headerCapture.refreshHandler).not.toBeNull()
    headerCapture.refreshHandler?.()

    await waitForMonthInSelect('2026年7月')
  })

  it('重载时命中陈旧客户端缓存，最终仍落到最新月份', async () => {
    // 上次访问留下的客户端缓存：数据只到 6 月（3 分钟 TTL 内的 stale-while-revalidate 回放）
    window.sessionStorage.setItem(
      SERIES_CACHE_KEY,
      JSON.stringify({
        updatedAt: Date.now(),
        value: makePayload(['2026-05', '2026-06']),
      })
    )
    // 服务端本次返回的实际已含 7 月；加一点延迟确保陈旧回放的状态先落屏
    financialPayload = makePayload(['2026-05', '2026-06', '2026-07'])
    financialDelayMs = 40

    render(<DisplayTab />)
    await switchToAccountingTab()
    await waitForMonthInSelect('2026年7月')
  })

  it('用户显式切换过月份后，数据更新不打扰其选择', async () => {
    render(<DisplayTab />)
    await switchToAccountingTab()
    await waitForMonthInSelect('2026年6月')

    // 用户在下拉框里显式选择 2026年5月
    const openMonthSelect = (monthLabel: string) => {
      const combo = screen
        .queryAllByRole('combobox', { hidden: true })
        .find((el) => (el.textContent ?? '').includes(monthLabel))
      expect(combo).toBeTruthy()
      fireEvent.pointerDown(combo as HTMLElement, { pointerType: 'mouse', button: 0 })
    }
    openMonthSelect('2026年6月')
    fireEvent.click(await screen.findByRole('option', { name: '2026年5月' }))
    await waitForMonthInSelect('2026年5月')

    // 数据刷新带来 7 月（刷新入口已上移头部，调用注册回调）
    financialPayload = makePayload(['2026-05', '2026-06', '2026-07'])
    expect(headerCapture.refreshHandler).not.toBeNull()
    headerCapture.refreshHandler?.()

    // 7 月进入可选项（说明新数据已生效）
    openMonthSelect('2026年5月')
    await screen.findByRole('option', { name: '2026年7月' })
    // 但当前选择仍停留在用户挑的 5 月
    await waitForMonthInSelect('2026年5月')
  })
})

describe('月份窗口 URL 参数（fromMonth/toMonth/monthRange）', () => {
  function seriesCallUrls(): string[] {
    return fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/monthly-reports/financial-series?'))
  }

  function expectWindowCalled(startMonth: string, endMonth: string) {
    expect(
      seriesCallUrls().some(
        (url) => url.includes(`start_month=${startMonth}`) && url.includes(`end_month=${endMonth}`)
      )
    ).toBe(true)
  }

  it('全新 URL 会物化滚动默认窗口（monthRange=last12m + 当前起止月份）', async () => {
    nav.setParams('project=1')
    render(<DisplayTab />)
    // 数据加载完成（窗口已生效）
    await screen.findByRole('tab', { name: '月度明细' })

    const expected = getBrowserDefaultMonthRange()
    await waitFor(() => {
      const params = new URLSearchParams(nav.toString())
      expect(params.get('monthRange')).toBe('last12m')
      expect(params.get('fromMonth')).toBe(expected.startMonth)
      expect(params.get('toMonth')).toBe(expected.endMonth)
    })
    expectWindowCalled(expected.startMonth, expected.endMonth)
  })

  it('过期的滚动窗口 URL 随时间推进，且月度明细默认到推进后的最新月份', async () => {
    // 上月生成的 URL：标记还在，但具体月份已过期（止于 2026-06）
    nav.setParams('project=1&monthRange=last12m&fromMonth=2025-07&toMonth=2026-06')
    financialPayload = makePayload(['2026-05', '2026-06', '2026-07'])

    render(<DisplayTab />)
    const expected = getBrowserDefaultMonthRange()

    // 请求窗口推进到当前时间，不再使用 URL 里的过期月份
    await waitFor(() => expectWindowCalled(expected.startMonth, expected.endMonth))

    // URL 里展示的具体月份同步刷新（仍携带 last12m 标记）
    const params = new URLSearchParams(nav.toString())
    expect(params.get('monthRange')).toBe('last12m')
    expect(params.get('fromMonth')).toBe(expected.startMonth)
    expect(params.get('toMonth')).toBe(expected.endMonth)

    // 推进后窗口内的 7 月成为月度明细默认月份
    await switchToAccountingTab()
    await waitForMonthInSelect('2026年7月')
  })

  it('无标记的具体月份 URL 视为显式窗口，不被滚动默认覆盖', async () => {
    // 分享/书签场景：他人显式选的窗口，哪怕已过期也要原样还原
    nav.setParams('project=1&fromMonth=2026-05&toMonth=2026-06')
    financialPayload = makePayload(['2026-05', '2026-06', '2026-07'])

    render(<DisplayTab />)
    await screen.findByRole('tab', { name: '月度明细' })

    // 按 URL 的显式窗口请求（7 月被窗口排除）
    expectWindowCalled('2026-05', '2026-06')
    expect(
      seriesCallUrls().some(
        (url) =>
          url.includes(`start_month=${getBrowserDefaultMonthRange().startMonth}`) &&
          url.includes(`end_month=${getBrowserDefaultMonthRange().endMonth}`)
      )
    ).toBe(false)

    // URL 不被写入滚动标记
    expect(new URLSearchParams(nav.toString()).get('monthRange')).toBeNull()

    // 月度明细默认落在显式窗口内的最新月份（6 月，而非窗口外的 7 月）
    await switchToAccountingTab()
    await waitForMonthInSelect('2026年6月')
  })
})

describe('BLF-962 头部插槽契约', () => {
  it('正文不再渲染筛选控件与刷新按钮，店铺/国家/起止月份注册进头部插槽', async () => {
    render(<DisplayTab />)
    await screen.findByRole('tab', { name: '月度明细' })
    expect(headerCapture.slotNode).not.toBeNull()
    expect(headerCapture.refreshHandler).not.toBeNull()

    // 正文（插槽 mock 不渲染 portal 内容）不应出现筛选控件与旧控制台文案
    expect(screen.queryByText('财务分析')).not.toBeInTheDocument()
    expect(screen.queryByText('分析控制台')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新数据' })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('请选择店铺')).not.toBeInTheDocument()

    // 单独渲染插槽节点：店铺 / 国家 / 起止月份 4 个控件确实都在插槽内容里
    //（已选中具体值时渲染选中文本而非 placeholder：店铺=铨富、国家=美国站、月份=yyyy-MM）
    render(<>{headerCapture.slotNode}</>)
    expect(await screen.findByText('铨富')).toBeInTheDocument()
    expect(screen.getByText('美国站 (US)')).toBeInTheDocument()
    expect(screen.getByText('2025-08')).toBeInTheDocument()
    expect(screen.getByText('2026-07')).toBeInTheDocument()
  })
})

describe('BLF-1344 项目选择跨 tab 共享', () => {
  /** 财务序列请求里带过的 project_id（accounting-detail 不算） */
  function seriesProjectIds(): string[] {
    return fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/monthly-reports/financial-series?'))
      .map((url) => new URLSearchParams(url.split('?')[1] ?? '').get('project_id') ?? '')
  }

  it('URL 没带项目时沿用共享记忆里的项目（其它 tab 选过的），并写回 URL', async () => {
    // 上一次在月报某个 tab 选过项目 2
    writeSharedReportProjectId(TEST_OWNER, '2')
    ;(fetchManagedProjectsCached as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, name: '铨富' },
      { id: 2, name: '玥涵' },
    ])
    nav.setParams('fromMonth=2025-08&toMonth=2026-07')

    render(<DisplayTab />)

    // 拉数用的是共享记忆里的项目，而不是列表里的第一个
    await waitFor(() => expect(seriesProjectIds()).toContain('2'))
    expect(seriesProjectIds()).not.toContain('1')
    // 选择同步进 URL，刷新 / 分享链接仍能还原
    await waitFor(() => expect(new URLSearchParams(nav.toString()).get('project')).toBe('2'))
  })

  it('URL 显式项目优先于共享记忆，并写回共享记忆供其它 tab 沿用', async () => {
    writeSharedReportProjectId(TEST_OWNER, '2')
    nav.setParams('project=1&fromMonth=2025-08&toMonth=2026-07')

    render(<DisplayTab />)

    await waitFor(() => expect(seriesProjectIds()).toContain('1'))
    await waitFor(() => expect(readSharedReportProjectId(TEST_OWNER)).toBe('1'))
  })

  it('可见项目列表为空时不拿未校验的 id 请求财务序列（换账号残留 / 无可见项目）', async () => {
    // 上一个账号在这台浏览器上选过项目 2，但当前操作者一个可见项目都没有
    writeSharedReportProjectId(TEST_OWNER, '2')
    ;(fetchManagedProjectsCached as ReturnType<typeof vi.fn>).mockResolvedValue([])
    nav.setParams('fromMonth=2025-08&toMonth=2026-07')

    render(<DisplayTab />)

    // 等页面与项目列表都落地（列表为空 → 不选任何项目）
    await screen.findByRole('tab', { name: '月度明细' })
    await waitFor(() => expect(fetchManagedProjectsCached).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 150))

    // 未校验的 2 既没进 URL，也没拿去请求财务序列
    expect(new URLSearchParams(nav.toString()).get('project')).toBeNull()
    expect(seriesProjectIds()).toHaveLength(0)
  })
})
