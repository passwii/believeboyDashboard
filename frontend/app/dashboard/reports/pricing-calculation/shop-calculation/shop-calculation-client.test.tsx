import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, type ReactNode } from 'react'

import { stableSession } from '@/test-utils/stable-mocks'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import type { PricingCalculationRunItem, ProductCostItem } from '@/lib/pricing-calculation-types'

const headerCapture = vi.hoisted(() => ({ slot: null as ReactNode }))
const downloadBlobMock = vi.hoisted(() => vi.fn())
const notificationsValue = vi.hoisted(() => ({ notify: vi.fn() }))
const nav = vi.hoisted(() => {
  let params = new URLSearchParams()
  return {
    set(value: string) {
      params = new URLSearchParams(value)
    },
    get: (key: string) => params.get(key),
    toString: () => params.toString(),
    replace: (url: string) => {
      const query = url.includes('?') ? (url.split('?')[1] ?? '') : ''
      params = new URLSearchParams(query)
    },
  }
})

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: false } }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/pricing-calculation/shop-calculation',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
  useSearchParams: () => ({ get: nav.get, toString: nav.toString }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => notificationsValue,
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

vi.mock('@/components/dashboard/pricing-calculation/shop-calculation-us-section', () => ({
  ShopCalculationUsSection: () => <div data-testid="shop-us-section">US</div>,
}))

vi.mock('@/components/dashboard/pricing-calculation/shop-calculation-eu-section', () => ({
  ShopCalculationEuSection: ({
    onDataReady,
    onHasCalculatedRowsChange,
  }: {
    onDataReady: (data: {
      items: ProductCostItem[]
      rows: Record<number, { draft: Record<string, string>; result: PricingCalculationRunItem | null }>
    }) => void
    onHasCalculatedRowsChange: (value: boolean) => void
  }) => {
    const emitted = useRef(false)
    useEffect(() => {
      if (emitted.current) return
      emitted.current = true
      onDataReady({ items: [euProduct], rows: { [euProduct.id]: { draft: {}, result: euRun } } })
      onHasCalculatedRowsChange(true)
    }, [onDataReady, onHasCalculatedRowsChange])
    return <div data-testid="shop-eu-section">EU</div>
  },
}))

vi.mock('@/components/dashboard/pricing-calculation/snapshot-selector', () => ({
  PricingSnapshotSelector: ({ disabled }: { disabled: boolean }) => (
    <button type="button" disabled={disabled}>
      定价快照
    </button>
  ),
}))

vi.mock('@/components/dashboard/pricing-calculation/create-snapshot-dialog', () => ({
  CreatePricingSnapshotDialog: () => null,
}))

vi.mock('@/components/dashboard/pricing-calculation/edit-snapshot-dialog', () => ({
  EditPricingSnapshotDialog: () => null,
}))

vi.mock('@/lib/operation-audit', () => ({
  logClientOperation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}))

vi.mock('exceljs', () => {
  function columnName(index: number) {
    let value = index
    let result = ''
    while (value > 0) {
      const remainder = (value - 1) % 26
      result = String.fromCharCode(65 + remainder) + result
      value = Math.floor((value - 1) / 26)
    }
    return result
  }

  function makeCell(rowIndex: number, columnIndex: number) {
    return {
      address: `${columnName(columnIndex)}${rowIndex}`,
      value: null,
      font: null,
      alignment: null,
      fill: null,
      border: null,
      numFmt: '',
    }
  }

  function makeRow(rowIndex: number) {
    const cells = new Map<number, ReturnType<typeof makeCell>>()
    return {
      height: 0,
      values: [] as unknown[],
      getCell(index: number) {
        if (!cells.has(index)) cells.set(index, makeCell(rowIndex, index))
        return cells.get(index)!
      },
      eachCell(
        optionsOrCallback:
          | { includeEmpty?: boolean }
          | ((cell: ReturnType<typeof makeCell>, index: number) => void),
        maybeCallback?: (cell: ReturnType<typeof makeCell>, index: number) => void
      ) {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!
        for (let index = 1; index <= Math.max(40, this.values.length); index += 1) {
          callback(this.getCell(index), index)
        }
      },
    }
  }

  const rows = new Map<number, ReturnType<typeof makeRow>>()
  let nextRow = 1
  const worksheet = {
    views: [],
    getRow(index: number) {
      if (!rows.has(index)) rows.set(index, makeRow(index))
      return rows.get(index)!
    },
    getCell(row: number, column: number) {
      return this.getRow(row).getCell(column)
    },
    mergeCells: vi.fn(),
    addRow(values: unknown[]) {
      const row = makeRow(nextRow)
      row.values = values
      rows.set(nextRow, row)
      nextRow += 1
      return row
    },
    eachRow(
      _options: unknown,
      callback: (row: ReturnType<typeof makeRow>, index: number) => void
    ) {
      for (const [index, row] of rows.entries()) callback(row, index)
    },
    getColumn() {
      return { width: 0 }
    },
  }
  const workbook = {
    creator: '',
    created: new Date(),
    addWorksheet: vi.fn(() => worksheet),
    xlsx: { writeBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) },
  }

  return {
    Workbook: class {
      constructor() {
        return workbook
      }
    },
  }
})

import ShopCalculationClient from './shop-calculation-client'

