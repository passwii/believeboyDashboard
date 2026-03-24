'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Calculator, CheckCircle2, Download, Loader2, RefreshCw, Search, Trash2, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'

const API_BASE = '/api/backend'
const MAX_VISIBLE_RUNS = 8
const MAX_SELECTED_RUNS = 4
const HISTORY_SHIPMENT_STATUSES = ['completed', 'in_transit'] as const

function PricingFieldSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

function PricingRunCardSkeleton() {
  return (
    <div className="min-w-[180px] rounded-xl border border-border/70 p-3">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-3 h-4 w-28" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-12" />
      </div>
      <Skeleton className="mt-3 h-6 w-24" />
      <Skeleton className="mt-2 h-3 w-16" />
    </div>
  )
}

function PricingTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  )
}

type PricingCalculationRunItem = {
  id: number
  product_name: string
  calculation_type: 'profit_calc' | 'profit_reverse'
  project_id: number | null
  sku: string | null
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
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
  }
  profit: {
    ddp_cost_rmb: number
    ddp_cost_usd: number
    payout_usd: number
    profit_usd: number
    profit_rate: number
  }
  warnings: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}

type ListResponse = {
  items: PricingCalculationRunItem[]
  total: number
  page: number
  page_size: number
}

// 店铺 SKU 核算快照类型
type StoreSkuPricingSnapshotItem = {
  id: number
  project_id: number  // 项目 ID
  project_name: string
  sku: string
  asin: string | null
  country: string | null
  calculation_type: 'profit_calc' | 'profit_reverse'
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
  commission_rate?: number
  target_profit_rate: number | null
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
  }
  profit: {
    ddp_cost_rmb: number
    ddp_cost_usd: number
    payout_usd: number
    profit_usd: number
    profit_rate: number
  }
  warnings: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}

type StoreSkuPricingSnapshotListResponse = {
  items: StoreSkuPricingSnapshotItem[]
  total: number
  page: number
  page_size: number
}

type ProjectOption = {
  id: number | null
  name: string
}

