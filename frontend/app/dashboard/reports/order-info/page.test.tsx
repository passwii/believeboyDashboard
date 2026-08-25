import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import OrderInfoPage from './page'

describe('订单信息页终端化（BLF-817）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockClear()
  })

  it('渲染订单行与终端状态 pill 语义色（Pending warn / Shipped pos / Cancelled neg）', async () => {
    render(<OrderInfoPage />)

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
    render(<OrderInfoPage />)

    await screen.findByText('111-1111111-0000001')
    expect(screen.getByText('Σ 单量').closest('span')).toHaveTextContent('3')
    expect(screen.getByText('Σ 金额').closest('span')).toHaveTextContent('43.00 USD')
    expect(screen.getByText(/共/).closest('span')).toHaveTextContent('3')
  })

  it('勾选行后聚合条出现选中态合计，金额口径 = item_price + shipping_price', async () => {
    const user = userEvent.setup()
    render(<OrderInfoPage />)

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
    render(<OrderInfoPage />)

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
    render(<OrderInfoPage />)
    await screen.findByText('111-1111111-0000001')

    const amountCell = screen.getByText('15.00 USD')
    expect(amountCell).toBeInTheDocument()
    expect(screen.getByText('+ 运费 5.00')).toBeInTheDocument()
    // 无运费的行不显示运费标注
    expect(screen.getByText('20.00 USD')).toBeInTheDocument()
  })
})
