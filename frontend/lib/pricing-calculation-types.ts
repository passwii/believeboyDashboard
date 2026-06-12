// Shared types for pricing calculation pages
//
// Per BEL-22-3 / BEL-29, the canonical shapes for `PricingCalculationRunItem`
// and `ShopCalculationItem` come from the OpenAPI export (Pydantic schemas
// in `backend/app/schemas/pricing_calculation.py`). The hand-written types
// below for `ProductCostItem`, `ProductCostsResponse`, and `ProjectManageOption`
// stay locally declared because they reflect page-level aggregates (sort
// order, project dropdown shape) that aren't 1:1 with a single backend schema
// — they will move into a follow-up schema pass.

import type { components } from '@/types/api-generated/api'

export type PricingCalculationRunItem = components['schemas']['PricingCalculationRunItem']
export type ShopCalculationItem = components['schemas']['ShopCalculationItem']
export type PricingCalculationDimensions = components['schemas']['PricingCalculationDimensions']
export type PricingCalculationWeight = components['schemas']['PricingCalculationWeight']
export type PricingCalculationFees = components['schemas']['PricingCalculationFees']
export type PricingCalculationProfit = components['schemas']['PricingCalculationProfit']

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