type ProjectManageOption = {
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

type ProductCostItem = {
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

type ProductCostsResponse = {
  items: ProductCostItem[]
  page: number
  page_size: number
  total?: number | null
  has_next: boolean
}

type ShipmentSkuSummaryItem = {
  project_id: number
  project_name: string
  sku: string
  shipment_count: number
  total_quantity: number
  total_chargeable_weight_kg: number
  total_logistics_cost: number
  average_logistics_unit_price: number
  refreshed_at: string
}

type ShipmentSkuSummaryResponse = {
  items: ShipmentSkuSummaryItem[]
}

type FormState = {
  product_name: string
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  fob_product_cost_rmb: string
  first_leg_unit_price_rmb: string
  sale_price_usd: string
  target_profit_rate: string
  commission_rate: string
  advertising_rate: string
  return_loss_rate: string
  storage_months: string
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: string
}

type CalculationMode = 'profit-calc' | 'profit-reverse'
type BusinessTab = 'new-product' | 'store-accounting'

type StoreSkuDraft = {
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  first_leg_cost_rmb: string
  sale_price_usd: string
  target_profit_rate: string
  advertising_rate: string
  return_loss_rate: string
  storage_months: string
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: string
}

type StoreSkuRowState = {
  draft: StoreSkuDraft
  loading: boolean
  result: PricingCalculationRunItem | null
  error: string | null
}

const INITIAL_FORM: FormState = {
  product_name: '',
  package_length_cm: '',
  package_width_cm: '',
  package_height_cm: '',
  weight_kg: '',
  fob_product_cost_rmb: '',
  first_leg_unit_price_rmb: '',
  sale_price_usd: '',
  target_profit_rate: '25',
  commission_rate: '15',
  advertising_rate: '12',
  return_loss_rate: '4',
  storage_months: '1',
  inbound_placement_mode: 'single_destination',
  usd_to_rmb_rate: '',
}

function buildInitialStoreDraft(item: ProductCostItem, historicalFirstLegCost?: number, exchangeRate?: string): StoreSkuDraft {
  const resolvedFirstLegCost = historicalFirstLegCost && historicalFirstLegCost > 0
    ? historicalFirstLegCost
    : item.first_leg_cost_rmb
  const resolvedExchangeRate = exchangeRate && exchangeRate.trim() ? exchangeRate : ''
  return {
    package_length_cm: item.package_length_cm > 0 ? String(item.package_length_cm) : '',
    package_width_cm: item.package_width_cm > 0 ? String(item.package_width_cm) : '',
    package_height_cm: item.package_height_cm > 0 ? String(item.package_height_cm) : '',
    weight_kg: item.weight_kg > 0 ? String(item.weight_kg) : '',
    first_leg_cost_rmb: resolvedFirstLegCost > 0 ? String(resolvedFirstLegCost) : '',
    sale_price_usd: '',
    target_profit_rate: '25',
    advertising_rate: '12',
    return_loss_rate: '4',
    storage_months: '1',
    inbound_placement_mode: 'single_destination',
    usd_to_rmb_rate: resolvedExchangeRate,
  }
}

// 将计算结果转换为快照格式
function buildSnapshotPayload(
  item: ProductCostItem,
  result: PricingCalculationRunItem,
  calculationType: 'profit-calc' | 'profit-reverse',
  projectId: number
): StoreSkuPricingSnapshotItem {
  return {
    id: 0, // 后端会自动生成
    project_id: projectId,
    project_name: item.project_name,
    sku: item.sku,
    asin: item.asin,
    country: item.country,
    calculation_type: calculationType === 'profit-calc' ? 'profit_calc' : 'profit_reverse',
    package_length_cm: result.package_length_cm,
    package_width_cm: result.package_width_cm,
    package_height_cm: result.package_height_cm,
    weight_kg: result.weight_kg,
    fob_product_cost_rmb: result.fob_product_cost_rmb,
    first_leg_cost_rmb: result.first_leg_cost_rmb,
    sale_price_usd: result.sale_price_usd,
    commission_rate: result.commission_rate,
    target_profit_rate: null,
    advertising_rate: result.advertising_rate,
    return_loss_rate: result.return_loss_rate,
    storage_months: result.storage_months,
    inbound_placement_mode: result.inbound_placement_mode,
    size_tier: result.size_tier,
    size_tier_label: result.size_tier_label,
    price_band: result.price_band,
    price_band_label: result.price_band_label,
    usd_to_rmb_rate: result.usd_to_rmb_rate,
    usd_to_rmb_rate_source: result.usd_to_rmb_rate_source,
    fulfillment_fee_rule_label: result.fulfillment_fee_rule_label,
    inbound_config_fee_rule_label: result.inbound_config_fee_rule_label,
    storage_fee_rule_label: result.storage_fee_rule_label,
    dimensions: result.dimensions,
    weights: result.weights,
    fees: result.fees,
    profit: {
      ddp_cost_rmb: result.profit.ddp_cost_rmb,
      ddp_cost_usd: result.profit.ddp_cost_usd,
      payout_usd: result.profit.payout_usd,
      profit_usd: result.profit.profit_usd,
      profit_rate: result.profit.profit_rate,
    },
    warnings: result.warnings,
    created_by: result.created_by,
    created_at: result.created_at,
    updated_at: result.updated_at,
  }
}

// 将快照转换为计算结果格式（用于前端显示）
function convertSnapshotToResult(snapshot: StoreSkuPricingSnapshotItem): PricingCalculationRunItem {
  return {
    id: snapshot.id,
    product_name: `${snapshot.project_name} / ${snapshot.sku}`,
    calculation_type: snapshot.calculation_type === 'profit_reverse' ? 'profit_reverse' : 'profit_calc',
    project_id: snapshot.project_id,
    sku: snapshot.sku,
    package_length_cm: snapshot.package_length_cm,
    package_width_cm: snapshot.package_width_cm,
    package_height_cm: snapshot.package_height_cm,
    weight_kg: snapshot.weight_kg,
    fob_product_cost_rmb: snapshot.fob_product_cost_rmb,
    first_leg_cost_rmb: snapshot.first_leg_cost_rmb,
    sale_price_usd: snapshot.sale_price_usd,
    commission_rate: snapshot.commission_rate ?? 0.15,
    advertising_rate: snapshot.advertising_rate,
    return_loss_rate: snapshot.return_loss_rate,
    storage_months: snapshot.storage_months,
    inbound_placement_mode: snapshot.inbound_placement_mode,
    size_tier: snapshot.size_tier,
    size_tier_label: snapshot.size_tier_label,
    price_band: snapshot.price_band,
    price_band_label: snapshot.price_band_label,
    usd_to_rmb_rate: snapshot.usd_to_rmb_rate,
    usd_to_rmb_rate_source: snapshot.usd_to_rmb_rate_source,
    fulfillment_fee_rule_label: snapshot.fulfillment_fee_rule_label,
    inbound_config_fee_rule_label: snapshot.inbound_config_fee_rule_label,
    storage_fee_rule_label: snapshot.storage_fee_rule_label,
    dimensions: snapshot.dimensions,
    weights: snapshot.weights,
    fees: snapshot.fees,
    profit: {
      ddp_cost_rmb: snapshot.profit.ddp_cost_rmb,
      ddp_cost_usd: snapshot.profit.ddp_cost_usd,
      payout_usd: snapshot.profit.payout_usd,
      profit_usd: snapshot.profit.profit_usd,
      profit_rate: snapshot.profit.profit_rate,
    },
    warnings: snapshot.warnings,
    created_by: snapshot.created_by,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
  }
}

// 保存店铺 SKU 核算快照
async function requestSaveStoreSkuSnapshot(
  payload: StoreSkuPricingSnapshotItem
): Promise<StoreSkuPricingSnapshotItem> {
  const response = await fetch(`${API_BASE}/api/v1/store-sku-pricing-snapshots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_id: payload.project_id,
      project_name: payload.project_name,
      sku: payload.sku,
      asin: payload.asin,
      country: payload.country,
      calculation_type: payload.calculation_type,
      package_length_cm: payload.package_length_cm,
      package_width_cm: payload.package_width_cm,
      package_height_cm: payload.package_height_cm,
      weight_kg: payload.weight_kg,
      fob_product_cost_rmb: payload.fob_product_cost_rmb,
      first_leg_cost_rmb: payload.first_leg_cost_rmb,
      ddp_cost_rmb: payload.profit.ddp_cost_rmb,
      ddp_cost_usd: payload.profit.ddp_cost_usd,
      sale_price_usd: payload.sale_price_usd,
      target_profit_rate: payload.target_profit_rate,
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
      longest_side_in: payload.dimensions.longest_side_in,
      middle_side_in: payload.dimensions.middle_side_in,
      shortest_side_in: payload.dimensions.shortest_side_in,
      length_plus_girth_in: payload.dimensions.length_plus_girth_in,
      volume_cubic_in: payload.dimensions.volume_cubic_in,
      volume_cubic_ft: payload.dimensions.volume_cubic_ft,
      product_weight_lb: payload.weights.product_weight_lb,
      product_weight_oz: payload.weights.product_weight_oz,
      dimensional_weight_lb: payload.weights.dimensional_weight_lb,
      chargeable_weight_lb: payload.weights.chargeable_weight_lb,
      chargeable_weight_oz: payload.weights.chargeable_weight_oz,
      chargeable_weight_rule: payload.weights.chargeable_weight_rule,
      fulfillment_fee_rule_label: payload.fulfillment_fee_rule_label,
      inbound_config_fee_rule_label: payload.inbound_config_fee_rule_label,
      storage_fee_rule_label: payload.storage_fee_rule_label,
      referral_fee_usd: payload.fees.referral_fee_usd,
      advertising_fee_usd: payload.fees.advertising_fee_usd,
      return_loss_usd: payload.fees.return_loss_usd,
      fba_fulfillment_fee_usd: payload.fees.fba_fulfillment_fee_usd,
      inbound_config_fee_usd: payload.fees.inbound_config_fee_usd,
      storage_fee_usd: payload.fees.storage_fee_usd,
      total_fee_usd: payload.fees.total_fee_usd,
      payout_usd: payload.profit.payout_usd,
      profit_usd: payload.profit.profit_usd,
      profit_rate: payload.profit.profit_rate,
      warnings: payload.warnings,
    }),
  })
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ detail: '保存快照失败' }))
    throw new Error(errorPayload.detail || '保存快照失败')
  }
  return response.json()
}

function formatCurrency(value: number) {
  return `$${value.toFixed(2)}`
}

function formatRmb(value: number) {
  return `RMB ${value.toFixed(2)}`
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`
}

function formatMetric(value: number, digits = 4) {
  return value.toFixed(digits)
}

function toNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatCompactDate(value: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getCalculationTypeMeta(calculationType: PricingCalculationRunItem['calculation_type']) {
  if (calculationType === 'profit_reverse') {
    return {
      label: '利润倒算',
      badgeClassName: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-200',
      cardClassName: 'border-amber-300 bg-amber-50/80 hover:border-amber-400 hover:bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/25 dark:hover:border-amber-800 dark:hover:bg-amber-950/40',
      selectedClassName: 'border-amber-400 bg-amber-100 shadow-sm ring-1 ring-amber-200 dark:border-amber-700 dark:bg-amber-950/60 dark:ring-amber-900/80',
    }
  }

  return {
    label: '利润核算',
    badgeClassName: 'border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-900/80 dark:bg-sky-950/45 dark:text-sky-200',
    cardClassName: 'border-sky-200 bg-sky-50/70 hover:border-sky-300 hover:bg-sky-50 dark:border-sky-900/70 dark:bg-sky-950/25 dark:hover:border-sky-800 dark:hover:bg-sky-950/40',
    selectedClassName: 'border-sky-400 bg-sky-100 shadow-sm ring-1 ring-sky-200 dark:border-sky-700 dark:bg-sky-950/60 dark:ring-sky-900/80',
  }
}

type ComparisonValueType = 'text' | 'currency_usd' | 'currency_rmb' | 'percent' | 'number'

type ComparisonRow = {
  label: string
  getDisplayValue: (run: PricingCalculationRunItem) => string
  getExportValue?: (run: PricingCalculationRunItem) => string | number
  valueType?: ComparisonValueType
}

type ComparisonSection = {
  title: string
  rows: ComparisonRow[]
}

function getComparisonSections(): ComparisonSection[] {
  return [
    {
      title: '货品数据',
      rows: [
        { label: '产品名称', getDisplayValue: (run) => run.product_name, getExportValue: (run) => run.product_name },
        { label: '测算类型', getDisplayValue: (run) => getCalculationTypeMeta(run.calculation_type).label, getExportValue: (run) => getCalculationTypeMeta(run.calculation_type).label },
        { label: '包装尺寸(cm)', getDisplayValue: (run) => `${run.package_length_cm} × ${run.package_width_cm} × ${run.package_height_cm}`, getExportValue: (run) => `${run.package_length_cm} × ${run.package_width_cm} × ${run.package_height_cm}` },
        { label: '重量(kg)', getDisplayValue: (run) => formatMetric(run.weight_kg, 3), getExportValue: (run) => run.weight_kg, valueType: 'number' },
      ],
    },
    {
      title: 'DDP 成本',
      rows: [
        { label: 'FOB成本', getDisplayValue: (run) => formatRmb(run.fob_product_cost_rmb), getExportValue: (run) => run.fob_product_cost_rmb, valueType: 'currency_rmb' },
        { label: '头程', getDisplayValue: (run) => formatRmb(run.first_leg_cost_rmb), getExportValue: (run) => run.first_leg_cost_rmb, valueType: 'currency_rmb' },
        { label: 'DDP(RMB)', getDisplayValue: (run) => formatRmb(run.profit.ddp_cost_rmb), getExportValue: (run) => run.profit.ddp_cost_rmb, valueType: 'currency_rmb' },
        { label: 'DDP(USD)', getDisplayValue: (run) => formatCurrency(run.profit.ddp_cost_usd), getExportValue: (run) => run.profit.ddp_cost_usd, valueType: 'currency_usd' },
      ],
    },
    {
      title: '费用支出',
      rows: [
        { label: '平台佣金', getDisplayValue: (run) => formatCurrency(run.fees.referral_fee_usd), getExportValue: (run) => run.fees.referral_fee_usd, valueType: 'currency_usd' },
        { label: '平台佣金率', getDisplayValue: (run) => formatPercent(run.commission_rate), getExportValue: (run) => run.commission_rate, valueType: 'percent' },
        { label: '广告费', getDisplayValue: (run) => formatCurrency(run.fees.advertising_fee_usd), getExportValue: (run) => run.fees.advertising_fee_usd, valueType: 'currency_usd' },
        { label: '广告费率', getDisplayValue: (run) => formatPercent(run.advertising_rate), getExportValue: (run) => run.advertising_rate, valueType: 'percent' },
        { label: '派送', getDisplayValue: (run) => formatCurrency(run.fees.fba_fulfillment_fee_usd), getExportValue: (run) => run.fees.fba_fulfillment_fee_usd, valueType: 'currency_usd' },
        { label: '配置费', getDisplayValue: (run) => formatCurrency(run.fees.inbound_config_fee_usd), getExportValue: (run) => run.fees.inbound_config_fee_usd, valueType: 'currency_usd' },
        { label: '仓储费', getDisplayValue: (run) => formatCurrency(run.fees.storage_fee_usd), getExportValue: (run) => run.fees.storage_fee_usd, valueType: 'currency_usd' },
        { label: '仓储月数', getDisplayValue: (run) => `${run.storage_months} 月`, getExportValue: (run) => run.storage_months, valueType: 'number' },
        { label: '退货损耗', getDisplayValue: (run) => formatCurrency(run.fees.return_loss_usd), getExportValue: (run) => run.fees.return_loss_usd, valueType: 'currency_usd' },
        { label: '退货折损率', getDisplayValue: (run) => formatPercent(run.return_loss_rate), getExportValue: (run) => run.return_loss_rate, valueType: 'percent' },
        { label: '费用合计', getDisplayValue: (run) => formatCurrency(run.fees.total_fee_usd), getExportValue: (run) => run.fees.total_fee_usd, valueType: 'currency_usd' },
      ],
    },
    {
      title: '售价与利润',
      rows: [
        { label: '售价', getDisplayValue: (run) => formatCurrency(run.sale_price_usd), getExportValue: (run) => run.sale_price_usd, valueType: 'currency_usd' },
        { label: '回款', getDisplayValue: (run) => formatCurrency(run.profit.payout_usd), getExportValue: (run) => run.profit.payout_usd, valueType: 'currency_usd' },
        { label: '利润', getDisplayValue: (run) => formatCurrency(run.profit.profit_usd), getExportValue: (run) => run.profit.profit_usd, valueType: 'currency_usd' },
        { label: '利润率', getDisplayValue: (run) => formatPercent(run.profit.profit_rate), getExportValue: (run) => run.profit.profit_rate, valueType: 'percent' },
      ],
    },
    {
      title: '核算规则',
      rows: [
        { label: '尺寸等级', getDisplayValue: (run) => run.size_tier_label, getExportValue: (run) => run.size_tier_label },
        { label: '售价带', getDisplayValue: (run) => run.price_band_label, getExportValue: (run) => run.price_band_label },
        { label: '计费重(lb)', getDisplayValue: (run) => formatMetric(run.weights.chargeable_weight_lb), getExportValue: (run) => run.weights.chargeable_weight_lb, valueType: 'number' },
        { label: '体积(ft³)', getDisplayValue: (run) => formatMetric(run.dimensions.volume_cubic_ft, 2), getExportValue: (run) => run.dimensions.volume_cubic_ft, valueType: 'number' },
        { label: '派送规则', getDisplayValue: (run) => run.fulfillment_fee_rule_label, getExportValue: (run) => run.fulfillment_fee_rule_label },
        { label: '入库配置', getDisplayValue: (run) => run.inbound_config_fee_rule_label, getExportValue: (run) => run.inbound_config_fee_rule_label },
        { label: '仓储规则', getDisplayValue: (run) => run.storage_fee_rule_label, getExportValue: (run) => run.storage_fee_rule_label },
        { label: '汇率', getDisplayValue: (run) => formatMetric(run.usd_to_rmb_rate, 4), getExportValue: (run) => run.usd_to_rmb_rate, valueType: 'number' },
      ],
    },
  ]
}

async function exportComparisonMatrixToExcel(runs: PricingCalculationRunItem[]) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const worksheet = workbook.addWorksheet('测算对比矩阵', {
    views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }],
  })

  const title = `测算对比矩阵 (${runs.length} 个产品)`
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const sections = getComparisonSections()
  const lastColumn = runs.length + 2

  worksheet.mergeCells(1, 1, 1, lastColumn)
  worksheet.getCell(1, 1).value = title
  worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
  worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  worksheet.mergeCells(2, 1, 2, lastColumn)
  worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：仅导出当前已选中的对比矩阵结果`
  worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
  worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
  worksheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  const headerRow = worksheet.getRow(4)
  headerRow.values = [
    '指标',
    '小类',
    ...runs.map((run) => `${run.product_name} (#${run.id})`),
  ]
  headerRow.height = 24

  worksheet.columns = [
    { width: 16 },
    { width: 18 },
    ...runs.map(() => ({ width: 22 })),
  ]

  const palette: Record<string, { section: string; sub: string }> = {
    '货品数据': { section: 'FFDCEEFF', sub: 'FFF4F9FF' },
    'DDP 成本': { section: 'FFFEE7C7', sub: 'FFFFF8EB' },
    '费用支出': { section: 'FFFFD9E2', sub: 'FFFFF1F4' },
    '利润核算': { section: 'FFD8F7E7', sub: 'FFEEFDF4' },
  }

  headerRow.eachCell((cell, colNumber) => {
    cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    cell.alignment = { vertical: 'middle', horizontal: colNumber <= 2 ? 'center' : 'left', wrapText: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  let currentRowIndex = 5
  sections.forEach((section) => {
    const startRow = currentRowIndex
    const colors = palette[section.title] ?? { section: 'FFE2E8F0', sub: 'FFF8FAFC' }

    section.rows.forEach((row) => {
      const excelRow = worksheet.getRow(currentRowIndex)
      excelRow.getCell(2).value = row.label
      excelRow.getCell(2).font = { name: 'Microsoft YaHei', bold: row.label === '售价' || row.label === '利润率', color: { argb: 'FF334155' } }
      excelRow.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row.label === '售价' || row.label === '利润率' ? 'FFFFEeba' : colors.sub } }
      excelRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }

      runs.forEach((run, index) => {
        const cell = excelRow.getCell(index + 3)
        const value = row.getExportValue ? row.getExportValue(run) : row.getDisplayValue(run)
        cell.value = value
        cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: typeof value === 'number' ? 'right' : 'left', wrapText: true }

        if (typeof value === 'number') {
          if (row.valueType === 'currency_usd') cell.numFmt = '$#,##0.00;[Red]-$#,##0.00'
          if (row.valueType === 'currency_rmb') cell.numFmt = '"RMB " #,##0.00;[Red]-"RMB " #,##0.00'
          if (row.valueType === 'percent') cell.numFmt = '0.00%'
          if (row.valueType === 'number') cell.numFmt = '0.0000'
        }

        if (row.label === '利润' && typeof value === 'number') {
          cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: value >= 0 ? 'FF047857' : 'FFBE123C' } }
        }
        if (row.label === '利润率' && typeof value === 'number') {
          cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: value >= 0 ? 'FF047857' : 'FFBE123C' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEeba' } }
        }
        if (row.label === '售价') {
          cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEeba' } }
        }
      })

      excelRow.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        }
      })

      currentRowIndex += 1
    })

    worksheet.mergeCells(startRow, 1, currentRowIndex - 1, 1)
    const sectionCell = worksheet.getCell(startRow, 1)
    sectionCell.value = section.title
    sectionCell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    sectionCell.alignment = { vertical: 'top', horizontal: 'center', wrapText: true }
    sectionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.section } }
    sectionCell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  const safeTimestamp = formatLocalTimestampForFilename()
  link.href = url
  link.download = `测算对比矩阵-${safeTimestamp}.xlsx`
  link.click()
  window.URL.revokeObjectURL(url)
}

