// API helper functions for pricing calculation

import type {
  PricingCalculationRunItem,
  ShopCalculationItem,
} from './pricing-calculation-types'

const API_BASE = '/api/backend'

export type CalculationMode =
  | 'profit-calc'
  | 'profit-reverse'
  | 'cost-reverse'
  | 'fbm-calc'

export type RequestPayload = {
  calculationMode: CalculationMode
  country: string
  product_name: string
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
  target_profit_rate?: number
  commission_rate?: number
  advertising_rate?: number
  return_loss_rate?: number
  storage_months?: number
  inbound_placement_mode?: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate?: number
  full_container_quantity?: number
  full_container_price_rmb?: number
  delivery_fee_usd?: number
  project_id?: number
  sku?: string
  use_historical_shipping_cost?: boolean
}

export async function requestPricingCalculation(
  payload: RequestPayload,
): Promise<PricingCalculationRunItem> {
  const { calculationMode, country, ...rest } = payload

  let body: Record<string, unknown> = { country, ...rest }

  let endpoint = ''
  if (calculationMode === 'profit-calc') {
    endpoint = '/api/v1/pricing-calculation/quote'
  } else if (calculationMode === 'profit-reverse') {
    endpoint = '/api/v1/pricing-calculation/reverse-quote'
  } else if (calculationMode === 'cost-reverse') {
    endpoint = '/api/v1/pricing-calculation/reverse-cost'
  } else if (calculationMode === 'fbm-calc') {
    endpoint = '/api/v1/pricing-calculation/fbm-quote'
  } else if (calculationMode === 'eu-calc') {
    endpoint = '/api/v1/pricing-calculation/eu-quote'
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({
      detail: '测算请求失败',
    }))) as { detail?: string; message?: string }
    throw new Error(errorPayload.detail || errorPayload.message || '定价测算失败')
  }
  return response.json() as Promise<PricingCalculationRunItem>
}

export type ShopCalculationPayload = {
  project_id: number
  project_name: string
  sku: string
  asin: string | null
  country: string | null
  accounting_type: 'profit_calc' | 'eu_accounting'
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  ddp_cost_rmb: number
  ddp_cost_usd: number
  sale_price_usd: number
  advertising_rate: number
  return_loss_rate: number
  storage_months: number
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: number
  usd_to_rmb_rate_source: string
  size_tier: string
  size_tier_label: string
  price_band: string
  price_band_label: string
  longest_side_in: number
  middle_side_in: number
  shortest_side_in: number
  length_plus_girth_in: number
  volume_cubic_in: number
  volume_cubic_ft: number
  product_weight_lb: number
  product_weight_oz: number
  dimensional_weight_lb: number
  chargeable_weight_lb: number
  chargeable_weight_oz: number
  chargeable_weight_rule: string
  fulfillment_fee_rule_label: string
  inbound_config_fee_rule_label: string
  storage_fee_rule_label: string
  referral_fee_usd: number
  advertising_fee_usd: number
  return_loss_usd: number
  fba_fulfillment_fee_usd: number
  inbound_config_fee_usd: number
  storage_fee_usd: number
  total_fee_usd: number
  payout_usd: number
  profit_usd: number
  profit_rate: number
  warnings: string[]
  delivery_fee_usd?: number
  inbound_config_fee_manual_usd?: number
  storage_fee_manual_usd?: number
  vat_usd?: number
  profit_after_vat_usd?: number | null
  profit_after_vat_rate?: number | null
}

/** @deprecated Use ShopCalculationPayload instead */
export type StoreAccountingPayload = ShopCalculationPayload

export async function requestSaveShopCalculation(
  payload: ShopCalculationPayload,
): Promise<ShopCalculationItem> {
  const response = await fetch(`${API_BASE}/api/v1/shop-calculation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: payload.project_id,
      project_name: payload.project_name,
      sku: payload.sku,
      asin: payload.asin,
      country: payload.country,
      accounting_type: payload.accounting_type,
      package_length_cm: payload.package_length_cm,
      package_width_cm: payload.package_width_cm,
      package_height_cm: payload.package_height_cm,
      weight_kg: payload.weight_kg,
      fob_product_cost_rmb: payload.fob_product_cost_rmb,
      first_leg_cost_rmb: payload.first_leg_cost_rmb,
      ddp_cost_rmb: payload.ddp_cost_rmb,
      ddp_cost_usd: payload.ddp_cost_usd,
      sale_price_usd: payload.sale_price_usd,
      advertising_rate: payload.advertising_rate,
      return_loss_rate: payload.return_loss_rate,
      storage_months: payload.storage_months,
      inbound_placement_mode: payload.inbound_placement_mode,
      usd_to_rmb_rate: payload.usd_to_rmb_rate,
      usd_to_rmb_rate_source: payload.usd_to_rmb_rate_source,
      size_tier: payload.size_tier,
      size_tier_label: payload.size_tier_label,
      price_band: payload.price_band,
      price_band_label: payload.price_band_label,
      longest_side_in: payload.longest_side_in,
      middle_side_in: payload.middle_side_in,
      shortest_side_in: payload.shortest_side_in,
      length_plus_girth_in: payload.length_plus_girth_in,
      volume_cubic_in: payload.volume_cubic_in,
      volume_cubic_ft: payload.volume_cubic_ft,
      product_weight_lb: payload.product_weight_lb,
      product_weight_oz: payload.product_weight_oz,
      dimensional_weight_lb: payload.dimensional_weight_lb,
      chargeable_weight_lb: payload.chargeable_weight_lb,
      chargeable_weight_oz: payload.chargeable_weight_oz,
      chargeable_weight_rule: payload.chargeable_weight_rule,
      fulfillment_fee_rule_label: payload.fulfillment_fee_rule_label,
      inbound_config_fee_rule_label: payload.inbound_config_fee_rule_label,
      storage_fee_rule_label: payload.storage_fee_rule_label,
      referral_fee_usd: payload.referral_fee_usd,
      advertising_fee_usd: payload.advertising_fee_usd,
      return_loss_usd: payload.return_loss_usd,
      fba_fulfillment_fee_usd: payload.fba_fulfillment_fee_usd,
      inbound_config_fee_usd: payload.inbound_config_fee_usd,
      storage_fee_usd: payload.storage_fee_usd,
      total_fee_usd: payload.total_fee_usd,
      payout_usd: payload.payout_usd,
      profit_usd: payload.profit_usd,
      profit_rate: payload.profit_rate,
      warnings: payload.warnings,
      delivery_fee_usd: payload.delivery_fee_usd ?? 0,
      inbound_config_fee_manual_usd: payload.inbound_config_fee_manual_usd ?? 0,
      storage_fee_manual_usd: payload.storage_fee_manual_usd ?? 0,
      vat_usd: payload.vat_usd ?? 0,
      profit_after_vat_usd: payload.profit_after_vat_usd ?? null,
      profit_after_vat_rate: payload.profit_after_vat_rate ?? null,
    }),
  })
  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({
      detail: '保存快照失败',
    }))) as { detail?: string; message?: string }
    throw new Error(errorPayload.detail || errorPayload.message || '保存快照失败')
  }
  return response.json() as Promise<ShopCalculationItem>
}

/** @deprecated Use requestSaveShopCalculation instead */
export const requestSaveStoreAccounting = requestSaveShopCalculation

export function formatCurrency(value: number) {
  return `$${value.toFixed(2)}`
}

export function formatRmb(value: number) {
  return `RMB ${value.toFixed(2)}`
}

export function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`
}

export function formatMetric(value: number, digits = 4) {
  return value.toFixed(digits)
}

export function toNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
