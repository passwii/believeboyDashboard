import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ShopCalculationTable } from './shop-calculation-table'
import type { PricingCalculationRunItem, ProductCostItem } from '@/lib/pricing-calculation-types'

const item: ProductCostItem = {
  id: 1,
  project_name: '项目A',
  sku: 'SKU-LONG-001',
  asin: 'B000TEST',
  fnsku: 'FNSKU-1',
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

const result: PricingCalculationRunItem = {
  id: 9,
  country: 'US',
  product_name: '项目A / SKU-LONG-001',
  calculation_type: 'profit_calc',
  project_id: 1,
  sku: 'SKU-LONG-001',
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
  warnings: ['体积重接近实重，请复核包装尺寸'],
  created_by: '张三',
  created_at: '2026-11-05T08:00:00+08:00',
  updated_at: '2026-11-05T08:00:00+08:00',
}

describe('ShopCalculationTable Warm Ledger contract', () => {
  it('renders all rows, fixed columns, and status blocks without Terminal surfaces', () => {
    const { container } = render(
      <ShopCalculationTable
        items={[item]}
        rowStates={{
          [item.id]: {
            draft: {
              package_length_cm: '20',
              package_width_cm: '12',
              package_height_cm: '8',
              weight_kg: '0.42',
              first_leg_cost_rmb: '6.4',
              sale_price_usd: '39.99',
              advertising_rate: '12',
              return_loss_rate: '4',
              storage_months: '1',
              inbound_placement_mode: 'single_destination',
              usd_to_rmb_rate: '7.2',
            },
            loading: false,
            result,
            error: null,
          },
        }}
        onDraftChange={vi.fn()}
        onCalculate={vi.fn()}
        systemExchangeRate="7.2"
      />
    )

    const table = container.querySelector('[data-warm-shop-calculation-table="true"]')
    expect(table).toBeInTheDocument()
    expect(container.querySelector('[data-sticky-column="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-status-block="warning"]')).toHaveTextContent(
      '体积重接近实重'
    )

    const markup = container.innerHTML
    expect(markup).not.toContain('rounded-none')
    expect(markup).not.toMatch(/\b(?:bg|border|text)-term-/)
    expect(markup).not.toContain('font-mono')
  })

  it('keeps edit and calculate actions wired with Warm controls', () => {
    const onDraftChange = vi.fn()
    const onCalculate = vi.fn()

    const { container } = render(
      <ShopCalculationTable
        items={[item]}
        rowStates={{}}
        onDraftChange={onDraftChange}
        onCalculate={onCalculate}
        systemExchangeRate="7.2"
      />
    )

    fireEvent.change(screen.getByLabelText('长(cm)'), { target: { value: '21' } })
    expect(onDraftChange).toHaveBeenCalledWith(item.id, 'package_length_cm', '21')

    fireEvent.click(screen.getByRole('button', { name: '测算' }))
    expect(onCalculate).toHaveBeenCalledWith(item)
    expect(container.querySelector('[data-status-block="pending"]')).toHaveTextContent('待测算')
  })

  it('uses Warm tokens and keeps all data rows inside the scroll container', () => {
    const css = readFileSync(join(__dirname, 'shop-calculation-table-warm.module.css'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-font-mono)')
    expect(css).toContain("[class~='text-right']")
    expect(css).toContain('font-variant-numeric: var(--warm-ledger-font-variant-numeric);')
    expect(css).toContain('position: sticky')
    expect(css).toContain('overflow: auto')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('rounded-none')
  })
})