async function exportStoreSkuTableToExcel(
  items: ProductCostItem[],
  rowStates: Record<number, StoreSkuRowState>,
  projectName: string,
  calculationMode: 'profit-calc' | 'profit-reverse'
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const worksheet = workbook.addWorksheet('店铺SKU核算表', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }],
  })

  const title = `店铺SKU核算表 - ${projectName}`
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  
  // 只导出有结果的SKU
  const itemsWithResults = items.filter((item) => {
    const rowState = rowStates[item.id]
    return rowState?.result != null
  })

  worksheet.mergeCells(1, 1, 1, 29)
  worksheet.getCell(1, 1).value = title
  worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
  worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  worksheet.mergeCells(2, 1, 2, 29)
  worksheet.getCell(2, 1).value = `导出时间：${exportedAt} 核算模式：${calculationMode === 'profit-calc' ? '利润核算' : '利润倒算'} 导出数量：${itemsWithResults.length} 条`
  worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
  worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
  worksheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  // 大分组表头（第3行）- 类似前端的分组效果
  const groupHeaderRow = worksheet.getRow(3)
  groupHeaderRow.height = 28

  // 定义分组配置：名称、起始列、跨列数、颜色
  const groupConfigs = [
    { name: '店铺产品', startCol: 1, span: 2, headerColor: 'FF6366F1', subColor: 'FFE0E7FF' },
    { name: '货品数据', startCol: 3, span: 6, headerColor: 'FF0EA5E9', subColor: 'FFE0F2FE' },
    { name: 'DDP 成本', startCol: 9, span: 4, headerColor: 'FFF59E0B', subColor: 'FFFEF3C7' },
    { name: '费用支出', startCol: 13, span: 11, headerColor: 'FFF43F5E', subColor: 'FFFDE8E8' },
    { name: '利润核算', startCol: 24, span: 3, headerColor: 'FF10B981', subColor: 'FFD1FAE5' },
    { name: '产品核定', startCol: 27, span: 3, headerColor: 'FF8B5CF6', subColor: 'FFEDE9FE' },
  ]

  // 设置分组表头（合并单元格）
  groupConfigs.forEach((group) => {
    const endCol = group.startCol + group.span - 1
    worksheet.mergeCells(3, group.startCol, 3, endCol)
    const cell = worksheet.getCell(3, group.startCol)
    cell.value = group.name
    cell.font = { name: 'Microsoft YaHei', size: 12, bold: true, color: { argb: group.name === '店铺产品' ? 'FFFFFFFF' : 'FF0F172A' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: group.headerColor } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  // 细分表头（第4行）
  const headerRow = worksheet.getRow(4)
  headerRow.values = [
    'SKU',
    '项目',
    'FOB成本(RMB)',
    '长(cm)',
    '宽(cm)',
    '高(cm)',
    '重量(kg)',
    '计费重(kg)',
    '头程(RMB)',
    'DDP(RMB)',
    'DDP(USD)',
    '汇率',
    calculationMode === 'profit-calc' ? '售价(USD)' : '目标利润率(%)',
    '广告费率(%)',
    '广告费(USD)',
    '退货折损率(%)',
    '退货损耗(USD)',
    '佣金(USD)',
    '派送费(USD)',
    '配置费(USD)',
    '仓储月数',
    '仓储费(USD)',
    '费用合计(USD)',
    '回款(USD)',
    calculationMode === 'profit-calc' ? '利润(USD)' : '倒算售价(USD)',
    calculationMode === 'profit-calc' ? '利润率(%)' : '-',
    '尺寸等级',
    '售价带',
    '规则',
  ]
  headerRow.height = 24

  worksheet.columns = [
    { width: 18 },
    { width: 14 },
    { width: 14 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 10 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 10 },
    { width: 12 },
    { width: 14 },
    { width: 12 },
    { width: 14 },
    { width: 12 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 32 },
  ]

  // 细分表头颜色映射（与分组保持一致）
  const subHeaderColorMap: Record<string, { bg: string }> = {
    '1': { bg: 'FFE0E7FF' },
    '2': { bg: 'FFE0E7FF' },
    '3': { bg: 'FFE0F2FE' },
    '4': { bg: 'FFE0F2FE' },
    '5': { bg: 'FFE0F2FE' },
    '6': { bg: 'FFE0F2FE' },
    '7': { bg: 'FFE0F2FE' },
    '8': { bg: 'FFE0F2FE' },
    '9': { bg: 'FFFEF3C7' },
    '10': { bg: 'FFFEF3C7' },
    '11': { bg: 'FFFEF3C7' },
    '12': { bg: 'FFFEF3C7' },
    '13': { bg: 'FFFDE8E8' },
    '14': { bg: 'FFFDE8E8' },
    '15': { bg: 'FFFDE8E8' },
    '16': { bg: 'FFFDE8E8' },
    '17': { bg: 'FFFDE8E8' },
    '18': { bg: 'FFFDE8E8' },
    '19': { bg: 'FFFDE8E8' },
    '20': { bg: 'FFFDE8E8' },
    '21': { bg: 'FFFDE8E8' },
    '22': { bg: 'FFFDE8E8' },
    '23': { bg: 'FFFDE8E8' },
    '24': { bg: 'FFD1FAE5' },
    '25': { bg: 'FFD1FAE5' },
    '26': { bg: 'FFD1FAE5' },
    '27': { bg: 'FFEDE9FE' },
    '28': { bg: 'FFEDE9FE' },
    '29': { bg: 'FFEDE9FE' },
  }

  headerRow.eachCell((cell, colNumber) => {
    const colorGroup = subHeaderColorMap[colNumber.toString()] || { bg: 'FFE2E8F0' }
    cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorGroup.bg } }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  let currentRowIndex = 5
  itemsWithResults.forEach((item) => {
    const rowState = rowStates[item.id]
    const result = rowState?.result
    const draft = rowState?.draft

    if (!result) return

    const volumeKg = (toNumber(draft?.package_length_cm ?? '') * toNumber(draft?.package_width_cm ?? '') * toNumber(draft?.package_height_cm ?? '')) / 6000
    const chargeableKg = Math.max(toNumber(draft?.weight_kg ?? ''), volumeKg)
    const firstLegCost = toNumber(draft?.first_leg_cost_rmb ?? '')
    const fobCost = item.fob_unit_cost
    const ddpRmb = fobCost + firstLegCost
    const exchangeRate = result.usd_to_rmb_rate
    const ddpUsd = exchangeRate > 0 ? ddpRmb / exchangeRate : 0

    const excelRow = worksheet.getRow(currentRowIndex)
    
    excelRow.getCell(1).value = item.sku
    excelRow.getCell(2).value = item.project_name
    excelRow.getCell(3).value = fobCost
    excelRow.getCell(3).numFmt = '#,##0.00'
    excelRow.getCell(4).value = result.package_length_cm
    excelRow.getCell(5).value = result.package_width_cm
    excelRow.getCell(6).value = result.package_height_cm
    excelRow.getCell(7).value = result.weight_kg
    excelRow.getCell(7).numFmt = '0.000'
    excelRow.getCell(8).value = result.weights.chargeable_weight_lb * 0.453592
    excelRow.getCell(8).numFmt = '0.00'
    excelRow.getCell(9).value = firstLegCost
    excelRow.getCell(9).numFmt = '#,##0.00'
    excelRow.getCell(10).value = ddpRmb
    excelRow.getCell(10).numFmt = '#,##0.00'
    excelRow.getCell(11).value = ddpUsd
    excelRow.getCell(11).numFmt = '$#,##0.00'
    excelRow.getCell(12).value = exchangeRate
    excelRow.getCell(12).numFmt = '0.0000'
    
    if (calculationMode === 'profit-calc') {
      excelRow.getCell(13).value = result.sale_price_usd
      excelRow.getCell(13).numFmt = '$#,##0.00'
    } else {
      excelRow.getCell(13).value = draft ? toNumber(draft.target_profit_rate) : 0
      excelRow.getCell(13).numFmt = '0.00'
    }
    
    excelRow.getCell(14).value = result.advertising_rate * 100
    excelRow.getCell(14).numFmt = '0.00'
    excelRow.getCell(15).value = result.fees.advertising_fee_usd
    excelRow.getCell(15).numFmt = '$#,##0.00'
    excelRow.getCell(16).value = result.return_loss_rate * 100
    excelRow.getCell(16).numFmt = '0.00'
    excelRow.getCell(17).value = result.fees.return_loss_usd
    excelRow.getCell(17).numFmt = '$#,##0.00'
    excelRow.getCell(18).value = result.fees.referral_fee_usd
    excelRow.getCell(18).numFmt = '$#,##0.00'
    excelRow.getCell(19).value = result.fees.fba_fulfillment_fee_usd
    excelRow.getCell(19).numFmt = '$#,##0.00'
    excelRow.getCell(20).value = result.fees.inbound_config_fee_usd
    excelRow.getCell(20).numFmt = '$#,##0.00'
    excelRow.getCell(21).value = result.storage_months
    excelRow.getCell(22).value = result.fees.storage_fee_usd
    excelRow.getCell(22).numFmt = '$#,##0.00'
    excelRow.getCell(23).value = result.fees.total_fee_usd
    excelRow.getCell(23).numFmt = '$#,##0.00'
    excelRow.getCell(24).value = result.profit.payout_usd
    excelRow.getCell(24).numFmt = '$#,##0.00'
    
    if (calculationMode === 'profit-calc') {
      excelRow.getCell(25).value = result.profit.profit_usd
      excelRow.getCell(25).numFmt = '$#,##0.00'
      excelRow.getCell(25).font = { color: { argb: result.profit.profit_usd >= 0 ? 'FF047857' : 'FFBE123C' } }
      
      excelRow.getCell(26).value = result.profit.profit_rate
      excelRow.getCell(26).numFmt = '0.00%'
      excelRow.getCell(26).font = { color: { argb: result.profit.profit_rate >= 0 ? 'FF047857' : 'FFBE123C' } }
    } else {
      excelRow.getCell(25).value = result.sale_price_usd
      excelRow.getCell(25).numFmt = '$#,##0.00'
      excelRow.getCell(26).value = '-'
    }
    
    excelRow.getCell(27).value = result.size_tier_label
    excelRow.getCell(28).value = result.price_band_label

    // 规则列：派送规则、入库配置、仓储规则
    const ruleLines = [
      `派送: ${result.fulfillment_fee_rule_label}`,
      `配置: ${result.inbound_config_fee_rule_label}`,
      `仓储: ${result.storage_fee_rule_label}`,
    ].join('\n')
    excelRow.getCell(29).value = ruleLines

    const colorMap: Record<string, { header: string; sub: string }> = {
      '1': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '2': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '3': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '4': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '5': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '6': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '7': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '8': { header: 'FFDCEEFF', sub: 'FFF0F5FF' },
      '9': { header: 'FFFEE7C7', sub: 'FFFEF3C7' },
      '10': { header: 'FFFEE7C7', sub: 'FFFEF3C7' },
      '11': { header: 'FFFEE7C7', sub: 'FFFEF3C7' },
      '12': { header: 'FFFEE7C7', sub: 'FFFEF3C7' },
      '13': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '14': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '15': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '16': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '17': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '18': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '19': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '20': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '21': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '22': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '23': { header: 'FFFFD9E2', sub: 'FFFFF1F4' },
      '24': { header: 'FFD8F7E7', sub: 'FFEEFDF4' },
      '25': { header: 'FFD8F7E7', sub: 'FFEEFDF4' },
      '26': { header: 'FFD8F7E7', sub: 'FFEEFDF4' },
      '27': { header: 'FFE9D5F9', sub: 'FFF5EEFD' },
      '28': { header: 'FFE9D5F9', sub: 'FFF5EEFD' },
      '29': { header: 'FFE9D5F9', sub: 'FFF5EEFD' },
    }

    excelRow.eachCell((cell, colNumber) => {
      const colorGroup = colorMap[colNumber.toString()] || { header: 'FFE2E8F0', sub: 'FFF8FAFC' }
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: colNumber <= 2 ? 'left' : 'right', wrapText: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorGroup.sub } }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      }
    })

    currentRowIndex += 1
  })

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  const safeTimestamp = formatLocalTimestampForFilename()
  link.href = url
  link.download = `店铺SKU核算表-${projectName}-${safeTimestamp}.xlsx`
  link.click()
  window.URL.revokeObjectURL(url)
}

