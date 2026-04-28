// Shared types for pricing calculation pages

export type PricingCalculationRunItem = {
  id: number
  country?: string
  product_name: string
  calculation_type:
    | 'profit_calc'
    | 'profit_reverse'
    | 'cost_reverse'
    | 'fbm_calc'
    | 'eu_accounting'
  project_id: number | null
  sku: string | null
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
  full_container_quantity?: number
  full_container_price_rmb?: number
  delivery_fee_usd?: number
  commission_rate: number
  advertising_rate: number
  return_loss_rate: number
  storage_months: number
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  size_tier: string
  size_tier_label: string
  price_band: string
  price_band_label: string
  usd_to_rmb_rate: number
  usd_to_rmb_rate_source: string
  fulfillment_fee_rule_label: string
  inbound_config_fee_rule_label: string
  storage_fee_rule_label: string
  dimensions: {
    longest_side_in: number
    middle_side_in: number
    shortest_side_in: number
    length_plus_girth_in: number
    volume_cubic_in: number
    volume_cubic_ft: number
  }
  weights: {
    product_weight_lb: number
    product_weight_oz: number
    dimensional_weight_lb: number
    chargeable_weight_lb: number
    chargeable_weight_oz: number
    chargeable_weight_rule: string
  }
  fees: {
    referral_fee_usd: number
    advertising_fee_usd: number
    return_loss_usd: number
    fba_fulfillment_fee_usd: number
    inbound_config_fee_usd: number
    storage_fee_usd: number
    total_fee_usd: number
    platform_fee_usd?: number
  }
  profit: {
    ddp_cost_rmb: number
    ddp_cost_usd: number
    payout_usd: number
    profit_usd: number
    profit_rate: number
    vat_usd?: number
    profit_after_vat_usd?: number | null
    profit_after_vat_rate?: number | null
  }
  warnings: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}

export type StoreAccountingItem = {
  id: number
  project_id: number
  project_name: string
  sku: string
  asin: string | null
  country: string
  accounting_type: 'profit_calc' | 'eu_accounting'
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
  commission_rate?: number
  advertising_rate: number
  return_loss_rate: number
  storage_months: number
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  size_tier: string
  size_tier_label: string
  price_band: string
  price_band_label: string
  usd_to_rmb_rate: number
  usd_to_rmb_rate_source: string
  fulfillment_fee_rule_label: string
  inbound_config_fee_rule_label: string
  storage_fee_rule_label: string
  dimensions: {
    longest_side_in: number
    middle_side_in: number
    shortest_side_in: number
    length_plus_girth_in: number
    volume_cubic_in: number
    volume_cubic_ft: number
  }
  weights: {
    product_weight_lb: number
    product_weight_oz: number
    dimensional_weight_lb: number
    chargeable_weight_lb: number
    chargeable_weight_oz: number
    chargeable_weight_rule: string
  }
  fees: {
    referral_fee_usd: number
    advertising_fee_usd: number
    return_loss_usd: number
    fba_fulfillment_fee_usd: number
    inbound_config_fee_usd: number
    storage_fee_usd: number
    total_fee_usd: number
    delivery_fee_usd?: number
    inbound_config_fee_manual_usd?: number
    storage_fee_manual_usd?: number
    platform_fee_usd?: number
  }
  profit: {
    ddp_cost_rmb: number
    ddp_cost_usd: number
    payout_usd: number
    profit_usd: number
    profit_rate: number
    vat_usd?: number
    profit_after_vat_usd?: number | null
    profit_after_vat_rate?: number | null
  }
  warnings: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}

export type ProductCostItem = {
  id: number
  project_name: string
  sku: string
  asin: string
  fnsku: string | null
  fob_unit_cost: number
  first_leg_cost_rmb: number
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  carton_length_cm: number
  carton_width_cm: number
  carton_height_cm: number
  carton_weight_kg: number
  units_per_carton: number
  currency: string
  country: string
  sort_order: number
  is_active: boolean
}

export type ProductCostsResponse = {
  items: ProductCostItem[]
  page: number
  page_size: number
  total?: number | null
  has_next: boolean
}

export type ProjectManageOption = {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  project_operator: string | null
  assistant_operator: string | null
  commission_basis: string | null
  commission_rate: number | null
  sort_order: number
  source_file: string | null
}

export const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

export const EU_COUNTRY_OPTIONS = [
  { value: 'DE', label: '德国站 (DE) - 19% VAT' },
  { value: 'UK', label: '英国站 (UK) - 20% VAT' },
] as const

export type Country = 'US' | 'DE' | 'UK'
