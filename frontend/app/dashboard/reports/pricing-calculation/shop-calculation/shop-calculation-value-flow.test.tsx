import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'
import type { PricingCalculationRunItem, ProductCostItem } from '@/lib/pricing-calculation-types'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

import { ShopCalculationUsSection } from '@/components/dashboard/pricing-calculation/shop-calculation-us-section'

const product: ProductCostItem = {
  id: 1,
  project_name: '项目A',
  sku: 'SKU-001',
  asin: 'B000001',
  fnsku: 'FNSKU-001',
  fob_unit_cost: 32.5,
  first_leg_cost_rmb: 6.4,
  package_length_cm: 20,
  package_width_cm: 12,
  package_height_cm: 8,
  weight_kg: 0.42,
  carton_length_cm: 40,
  carton_width_cm: 30,
  carton_height_cm: 20,
  carton_weight_kg: 8,
  units_per_carton: 20,
  currency: 'USD',
  country: 'US',
  sort_order: 1,
  is_active: true,
}

const run = makeRun()

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'

  if (url.includes('/api/exchange-rates')) {
    return jsonResponse({ data: [{ rate: 7.2 }] })
  }
  if (url.includes('/api/v1/sku-info')) {
    return jsonResponse({ items: [product], page: 1, page_size: 200, has_next: false })
  }
  if (url.includes('/api/v1/pricing-calculation/quote') && method === 'POST') {
    return jsonResponse(run)
  }
  if (url.includes('/api/v1/shop-calculation') && method === 'POST') {
    return jsonResponse({ id: 11, sku: product.sku })
  }
  if (url.includes('/api/v1/shop-calculation') && method === 'GET') {
    return jsonResponse({ items: [], total: 0 })
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
  vi.stubGlobal('fetch', fetchMock)
})

describe('店铺测算真实测算契约', () => {
  it('submits the real quote payload and saves the resulting snapshot', async () => {
    render(
      <ShopCalculationUsSection
        selectedCountry="US"
        selectedProjectName="项目A"
        selectedProjectId={1}
        skuKeyword=""
        onProjectChange={vi.fn()}
        onSkuKeywordChange={vi.fn()}
        onStoreRowsChange={vi.fn()}
      />
    )

    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('售价(USD)'), { target: { value: '39.99' } })
    fireEvent.click(screen.getByRole('button', { name: '测算' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backend/api/v1/pricing-calculation/quote',
        expect.objectContaining({ method: 'POST' })
      )
    })

    const quoteCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/pricing-calculation/quote')
    )
    const quoteBody = JSON.parse(String(quoteCall?.[1]?.body))
    expect(quoteBody).toMatchObject({
      country: 'US',
      project_id: 1,
      sku: 'SKU-001',
      product_name: '项目A / SKU-001',
      package_length_cm: 20,
      package_width_cm: 12,
      package_height_cm: 8,
      weight_kg: 0.42,
      fob_product_cost_rmb: 32.5,
      first_leg_cost_rmb: 6.4,
      sale_price_usd: 39.99,
      commission_rate: 0.15,
      advertising_rate: 0.12,
      return_loss_rate: 0.04,
      storage_months: 1,
      inbound_placement_mode: 'single_destination',
      use_historical_shipping_cost: true,
      usd_to_rmb_rate: 7.2,
    })
    expect(quoteBody).not.toHaveProperty('date')

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backend/api/v1/shop-calculation',
        expect.objectContaining({ method: 'POST' })
      )
    })
    const saveCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/api/v1/shop-calculation') && init?.method === 'POST'
    )
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      project_id: 1,
      project_name: '项目A',
      sku: 'SKU-001',
      country: 'US',
      accounting_type: 'profit_calc',
      profit_usd: 16.09,
    })
  })
})

function makeRun(): PricingCalculationRunItem {
  return {
    id: 9,
    country: 'US',
    product_name: '项目A / SKU-001',
    calculation_type: 'profit_calc',
    project_id: 1,
    sku: 'SKU-001',
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