const euProduct: ProductCostItem = {
  id: 2,
  project_name: '项目A',
  sku: 'SKU-EU-001',
  asin: 'B000EU',
  fnsku: 'FNSKU-EU',
  fob_unit_cost: 20,
  first_leg_cost_rmb: 5,
  package_length_cm: 20,
  package_width_cm: 12,
  package_height_cm: 8,
  weight_kg: 0.4,
  carton_length_cm: 40,
  carton_width_cm: 30,
  carton_height_cm: 20,
  carton_weight_kg: 8,
  units_per_carton: 20,
  currency: 'EUR',
  country: 'DE',
  sort_order: 1,
  is_active: true,
}

const euRun: PricingCalculationRunItem = {
  id: 12,
  country: 'DE',
  product_name: '项目A / SKU-EU-001',
  calculation_type: 'eu_accounting',
  project_id: 1,
  sku: 'SKU-EU-001',
  package_length_cm: 20,
  package_width_cm: 12,
  package_height_cm: 8,
  weight_kg: 0.4,
  fob_product_cost_rmb: 20,
  first_leg_cost_rmb: 5,
  delivery_fee_usd: 0,
  full_container_price_rmb: 0,
  full_container_quantity: 0,
  sale_price_usd: 30,
  commission_rate: 0.15,
  advertising_rate: 0.12,
  return_loss_rate: 0.04,
  storage_months: 1,
  inbound_placement_mode: 'single_destination',
  size_tier: 'standard',
  size_tier_label: '标准尺寸',
  price_band: '20-30',
  price_band_label: '€20-€30',
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
    product_weight_lb: 0.9,
    product_weight_oz: 14.4,
    dimensional_weight_lb: 0.8,
    chargeable_weight_lb: 0.9,
    chargeable_weight_oz: 14.4,
    chargeable_weight_rule: '实重',
  },
  fees: {
    referral_fee_usd: 4.5,
    advertising_fee_usd: 3.6,
    return_loss_usd: 1.2,
    fba_fulfillment_fee_usd: 5,
    inbound_config_fee_usd: 0.5,
    storage_fee_usd: 0.2,
    platform_fee_usd: 0,
    total_fee_usd: 15,
  },
  profit: {
    ddp_cost_rmb: 25,
    ddp_cost_usd: 3.5,
    delivery_fee_usd: 0,
    full_container_price_rmb: 0,
    full_container_quantity: 0,
    payout_usd: 18,
    profit_usd: 9,
    profit_rate: 0.3,
    vat_usd: 0,
  },
  warnings: [],
  created_by: '张三',
  created_at: '2026-11-05T08:00:00+08:00',
  updated_at: '2026-11-05T08:00:00+08:00',
}

const fetchMock = vi.fn(async () => jsonResponse({}))

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
  nav.set('')
  vi.stubGlobal('fetch', fetchMock)
})

describe('店铺测算 Warm Ledger 页面', () => {
  it('renders the Warm console, snapshot control, and data table surface', async () => {
    const { container } = render(<ShopCalculationClient />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      container.querySelector('[data-warm-pricing-shop-calculation="true"]')
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '控制台' })).toHaveAttribute(
      'data-warm-surface',
      'true'
    )
    expect(screen.getByTestId('shop-us-section')).toBeInTheDocument()
    expect(screen.getByText('SKU')).toBeInTheDocument()
    expect(screen.getByText('已测算')).toBeInTheDocument()
    expect(screen.getByText('盈利')).toBeInTheDocument()
    expect(screen.getByText('盈利占比')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '定价快照' })).toBeInTheDocument())
  })

  it('keeps export disabled until calculated rows exist', async () => {
    render(<ShopCalculationClient />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: '导出 Excel' })).toBeDisabled()
  })

  it('renders only Warm controls inside the header portal', async () => {
    render(<ShopCalculationClient />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(headerCapture.slot).not.toBeNull()
    const { container } = render(<>{headerCapture.slot}</>)
    const header = container.querySelector('[data-warm-header-filters="true"]')

    expect(header).toBeInTheDocument()
    expect(screen.getByLabelText('项目筛选')).toBeInTheDocument()
    expect(screen.getByLabelText('SKU 搜索')).toBeInTheDocument()
    expect(screen.getByLabelText('站点筛选')).toBeInTheDocument()
    for (const element of [header!, ...Array.from(header!.querySelectorAll('*'))]) {
      const className = typeof element.className === 'string' ? element.className : ''
      expect(className).not.toContain('rounded-none')
      expect(className).not.toContain('term-')
      expect(className).not.toContain('font-mono')
    }
  })

  it('writes project and country changes back to the URL contract', async () => {
    render(<ShopCalculationClient />)
    await waitFor(() => expect(fetchManagedProjectsCached).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    render(<>{headerCapture.slot}</>)
    await waitFor(() => expect(screen.getByLabelText('项目筛选')).not.toBeDisabled())

    fireEvent.change(screen.getByLabelText('项目筛选'), { target: { value: '项目A' } })
    await waitFor(() => expect(nav.get('project')).toBe('1'))

    fireEvent.change(screen.getByLabelText('站点筛选'), { target: { value: 'DE' } })
    await waitFor(() => {
      expect(nav.get('project')).toBe('1')
      expect(nav.get('country')).toBe('DE')
    })
  })

  it('exports calculated EU rows through the real download contract', async () => {
    nav.set('country=DE')
    render(<ShopCalculationClient />)

    const exportButton = screen.getByRole('button', { name: '导出 Excel' })
    await waitFor(() => expect(exportButton).toBeEnabled())
    fireEvent.click(exportButton)

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1))
    const filename = String(downloadBlobMock.mock.calls[0]?.[1])
    expect(filename).toContain('德国')
    expect(filename).toContain('店铺SKU测算')
    expect(filename).toMatch(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.xlsx$/)
  })
})
