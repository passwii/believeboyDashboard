import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableSession } from '@/test-utils/stable-mocks'

const projectListMock = vi.hoisted(() => vi.fn())
const headerRefreshState = vi.hoisted(() => ({ handler: null as (() => void | Promise<void>) | null }))
const globalFilterTestMode = vi.hoisted(() => ({ useRealProvider: false }))
const serverNotificationRefresh = vi.hoisted(() => vi.fn())

// BLF-819 review：用可控 mock 替换 useTerminalGlobalFilter，驱动头部→页面同步测试。
// 默认值与真实 Provider 水合后的默认一致（ready + country=US + 近7天）。
const gfState = {
  ready: true,
  projectId: '',
  country: 'US',
  dateFrom: '2026-08-19',
  dateTo: '2026-08-25',
}
const gfSetters = {
  setProjectId: vi.fn(),
  setCountry: vi.fn(),
  setDateRange: vi.fn(),
}
vi.mock('@/components/terminal/global-filter-context', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/components/terminal/global-filter-context')
  >()
  const RealProvider = actual.TerminalGlobalFilterProvider
  return {
    ...actual,
    TerminalGlobalFilterProvider: ({ children }: { children: ReactNode }) =>
      globalFilterTestMode.useRealProvider
        ? <RealProvider>{children}</RealProvider>
        : <>{children}</>,
    useTerminalGlobalFilter: () => globalFilterTestMode.useRealProvider
      ? actual.useTerminalGlobalFilter()
      : gfValue,
  }
})

// BLF-940：header slot / mobile strip / refresh 走 mock，避免挂载点缺失抛错。
// 插槽内容直接渲染回页面正文（便于断言筛选控件存在性，生产环境 portal 进 head）。
vi.mock('@/components/terminal/terminal-header-slot', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/components/terminal/terminal-header-slot')
  >()
  return {
    ...actual,
    useHeaderRefresh: vi.fn((handler: () => void | Promise<void>) => {
      headerRefreshState.handler = handler
      return { setLoading: vi.fn() }
    }),
    useHeaderSlot: (node: React.ReactNode) => node,
    useMobileFilterStrip: () => null,
  }
})

/** 测试内修改全局筛选态（模拟用户在头部操作）；bump 版本号让 mock 返回新引用触发重渲染 */
let gfVersion = 0
const gfValue = new Proxy(gfState, {
  get(target, key) {
    if (key === '__gfVersion') return gfVersion
    if (key in gfSetters) return gfSetters[key as keyof typeof gfSetters]
    return target[key as keyof typeof gfState]
  },
})

/** 测试内修改全局筛选态（模拟用户在头部操作） */
function setGf(patch: Partial<typeof gfState>) {
  Object.assign(gfState, patch)
  gfVersion += 1
}

const mockSearchParams = {
  getAll: vi.fn((_key: string): string[] => []),
  get: vi.fn((_key: string): string | null => null),
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/dashboard/reports/order-info',
  useSearchParams: () => mockSearchParams,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string
  }) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string
  }) => <a href={href} {...props}>{children}</a>,
}))

const notify = vi.fn()

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
  useServerNotifications: () => ({ unreadCount: 0, refresh: serverNotificationRefresh }),
}))

vi.mock('@/components/dashboard/search-command', () => ({
  OPEN_SEARCH_EVENT: 'open-search',
  SearchCommand: () => null,
}))

vi.mock('../../../../components/dashboard-v2/warm-ledger/shell/warm-notification-panel', () => ({
  WarmNotificationPanel: () => null,
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: projectListMock,
}))

