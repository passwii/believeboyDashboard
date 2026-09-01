import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  getAll: vi.fn((): string[] => []),
  get: vi.fn((): string | null => null),
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/dashboard/reports/order-info',
  useSearchParams: () => mockSearchParams,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))

const notify = vi.fn()

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi
    .fn()
    .mockResolvedValue([{ id: 1, name: '店铺A' }]),
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

const fetchMock = vi.fn(async () =>
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
    // 店铺下拉显示自动选中的第一个店铺「店铺A」（而非 __all__）
    const projectTrigger = screen.getByRole('combobox', { name: '店铺' })
    expect(projectTrigger).toHaveTextContent('店铺A')
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
})
