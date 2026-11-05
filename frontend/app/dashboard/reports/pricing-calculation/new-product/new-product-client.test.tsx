import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { stableNotifications } from '@/test-utils/stable-mocks'
import type { PricingCalculationRunItem } from '@/lib/pricing-calculation-types'

const headerCapture = vi.hoisted(() => ({ slot: null as ReactNode }))
const downloadBlobMock = vi.hoisted(() => vi.fn())

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/pricing-calculation/new-product',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="dynamic-table" />,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '项目A' }]),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderSlot: (node: ReactNode) => {
    headerCapture.slot = node
    return null
  },
  useMobileFilterStrip: () => null,
}))

vi.mock('@/lib/operation-audit', () => ({
  logClientOperation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}))

vi.mock('@/lib/excel-styles', () => ({
  applyBorder: vi.fn(),
  applyHeaderBorder: vi.fn(),
}))

vi.mock('exceljs', () => {
  function makeCell() {
    return {
      value: null,
      font: null,
      alignment: null,
      fill: null,
      border: null,
      numFmt: '',
    }
  }

  function makeRow() {
    const cells = new Map<number, ReturnType<typeof makeCell>>()
    return {
      height: 0,
      values: [] as unknown[],
      getCell(index: number) {
        if (!cells.has(index)) cells.set(index, makeCell())
        return cells.get(index)!
      },
      eachCell(callback: (cell: ReturnType<typeof makeCell>, index: number) => void) {
        for (let index = 1; index <= 40; index += 1) callback(this.getCell(index), index)
      },
    }
  }

  const rows = new Map<number, ReturnType<typeof makeRow>>()
  const worksheet = {
    columns: [] as unknown[],
    pageSetup: {},
    getRow(index: number) {
      if (!rows.has(index)) rows.set(index, makeRow())
      return rows.get(index)!
    },
    getCell(row: number, column: number) {
      return this.getRow(row).getCell(column)
    },
    mergeCells: vi.fn(),
  }
  const workbook = {
    creator: '',
    created: new Date(),
    addWorksheet: vi.fn(() => worksheet),
    xlsx: {
      writeBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    },
  }

  return {
    Workbook: class {
      constructor() {
        return workbook
      }
    },
  }
})

import NewProductClient from './new-product-client'

let runsPayload: PricingCalculationRunItem[] = []
let quoteDeferred: Promise<Response> | null = null
let deleteDeferred: Promise<Response> | null = null

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/pricing-calculation/quote') && init?.method === 'POST') {
    if (quoteDeferred) return quoteDeferred
  }
  if (url.includes('/pricing-calculation/runs/') && init?.method === 'DELETE') {
    if (deleteDeferred) return deleteDeferred
  }
  if (url.includes('/pricing-calculation/runs')) {
    return jsonResponse({
      items: runsPayload,
      total: runsPayload.length,
      page: 1,
      page_size: 12,
    })
  }
  if (url.includes('/product-costs')) {
    return jsonResponse({ items: [], page: 1, page_size: 20, has_next: false })
  }
  if (url.includes('/shipment')) {
    return jsonResponse({ items: [] })
  }
  return jsonResponse({})
})

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers(),
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  headerCapture.slot = null
  runsPayload = []
  quoteDeferred = null
  deleteDeferred = null
  vi.stubGlobal('fetch', fetchMock)
})