const MOCK_ITEMS = [
  {
    id: 101,
    project_id: 1,
    project_name: '店铺A',
    brand_name: null,
    source_file_id: 1,
    purchase_at_utc: '2026-08-20T02:30:00Z',
    purchase_at_pt: '2026-08-19 19:30:00',
    purchase_date_pt: '2026-08-19',
    amazon_order_id: '111-1111111-0000001',
    order_status: 'Pending',
    fulfillment_channel: 'Amazon',
    fulfillment_label: 'FBA',
    ship_service_level: null,
    sku: 'SKU-A',
    asin: 'B0TEST0001',
    product_name: '测试商品A',
    quantity: 2,
    item_price: 10,
    shipping_price: 5,
    currency: 'USD',
    country: 'US',
    state: null,
    city: null,
    postal_code: null,
    is_counted_sales: true,
    created_at: '2026-08-20T03:00:00Z',
    carrier: null,
    tracking_no: null,
    shipped_at: null,
    updated_by: null,
    updated_at: null,
  },
  {
    id: 102,
    project_id: 1,
    project_name: '店铺A',
    brand_name: null,
    source_file_id: 1,
    purchase_at_utc: '2026-08-21T12:00:00Z',
    purchase_at_pt: '2026-08-21 05:00:00',
    purchase_date_pt: '2026-08-21',
    amazon_order_id: '111-1111111-0000002',
    order_status: 'Shipped',
    fulfillment_channel: 'Amazon',
    fulfillment_label: 'FBA',
    ship_service_level: null,
    sku: 'SKU-B',
    asin: 'B0TEST0002',
    product_name: '测试商品B',
    quantity: 1,
    item_price: 20,
    shipping_price: 0,
    currency: 'USD',
    country: 'US',
    state: null,
    city: null,
    postal_code: null,
    is_counted_sales: true,
    created_at: '2026-08-21T12:30:00Z',
    carrier: null,
    tracking_no: null,
    shipped_at: null,
    updated_by: null,
    updated_at: null,
  },
  {
    id: 103,
    project_id: 1,
    project_name: '店铺A',
    brand_name: null,
    source_file_id: 1,
    purchase_at_utc: '2026-08-22T12:00:00Z',
    purchase_at_pt: '2026-08-22 05:00:00',
    purchase_date_pt: '2026-08-22',
    amazon_order_id: '111-1111111-0000003',
    order_status: 'Cancelled',
    fulfillment_channel: 'Merchant',
    fulfillment_label: 'FBM',
    ship_service_level: null,
    sku: null,
    asin: null,
    product_name: '测试商品C',
    quantity: 3,
    item_price: 7,
    shipping_price: 1,
    currency: 'USD',
    country: 'US',
    state: null,
    city: null,
    postal_code: null,
    is_counted_sales: false,
    created_at: '2026-08-22T12:30:00Z',
    carrier: 'UPS',
    tracking_no: '1Z999AA1',
    shipped_at: null,
    updated_by: null,
    updated_at: null,
  },
]

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(''),
  } as unknown as Response
}

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
  jsonResponse({
    items: MOCK_ITEMS,
    total: 3,
    page: 1,
    page_size: 50,
    stats: {
      total_orders: 3,
      total_quantity: 6,
      total_amount: 43,
      currency: 'USD',
      fba_count: 2,
      fbm_count: 1,
    },
  })
)

vi.stubGlobal('fetch', fetchMock)

import {
  TerminalGlobalFilterProvider,
  useTerminalGlobalFilter,
} from '@/components/terminal/global-filter-context'
import { WarmLedgerRouteFrame } from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame'
import OrderInfoPage from './page'

const ORDER_INFO_SOURCE_ROOT = join(
  process.cwd(),
  'app/dashboard/reports/order-info'
)
const TERMINAL_VISUAL_RESIDUE = [
  { label: 'Terminal token', pattern: /--term-/g },
  { label: 'Terminal utility', pattern: /\bterm-[a-z0-9-]+/g },
  { label: 'Terminal zero-radius utility', pattern: /\brounded-none\b/g },
]

function collectOrderInfoSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectOrderInfoSourceFiles(path)
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return []
    return ['.css', '.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

describe('订单信息页 Warm Ledger 迁移', () => {
  beforeEach(() => {
    globalFilterTestMode.useRealProvider = false
    window.localStorage.clear()
    window.history.replaceState({}, '', '/dashboard/reports/order-info')
    vi.clearAllMocks()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        items: MOCK_ITEMS,
        total: 3,
        page: 1,
        page_size: 50,
        stats: {
          total_orders: 3,
          total_quantity: 6,
          total_amount: 43,
          currency: 'USD',
          fba_count: 2,
          fbm_count: 1,
        },
      })
    )
    headerRefreshState.handler = null
    projectListMock.mockResolvedValue([{ id: 1, name: '店铺A' }])
  })

  afterEach(() => {
    globalFilterTestMode.useRealProvider = false
    window.localStorage.clear()
    window.history.replaceState({}, '', '/dashboard/reports/order-info')
  })

  it('V4 Order Info 源文件不重新引入 Terminal 视觉残留', () => {
    const violations = collectOrderInfoSourceFiles(ORDER_INFO_SOURCE_ROOT).flatMap((path) => {
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

  it('订单表保留 13 列、规范数值列与选中态语义', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    const table = screen.getByRole('table', { name: '订单列表' })
    const orderPanel = screen.getByRole('region', { name: '订单信息' })
    const tableScroll = table.parentElement
    const firstHeader = table.querySelector('thead th')
    const quantityHeader = screen.getByRole('columnheader', { name: /数量/ })
    const quantityCell = table.querySelector('tbody tr:first-child td:nth-child(6)')
    const amountCell = table.querySelector('tbody tr:first-child td:nth-child(7)')

    expect(orderPanel).toHaveAttribute('data-warm-order-info', 'true')
    expect(tableScroll).toHaveAttribute('data-order-info-table-scroll', 'true')
    expect(table).toHaveAttribute('data-order-info-table-min-width', '1560')
    expect(table.querySelectorAll('thead th')).toHaveLength(13)
    expect(firstHeader).toHaveAttribute('scope', 'col')
    expect(firstHeader?.className).not.toMatch(/term-|rounded-none/)
    expect(quantityHeader).toHaveAttribute('data-numeric', 'true')
    expect(quantityCell).toHaveAttribute('data-numeric', 'true')
    expect(amountCell).toHaveAttribute('data-numeric', 'true')
    expect(table).toHaveAttribute('data-order-info-numeric', 'true')
  })

  it('订单专属筛选集中在订单信息面板内，不占用全局 Header 插槽', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    const orderPanel = screen.getByRole('region', { name: '订单信息' })
    const filters = within(orderPanel).getByRole('group', { name: '订单筛选' })

    expect(within(filters).getAllByRole('combobox')).toHaveLength(3)
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    expect(within(filters).getByPlaceholderText('订单号 111-…')).toBeInTheDocument()
    expect(within(filters).getByPlaceholderText('SKU')).toBeInTheDocument()
    expect(within(filters).getByPlaceholderText('ASIN')).toBeInTheDocument()
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
    expect(within(filters).getByText('订单属性')).toBeInTheDocument()
    expect(within(filters).getByText('订单查找')).toBeInTheDocument()
  })

  it('订单类型筛选保留多选，可同时提交 FBA 与 FBM', async () => {
    const restore = routeFetch(() =>
      jsonResponse({
        ...FILTER_OPTIONS_OK,
        fulfillment_channels: [
          { value: 'Amazon', label: 'FBA-UT' },
          { value: 'Merchant', label: 'FBM-UT' },
        ],
      })
    )

    try {
      resetGfAndParams()
      const user = userEvent.setup()
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      await screen.findByText('111-1111111-0000001')
      const orderPanel = screen.getByRole('region', { name: '订单信息' })
      const filters = within(orderPanel).getByRole('group', { name: '订单筛选' })
      await user.click(screen.getAllByRole('combobox')[0]!)
      await user.click(await screen.findByRole('option', { name: 'FBA-UT' }))
      await user.click(screen.getByRole('option', { name: 'FBM-UT' }))

      await waitFor(() => {
        const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
        expect(lastUrl).toContain('fulfillment_channels=Amazon')
        expect(lastUrl).toContain('fulfillment_channels=Merchant')
      })
      expect(filters.querySelectorAll('[data-warm-order-multiselect="true"]')).toHaveLength(3)
    } finally {
      restore()
    }
  })

  it('首次加载时保留表格骨架状态', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/order-info/overview')) {
        return new Promise<Response>(() => {})
      }
      return jsonResponse(FILTER_OPTIONS_OK)
    })

    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    const table = await screen.findByRole('table', { name: '订单列表' })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/order-info/overview'))).toBe(true)
    })

    expect(table.querySelectorAll('tbody tr')).toHaveLength(12)
    expect(table.querySelectorAll('[data-warm-order-skeleton="true"]')).toHaveLength(12)
    expect(screen.queryByText('暂无订单数据')).not.toBeInTheDocument()
  })

  it('无匹配订单时显示筛选空态，底部汇总仍显示真实零值', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        items: [],
        total: 0,
        page: 1,
        page_size: 50,
        stats: {
          total_orders: 0,
          total_quantity: 0,
          total_amount: 0,
          currency: 'USD',
          fba_count: 0,
          fbm_count: 0,
        },
      })
    )

    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    expect(await screen.findByText(/当前筛选条件下无订单/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Σ 单量').closest('span')).toHaveTextContent('0')
      expect(screen.getByText('Σ 金额').closest('span')).toHaveTextContent('0.00 USD')
    })
    expect(screen.queryByText('111-1111111-0000001')).not.toBeInTheDocument()
  })

  it('渲染订单行与 Warm 状态 pill 语义（Pending warn / Shipped pos / Cancelled neg）', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    // 等数据行渲染出来
    expect(await screen.findByText('111-1111111-0000001')).toBeInTheDocument()
    expect(screen.getByText('111-1111111-0000002')).toBeInTheDocument()
    expect(screen.getByText('111-1111111-0000003')).toBeInTheDocument()

    expect(screen.getByText('处理中').closest('[data-order-status-tone]')).toHaveAttribute(
      'data-order-status-tone',
      'warn'
    )
    expect(screen.getByText('已发货').closest('[data-order-status-tone]')).toHaveAttribute(
      'data-order-status-tone',
      'pos'
    )
    expect(screen.getByText('已取消').closest('[data-order-status-tone]')).toHaveAttribute(
      'data-order-status-tone',
      'neg'
    )
  })

  it('底部 pinned 聚合条展示总单量 / 总金额 / FBA·FBM 行数与翻页信息', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    expect(screen.getByText('Σ 单量').closest('span')).toHaveTextContent('3')
    expect(screen.getByText('Σ 金额').closest('span')).toHaveTextContent('43.00 USD')
    expect(screen.getByText(/共/).closest('span')).toHaveTextContent('3')
  })

  it('勾选行后聚合条出现选中态合计，金额口径 = item_price + shipping_price', async () => {
    const user = userEvent.setup()
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')

    // 勾选第一行（金额 = 10 + 5 = 15，数量 = 2）
    await user.click(screen.getByLabelText('选中订单 111-1111111-0000001'))

    await waitFor(() => {
      expect(screen.getByText(/已选 1 行/)).toHaveTextContent('Σ 金额 15.00')
      expect(screen.getByText(/已选 1 行/)).toHaveTextContent('Σ 数量 2')
    })
  })

  it('CSV 导出沿用当前筛选载荷，不携带分页、排序或所选行范围', async () => {
    const previousGf = { ...gfState }
    resetGfAndParams()
    setGf({ projectId: '1' })
    const originalImplementation = fetchMock.getMockImplementation()!
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:order-info-test'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/order-info/export')) {
        return jsonResponse({ filename: 'orders_20260825.csv', content_base64: '' })
      }
      return jsonResponse(OVERVIEW_OK)
    })

    try {
      const user = userEvent.setup()
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      await screen.findByText('111-1111111-0000001')
      await user.click(screen.getByLabelText('选中订单 111-1111111-0000001'))
      await user.click(screen.getByRole('button', { name: '导出 CSV' }))

      await waitFor(() => {
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/order-info/export'))).toBe(true)
      })
      const exportCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/order-info/export')
      )!
      const payload = JSON.parse(exportCall[1]?.body as string) as Record<string, unknown>
      const overviewCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/order-info/overview')
      )!
      const overviewUrl = new URL(String(overviewCall[0]), window.location.origin)

      expect(payload).toMatchObject({
        project_ids: [1],
        fulfillment_channels: [],
        order_statuses: [],
        countries: ['US'],
        currencies: [],
        sku_keyword: null,
        order_id_keyword: null,
        asin_keyword: null,
      })
      expect(payload.date_from).toBe(overviewUrl.searchParams.get('date_from'))
      expect(payload.date_to).toBe(overviewUrl.searchParams.get('date_to'))
      expect(payload).not.toHaveProperty('page')
      expect(payload).not.toHaveProperty('page_size')
      expect(payload).not.toHaveProperty('sort_by')
      expect(payload).not.toHaveProperty('sort_dir')
      expect(payload).not.toHaveProperty('selected_ids')
      expect(click).toHaveBeenCalledOnce()
    } finally {
      click.mockRestore()
      fetchMock.mockImplementation(originalImplementation)
      if (createObjectUrlDescriptor) {
        Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
      } else {
        Reflect.deleteProperty(URL, 'createObjectURL')
      }
      if (revokeObjectUrlDescriptor) {
        Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
      } else {
        Reflect.deleteProperty(URL, 'revokeObjectURL')
      }
      setGf(previousGf)
    }
  })

  it('表头排序按钮可点击触发带 sort 参数的刷新请求', async () => {
    const user = userEvent.setup()
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    const callsAfterLoad = fetchMock.mock.calls.length

    await user.click(screen.getByRole('button', { name: /数量/ }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterLoad)
    })
    const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
    expect(lastUrl).toContain('sort_by=quantity')
    expect(lastUrl).toContain('sort_dir=desc')
  })

  it('金额单元格展示 item_price + shipping_price 合计并标注运费', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )
    await screen.findByText('111-1111111-0000001')

    const amountCell = screen.getByText('15.00 USD')
    expect(amountCell).toBeInTheDocument()
    expect(screen.getByText('+ 运费 5.00')).toBeInTheDocument()
    // 无运费的行不显示运费标注
    expect(screen.getByText('20.00 USD')).toBeInTheDocument()
  })

  // ====== BLF-819 review 补测：头部 → 页面绑定 effect ======

  it('BLF-819 首次水合守卫：URL 无 g* 参数（gf projectId 为空）时，binding 不覆盖页面 projectId，自动选第一个店铺生效', async () => {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '2026-08-19', dateTo: '2026-08-25' })
    const { rerender } = render(<OrderInfoPage />)

    await screen.findByText('111-1111111-0000001')
    // BLF-940：页面项目 Select 已移除（由 head 全局四件套承担），
    // 自动选第一个店铺的行为通过请求参数验证。
    // 首次请求带的是 autoselect 出的 project_ids=1
    const firstCall = String(fetchMock.mock.calls[0]![0])
    expect(firstCall).toContain('project_ids=1')
  })

  it('BLF-819 头部切换项目/站点/日期后，页面筛选与请求参数随动', async () => {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '2026-08-19', dateTo: '2026-08-25' })
    const { rerender } = render(<OrderInfoPage />)
    await screen.findByText('111-1111111-0000001')

    // 模拟用户在头部切到项目 2 / 德国站 / 自定义日期
    act(() => {
      setGf({ projectId: '2', country: 'DE', dateFrom: '2026-08-01', dateTo: '2026-08-05' })
    })
    rerender(<OrderInfoPage />)

    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
      expect(lastUrl).toContain('project_ids=2')
      expect(lastUrl).toContain('countries=DE')
      expect(lastUrl).toContain('date_from=2026-08-01')
      expect(lastUrl).toContain('date_to=2026-08-05')
    })
  })

  it("BLF-819 '__all__' ↔ 'all' 语义映射：头部选全部项目时页面回到全店铺且不误传具体 project_id", async () => {
    // 先让头部持有具体项目 1
    setGf({ ready: true, projectId: '1', country: 'US', dateFrom: '2026-08-19', dateTo: '2026-08-25' })
    const { rerender } = render(<OrderInfoPage />)
    await screen.findByText('111-1111111-0000001')
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('project_ids=1')

    // 头部切到「全部项目」→ 页面应回 DEFAULT_PROJECT_VALUE('__all__')，请求不带 project_ids
    act(() => {
      setGf({ projectId: 'all' })
    })
    rerender(<OrderInfoPage />)

    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
      expect(lastUrl).not.toContain('project_ids=')
    })
  })

  // ====== BLF-927：URL order_statuses 预填 ======

  it('BLF-927 URL 预填：?order_statuses=Pending 时状态筛选预填且请求带 Pending', async () => {
    mockSearchParams.getAll.mockImplementation((key: string) =>
 key === 'order_statuses' ? ['Pending'] : []
    )
    try {
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      // 注：状态徽标文案依赖 filter-options（BEL-422 按需加载，测试内未触发下拉），
      // 这里断言核心契约 —— 状态筛选已生效：请求带 order_statuses=Pending。
      await screen.findByText('111-1111111-0000001')
      // 数据请求带 order_statuses=Pending
      await waitFor(() => {
        expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('order_statuses=Pending')
      })
    } finally {
      mockSearchParams.getAll.mockImplementation(() => [])
    }
  })

  it('BLF-927 URL 预填：逗号分隔多状态（Pending,Shipped）均预填', async () => {
    mockSearchParams.getAll.mockImplementation((key: string) =>
      key === 'order_statuses' ? ['Pending,Shipped'] : []
    )
    try {
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      await screen.findByText('111-1111111-0000001')
      await waitFor(() => {
        const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
        expect(lastUrl).toContain('order_statuses=Pending')
        expect(lastUrl).toContain('order_statuses=Shipped')
      })
    } finally {
      mockSearchParams.getAll.mockImplementation(() => [])
    }
  })

  it('BLF-927 URL 无 order_statuses 时保持既有行为（状态筛选为空）', async () => {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '2026-08-19', dateTo: '2026-08-25' })
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
      expect(lastUrl).not.toContain('order_statuses=')
    })
  })

  // ====== BLF-939：URL project_id / date_from / date_to 预填（首页订单流面板跳转带入） ======

  it('BLF-939 URL 预填：project_id + date_from + date_to + order_statuses 全参数生效', async () => {
    const realGet = mockSearchParams.get
    const realGetAll = mockSearchParams.getAll
    mockSearchParams.get = vi.fn((key: string) => {
      if (key === 'project_id') return '3'
      if (key === 'date_from') return '2026-08-01'
      if (key === 'date_to') return '2026-08-05'
      return null
    })
    mockSearchParams.getAll = vi.fn((key: string) =>
      key === 'order_statuses' ? ['Pending'] : []
    )
    try {
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      await screen.findByText('111-1111111-0000001')
      await waitFor(() => {
        const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
        expect(lastUrl).toContain('project_ids=3')
        expect(lastUrl).toContain('order_statuses=Pending')
        expect(lastUrl).toContain('date_from=2026-08-01')
        expect(lastUrl).toContain('date_to=2026-08-05')
      })
    } finally {
      mockSearchParams.get = realGet
      mockSearchParams.getAll = realGetAll
    }
  })

  it('Warm Order Info 深链项目/日期优先于已保存全局范围并同步首个 overview 请求', async () => {
    const params = new URLSearchParams({
      project_id: '3',
      date_from: '2026-08-01',
      date_to: '2026-08-05',
    })
    window.history.replaceState(
      {},
      '',
      `/dashboard/reports/order-info?${params.toString()}`
    )
    window.localStorage.setItem(
      'bb.terminal.global-filter',
      JSON.stringify({
        projectId: '99',
        country: 'DE',
        dateFrom: '2026-09-01',
        dateTo: '2026-09-07',
      })
    )
    mockSearchParams.get = vi.fn((key: string) => params.get(key))
    mockSearchParams.getAll = vi.fn(() => [])
    projectListMock.mockResolvedValue([
      { id: 1, name: '店铺A' },
      { id: 3, name: '店铺三' },
    ])
    globalFilterTestMode.useRealProvider = true

    try {
      render(
        <WarmLedgerRouteFrame pathname="/dashboard/reports/order-info">
          <>
            <GlobalFilterProbe />
            <OrderInfoPage />
          </>
        </WarmLedgerRouteFrame>
      )

      await screen.findByText('111-1111111-0000001')
      const probe = screen.getByTestId('global-filter-probe')
      await waitFor(() => {
        expect(probe).toHaveTextContent('3|DE|2026-08-01|2026-08-05')
      })
      expect(screen.getByRole('combobox', { name: '项目筛选' })).toHaveTextContent('店铺三')
      expect(screen.getByRole('combobox', { name: '站点筛选' })).toHaveTextContent(/DE/)
      expect(document.querySelector('.warm-ledger__route-date-range')).toHaveTextContent(
        '2026-08-01 ~ 2026-08-05'
      )

      const overviewRequests = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/order-info/overview')
      )
      expect(overviewRequests.length).toBeGreaterThan(0)
      const firstOverviewUrl = String(overviewRequests[0]![0])
      expect(firstOverviewUrl).toContain('project_ids=3')
      expect(firstOverviewUrl).toContain('countries=DE')
      expect(firstOverviewUrl).toContain('date_from=2026-08-01')
      expect(firstOverviewUrl).toContain('date_to=2026-08-05')
    } finally {
      globalFilterTestMode.useRealProvider = false
      mockSearchParams.get = vi.fn(() => null)
      mockSearchParams.getAll = vi.fn(() => [])
    }
  })

  it('BLF-939 URL 预填：无 project_id 时保持自动选中第一个店铺', async () => {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '2026-08-19', dateTo: '2026-08-25' })
    mockSearchParams.get = vi.fn(() => null)
    mockSearchParams.getAll = vi.fn(() => [])
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    // 无 project_id 参数 → autoselect 生效，首请求带 project_ids=1
    expect(String(fetchMock.mock.calls[0]![0])).toContain('project_ids=1')
  })

  it('首页今日出单跳转：URL order_id_keyword 会进入订单号筛选', async () => {
    const realGet = mockSearchParams.get
    mockSearchParams.get = vi.fn((key: string) =>
      key === 'order_id_keyword' ? '114-1234567-1234567' : null
    )
    try {
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      await screen.findByText('111-1111111-0000001')
      await waitFor(() => {
        expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(
          'order_id_keyword=114-1234567-1234567'
        )
      })
    } finally {
      mockSearchParams.get = realGet
    }
  })

  // ====== BLF-1019：筛选下拉按需加载（失败可重试，不再永久空白） ======

  const FILTER_OPTIONS_OK = {
    projects: [{ value: '1', label: '店铺A' }],
    order_statuses: [{ value: 'Pending', label: '处理中-UT' }],
    fulfillment_channels: [{ value: 'Amazon', label: 'FBA-UT' }],
    countries: [{ value: 'US', label: 'US' }],
    currencies: [{ value: 'USD', label: 'USD' }],
  }

  const OVERVIEW_OK = {
    items: MOCK_ITEMS,
    total: 3,
    page: 1,
    page_size: 50,
    stats: {
      total_orders: 3,
      total_quantity: 6,
      total_amount: 43,
      currency: 'USD',
      fba_count: 2,
      fbm_count: 1,
    },
  }

  function errResponse(): Response {
    return {
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('timeout'),
    } as unknown as Response
  }

  it('overview 返回后端 504 时展示已剥除内部 code 的用户文案', async () => {
    resetGfAndParams()
    const originalImplementation = fetchMock.getMockImplementation()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/order-info/overview')) {
        return {
          ok: false,
          status: 504,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                detail:
                  'order_info_query_timeout: 订单查询超过服务端上限（15000ms），请收窄店铺或日期范围后重试',
              })
            ),
        } as Response
      }
      return jsonResponse(FILTER_OPTIONS_OK)
    })

    try {
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('订单查询超过服务端上限（15000ms），请收窄店铺或日期范围后重试')
      expect(alert).not.toHaveTextContent('order_info_query_timeout')
    } finally {
      fetchMock.mockImplementation(originalImplementation!)
    }
  })

  /** 按 URL 分流 fetch：filter-options 走 filterImpl，其余走 overview 常量 */
  function routeFetch(filterImpl: (url: string) => Response) {
    const orig = fetchMock.getMockImplementation()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('filter-options')) return filterImpl(url)
      return jsonResponse(OVERVIEW_OK)
    })
    return () => {
      fetchMock.mockImplementation(orig!)
    }
  }

  function filterOptionsCalls() {
    return fetchMock.mock.calls.filter((c) => String(c[0]).includes('filter-options'))
  }

  function resetGfAndParams() {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '2026-08-19', dateTo: '2026-08-25' })
    mockSearchParams.get = vi.fn(() => null)
    mockSearchParams.getAll = vi.fn(() => [])
  }

  it('BLF-1019 首屏不预拉 filter-options，打开类型下拉后加载并渲染选项', async () => {
    const restore = routeFetch(() => jsonResponse(FILTER_OPTIONS_OK))
    try {
      resetGfAndParams()
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      await screen.findByText('111-1111111-0000001')
      // BEL-422 懒加载：首屏只有 overview 请求
      expect(filterOptionsCalls()).toHaveLength(0)

      const user = userEvent.setup()
      await user.click(screen.getAllByRole('combobox')[0])

      await screen.findByText('FBA-UT')
      expect(filterOptionsCalls()).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('项目列表失败时不发全店铺 overview，重试成功后恢复订单查询', async () => {
    projectListMock.mockRejectedValueOnce(new Error('项目列表请求失败'))
    resetGfAndParams()
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('店铺列表加载失败，已暂停订单查询以避免默认查询全部店铺。')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/order-info/overview'))).toHaveLength(0)

    projectListMock.mockResolvedValueOnce([{ id: 1, name: '店铺A' }])
    await userEvent.setup().click(screen.getByRole('button', { name: '重试店铺列表' }))

    await screen.findByText('111-1111111-0000001')
    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('project_ids=1')
    })
  })

  it('订单筛选清空保留 Head 项目、站点和日期条件', async () => {
    resetGfAndParams()
    const { rerender } = render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    act(() => {
      setGf({ projectId: '2', country: 'DE', dateFrom: '2026-08-01', dateTo: '2026-08-05' })
    })
    rerender(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )
    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
      expect(lastUrl).toContain('project_ids=2')
      expect(lastUrl).toContain('countries=DE')
      expect(lastUrl).toContain('date_from=2026-08-01')
      expect(lastUrl).toContain('date_to=2026-08-05')
    })

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('SKU'), 'SKU-A')
    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('sku_keyword=SKU-A')
    })

    const overviewCallsBeforeClear = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/order-info/overview')
    ).length
    await user.click(screen.getByRole('button', { name: '清空订单筛选' }))
    await waitFor(() => {
      const overviewCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/order-info/overview')
      )
      expect(overviewCalls.length).toBeGreaterThan(overviewCallsBeforeClear)
      const lastUrl = String(overviewCalls.at(-1)![0])
      expect(lastUrl).toContain('project_ids=2')
      expect(lastUrl).toContain('countries=DE')
      expect(lastUrl).toContain('date_from=2026-08-01')
      expect(lastUrl).toContain('date_to=2026-08-05')
      expect(lastUrl).not.toContain('sku_keyword=')
    })
  })

  it('项目列表失败时仍尊重 URL 显式项目范围', async () => {
    projectListMock.mockRejectedValueOnce(new Error('项目列表请求失败'))
    resetGfAndParams()
    mockSearchParams.get = vi.fn((key: string) => (key === 'project_id' ? '3' : null))
    try {
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )

      await screen.findByText('111-1111111-0000001')
      await waitFor(() => {
        expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('project_ids=3')
      })
    } finally {
      mockSearchParams.get = vi.fn(() => null)
    }
  })

  it('项目列表失败时仍尊重头部显式项目范围，不被自动选择改写', async () => {
    projectListMock.mockRejectedValueOnce(new Error('项目列表请求失败'))
    resetGfAndParams()
    setGf({ projectId: '2' })
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('project_ids=2')
    })
  })

  it('项目列表失败时仍允许用户主动选择全部项目', async () => {
    projectListMock.mockRejectedValueOnce(new Error('项目列表请求失败'))
    resetGfAndParams()
    setGf({ projectId: 'all' })
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    await waitFor(() => {
      const overviewCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/order-info/overview')
      )
      expect(overviewCalls.length).toBeGreaterThan(0)
      expect(String(overviewCalls.at(-1)![0])).not.toContain('project_ids=')
    })
  })

  it('后续页使用 list-only 并复用第一页统计', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ...OVERVIEW_OK, total: 120 }))
    resetGfAndParams()
      const user = userEvent.setup()
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      await screen.findByText('111-1111111-0000001')
      expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('/order-info/overview?')

      await user.click(screen.getByRole('button', { name: '下一页' }))
      await waitFor(() => {
        expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('/order-info/list?')
        expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('page=2')
      })
      expect(screen.getByText('Σ 单量').closest('span')).toHaveTextContent('3')
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/order-info/overview'))).toHaveLength(1)
  })

  it('第 2 页刷新尚未执行时快速翻页，取消旧意图并让新页只请求 list', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ...OVERVIEW_OK, total: 150 }))
    resetGfAndParams()
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    await userEvent.setup().click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => {
      const url = new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://localhost')
      expect(url.pathname).toBe('/api/backend/api/v1/order-info/list')
      expect(url.searchParams.get('page')).toBe('2')
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled())

    fetchMock.mockClear()
    act(() => {
      headerRefreshState.handler?.()
      fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://localhost')
      expect(url.pathname).toBe('/api/backend/api/v1/order-info/list')
      expect(url.searchParams.get('page')).toBe('3')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/order-info/overview'))).toHaveLength(0)
  })

  it('过滤条件切换后 abort 旧请求，并拒绝忽略 abort 的过期响应', async () => {
    resetGfAndParams()
    const { rerender } = render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )
    await screen.findByText('111-1111111-0000001')
    fetchMock.mockClear()

    let resolveStale!: (response: Response) => void
    let staleSignal: AbortSignal | undefined
    const staleItem = { ...MOCK_ITEMS[0], id: 999, amazon_order_id: '111-1111111-0000009' }
    const freshItem = { ...MOCK_ITEMS[0], id: 1000, amazon_order_id: '111-1111111-0000010' }
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('date_from=2026-08-01')) {
        return Promise.resolve(jsonResponse({ ...OVERVIEW_OK, items: [freshItem] }))
      }
      staleSignal = init?.signal as AbortSignal
      return new Promise((resolve) => {
        resolveStale = resolve
      })
    })

    act(() => {
      headerRefreshState.handler?.()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => {
      setGf({ dateFrom: '2026-08-01', dateTo: '2026-08-05' })
    })
    rerender(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )
    expect(staleSignal?.aborted).toBe(true)
    expect(await screen.findByText(freshItem.amazon_order_id)).toBeInTheDocument()

    await act(async () => {
      resolveStale(jsonResponse({ ...OVERVIEW_OK, items: [staleItem] }))
      await Promise.resolve()
    })
    expect(screen.getByText(freshItem.amazon_order_id)).toBeInTheDocument()
    expect(screen.queryByText(staleItem.amazon_order_id)).not.toBeInTheDocument()
  })

  it('手动刷新与待执行筛选 debounce 合并为一次 overview 请求', async () => {
    const restore = routeFetch(() => jsonResponse(FILTER_OPTIONS_OK))
    try {
      resetGfAndParams()
      const { rerender } = render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      await screen.findByText('111-1111111-0000001')
      fetchMock.mockClear()

      act(() => {
        setGf({ dateFrom: '2026-08-01', dateTo: '2026-08-05' })
      })
      rerender(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      const refresh = headerRefreshState.handler
      expect(refresh).not.toBeNull()
      act(() => {
        refresh?.()
      })
      await waitFor(() => {
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/order-info/overview'))).toHaveLength(1)
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/order-info/overview'))).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('刷新失败时保留当前页面已有订单', async () => {
    const restore = routeFetch(() => jsonResponse(FILTER_OPTIONS_OK))
    try {
      resetGfAndParams()
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      await screen.findByText('111-1111111-0000001')
      fetchMock.mockImplementationOnce(async () => errResponse())
      act(() => {
        headerRefreshState.handler?.()
      })

      expect(await screen.findByText(/数据加载失败.*timeout/)).toBeInTheDocument()
      expect(screen.getByText('111-1111111-0000001')).toBeInTheDocument()

      act(() => {
        headerRefreshState.handler?.()
      })
      await waitFor(() => {
        expect(screen.queryByText(/数据加载失败.*timeout/)).not.toBeInTheDocument()
      })
      expect(screen.getByText('111-1111111-0000001')).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('BLF-1019 filter-options 首次失败不锁死：提示重试、不误报未关联店铺，再次打开重试成功', async () => {
    let n = 0
    const restore = routeFetch(() => (++n === 1 ? errResponse() : jsonResponse(FILTER_OPTIONS_OK)))
    try {
      resetGfAndParams()
      render(
        <TerminalGlobalFilterProvider>
          <OrderInfoPage />
        </TerminalGlobalFilterProvider>
      )
      await screen.findByText('111-1111111-0000001')

      const user = userEvent.setup()
      await user.click(screen.getAllByRole('combobox')[0])

      // 失败态：触发器提示重试，而不是静默空白
      await screen.findByText('类型 · 加载失败，点开重试')
      // 旧空壳 fallback 会误触"未关联任何店铺"警告；失败时必须保持 null 不误报
      expect(screen.queryByText(/未关联任何店铺/)).not.toBeInTheDocument()
      expect(filterOptionsCalls()).toHaveLength(1)

      // 关闭再打开 → 释放锁存，重试成功并渲染选项
      await user.keyboard('{Escape}')
      await user.click(screen.getAllByRole('combobox')[0])
      await screen.findByText('FBA-UT')
      expect(filterOptionsCalls()).toHaveLength(2)
    } finally {
      restore()
    }
  })
})

function GlobalFilterProbe() {
  const { projectId, country, dateFrom, dateTo } = useTerminalGlobalFilter()
  return (
    <output data-testid="global-filter-probe">
      {`${projectId}|${country}|${dateFrom}|${dateTo}`}
    </output>
  )
}
