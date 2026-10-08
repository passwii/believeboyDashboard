import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableSession } from '@/test-utils/stable-mocks'

const projectListMock = vi.hoisted(() => vi.fn())
const headerRefreshState = vi.hoisted(() => ({ handler: null as (() => void | Promise<void>) | null }))

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
  return {
    ...actual,
    TerminalGlobalFilterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useTerminalGlobalFilter: () => gfValue,
  }
})

// BLF-940：header slot / mobile strip / refresh 走 mock，避免挂载点缺失抛错。
// 插槽内容直接渲染回页面正文（便于断言筛选控件存在性，生产环境 portal 进 head）。
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn((handler: () => void | Promise<void>) => {
    headerRefreshState.handler = handler
    return { setLoading: vi.fn() }
  }),
  useHeaderSlot: (node: React.ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

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
  get: vi.fn((): string | null => null),
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/dashboard/reports/order-info',
  useSearchParams: () => mockSearchParams,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession(),
}))

const notify = vi.fn()

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
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

import { TerminalGlobalFilterProvider } from '@/components/terminal/global-filter-context'
import OrderInfoPage from './page'

describe('订单信息页终端化（BLF-817）', () => {
  beforeEach(() => {
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

  it('订单表使用实体 term 表头、规范数值列与选中态语义', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    const table = screen.getByRole('table', { name: '订单列表' })
    const firstHeader = table.querySelector('thead th')
    const quantityHeader = screen.getByRole('columnheader', { name: /数量/ })
    const quantityCell = table.querySelector('tbody tr:first-child td:nth-child(6)')
    const amountCell = table.querySelector('tbody tr:first-child td:nth-child(7)')

    expect(firstHeader?.className).toContain('bg-term-raised')
    expect(quantityHeader.className).toContain('text-right')
    expect(quantityHeader.className).toContain('tabular-nums')
    expect(quantityCell?.className).toContain('text-right')
    expect(quantityCell?.className).toContain('tabular-nums')
    expect(amountCell?.className).toContain('text-right')
    expect(amountCell?.className).toContain('tabular-nums')
    expect(table).toHaveClass('tabular-nums')
  })

  it('渲染订单行与终端状态 pill 语义色（Pending warn / Shipped pos / Cancelled neg）', async () => {
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    // 等数据行渲染出来
    expect(await screen.findByText('111-1111111-0000001')).toBeInTheDocument()
    expect(screen.getByText('111-1111111-0000002')).toBeInTheDocument()
    expect(screen.getByText('111-1111111-0000003')).toBeInTheDocument()

    const pendingPill = screen.getByText('处理中').closest('span')!
    expect(pendingPill.className).toContain('text-term-warn')
    expect(screen.getByText('已发货').closest('span')!.className).toContain('text-term-pos')
    expect(screen.getByText('已取消').closest('span')!.className).toContain('text-term-neg')
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

  it('表头排序按钮可点击触发带 sort 参数的刷新请求', async () => {
    const user = userEvent.setup()
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('111-1111111-0000001')
    const callsAfterLoad = fetchMock.mock.calls.length

    await user.click(screen.getByRole('columnheader', { name: /数量/ }))

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

  it('项目列表失败后用户清空筛选并重试时保留全部店铺选择', async () => {
    projectListMock.mockRejectedValueOnce(new Error('项目列表请求失败'))
    resetGfAndParams()
    render(
      <TerminalGlobalFilterProvider>
        <OrderInfoPage />
      </TerminalGlobalFilterProvider>
    )

    await screen.findByText('店铺列表加载失败，已暂停订单查询以避免默认查询全部店铺。')

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: '清空筛选' })[0]!)
    await waitFor(() => {
      const overviewCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/order-info/overview')
      )
      expect(overviewCalls.length).toBeGreaterThan(0)
      expect(String(overviewCalls.at(-1)![0])).not.toContain('project_ids=')
    })

    projectListMock.mockResolvedValueOnce([{ id: 1, name: '店铺A' }])
    await user.click(screen.getByRole('button', { name: '重试店铺列表' }))

    await waitFor(() => {
      const overviewCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/order-info/overview')
      )
      expect(overviewCalls.length).toBeGreaterThan(0)
      expect(String(overviewCalls.at(-1)![0])).not.toContain('project_ids=')
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

      expect(await screen.findByText(/ERR · timeout/)).toBeInTheDocument()
      expect(screen.getByText('111-1111111-0000001')).toBeInTheDocument()

      act(() => {
        headerRefreshState.handler?.()
      })
      await waitFor(() => {
        expect(screen.queryByText(/ERR · timeout/)).not.toBeInTheDocument()
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