export default function PricingCalculationPage() {
  const [activeBusinessTab, setActiveBusinessTab] = useState<BusinessTab>('new-product')
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [calculationMode, setCalculationMode] = useState<CalculationMode>('profit-calc')
  const [runs, setRuns] = useState<PricingCalculationRunItem[]>([])
  const [productKeyword, setProductKeyword] = useState('')
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [runsLoading, setRunsLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [deletingRunId, setDeletingRunId] = useState<number | null>(null)
  const [recalculatingRunId, setRecalculatingRunId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [skuKeyword, setSkuKeyword] = useState('')
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [storeSkusLoading, setStoreSkusLoading] = useState(false)
  const [storeSkusError, setStoreSkusError] = useState<string | null>(null)
  const [storeRows, setStoreRows] = useState<Record<number, StoreSkuRowState>>({})
  const [storeCalculationMode, setStoreCalculationMode] = useState<'profit-calc' | 'profit-reverse'>('profit-calc')
  const [systemExchangeRate, setSystemExchangeRate] = useState<string>('')
  const selectedProject = useMemo(
    () => projects.find((project) => project.name === selectedProjectName) ?? null,
    [projects, selectedProjectName]
  )

  useEffect(() => {
    async function loadRuns() {
      setRunsLoading(true)
      try {
        const response = await fetch(`${API_BASE}/api/v1/pricing-calculation/runs?page=1&page_size=24`, {
          cache: 'no-store',
        })
        const payload = (await response.json()) as ListResponse | { detail?: string; message?: string }
        if (!response.ok) {
          const errorPayload = payload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || '测算记录加载失败')
        }
        setRuns((payload as ListResponse).items)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '测算记录加载失败')
      } finally {
        setRunsLoading(false)
      }
    }

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
          cache: 'no-store',
        })
        const payload = (await response.json()) as ProjectManageOption[] | { detail?: string; message?: string }
        if (!response.ok) {
          const errorPayload = payload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || '项目列表加载失败')
        }
        setProjects((payload as ProjectManageOption[]).map((project) => ({ id: project.id, name: project.name })))
      } catch (loadError) {
        setProjectsError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }

    void loadRuns()
    void loadProjects()
  }, [])

  useEffect(() => {
    async function loadProjectSkus() {
      if (!selectedProjectName) {
        setStoreSkus([])
        setStoreSkusError(null)
        setStoreRows({})
        setSystemExchangeRate('')
        return
      }

      setStoreSkusLoading(true)
      setStoreSkusError(null)
      try {
        const search = new URLSearchParams({
          project_name: selectedProjectName,
          is_active: 'true',
          page: '1',
          page_size: '200',
          include_total: 'true',
        })
        const summarySearch = new URLSearchParams({
          include_only_history_calc: 'true',
          shipment_status: HISTORY_SHIPMENT_STATUSES.join(','),
        })
        const exchangeRateSearch = new URLSearchParams({
          currency: 'USD',
          page: '1',
          page_size: '1',
        })
        if (selectedProject?.id) {
          summarySearch.set('project_id', String(selectedProject.id))
        }
        const [skuResponse, summaryResponse, exchangeRateResponse] = await Promise.all([
          fetch(`${API_BASE}/api/v1/sku-info?${search.toString()}`, { cache: 'no-store' }),
          fetch(`${API_BASE}/api/v1/shipment-schedules/sku-summary?${summarySearch.toString()}`, { cache: 'no-store' }),
          fetch(`/api/exchange-rates?${exchangeRateSearch.toString()}`, { cache: 'no-store' }),
        ])
        const skuPayload = (await skuResponse.json()) as ProductCostsResponse | { detail?: string; message?: string }
        if (!skuResponse.ok) {
          const errorPayload = skuPayload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || 'SKU 列表加载失败')
        }
        const shipmentSummaryPayload = (await summaryResponse.json()) as ShipmentSkuSummaryResponse | { detail?: string; message?: string }
        if (!summaryResponse.ok) {
          const errorPayload = shipmentSummaryPayload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || '头程历史加权成本加载失败')
        }
        const summaryBySku = new Map(
          (shipmentSummaryPayload as ShipmentSkuSummaryResponse).items.map((item) => [item.sku, item.average_logistics_unit_price])
        )
        
        let systemRateValue = ''
        const exchangeRatePayload = await exchangeRateResponse.json()
        const exchangeRateItems = (exchangeRatePayload as { items?: Array<{ rate: number }> })?.items
        if (exchangeRateResponse.ok && exchangeRateItems && exchangeRateItems.length > 0) {
          systemRateValue = String(exchangeRateItems[0].rate)
          setSystemExchangeRate(systemRateValue)
        } else {
          setSystemExchangeRate('')
        }
        
        const items = (skuPayload as ProductCostsResponse).items
        setStoreSkus(items)

        // 加载已保存的快照（根据当前核算模式过滤）
        let snapshotsMap: Record<string, StoreSkuPricingSnapshotItem> = {}
        if (selectedProject?.id) {
          try {
            const snapshotSearch = new URLSearchParams({
              project_id: String(selectedProject.id),
              calculation_type: storeCalculationMode === 'profit-calc' ? 'profit_calc' : 'profit_reverse',
              page: '1',
              page_size: '200',
            })
            const snapshotResponse = await fetch(`${API_BASE}/api/v1/store-sku-pricing-snapshots?${snapshotSearch.toString()}`, { cache: 'no-store' })
            if (snapshotResponse.ok) {
              const snapshotPayload = (await snapshotResponse.json()) as StoreSkuPricingSnapshotListResponse
              snapshotPayload.items.forEach((snapshot) => {
                snapshotsMap[`${snapshot.sku}_${snapshot.calculation_type}`] = snapshot
              })
            }
          } catch (snapshotError) {
            console.warn('加载快照失败:', snapshotError)
          }
        }

        setStoreRows((current) => {
          const next: Record<number, StoreSkuRowState> = {}
          items.forEach((item) => {
            const existing = current[item.id]
            const historicalFirstLegCost = summaryBySku.get(item.sku)
            // 优先使用快照数据，如果没有快照则使用初始草稿
            const snapshotKey = `${item.sku}_${storeCalculationMode === 'profit-calc' ? 'profit_calc' : 'profit_reverse'}`
            const snapshot = snapshotsMap[snapshotKey]
            
            // 如果有快照，从快照中读取动态参数来初始化 draft
            let initialDraft: StoreSkuDraft
            if (snapshot) {
              initialDraft = {
                package_length_cm: snapshot.package_length_cm > 0 ? String(snapshot.package_length_cm) : '',
                package_width_cm: snapshot.package_width_cm > 0 ? String(snapshot.package_width_cm) : '',
                package_height_cm: snapshot.package_height_cm > 0 ? String(snapshot.package_height_cm) : '',
                weight_kg: snapshot.weight_kg > 0 ? String(snapshot.weight_kg) : '',
                first_leg_cost_rmb: snapshot.first_leg_cost_rmb > 0 ? String(snapshot.first_leg_cost_rmb) : '',
                sale_price_usd: snapshot.sale_price_usd > 0 ? String(snapshot.sale_price_usd) : '',
                target_profit_rate: snapshot.target_profit_rate !== null ? String(snapshot.target_profit_rate) : '25',
                advertising_rate: String(snapshot.advertising_rate * 100),
                return_loss_rate: String(snapshot.return_loss_rate * 100),
                storage_months: String(snapshot.storage_months),
                inbound_placement_mode: snapshot.inbound_placement_mode,
                usd_to_rmb_rate: snapshot.usd_to_rmb_rate > 0 ? String(snapshot.usd_to_rmb_rate) : systemRateValue,
              }
            } else {
              initialDraft = buildInitialStoreDraft(item, historicalFirstLegCost, systemRateValue)
            }
            
            next[item.id] = {
              draft: existing?.draft ?? initialDraft,
              loading: false,
              result: existing?.result ?? (snapshot ? convertSnapshotToResult(snapshot) : null),
              error: existing?.error ?? null,
            }
          })
          return next
        })
      } catch (loadError) {
        setStoreSkus([])
        setStoreRows({})
        setStoreSkusError(loadError instanceof Error ? loadError.message : 'SKU 列表加载失败')
      } finally {
        setStoreSkusLoading(false)
      }
    }

    void loadProjectSkus()
  }, [selectedProject?.id, selectedProjectName, storeCalculationMode])

  const filteredRuns = useMemo(() => {
    const normalizedKeyword = productKeyword.trim().toLowerCase()
    if (!normalizedKeyword) {
      return runs
    }
    return runs.filter((run) => run.product_name.toLowerCase().includes(normalizedKeyword))
  }, [productKeyword, runs])
  const visibleRuns = useMemo(() => filteredRuns.slice(0, MAX_VISIBLE_RUNS), [filteredRuns])

  const selectedRuns = useMemo(() => {
    if (selectedRunIds.length === 0) {
      return []
    }
    const selectedSet = new Set(selectedRunIds)
    return runs.filter((run) => selectedSet.has(run.id)).slice(0, MAX_SELECTED_RUNS)
  }, [runs, selectedRunIds])
  const volumeWeightKg = useMemo(() => {
    return (toNumber(form.package_length_cm) * toNumber(form.package_width_cm) * toNumber(form.package_height_cm)) / 6000
  }, [form.package_height_cm, form.package_length_cm, form.package_width_cm])
  const chargeableWeightKg = useMemo(() => {
    return Math.max(toNumber(form.weight_kg), volumeWeightKg)
  }, [form.weight_kg, volumeWeightKg])
  const firstLegUnitPriceRmb = useMemo(() => {
    return toNumber(form.first_leg_unit_price_rmb)
  }, [form.first_leg_unit_price_rmb])
  const firstLegCostRmb = useMemo(() => {
    return chargeableWeightKg * firstLegUnitPriceRmb
  }, [chargeableWeightKg, firstLegUnitPriceRmb])
  const filteredStoreSkus = useMemo(() => {
    const normalizedKeyword = skuKeyword.trim().toLowerCase()
    if (!normalizedKeyword) {
      return storeSkus
    }
    return storeSkus.filter((item) => {
      return [item.sku, item.asin, item.project_name].some((value) => value.toLowerCase().includes(normalizedKeyword))
    })
  }, [skuKeyword, storeSkus])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const createdRun = await requestPricingCalculation({
        calculationMode,
        product_name: form.product_name.trim(),
        package_length_cm: Number(form.package_length_cm),
        package_width_cm: Number(form.package_width_cm),
        package_height_cm: Number(form.package_height_cm),
        weight_kg: Number(form.weight_kg),
        fob_product_cost_rmb: Number(form.fob_product_cost_rmb),
        first_leg_cost_rmb: firstLegCostRmb,
        sale_price_usd: Number(form.sale_price_usd),
        target_profit_rate: Number(form.target_profit_rate) / 100,
        commission_rate: Number(form.commission_rate) / 100,
        advertising_rate: Number(form.advertising_rate) / 100,
        return_loss_rate: Number(form.return_loss_rate) / 100,
        storage_months: Number(form.storage_months),
        inbound_placement_mode: form.inbound_placement_mode,
        usd_to_rmb_rate: form.usd_to_rmb_rate.trim() ? Number(form.usd_to_rmb_rate) : undefined,
      })

      setRuns((current) => [createdRun, ...current])
      setSelectedRunIds((current) => [createdRun.id, ...current.filter((id) => id !== createdRun.id)].slice(0, MAX_SELECTED_RUNS))
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '定价测算失败')
    } finally {
      setLoading(false)
    }
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function toggleRunSelection(runId: number) {
    setSelectedRunIds((current) => {
      if (current.includes(runId)) {
        return current.filter((id) => id !== runId)
      }
      return [runId, ...current].slice(0, MAX_SELECTED_RUNS)
    })
  }

  async function handleDeleteRun(runId: number) {
    const confirmed = window.confirm('确认删除这条测算记录吗？删除后不可恢复。')
    if (!confirmed) {
      return
    }

    setDeletingRunId(runId)
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/api/v1/pricing-calculation/runs/${runId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
        throw new Error(payload?.detail || payload?.message || '删除测算记录失败')
      }

      setRuns((current) => current.filter((run) => run.id !== runId))
      setSelectedRunIds((current) => current.filter((id) => id !== runId))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除测算记录失败')
    } finally {
      setDeletingRunId(null)
    }
  }

  async function handleRecalculateRun(runId: number) {
    const confirmed = window.confirm('确认使用最新计算逻辑重新计算这条记录吗？\\n\\n新的计算逻辑：回款 = 售价 - 费用合计（含广告费）')
    if (!confirmed) {
      return
    }

    setRecalculatingRunId(runId)
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/api/v1/pricing-calculation/runs/${runId}/recalculate`, {
        method: 'POST',
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
        throw new Error(payload?.detail || payload?.message || '重算失败')
      }

      const updatedRun = (await response.json()) as PricingCalculationRunItem
      setRuns((current) => current.map((run) => run.id === runId ? updatedRun : run))
    } catch (recalcError) {
      setError(recalcError instanceof Error ? recalcError.message : '重算失败')
    } finally {
      setRecalculatingRunId(null)
    }
  }

  async function handleExportComparisonMatrix() {
    if (selectedRuns.length === 0) {
      setError('请先选择至少一条测算结果，再导出对比矩阵。')
      return
    }

    setExporting(true)
    setError(null)
    try {
      await exportComparisonMatrixToExcel(selectedRuns)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }

  async function handleExportStoreSkuTable() {
    if (!selectedProjectName) {
      setError('请先选择项目')
      return
    }

    // 检查是否有可导出的数据
    const itemsWithResults = filteredStoreSkus.filter((item) => {
      const rowState = storeRows[item.id]
      return rowState?.result != null
    })

    if (itemsWithResults.length === 0) {
      setError('没有可导出的测算结果，请先进行测算')
      return
    }

    setExporting(true)
    setError(null)
    try {
      await exportStoreSkuTableToExcel(filteredStoreSkus, storeRows, selectedProjectName, storeCalculationMode)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }

  function updateStoreDraft(rowId: number, key: keyof StoreSkuDraft, value: string) {
    setStoreRows((current) => {
      const row = current[rowId]
      if (!row) return current
      return {
        ...current,
        [rowId]: {
          ...row,
          draft: {
            ...row.draft,
            [key]: value,
          },
        },
      }
    })
  }

  async function handleStoreSkuCalculate(item: ProductCostItem, calculationMode: 'profit-calc' | 'profit-reverse' = 'profit-calc') {
    const rowState = storeRows[item.id]
    if (!rowState) return

    setStoreRows((current) => ({
      ...current,
      [item.id]: {
        ...current[item.id],
        loading: true,
        error: null,
      },
    }))

    try {
      const draft = rowState.draft
      const packageLength = Number(draft.package_length_cm)
      const packageWidth = Number(draft.package_width_cm)
      const packageHeight = Number(draft.package_height_cm)
      const weightKg = Number(draft.weight_kg)
      const volumeKg = (packageLength * packageWidth * packageHeight) / 6000
      const chargeableKg = Math.max(weightKg, volumeKg)
      const createdRun = await requestPricingCalculation({
        calculationMode,
        product_name: `${item.project_name} / ${item.sku}`,
        package_length_cm: packageLength,
        package_width_cm: packageWidth,
        package_height_cm: packageHeight,
        weight_kg: weightKg,
        fob_product_cost_rmb: item.fob_unit_cost,
        first_leg_cost_rmb: Number(draft.first_leg_cost_rmb),
        project_id: selectedProject?.id ?? undefined,
        sku: item.sku,
        use_historical_shipping_cost: true,
        sale_price_usd: calculationMode === 'profit-calc' ? Number(draft.sale_price_usd) : 0,
        target_profit_rate: calculationMode === 'profit-reverse' ? Number(draft.target_profit_rate) / 100 : 0,
        commission_rate: 0.15,
        advertising_rate: Number(draft.advertising_rate) / 100,
        return_loss_rate: Number(draft.return_loss_rate) / 100,
        storage_months: Number(draft.storage_months),
        inbound_placement_mode: draft.inbound_placement_mode,
        usd_to_rmb_rate: draft.usd_to_rmb_rate.trim() ? Number(draft.usd_to_rmb_rate) : undefined,
      })

      setStoreRows((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          loading: false,
          result: createdRun,
          error: null,
        },
      }))

      // 保存快照到后端（不添加到新品核算的历史列表）
      if (selectedProject?.id) {
        try {
          const snapshotPayload = buildSnapshotPayload(item, createdRun, calculationMode, selectedProject.id)
          await requestSaveStoreSkuSnapshot(snapshotPayload)
        } catch (snapshotError) {
          console.warn('保存快照失败:', snapshotError)
        }
      }
    } catch (submitError) {
      setStoreRows((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          loading: false,
          error: submitError instanceof Error ? submitError.message : '店铺核算失败',
        },
      }))
    }
  }

  return (
    <div className="space-y-4">
      <Tabs value={activeBusinessTab} onValueChange={(value) => setActiveBusinessTab(value as BusinessTab)} className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">定价测算</h1>
            <p className="text-sm text-muted-foreground">在同一个工作台里完成新品核算与店铺维度 SKU 测算。</p>
          </div>
          <TabsList className="grid w-full grid-cols-2 lg:w-[320px]">
            <TabsTrigger value="new-product">新品核算</TabsTrigger>
            <TabsTrigger value="store-accounting">店铺核算</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="new-product" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[520px_minmax(0,1fr)]">
            <Card className="border-border/80 bg-card/95 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">测算输入</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleSubmit}>
                  <Tabs value={calculationMode} onValueChange={(value) => setCalculationMode(value as CalculationMode)}>
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="profit-calc">利润核算</TabsTrigger>
                      <TabsTrigger value="profit-reverse">利润倒算</TabsTrigger>
                    </TabsList>
                  </Tabs>

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                    <Field label="产品名称">
                      <Input value={form.product_name} onChange={(event) => updateField('product_name', event.target.value)} placeholder="例如：桌面置物架" required />
                    </Field>
                    <Field label="FOB 产品成本(RMB)">
                      <Input type="number" step="0.01" value={form.fob_product_cost_rmb} onChange={(event) => updateField('fob_product_cost_rmb', event.target.value)} required />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <Field label="长(cm)">
                      <Input type="number" step="0.01" value={form.package_length_cm} onChange={(event) => updateField('package_length_cm', event.target.value)} required />
                    </Field>
                    <Field label="宽(cm)">
                      <Input type="number" step="0.01" value={form.package_width_cm} onChange={(event) => updateField('package_width_cm', event.target.value)} required />
                    </Field>
                    <Field label="高(cm)">
                      <Input type="number" step="0.01" value={form.package_height_cm} onChange={(event) => updateField('package_height_cm', event.target.value)} required />
                    </Field>
                    <Field label="重量(kg)">
                      <Input type="number" step="0.001" value={form.weight_kg} onChange={(event) => updateField('weight_kg', event.target.value)} required />
                    </Field>
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-muted/45 p-4">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                      <div className="space-y-3">
                        <Field label="头程单价(RMB/kg)">
                          <Input type="number" step="0.01" value={form.first_leg_unit_price_rmb} onChange={(event) => updateField('first_leg_unit_price_rmb', event.target.value)} placeholder="请输入头程单价" />
                        </Field>
                        <p className="text-xs leading-5 text-muted-foreground">
                          实重 {formatMetric(toNumber(form.weight_kg), 3)} kg，体积重 {formatMetric(volumeWeightKg, 3)} kg，计费重 {formatMetric(chargeableWeightKg, 3)} kg。
                        </p>
                      </div>
                      <div className="rounded-xl border border-border/70 bg-background/85 p-3 dark:bg-background/55">
                        <p className="text-xs text-muted-foreground">头程成本(RMB)</p>
                        <p className="mt-2 text-2xl font-semibold text-foreground">{firstLegCostRmb.toFixed(2)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">计费重 × 头程单价</p>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {calculationMode === 'profit-calc' ? (
                      <Field label="售价(USD)">
                        <Input type="number" step="0.01" value={form.sale_price_usd} onChange={(event) => updateField('sale_price_usd', event.target.value)} required />
                      </Field>
                    ) : (
                      <Field label="目标利润率(%)">
                        <Input type="number" step="0.01" value={form.target_profit_rate} onChange={(event) => updateField('target_profit_rate', event.target.value)} required />
                      </Field>
                    )}
                    <Field label="平台佣金率(%)">
                      <Input type="number" step="0.01" value={form.commission_rate} onChange={(event) => updateField('commission_rate', event.target.value)} required />
                    </Field>
                    <Field label="广告费率(%)">
                      <Input type="number" step="0.01" value={form.advertising_rate} onChange={(event) => updateField('advertising_rate', event.target.value)} required />
                    </Field>
                    <Field label="退货折损率(%)">
                      <Input type="number" step="0.01" value={form.return_loss_rate} onChange={(event) => updateField('return_loss_rate', event.target.value)} required />
                    </Field>
                    <Field label="仓储月数">
                      <Input type="number" step="0.01" value={form.storage_months} onChange={(event) => updateField('storage_months', event.target.value)} required />
                    </Field>
                  </div>

                  <Button type="submit" disabled={loading} className="h-10 w-full">
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                    {calculationMode === 'profit-reverse' ? '倒算售价' : '开始测算'}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="border-border/80 bg-card/95 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">筛选产品</CardTitle>
                  <CardDescription>先搜索产品，再选择最多 {MAX_SELECTED_RUNS} 个测算结果进入对比矩阵。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-col gap-3 md:flex-row">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={productKeyword}
                        onChange={(event) => setProductKeyword(event.target.value)}
                        placeholder="按产品名称筛选"
                        className="pl-9"
                      />
                    </div>
                    <Button type="button" variant="outline" onClick={() => setSelectedRunIds([])} disabled={selectedRunIds.length === 0}>
                      清空选择
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>筛选结果 {filteredRuns.length} 条</span>
                    <span>已选 {selectedRuns.length}/{MAX_SELECTED_RUNS}</span>
                    {productKeyword ? <span>关键词: {productKeyword}</span> : null}
                  </div>
                </CardContent>
              </Card>

              {error ? (
                <Card className="border-destructive/40">
                  <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </CardContent>
                </Card>
              ) : null}

              <Card className="border-border/80 bg-card/95 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">最近测算</CardTitle>
                  <CardDescription>点击卡片即可加入或移出对比矩阵。</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-3">
                    {runsLoading ? (
                      <>
                        <PricingRunCardSkeleton />
                        <PricingRunCardSkeleton />
                        <PricingRunCardSkeleton />
                        <PricingRunCardSkeleton />
                      </>
                    ) : visibleRuns.length === 0 ? (
                      <div className="rounded-2xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                        {runs.length === 0 ? '暂无测算记录' : '没有匹配当前筛选条件的产品'}
                      </div>
                    ) : (
                      visibleRuns.map((run) => {
                        const typeMeta = getCalculationTypeMeta(run.calculation_type ?? 'profit_calc')
                        const isSelected = selectedRunIds.includes(run.id)

                        return (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => toggleRunSelection(run.id)}
                            className={cn(
                              'min-w-[180px] rounded-xl border p-3 text-left transition-colors',
                              isSelected ? typeMeta.selectedClassName : typeMeta.cardClassName
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-xs text-muted-foreground">{formatCompactDate(run.created_at)}</p>
                                <p className="mt-1 line-clamp-1 text-sm font-semibold text-foreground">{run.product_name}</p>
                              </div>
                              <div className="flex items-center gap-1">
                                {isSelected ? (
                                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                                ) : (
                                  <X className="h-4 w-4 text-slate-300 dark:text-slate-600" />
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-full text-muted-foreground hover:bg-background/80 hover:text-amber-600 dark:hover:text-amber-400"
                                  disabled={recalculatingRunId === run.id}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleRecalculateRun(run.id)
                                  }}
                                  title="使用最新计算逻辑重算"
                                >
                                  {recalculatingRunId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-full text-muted-foreground hover:bg-background/80 hover:text-rose-600 dark:hover:text-rose-400"
                                  disabled={deletingRunId === run.id}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleDeleteRun(run.id)
                                  }}
                                >
                                  {deletingRunId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                </Button>
                              </div>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <Badge className={cn('border text-[10px]', typeMeta.badgeClassName)}>{typeMeta.label}</Badge>
                              <Badge variant="secondary" className="text-[10px]">{run.size_tier_label}</Badge>
                            </div>
                            <p className={`mt-2 text-lg font-semibold ${run.profit.profit_usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {formatCurrency(run.profit.profit_usd)}
                            </p>
                            <p className="text-xs text-muted-foreground">{formatPercent(run.profit.profit_rate)}</p>
                          </button>
                        )
                      })
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="border-border/80 bg-card/95 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-lg">测算对比矩阵</CardTitle>
                  <CardDescription>只展示当前已选中的产品，方便横向比较成本、费用与利润。</CardDescription>
                </div>
                <Button type="button" variant="outline" onClick={() => void handleExportComparisonMatrix()} disabled={selectedRuns.length === 0 || exporting}>
                  {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                  导出 Excel
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <ComparisonTable runs={selectedRuns} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="store-accounting" className="space-y-4">
          <Card className="border-border/80 bg-card/95 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">项目筛选</CardTitle>
              <CardDescription>先选择项目，再按 SKU 逐行填写测算参数并生成结果；头程加权成本会自动从发货汇总带入。</CardDescription>
            </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)_140px]">
                {projectsLoading ? (
                  <PricingFieldSkeleton />
                ) : (
                  <Field label="项目">
                    <select
                      value={selectedProjectName}
                      onChange={(event) => setSelectedProjectName(event.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                    >
                      <option value="">请选择项目</option>
                      {projects.map((project) => (
                        <option key={`${project.id ?? project.name}-${project.name}`} value={project.name}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="SKU / ASIN 搜索">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={skuKeyword} onChange={(event) => setSkuKeyword(event.target.value)} placeholder="输入 SKU、ASIN 或项目名" className="pl-9" />
                  </div>
                </Field>
                <div className="flex items-end">
                  <div className="w-full rounded-xl border border-border/70 bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                    {projectsLoading ? '项目准备中...' : storeSkusLoading ? 'SKU 数据同步中...' : `SKU 数量 ${filteredStoreSkus.length}`}
                  </div>
                </div>
              </div>

              {projectsError ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{projectsError}</div>
              ) : null}
              {storeSkusError ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{storeSkusError}</div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/95 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-lg">店铺 SKU 核算表</CardTitle>
                </div>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  <Tabs value={storeCalculationMode} onValueChange={(value) => setStoreCalculationMode(value as 'profit-calc' | 'profit-reverse')} className="w-auto">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="profit-calc">利润核算</TabsTrigger>
                      <TabsTrigger value="profit-reverse">利润倒算</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Button type="button" variant="outline" onClick={() => void handleExportStoreSkuTable()} disabled={!selectedProjectName || exporting}>
                    {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    导出 Excel
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {!selectedProjectName ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">请选择项目后查看对应 SKU。</div>
              ) : storeSkusLoading && filteredStoreSkus.length === 0 ? (
                <PricingTableSkeleton rows={8} />
              ) : filteredStoreSkus.length === 0 ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">当前项目下暂无匹配的 SKU。</div>
              ) : (
                <div className="relative">
                  {storeSkusLoading ? (
                    <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                      SKU 数据更新中...
                    </div>
                  ) : null}
                  <StoreAccountingTable items={filteredStoreSkus} rowStates={storeRows} onDraftChange={updateStoreDraft} onCalculate={handleStoreSkuCalculate} systemExchangeRate={systemExchangeRate} calculationMode={storeCalculationMode} />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

async function requestPricingCalculation(payload: {
  calculationMode: CalculationMode
  product_name: string
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  project_id?: number
  sku?: string
  use_historical_shipping_cost?: boolean
  sale_price_usd: number
  target_profit_rate: number
  commission_rate: number
  advertising_rate: number
  return_loss_rate: number
  storage_months: number
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate?: number
}): Promise<PricingCalculationRunItem> {
  const endpoint =
    payload.calculationMode === 'profit-reverse'
      ? `${API_BASE}/api/v1/pricing-calculation/reverse-quote`
      : `${API_BASE}/api/v1/pricing-calculation/quote`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product_name: payload.product_name,
      package_length_cm: payload.package_length_cm,
      package_width_cm: payload.package_width_cm,
      package_height_cm: payload.package_height_cm,
      weight_kg: payload.weight_kg,
      fob_product_cost_rmb: payload.fob_product_cost_rmb,
      first_leg_cost_rmb: payload.first_leg_cost_rmb,
      ...(payload.project_id ? { project_id: payload.project_id } : {}),
      ...(payload.sku ? { sku: payload.sku } : {}),
      ...(payload.use_historical_shipping_cost ? { use_historical_shipping_cost: payload.use_historical_shipping_cost } : {}),
      ...(payload.calculationMode === 'profit-reverse'
        ? { target_profit_rate: payload.target_profit_rate }
        : { sale_price_usd: payload.sale_price_usd }),
      commission_rate: payload.commission_rate,
      advertising_rate: payload.advertising_rate,
      return_loss_rate: payload.return_loss_rate,
      storage_months: payload.storage_months,
      inbound_placement_mode: payload.inbound_placement_mode,
      ...(payload.usd_to_rmb_rate ? { usd_to_rmb_rate: payload.usd_to_rmb_rate } : {}),
    }),
  })

  const body = (await response.json()) as PricingCalculationRunItem | { detail?: string; message?: string }
  if (!response.ok) {
    const errorPayload = body as { detail?: string; message?: string }
    throw new Error(errorPayload.detail || errorPayload.message || '定价测算失败')
  }
  return body as PricingCalculationRunItem
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function StoreAccountingTable({
  items,
  rowStates,
  onDraftChange,
  onCalculate,
  systemExchangeRate,
  calculationMode,
}: {
  items: ProductCostItem[]
  rowStates: Record<number, StoreSkuRowState>
  onDraftChange: (rowId: number, key: keyof StoreSkuDraft, value: string) => void
  onCalculate: (item: ProductCostItem, calculationMode: 'profit-calc' | 'profit-reverse') => void
  systemExchangeRate: string
  calculationMode: 'profit-calc' | 'profit-reverse'
}) {
  const groupStyles: Record<string, { header: string; subHeader: string; sticky?: string }> = {
    '店铺产品': {
      header: 'bg-indigo-100 text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100',
      subHeader: 'bg-indigo-50 dark:bg-indigo-950',
    },
    '货品数据': {
      header: 'bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100',
      subHeader: 'bg-sky-50 dark:bg-sky-950',
    },
    'DDP 成本': {
      header: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
      subHeader: 'bg-amber-50 dark:bg-amber-950',
    },
    '费用支出': {
      header: 'bg-rose-100 text-rose-950 dark:bg-rose-950 dark:text-rose-100',
      subHeader: 'bg-rose-50 dark:bg-rose-950',
    },
    '利润核算': {
      header: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100',
      subHeader: 'bg-emerald-50 dark:bg-emerald-950',
    },
    '产品核定': {
      header: 'bg-violet-100 text-violet-950 dark:bg-violet-950 dark:text-violet-100',
      subHeader: 'bg-violet-50 dark:bg-violet-950',
    },
    '操作': {
      header: 'bg-slate-200 text-slate-900 dark:bg-slate-900 dark:text-slate-100',
      subHeader: 'bg-slate-100 dark:bg-slate-950',
    },
  }

  const compactInputClassName = 'h-8 w-[52px] min-w-[52px] whitespace-nowrap px-1.5 text-center text-xs tabular-nums sm:w-[60px] sm:min-w-[60px]'
  const compactSelectClassName = 'flex h-8 w-[84px] min-w-[84px] rounded-md border border-input bg-background px-1.5 py-1 text-xs ring-offset-background sm:w-[96px] sm:min-w-[96px]'

  return (
    <Table className="w-max min-w-full text-xs" containerClassName="rounded-xl border border-border/70">
      <TableHeader className="bg-muted">
        <TableRow className="hover:bg-transparent">
          <TableHead colSpan={1} className={cn('sticky left-0 z-50 border-r px-3 py-2 text-center font-semibold', groupStyles['店铺产品'].header)}>店铺产品</TableHead>
          <TableHead colSpan={6} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['货品数据'].header)}>货品数据</TableHead>
          <TableHead colSpan={4} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['DDP 成本'].header)}>DDP 成本</TableHead>
          <TableHead colSpan={10} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['费用支出'].header)}>费用支出</TableHead>
          <TableHead colSpan={4} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['利润核算'].header)}>利润核算</TableHead>
          <TableHead colSpan={2} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['产品核定'].header)}>产品核定</TableHead>
          <TableHead colSpan={2} className={cn('px-3 py-2 text-center font-semibold', groupStyles['操作'].header)}>操作</TableHead>
        </TableRow>
        <TableRow>
          <TableHead className={cn('sticky left-0 z-40 min-w-[160px] whitespace-nowrap border-r px-3 py-2', groupStyles['店铺产品'].subHeader)}>SKU / 项目</TableHead>
          <TableHead className={cn('min-w-[86px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['货品数据'].subHeader)}>FOB(RMB)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>长(cm)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>宽(cm)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>高(cm)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>重量(kg)</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['货品数据'].subHeader)}>计费重</TableHead>

          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['DDP 成本'].subHeader)}>头程(RMB)</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['DDP 成本'].subHeader)}>DDP(RMB)</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['DDP 成本'].subHeader)}>DDP(USD)</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2', groupStyles['DDP 成本'].subHeader)}>汇率</TableHead>

          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>
                {calculationMode === 'profit-calc' ? '售价(USD)' : '目标利润率%'}
              </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>广告费率%</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>广告费</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>退货折损率%</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>退货损耗</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>佣金</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>派送费</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>配置费</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>仓储月数</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>仓储费</TableHead>

          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>费用合计</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>回款</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>利润</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>利润率</TableHead>

          <TableHead className={cn('min-w-[112px] whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>尺寸等级 / 售价带</TableHead>
          <TableHead className={cn('min-w-[208px] whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>规则</TableHead>

          <TableHead className={cn('min-w-[100px] whitespace-nowrap px-3 py-2 text-center', groupStyles['操作'].subHeader)}>状态</TableHead>
          <TableHead className={cn('min-w-[108px] whitespace-nowrap px-3 py-2 text-center', groupStyles['操作'].subHeader)}>测算</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const rowState = rowStates[item.id]
          const draft = rowState?.draft ?? buildInitialStoreDraft(item)
          const volumeKg = (toNumber(draft.package_length_cm) * toNumber(draft.package_width_cm) * toNumber(draft.package_height_cm)) / 6000
          const chargeableKg = Math.max(toNumber(draft.weight_kg), volumeKg)
          const firstLegCost = toNumber(draft.first_leg_cost_rmb)
          const result = rowState?.result
          const fobCost = item.fob_unit_cost
          const hasFob = fobCost > 0
          const hasFirstLeg = firstLegCost > 0
          const exchangeRate = draft.usd_to_rmb_rate ? toNumber(draft.usd_to_rmb_rate) : (result?.usd_to_rmb_rate ?? 0)
          const ddpRmb = hasFob && hasFirstLeg ? fobCost + firstLegCost : null
          const ddpUsd = ddpRmb && exchangeRate > 0 ? ddpRmb / exchangeRate : null

          return (
            <TableRow key={item.id} className="align-middle hover:bg-muted/30">
              <TableCell className={cn('sticky left-0 z-20 whitespace-nowrap border-r px-3 py-2', groupStyles['店铺产品'].subHeader)}>
                <div className="min-w-[136px]">
                  <p className="truncate font-semibold text-foreground">{item.sku}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{item.project_name}</p>
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums">{item.fob_unit_cost.toFixed(2)}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.01" className={compactInputClassName} value={draft.package_length_cm} onChange={(event) => onDraftChange(item.id, 'package_length_cm', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.01" className={compactInputClassName} value={draft.package_width_cm} onChange={(event) => onDraftChange(item.id, 'package_width_cm', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.01" className={compactInputClassName} value={draft.package_height_cm} onChange={(event) => onDraftChange(item.id, 'package_height_cm', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.001" className={compactInputClassName} value={draft.weight_kg} onChange={(event) => onDraftChange(item.id, 'weight_kg', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{formatMetric(chargeableKg, 2)} kg</TableCell>

              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {firstLegCost > 0 ? firstLegCost.toFixed(2) : <span className="text-[11px] text-muted-foreground">待补</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{ddpRmb !== null ? ddpRmb.toFixed(2) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{ddpUsd !== null ? formatCurrency(ddpUsd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.0001" className={compactInputClassName} value={draft.usd_to_rmb_rate} onChange={(event) => onDraftChange(item.id, 'usd_to_rmb_rate', event.target.value)} placeholder={result ? formatMetric(result.usd_to_rmb_rate, 4) : (systemExchangeRate || '自动')} />
              </TableCell>

              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                {calculationMode === 'profit-calc' ? (
                  <Input type="number" step="0.01" className={compactInputClassName} value={draft.sale_price_usd} onChange={(event) => onDraftChange(item.id, 'sale_price_usd', event.target.value)} />
                ) : (
                  <Input type="number" step="0.01" className={compactInputClassName} value={draft.target_profit_rate} onChange={(event) => onDraftChange(item.id, 'target_profit_rate', event.target.value)} />
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.01" className={compactInputClassName} value={draft.advertising_rate} onChange={(event) => onDraftChange(item.id, 'advertising_rate', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.advertising_fee_usd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.01" className={compactInputClassName} value={draft.return_loss_rate} onChange={(event) => onDraftChange(item.id, 'return_loss_rate', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.return_loss_usd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.referral_fee_usd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.fba_fulfillment_fee_usd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.inbound_config_fee_usd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-2 py-2">
                <Input type="number" step="0.01" className={compactInputClassName} value={draft.storage_months} onChange={(event) => onDraftChange(item.id, 'storage_months', event.target.value)} />
              </TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.storage_fee_usd) : '-'}</TableCell>

              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">{result ? formatCurrency(result.fees.total_fee_usd) : '-'}</TableCell>
              <TableCell className="whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums">{result ? formatCurrency(result.profit.payout_usd) : '-'}</TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums', result ? (result.profit.profit_usd >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400') : 'text-muted-foreground')}>
                {result ? (calculationMode === 'profit-reverse' ? formatCurrency(result.sale_price_usd) : formatCurrency(result.profit.profit_usd)) : '-'}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums', result ? (result.profit.profit_rate >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400') : 'text-muted-foreground')}>
                {result ? (calculationMode === 'profit-reverse' ? '-' : formatPercent(result.profit.profit_rate)) : '-'}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>
                {result ? (
                  <div className="leading-5">
                    <div>{result.size_tier_label}</div>
                    <div className="text-[11px] text-muted-foreground">{result.price_band_label}</div>
                  </div>
                ) : '-'}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>
                {result ? (
                  <div className="max-w-[196px] space-y-0.5 overflow-hidden text-ellipsis text-[11px] text-muted-foreground">
                    <p className="truncate">派送: {result.fulfillment_fee_rule_label}</p>
                    <p className="truncate">配置: {result.inbound_config_fee_rule_label}</p>
                    <p className="truncate">仓储: {result.storage_fee_rule_label}</p>
                  </div>
                ) : '-'}
              </TableCell>

              <TableCell className="px-3 py-2 text-center">
                {rowState?.error ? (
                  <div className="max-w-[88px] text-[11px] leading-4 text-destructive">{rowState.error}</div>
                ) : result?.warnings.length ? (
                  <div className="max-w-[88px] text-[11px] leading-4 text-amber-600 dark:text-amber-300" title={result.warnings.join('；')}>
                    {result.warnings[0]}
                  </div>
                ) : result ? (
                  <Badge variant="secondary" className="whitespace-nowrap">已测算</Badge>
                ) : (
                  <span className="text-[11px] text-muted-foreground">待测算</span>
                )}
              </TableCell>
              <TableCell className="px-3 py-2 text-center">
                <div className="flex flex-col items-center gap-2">
                  <select
                    value={draft.inbound_placement_mode}
                    onChange={(event) => onDraftChange(item.id, 'inbound_placement_mode', event.target.value)}
                    className={compactSelectClassName}
                  >
                    <option value="single_destination">单仓</option>
                    <option value="amazon_optimized_split">优化拆仓</option>
                  </select>
                  <Button type="button" onClick={() => onCalculate(item, calculationMode)} disabled={rowState?.loading} className="h-8 min-w-[92px]">
                    {rowState?.loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                    {calculationMode === 'profit-reverse' ? '倒算售价' : '测算'}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function ComparisonTable({ runs }: { runs: PricingCalculationRunItem[] }) {
  if (runs.length === 0) {
    return <div className="rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无可对比的测算结果</div>
  }

  const sections = getComparisonSections()

  const sectionStyles: Record<string, { categoryCell: string; subCell: string }> = {
    '货品数据': {
      categoryCell: 'border-sky-200 bg-sky-100 text-sky-950 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100',
      subCell: 'bg-sky-50 dark:bg-sky-950',
    },
    'DDP 成本': {
      categoryCell: 'border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
      subCell: 'bg-amber-50 dark:bg-amber-950',
    },
    '费用支出': {
      categoryCell: 'border-rose-200 bg-rose-100 text-rose-950 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100',
      subCell: 'bg-rose-50 dark:bg-rose-950',
    },
    '售价与利润': {
      categoryCell: 'border-emerald-200 bg-emerald-100 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
      subCell: 'bg-emerald-50 dark:bg-emerald-950',
    },
    '核算规则': {
      categoryCell: 'border-violet-200 bg-violet-100 text-violet-950 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-100',
      subCell: 'bg-violet-50 dark:bg-violet-950',
    },
  }

  return (
    <div className="max-h-[600px] overflow-auto rounded-xl border border-border/70">
      <table className="w-max min-w-full text-xs border-collapse">
        <thead className="sticky top-0 z-30 bg-muted">
          <tr>
            <th className="sticky left-0 z-20 min-w-[116px] whitespace-nowrap bg-muted px-3 py-2 border-b border-r font-semibold text-left">分类</th>
            <th className="sticky left-[116px] z-20 min-w-[150px] whitespace-nowrap bg-muted px-3 py-2 border-b border-l font-semibold text-left">明细项</th>
          {runs.map((run) => (
            <th key={run.id} className="min-w-[210px] whitespace-nowrap bg-muted px-3 py-2 border-b border-l align-top">
              <div className="space-y-1 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="max-w-[150px] truncate font-semibold text-foreground">{run.product_name}</span>
                  <Badge variant="outline" className="text-[10px]">#{run.id}</Badge>
                </div>
                <div className="text-[10px] text-muted-foreground">{formatCompactDate(run.created_at)}</div>
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sections.flatMap((section) =>
          section.rows.map((row, index) => (
            <tr 
              key={`${section.title}-${row.label}`} 
              className={cn(
                'hover:bg-muted/30',
                row.label === '售价' || row.label === '利润率' ? 'bg-yellow-50 dark:bg-yellow-950/20' : ''
              )}
            >
              {index === 0 ? (
                <td
                  rowSpan={section.rows.length}
                  className={cn(
                    'sticky left-0 z-10 min-w-[116px] whitespace-nowrap border-r border-b align-top font-semibold bg-muted p-2',
                    sectionStyles[section.title]?.categoryCell ?? 'border-slate-200 bg-slate-100 text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100'
                  )}
                >
                  {section.title}
                </td>
              ) : null}
              <td
                className={cn(
                  'sticky left-[116px] z-10 min-w-[150px] whitespace-nowrap border-l border-b font-medium p-2',
                  row.label === '售价' || row.label === '利润率' ? 'bg-yellow-50 font-bold text-slate-900 dark:bg-yellow-950/30 dark:text-yellow-100' : 'text-slate-700 dark:text-slate-200',
                  sectionStyles[section.title]?.subCell ?? 'bg-background'
                )}
              >
                {row.label}
              </td>
              {runs.map((run) => (
                <td 
                  key={`${row.label}-${run.id}`} 
                  className={cn(
                    'whitespace-nowrap border-l border-b align-top leading-5 p-2',
                    row.label === '售价' && 'bg-yellow-50 font-semibold text-foreground dark:bg-yellow-950/30',
                    row.label === '利润率' && 'bg-yellow-50 font-semibold text-foreground dark:bg-yellow-950/30'
                  )}
                >
                  {row.getDisplayValue(run)}
                </td>
              ))}
            </tr>
          ))
        )}
        </tbody>
      </table>
    </div>
  )
}