describe('新品核算 Warm Ledger 页面', () => {
  it('renders the Warm workspace and preserves the four calculation modes', async () => {
    const user = userEvent.setup()
    const { container } = render(<NewProductClient />)

    expect(container.querySelector('[data-warm-pricing-new-product="true"]')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '测算输入' })).toHaveAttribute(
      'data-warm-surface',
      'true'
    )
    expect(screen.getByRole('region', { name: '控制台' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '最近测算' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '测算对比矩阵' })).toBeInTheDocument()

    for (const mode of ['利润核算', '利润倒算', '成本倒推', 'FBM测算']) {
      expect(screen.getByRole('tab', { name: mode })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('tab', { name: '利润倒算' }))
    expect(await screen.findByText('目标利润率(%)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '倒算售价' })).toBeInTheDocument()
  })

  it('keeps the form, export action, and empty run state usable', async () => {
    render(<NewProductClient />)

    expect(screen.getByPlaceholderText('例如：桌面置物架')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始测算' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 Excel' })).toBeDisabled()
    await waitFor(() => expect(screen.getAllByText('暂无测算记录').length).toBeGreaterThan(0))
  })

  it('renders only Warm controls inside the header portal', () => {
    render(<NewProductClient />)

    expect(headerCapture.slot).not.toBeNull()
    const { container } = render(<>{headerCapture.slot}</>)
    const header = container.querySelector('[data-warm-header-filters="true"]')

    expect(header).toBeInTheDocument()
    expect(screen.getByLabelText('产品搜索')).toBeInTheDocument()
    expect(screen.getByLabelText('已选测算结果')).toBeInTheDocument()
    for (const element of [header!, ...Array.from(header!.querySelectorAll('*'))]) {
      const className = typeof element.className === 'string' ? element.className : ''
      expect(className).not.toContain('rounded-none')
      expect(className).not.toContain('term-')
      expect(className).not.toContain('font-mono')
    }
  })

  it('submits the calculation URL and payload with a busy Warm button', async () => {
    let resolveQuote: (response: Response) => void = () => {}
    quoteDeferred = new Promise<Response>((resolve) => {
      resolveQuote = resolve
    })
    const run = makeRun()

    render(<NewProductClient />)
    fireEvent.change(screen.getByPlaceholderText('例如：桌面置物架'), {
      target: { value: '测试产品' },
    })
    const numericInputs = screen.getAllByRole('spinbutton')
    numericInputs.slice(0, 11).forEach((input, index) => {
      fireEvent.change(input, { target: { value: index === 0 ? '10' : '1' } })
    })
    fireEvent.click(screen.getByRole('button', { name: '开始测算' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/pricing-calculation/quote'),
        expect.objectContaining({ method: 'POST' })
      )
    })

    const busyButton = screen.getByRole('button', { name: '正在测算' })
    expect(busyButton).toHaveAttribute('aria-busy', 'true')
    expect(busyButton).toBeDisabled()

    const quoteCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/pricing-calculation/quote')
    )
    const payload = JSON.parse(String(quoteCall?.[1]?.body))
    expect(payload.product_name).toBe('测试产品')
    expect(payload.country).toBe('US')
    expect(payload.sale_price_usd).toBe(1)

    resolveQuote(jsonResponse(run))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '开始测算' })).not.toHaveAttribute('aria-busy')
    )
  })

  it('exports selected comparison runs with the original download contract', async () => {
    runsPayload = [makeRun()]
    render(<NewProductClient />)

    const runCard = await screen.findByRole('button', { name: /测试产品/ })
    fireEvent.click(runCard)

    const exportButton = screen.getByRole('button', { name: '导出 Excel' })
    await waitFor(() => expect(exportButton).toBeEnabled())
    fireEvent.click(exportButton)

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1))
    expect(String(downloadBlobMock.mock.calls[0]?.[1])).toContain('测算对比矩阵')
  })

  it('exposes WarmIconButton delete loading state and DELETE contract', async () => {
    runsPayload = [makeRun()]
    let resolveDelete: (response: Response) => void = () => {}
    deleteDeferred = new Promise<Response>((resolve) => {
      resolveDelete = resolve
    })
    render(<NewProductClient />)

    await screen.findByRole('button', { name: /测试产品/ })
    fireEvent.click(screen.getByRole('button', { name: '删除此测算' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backend/api/v1/pricing-calculation/runs/91',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
    const busyDelete = screen.getByRole('button', { name: '正在删除测算记录' })
    expect(busyDelete).toHaveAttribute('aria-busy', 'true')
    expect(busyDelete).toBeDisabled()

    resolveDelete(jsonResponse({ ok: true }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '删除此测算' })).not.toHaveAttribute('aria-busy')
    )
  })
})

function makeRun(): PricingCalculationRunItem {
  return {
    id: 91,
    country: 'US',
    product_name: '测试产品 / SKU-1',
    calculation_type: 'profit_calc',
    project_id: 1,
    sku: 'SKU-1',
    package_length_cm: 20,
    package_width_cm: 12,
    package_height_cm: 8,
    weight_kg: 0.42,
    fob_product_cost_rmb: 32.5,
    first_leg_cost_rmb: 6.4,
    delivery_fee_usd: 0,
    full_container_price_rmb: 0,
    full_container_quantity: 0,
    sale_price_usd: 39.99,
    commission_rate: 0.15,
    advertising_rate: 0.12,
    return_loss_rate: 0.04,
    storage_months: 1,
    inbound_placement_mode: 'single_destination',
    size_tier: 'standard',
    size_tier_label: '标准尺寸',
    price_band: '20-30',
    price_band_label: '$20-$30',
    usd_to_rmb_rate: 7.2,
    usd_to_rmb_rate_source: 'system',
    fulfillment_fee_rule_label: '标准配送',
    inbound_config_fee_rule_label: '单仓入库',
    storage_fee_rule_label: '月度仓储',
    dimensions: {
      longest_side_in: 7.8,
      middle_side_in: 4.7,
      shortest_side_in: 3.1,
      length_plus_girth_in: 23.4,
      volume_cubic_in: 114,
      volume_cubic_ft: 0.06,
    },
    weights: {
      product_weight_lb: 0.92,
      product_weight_oz: 14.7,
      dimensional_weight_lb: 0.8,
      chargeable_weight_lb: 0.92,
      chargeable_weight_oz: 14.7,
      chargeable_weight_rule: '实重',
    },
    fees: {
      referral_fee_usd: 6,
      advertising_fee_usd: 4.8,
      return_loss_usd: 1.6,
      fba_fulfillment_fee_usd: 5.2,
      inbound_config_fee_usd: 0.6,
      storage_fee_usd: 0.3,
      platform_fee_usd: 0,
      total_fee_usd: 18.5,
    },
    profit: {
      ddp_cost_rmb: 38.9,
      ddp_cost_usd: 5.4,
      delivery_fee_usd: 0,
      full_container_price_rmb: 0,
      full_container_quantity: 0,
      payout_usd: 21.49,
      profit_usd: 16.09,
      profit_rate: 0.4,
      vat_usd: 0,
    },
    warnings: [],
    created_by: '张三',
    created_at: '2026-11-05T08:00:00+08:00',
    updated_at: '2026-11-05T08:00:00+08:00',
  }
}
