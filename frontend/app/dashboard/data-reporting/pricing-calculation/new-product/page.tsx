'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Calculator,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
  Trash2,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import {
  DataCard,
  DataCardContent,
  DataCardHeader,
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
} from '@/components/ui/data-card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { BarSkeleton, PricingTableSkeleton } from '@/components/ui/table-skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { logClientOperation } from '@/lib/operation-audit'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import { applyBorder, applyHeaderBorder } from '@/lib/excel-styles'

const API_BASE = '/api/backend'
const MAX_VISIBLE_RUNS = 12
const MAX_SELECTED_RUNS = 8
const HISTORY_SHIPMENT_STATUSES = ['completed', 'in_transit'] as const
const CALCULATION_MODE_ORDER = [
  'profit-calc',
  'profit-reverse',
  'cost-reverse',
  'fbm-calc',
] as const
const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

const COUNTRY_MAP: Record<string, string> = {
  US: 'US',
  DE: 'DE',
  UK: 'UK',
  FR: 'FR',
  IT: 'IT',
  ES: 'ES',
  JP: 'JP',
  CA: 'CA',
  MX: 'MX',
  AU: 'AU',
  IN: 'IN',
}

const LazyComparisonTable = dynamic(
  () =>
    import('@/components/dashboard/pricing-calculation/comparison-table').then(
      (mod) => mod.ComparisonTable,
    ),
  {
    loading: () => <BarSkeleton rows={10} height='h-11' />,
  },
)

const LazyStoreAccountingTable = dynamic(
  () =>
    import(
      '@/components/dashboard/pricing-calculation/store-accounting-table'
    ).then((mod) => mod.StoreAccountingTable),
  {
    loading: () => <PricingTableSkeleton rows={8} />,
  },
)

function PricingFieldSkeleton() {
  return (
    <div className='space-y-2'>
      <Skeleton className='h-4 w-16' />
      <Skeleton className='h-10 w-full' />
    </div>
  )
}

function PricingRunCardSkeleton() {
  return (
    <div className='min-h-[112px] rounded-xl border border-border/70 p-3'>
      <Skeleton className='h-3 w-20' />
      <Skeleton className='mt-3 h-4 w-28' />
      <div className='mt-3 flex gap-2'>
        <Skeleton className='h-5 w-16' />
        <Skeleton className='h-5 w-12' />
      </div>
      <Skeleton className='mt-3 h-6 w-24' />
      <Skeleton className='mt-2 h-3 w-16' />
    </div>
  )
}

type PricingCalculationRunItem = {
  id: number
  country: string
  product_name: string
  calculation_type:
    | 'profit_calc'
    | 'profit_reverse'
    | 'cost_reverse'
    | 'fbm_calc'
  project_id: number | null
  sku: string | null
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  first_leg_unit_price_rmb_per_kg?: number | null
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
  project_id: number
  project_name: string
  sku: string
  asin: string | null
  country: string | null
  calculation_type: 'profit_calc' | 'profit_reverse' | 'cost_reverse'
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
  delivery_fee_usd: string
  full_container_quantity: string
  full_container_price_rmb: string
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: string
}

type CalculationMode =
  | 'profit-calc'
  | 'profit-reverse'
  | 'cost-reverse'
  | 'fbm-calc'
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
  first_leg_unit_price_rmb: '5',
  sale_price_usd: '',
  target_profit_rate: '25',
  commission_rate: '15',
  advertising_rate: '12',
  return_loss_rate: '4',
  storage_months: '1',
  delivery_fee_usd: '',
  full_container_quantity: '',
  full_container_price_rmb: '',
  inbound_placement_mode: 'single_destination',
  usd_to_rmb_rate: '',
}

function buildInitialStoreDraft(
  item: ProductCostItem,
  historicalFirstLegCost?: number,
  exchangeRate?: string,
): StoreSkuDraft {
  const resolvedFirstLegCost =
    historicalFirstLegCost && historicalFirstLegCost > 0
      ? historicalFirstLegCost
      : item.first_leg_cost_rmb > 0
        ? item.first_leg_cost_rmb
        : 5
  const resolvedExchangeRate =
    exchangeRate && exchangeRate.trim() ? exchangeRate : ''
  return {
    package_length_cm:
      item.package_length_cm > 0 ? String(item.package_length_cm) : '',
    package_width_cm:
      item.package_width_cm > 0 ? String(item.package_width_cm) : '',
    package_height_cm:
      item.package_height_cm > 0 ? String(item.package_height_cm) : '',
    weight_kg: item.weight_kg > 0 ? String(item.weight_kg) : '',
    first_leg_cost_rmb:
      resolvedFirstLegCost > 0 ? String(resolvedFirstLegCost) : '5',
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
  projectId: number,
): StoreSkuPricingSnapshotItem {
  return {
    id: 0, // 后端会自动生成
    project_id: projectId,
    project_name: item.project_name,
    sku: item.sku,
    asin: item.asin,
    country: item.country,
    calculation_type:
      calculationType === 'profit-calc' ? 'profit_calc' : 'profit_reverse',
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
function convertSnapshotToResult(
  snapshot: StoreSkuPricingSnapshotItem,
): PricingCalculationRunItem {
  return {
    id: snapshot.id,
    country: snapshot.country ?? '',
    product_name: `${snapshot.project_name} / ${snapshot.sku}`,
    calculation_type:
      snapshot.calculation_type === 'profit_reverse'
        ? 'profit_reverse'
        : 'profit_calc',
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
  payload: StoreSkuPricingSnapshotItem,
): Promise<StoreSkuPricingSnapshotItem> {
  const response = await fetch(
    `${API_BASE}/api/v1/store-sku-pricing-snapshots`,
    {
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
    },
  )
  if (!response.ok) {
    const errorPayload = await response
      .json()
      .catch(() => ({ detail: '保存快照失败' }))
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

function formatRelativeTime(value: string): string {
  if (!value) return ''
  const now = Date.now()
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}秒前`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}小时前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 30) return `${diffDay}天前`
  return formatCompactDate(value)
}

function getCalculationTypeMeta(
  calculationType: PricingCalculationRunItem['calculation_type'],
) {
  if (calculationType === 'fbm_calc') {
    return {
      label: 'FBM测算',
      badgeClassName:
        'border-violet-300 bg-violet-100 text-violet-900 dark:border-violet-900/80 dark:bg-violet-950/50 dark:text-violet-200',
      cardClassName:
        'border-violet-300 bg-violet-50/80 hover:border-violet-400 hover:bg-violet-50 dark:border-violet-900/70 dark:bg-violet-950/25 dark:hover:border-violet-800 dark:hover:bg-violet-950/40',
      selectedClassName:
        'border-violet-400 bg-violet-100 shadow-sm ring-1 ring-violet-200 dark:border-violet-700 dark:bg-violet-950/60 dark:ring-violet-900/80',
    }
  }

  if (calculationType === 'cost_reverse') {
    return {
      label: '成本倒推',
      badgeClassName:
        'border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-900/80 dark:bg-emerald-950/50 dark:text-emerald-200',
      cardClassName:
        'border-emerald-300 bg-emerald-50/80 hover:border-emerald-400 hover:bg-emerald-50 dark:border-emerald-900/70 dark:bg-emerald-950/25 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/40',
      selectedClassName:
        'border-emerald-400 bg-emerald-100 shadow-sm ring-1 ring-emerald-200 dark:border-emerald-700 dark:bg-emerald-950/60 dark:ring-emerald-900/80',
    }
  }

  if (calculationType === 'profit_reverse') {
    return {
      label: '利润倒算',
      badgeClassName:
        'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-200',
      cardClassName:
        'border-amber-300 bg-amber-50/80 hover:border-amber-400 hover:bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/25 dark:hover:border-amber-800 dark:hover:bg-amber-950/40',
      selectedClassName:
        'border-amber-400 bg-amber-100 shadow-sm ring-1 ring-amber-200 dark:border-amber-700 dark:bg-amber-950/60 dark:ring-amber-900/80',
    }
  }

  return {
    label: '利润核算',
    badgeClassName:
      'border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-900/80 dark:bg-sky-950/45 dark:text-sky-200',
    cardClassName:
      'border-sky-200 bg-sky-50/70 hover:border-sky-300 hover:bg-sky-50 dark:border-sky-900/70 dark:bg-sky-950/25 dark:hover:border-sky-800 dark:hover:bg-sky-950/40',
    selectedClassName:
      'border-sky-400 bg-sky-100 shadow-sm ring-1 ring-sky-200 dark:border-sky-700 dark:bg-sky-950/60 dark:ring-sky-900/80',
  }
}

function getRunSummary(run: PricingCalculationRunItem) {
  return `${run.product_name} - ${getCalculationTypeMeta(run.calculation_type).label} - ${formatCompactDate(run.created_at)}`
}

type ComparisonValueType =
  | 'text'
  | 'currency_usd'
  | 'currency_rmb'
  | 'percent'
  | 'number'

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
        {
          label: '产品名称',
          getDisplayValue: (run) => run.product_name,
          getExportValue: (run) => run.product_name,
        },
        {
          label: '测算类型',
          getDisplayValue: (run) =>
            getCalculationTypeMeta(run.calculation_type).label,
          getExportValue: (run) =>
            getCalculationTypeMeta(run.calculation_type).label,
        },
        {
          label: '包装尺寸(cm)',
          getDisplayValue: (run) =>
            `${run.package_length_cm} × ${run.package_width_cm} × ${run.package_height_cm}`,
          getExportValue: (run) =>
            `${run.package_length_cm} × ${run.package_width_cm} × ${run.package_height_cm}`,
        },
        {
          label: '重量(kg)',
          getDisplayValue: (run) => formatMetric(run.weight_kg, 3),
          getExportValue: (run) => run.weight_kg,
          valueType: 'number',
        },
      ],
    },
    {
      title: 'DDP 成本',
      rows: [
        {
          label: 'FOB成本',
          getDisplayValue: (run) => formatRmb(run.fob_product_cost_rmb),
          getExportValue: (run) => run.fob_product_cost_rmb,
          valueType: 'currency_rmb',
        },
        {
          label: '头程',
          getDisplayValue: (run) => formatRmb(run.first_leg_cost_rmb),
          getExportValue: (run) => run.first_leg_cost_rmb,
          valueType: 'currency_rmb',
        },
        {
          label: 'DDP(RMB)',
          getDisplayValue: (run) => formatRmb(run.profit.ddp_cost_rmb),
          getExportValue: (run) => run.profit.ddp_cost_rmb,
          valueType: 'currency_rmb',
        },
        {
          label: 'DDP(USD)',
          getDisplayValue: (run) => formatCurrency(run.profit.ddp_cost_usd),
          getExportValue: (run) => run.profit.ddp_cost_usd,
          valueType: 'currency_usd',
        },
      ],
    },
    {
      title: '费用支出',
      rows: [
        {
          label: '平台佣金',
          getDisplayValue: (run) => formatCurrency(run.fees.referral_fee_usd),
          getExportValue: (run) => run.fees.referral_fee_usd,
          valueType: 'currency_usd',
        },
        {
          label: '平台佣金率',
          getDisplayValue: (run) => formatPercent(run.commission_rate),
          getExportValue: (run) => run.commission_rate,
          valueType: 'percent',
        },
        {
          label: '广告费',
          getDisplayValue: (run) =>
            formatCurrency(run.fees.advertising_fee_usd),
          getExportValue: (run) => run.fees.advertising_fee_usd,
          valueType: 'currency_usd',
        },
        {
          label: '广告费率',
          getDisplayValue: (run) => formatPercent(run.advertising_rate),
          getExportValue: (run) => run.advertising_rate,
          valueType: 'percent',
        },
        {
          label: '派送',
          getDisplayValue: (run) =>
            formatCurrency(run.fees.fba_fulfillment_fee_usd),
          getExportValue: (run) => run.fees.fba_fulfillment_fee_usd,
          valueType: 'currency_usd',
        },
        {
          label: '配置费',
          getDisplayValue: (run) =>
            formatCurrency(run.fees.inbound_config_fee_usd),
          getExportValue: (run) => run.fees.inbound_config_fee_usd,
          valueType: 'currency_usd',
        },
        {
          label: '仓储费',
          getDisplayValue: (run) => formatCurrency(run.fees.storage_fee_usd),
          getExportValue: (run) => run.fees.storage_fee_usd,
          valueType: 'currency_usd',
        },
        {
          label: '仓储月数',
          getDisplayValue: (run) => `${run.storage_months} 月`,
          getExportValue: (run) => run.storage_months,
          valueType: 'number',
        },
        {
          label: '退货损耗',
          getDisplayValue: (run) => formatCurrency(run.fees.return_loss_usd),
          getExportValue: (run) => run.fees.return_loss_usd,
          valueType: 'currency_usd',
        },
        {
          label: '退货折损率',
          getDisplayValue: (run) => formatPercent(run.return_loss_rate),
          getExportValue: (run) => run.return_loss_rate,
          valueType: 'percent',
        },
        {
          label: '费用合计',
          getDisplayValue: (run) => formatCurrency(run.fees.total_fee_usd),
          getExportValue: (run) => run.fees.total_fee_usd,
          valueType: 'currency_usd',
        },
      ],
    },
    {
      title: '售价与利润',
      rows: [
        {
          label: '售价',
          getDisplayValue: (run) => formatCurrency(run.sale_price_usd),
          getExportValue: (run) => run.sale_price_usd,
          valueType: 'currency_usd',
        },
        {
          label: '回款',
          getDisplayValue: (run) => formatCurrency(run.profit.payout_usd),
          getExportValue: (run) => run.profit.payout_usd,
          valueType: 'currency_usd',
        },
        {
          label: '利润',
          getDisplayValue: (run) => formatCurrency(run.profit.profit_usd),
          getExportValue: (run) => run.profit.profit_usd,
          valueType: 'currency_usd',
        },
        {
          label: '利润率',
          getDisplayValue: (run) => formatPercent(run.profit.profit_rate),
          getExportValue: (run) => run.profit.profit_rate,
          valueType: 'percent',
        },
      ],
    },
    {
      title: '核算规则',
      rows: [
        {
          label: '尺寸等级',
          getDisplayValue: (run) => run.size_tier_label,
          getExportValue: (run) => run.size_tier_label,
        },
        {
          label: '售价带',
          getDisplayValue: (run) => run.price_band_label,
          getExportValue: (run) => run.price_band_label,
        },
        {
          label: '计费重(lb)',
          getDisplayValue: (run) =>
            formatMetric(run.weights.chargeable_weight_lb),
          getExportValue: (run) => run.weights.chargeable_weight_lb,
          valueType: 'number',
        },
        {
          label: '体积(ft³)',
          getDisplayValue: (run) =>
            formatMetric(run.dimensions.volume_cubic_ft, 2),
          getExportValue: (run) => run.dimensions.volume_cubic_ft,
          valueType: 'number',
        },
        {
          label: '派送规则',
          getDisplayValue: (run) => run.fulfillment_fee_rule_label,
          getExportValue: (run) => run.fulfillment_fee_rule_label,
        },
        {
          label: '入库配置',
          getDisplayValue: (run) => run.inbound_config_fee_rule_label,
          getExportValue: (run) => run.inbound_config_fee_rule_label,
        },
        {
          label: '仓储规则',
          getDisplayValue: (run) => run.storage_fee_rule_label,
          getExportValue: (run) => run.storage_fee_rule_label,
        },
        {
          label: '汇率',
          getDisplayValue: (run) => formatMetric(run.usd_to_rmb_rate, 4),
          getExportValue: (run) => run.usd_to_rmb_rate,
          valueType: 'number',
        },
      ],
    },
  ]
}

async function exportComparisonMatrixToExcel(
  runs: PricingCalculationRunItem[],
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const worksheet = workbook.addWorksheet('测算对比矩阵', {
    views: [{ state: 'frozen', ySplit: 4, xSplit: 2, showGridLines: false }],
  })

  const title = `测算对比矩阵 (${runs.length} 个产品)`
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const sections = getComparisonSections()
  const lastColumn = runs.length + 2

  worksheet.mergeCells(1, 1, 1, lastColumn)
  worksheet.getCell(1, 1).value = title
  worksheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  worksheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }
  worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  worksheet.mergeCells(2, 1, 2, lastColumn)
  worksheet.getCell(2, 1).value =
    `导出时间：${exportedAt}    说明：仅导出当前已选中的对比矩阵结果`
  worksheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  worksheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }
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
    货品数据: { section: 'FFDCEEFF', sub: 'FFF4F9FF' },
    'DDP 成本': { section: 'FFFEE7C7', sub: 'FFFFF8EB' },
    费用支出: { section: 'FFFFD9E2', sub: 'FFFFF1F4' },
    利润核算: { section: 'FFD8F7E7', sub: 'FFEEFDF4' },
  }

  headerRow.eachCell((cell, colNumber) => {
    applyHeaderBorder(cell)
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: colNumber <= 2 ? 'center' : 'left',
      wrapText: true,
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' },
    }
  })

  let currentRowIndex = 5
  sections.forEach((section) => {
    const startRow = currentRowIndex
    const colors = palette[section.title] ?? {
      section: 'FFE2E8F0',
      sub: 'FFF8FAFC',
    }

    section.rows.forEach((row) => {
      const excelRow = worksheet.getRow(currentRowIndex)
      excelRow.getCell(2).value = row.label
      excelRow.getCell(2).font = {
        name: 'Microsoft YaHei',
        bold: row.label === '售价' || row.label === '利润率',
        color: { argb: 'FF334155' },
      }
      excelRow.getCell(2).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb:
            row.label === '售价' || row.label === '利润率'
              ? 'FFFFEeba'
              : colors.sub,
        },
      }
      excelRow.getCell(2).alignment = {
        vertical: 'middle',
        horizontal: 'left',
        wrapText: true,
      }

      runs.forEach((run, index) => {
        const cell = excelRow.getCell(index + 3)
        const value = row.getExportValue
          ? row.getExportValue(run)
          : row.getDisplayValue(run)
        cell.value = value
        cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: typeof value === 'number' ? 'right' : 'left',
          wrapText: true,
        }

        if (typeof value === 'number') {
          if (row.valueType === 'currency_usd')
            cell.numFmt = '$#,##0.00;[Red]-$#,##0.00'
          if (row.valueType === 'currency_rmb')
            cell.numFmt = '"RMB " #,##0.00;[Red]-"RMB " #,##0.00'
          if (row.valueType === 'percent') cell.numFmt = '0.00%'
          if (row.valueType === 'number') cell.numFmt = '0.0000'
        }

        if (row.label === '利润' && typeof value === 'number') {
          cell.font = {
            name: 'Microsoft YaHei',
            bold: true,
            color: { argb: value >= 0 ? 'FF047857' : 'FFBE123C' },
          }
        }
        if (row.label === '利润率' && typeof value === 'number') {
          cell.font = {
            name: 'Microsoft YaHei',
            bold: true,
            color: { argb: value >= 0 ? 'FF047857' : 'FFBE123C' },
          }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFEeba' },
          }
        }
        if (row.label === '售价') {
          cell.font = {
            name: 'Microsoft YaHei',
            bold: true,
            color: { argb: 'FF0F172A' },
          }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFEeba' },
          }
        }
      })

      excelRow.eachCell((cell) => {
        applyBorder(cell)
      })

      currentRowIndex += 1
    })

    worksheet.mergeCells(startRow, 1, currentRowIndex - 1, 1)
    const sectionCell = worksheet.getCell(startRow, 1)
    sectionCell.value = section.title
    sectionCell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    sectionCell.alignment = {
      vertical: 'top',
      horizontal: 'center',
      wrapText: true,
    }
    sectionCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: colors.section },
    }
    applyHeaderBorder(sectionCell)
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
  calculationMode: 'profit-calc' | 'profit-reverse',
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const worksheet = workbook.addWorksheet('店铺SKU核算表', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 4, showGridLines: false }],
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
  worksheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  worksheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }
  worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  worksheet.mergeCells(2, 1, 2, 29)
  worksheet.getCell(2, 1).value =
    `导出时间：${exportedAt} 核算模式：${calculationMode === 'profit-calc' ? '利润核算' : '利润倒算'} 导出数量：${itemsWithResults.length} 条`
  worksheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  worksheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }
  worksheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  // 大分组表头（第3行）- 类似前端的分组效果
  const groupHeaderRow = worksheet.getRow(3)
  groupHeaderRow.height = 28

  // 定义分组配置：名称、起始列、跨列数、颜色
  const groupConfigs = [
    {
      name: '店铺产品',
      startCol: 1,
      span: 2,
      headerColor: 'FF6366F1',
      subColor: 'FFE0E7FF',
    },
    {
      name: '货品数据',
      startCol: 3,
      span: 6,
      headerColor: 'FF0EA5E9',
      subColor: 'FFE0F2FE',
    },
    {
      name: 'DDP 成本',
      startCol: 9,
      span: 4,
      headerColor: 'FFF59E0B',
      subColor: 'FFFEF3C7',
    },
    {
      name: '费用支出',
      startCol: 13,
      span: 11,
      headerColor: 'FFF43F5E',
      subColor: 'FFFDE8E8',
    },
    {
      name: '利润核算',
      startCol: 24,
      span: 3,
      headerColor: 'FF10B981',
      subColor: 'FFD1FAE5',
    },
    {
      name: '产品核定',
      startCol: 27,
      span: 3,
      headerColor: 'FF8B5CF6',
      subColor: 'FFEDE9FE',
    },
  ]

  // 设置分组表头（合并单元格）
  groupConfigs.forEach((group) => {
    const endCol = group.startCol + group.span - 1
    worksheet.mergeCells(3, group.startCol, 3, endCol)
    const cell = worksheet.getCell(3, group.startCol)
    cell.value = group.name
    cell.font = {
      name: 'Microsoft YaHei',
      size: 12,
      bold: true,
      color: { argb: group.name === '店铺产品' ? 'FFFFFFFF' : 'FF0F172A' },
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: group.headerColor },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    }
    applyHeaderBorder(cell)
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
    const colorGroup = subHeaderColorMap[colNumber.toString()] || {
      bg: 'FFE2E8F0',
    }
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: { argb: 'FF0F172A' },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: colorGroup.bg },
    }
    applyHeaderBorder(cell)
  })

  let currentRowIndex = 5
  itemsWithResults.forEach((item) => {
    const rowState = rowStates[item.id]
    const result = rowState?.result
    const draft = rowState?.draft

    if (!result) return

    const volumeKg =
      (toNumber(draft?.package_length_cm ?? '') *
        toNumber(draft?.package_width_cm ?? '') *
        toNumber(draft?.package_height_cm ?? '')) /
      6000
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
      excelRow.getCell(13).value = draft
        ? toNumber(draft.target_profit_rate)
        : 0
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
      excelRow.getCell(25).font = {
        color: {
          argb: result.profit.profit_usd >= 0 ? 'FF047857' : 'FFBE123C',
        },
      }

      excelRow.getCell(26).value = result.profit.profit_rate
      excelRow.getCell(26).numFmt = '0.00%'
      excelRow.getCell(26).font = {
        color: {
          argb: result.profit.profit_rate >= 0 ? 'FF047857' : 'FFBE123C',
        },
      }
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
      const colorGroup = colorMap[colNumber.toString()] || {
        header: 'FFE2E8F0',
        sub: 'FFF8FAFC',
      }
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber <= 2 ? 'left' : 'right',
        wrapText: true,
      }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: colorGroup.sub },
      }
      applyBorder(cell)
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
  const { notify } = useNotifications()
  const [selectedCountry, setSelectedCountry] = useState<string>('US')
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [calculationMode, setCalculationMode] =
    useState<CalculationMode>('profit-calc')
  const [runs, setRuns] = useState<PricingCalculationRunItem[]>([])
  const [runsPage, setRunsPage] = useState(1)
  const [runsTotal, setRunsTotal] = useState(0)
  const RUNS_PAGE_SIZE = 12
  const [productKeyword, setProductKeyword] = useState('')
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([])
  const [runPickerOpen, setRunPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [runsLoading, setRunsLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [deletingRunId, setDeletingRunId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [skuKeyword, setSkuKeyword] = useState('')
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [storeSkusLoading, setStoreSkusLoading] = useState(false)
  const [storeSkusError, setStoreSkusError] = useState<string | null>(null)
  const [storeRows, setStoreRows] = useState<Record<number, StoreSkuRowState>>(
    {},
  )
  const storeCalculationMode: 'profit-calc' | 'profit-reverse' = 'profit-calc'
  const [systemExchangeRate, setSystemExchangeRate] = useState<string>('')
  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.name === selectedProjectName) ?? null,
    [projects, selectedProjectName],
  )

  const loadRuns = useCallback(async (page: number) => {
    setRunsLoading(true)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/pricing-calculation/runs?page=${page}&page_size=${RUNS_PAGE_SIZE}`,
        {
          cache: 'no-store',
        },
      )
      const payload = (await response.json()) as
        | ListResponse
        | { detail?: string; message?: string }
      if (!response.ok) {
        const errorPayload = payload as { detail?: string; message?: string }
        throw new Error(
          errorPayload.detail || errorPayload.message || '测算记录加载失败',
        )
      }
      const data = payload as ListResponse
      setRuns(data.items)
      setRunsTotal(data.total)
      setRunsPage(page)
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : '测算记录加载失败',
      )
    } finally {
      setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRuns(1)
    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
          cache: 'no-store',
        })
        const payload = (await response.json()) as
          | ProjectManageOption[]
          | { detail?: string; message?: string }
        if (!response.ok) {
          const errorPayload = payload as { detail?: string; message?: string }
          throw new Error(
            errorPayload.detail || errorPayload.message || '项目列表加载失败',
          )
        }
        setProjects(
          (payload as ProjectManageOption[]).map((project) => ({
            id: project.id,
            name: project.name,
          })),
        )
      } catch (loadError) {
        setProjectsError(
          loadError instanceof Error ? loadError.message : '项目列表加载失败',
        )
      } finally {
        setProjectsLoading(false)
      }
    }

    void loadProjects()
  }, [loadRuns])

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
        const [skuResponse, summaryResponse, exchangeRateResponse] =
          await Promise.all([
            fetch(`${API_BASE}/api/v1/sku-info?${search.toString()}`, {
              cache: 'no-store',
            }),
            fetch(
              `${API_BASE}/api/v1/shipment-schedules/sku-summary?${summarySearch.toString()}`,
              { cache: 'no-store' },
            ),
            fetch(`/api/exchange-rates?${exchangeRateSearch.toString()}`, {
              cache: 'no-store',
            }),
          ])
        const skuPayload = (await skuResponse.json()) as
          | ProductCostsResponse
          | { detail?: string; message?: string }
        if (!skuResponse.ok) {
          const errorPayload = skuPayload as {
            detail?: string
            message?: string
          }
          throw new Error(
            errorPayload.detail || errorPayload.message || 'SKU 列表加载失败',
          )
        }
        const shipmentSummaryPayload = (await summaryResponse.json()) as
          | ShipmentSkuSummaryResponse
          | { detail?: string; message?: string }
        if (!summaryResponse.ok) {
          const errorPayload = shipmentSummaryPayload as {
            detail?: string
            message?: string
          }
          throw new Error(
            errorPayload.detail ||
              errorPayload.message ||
              '头程历史加权成本加载失败',
          )
        }
        const summaryBySku = new Map(
          (shipmentSummaryPayload as ShipmentSkuSummaryResponse).items.map(
            (item) => [item.sku, item.average_logistics_unit_price],
          ),
        )

        let systemRateValue = ''
        const exchangeRatePayload = await exchangeRateResponse.json()
        const exchangeRateItems = (
          exchangeRatePayload as { items?: Array<{ rate: number }> }
        )?.items
        if (
          exchangeRateResponse.ok &&
          exchangeRateItems &&
          exchangeRateItems.length > 0
        ) {
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
              calculation_type:
                storeCalculationMode === 'profit-calc'
                  ? 'profit_calc'
                  : 'profit_reverse',
              page: '1',
              page_size: '200',
            })
            const snapshotResponse = await fetch(
              `${API_BASE}/api/v1/store-sku-pricing-snapshots?${snapshotSearch.toString()}`,
              { cache: 'no-store' },
            )
            if (snapshotResponse.ok) {
              const snapshotPayload =
                (await snapshotResponse.json()) as StoreSkuPricingSnapshotListResponse
              snapshotPayload.items.forEach((snapshot) => {
                snapshotsMap[`${snapshot.sku}_${snapshot.calculation_type}`] =
                  snapshot
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
                package_length_cm:
                  snapshot.package_length_cm > 0
                    ? String(snapshot.package_length_cm)
                    : '',
                package_width_cm:
                  snapshot.package_width_cm > 0
                    ? String(snapshot.package_width_cm)
                    : '',
                package_height_cm:
                  snapshot.package_height_cm > 0
                    ? String(snapshot.package_height_cm)
                    : '',
                weight_kg:
                  snapshot.weight_kg > 0 ? String(snapshot.weight_kg) : '',
                first_leg_cost_rmb:
                  snapshot.first_leg_cost_rmb > 0
                    ? String(snapshot.first_leg_cost_rmb)
                    : '',
                sale_price_usd:
                  snapshot.sale_price_usd > 0
                    ? String(snapshot.sale_price_usd)
                    : '',
                target_profit_rate:
                  snapshot.target_profit_rate !== null
                    ? String(snapshot.target_profit_rate)
                    : '25',
                advertising_rate: String(snapshot.advertising_rate * 100),
                return_loss_rate: String(snapshot.return_loss_rate * 100),
                storage_months: String(snapshot.storage_months),
                inbound_placement_mode: snapshot.inbound_placement_mode,
                usd_to_rmb_rate:
                  snapshot.usd_to_rmb_rate > 0
                    ? String(snapshot.usd_to_rmb_rate)
                    : systemRateValue,
              }
            } else {
              initialDraft = buildInitialStoreDraft(
                item,
                historicalFirstLegCost,
                systemRateValue,
              )
            }

            next[item.id] = {
              draft: existing?.draft ?? initialDraft,
              loading: false,
              result:
                existing?.result ??
                (snapshot ? convertSnapshotToResult(snapshot) : null),
              error: existing?.error ?? null,
            }
          })
          return next
        })
      } catch (loadError) {
        setStoreSkus([])
        setStoreRows({})
        setStoreSkusError(
          loadError instanceof Error ? loadError.message : 'SKU 列表加载失败',
        )
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
    return runs.filter((run) => {
      return [
        run.product_name,
        run.created_by ?? '',
        getCalculationTypeMeta(run.calculation_type).label,
        formatCompactDate(run.created_at),
      ].some((value) => value.toLowerCase().includes(normalizedKeyword))
    })
  }, [productKeyword, runs])
  const runPickerOptions = useMemo(() => {
    return filteredRuns.map((run) => ({
      run,
      summary: getRunSummary(run),
    }))
  }, [filteredRuns])
  const visibleRuns = filteredRuns

  const selectedRuns = useMemo(() => {
    if (selectedRunIds.length === 0) {
      return []
    }
    const runMap = new Map(runs.map((run) => [run.id, run]))
    return selectedRunIds
      .map((id) => runMap.get(id))
      .filter((run): run is PricingCalculationRunItem => Boolean(run))
      .slice(0, MAX_SELECTED_RUNS)
  }, [runs, selectedRunIds])
  const volumeWeightKg = useMemo(() => {
    return (
      (toNumber(form.package_length_cm) *
        toNumber(form.package_width_cm) *
        toNumber(form.package_height_cm)) /
      6000
    )
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
      return [item.sku, item.asin, item.project_name].some((value) =>
        value.toLowerCase().includes(normalizedKeyword),
      )
    })
  }, [skuKeyword, storeSkus])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)

    try {
      let createdRun: PricingCalculationRunItem

      const fbmFirstLegCost =
        calculationMode === 'fbm-calc' &&
        toNumber(form.full_container_quantity) > 0 &&
        toNumber(form.full_container_price_rmb) > 0
          ? toNumber(form.full_container_price_rmb) /
            toNumber(form.full_container_quantity)
          : firstLegCostRmb

      createdRun = await requestPricingCalculation({
        calculationMode,
        country: selectedCountry,
        product_name: form.product_name.trim(),
        package_length_cm: Number(form.package_length_cm),
        package_width_cm: Number(form.package_width_cm),
        package_height_cm: Number(form.package_height_cm),
        weight_kg: Number(form.weight_kg),
        fob_product_cost_rmb: Number(form.fob_product_cost_rmb),
        first_leg_cost_rmb: fbmFirstLegCost,
        first_leg_unit_price_rmb: toNumber(form.first_leg_unit_price_rmb) || undefined,
        sale_price_usd: Number(form.sale_price_usd),
        target_profit_rate: Number(form.target_profit_rate) / 100,
        commission_rate: Number(form.commission_rate) / 100,
        advertising_rate: Number(form.advertising_rate) / 100,
        return_loss_rate: Number(form.return_loss_rate) / 100,
        storage_months: Number(form.storage_months),
        inbound_placement_mode: form.inbound_placement_mode,
        usd_to_rmb_rate: form.usd_to_rmb_rate.trim()
          ? Number(form.usd_to_rmb_rate)
          : undefined,
        ...(calculationMode === 'fbm-calc' && {
          full_container_quantity: Number(form.full_container_quantity),
          full_container_price_rmb: Number(form.full_container_price_rmb),
          delivery_fee_usd: Number(form.delivery_fee_usd),
        }),
      })

      setRuns((current) => [createdRun, ...current])
      setSelectedRunIds((current) =>
        [createdRun.id, ...current.filter((id) => id !== createdRun.id)].slice(
          0,
          MAX_SELECTED_RUNS,
        ),
      )
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : '定价测算失败',
      )
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

  function handleLoadRunData(run: PricingCalculationRunItem) {
    // Map backend calculation_type to frontend calculationMode
    const modeMap: Record<PricingCalculationRunItem['calculation_type'], CalculationMode> = {
      profit_calc: 'profit-calc',
      profit_reverse: 'profit-reverse',
      cost_reverse: 'cost-reverse',
      fbm_calc: 'fbm-calc',
    }
    const targetMode = modeMap[run.calculation_type] ?? 'profit-calc'
    setCalculationMode(targetMode)
    setSelectedCountry(run.country)

    // Use stored first_leg_unit_price_rmb directly (saved as user input, not derived)
    // For fbm-calc, derive unit price from full_container data if available
    let firstLegUnitPriceRmb = run.first_leg_unit_price_rmb_per_kg ?? 0
    if (targetMode === 'fbm-calc' && run.full_container_quantity && run.full_container_quantity > 0) {
      firstLegUnitPriceRmb =
        (run.full_container_price_rmb ?? 0) / run.full_container_quantity
    }

    setForm({
      product_name: run.product_name ?? '',
      package_length_cm: run.package_length_cm > 0 ? String(run.package_length_cm) : '',
      package_width_cm: run.package_width_cm > 0 ? String(run.package_width_cm) : '',
      package_height_cm: run.package_height_cm > 0 ? String(run.package_height_cm) : '',
      weight_kg: run.weight_kg > 0 ? String(run.weight_kg) : '',
      fob_product_cost_rmb:
        run.fob_product_cost_rmb > 0 ? String(run.fob_product_cost_rmb) : '',
      first_leg_unit_price_rmb:
        firstLegUnitPriceRmb > 0 ? String(firstLegUnitPriceRmb.toFixed(4)) : '',
      sale_price_usd: run.sale_price_usd > 0 ? String(run.sale_price_usd) : '',
      target_profit_rate: '25',
      commission_rate: run.commission_rate > 0 ? String(run.commission_rate * 100) : '',
      advertising_rate:
        run.advertising_rate > 0 ? String(run.advertising_rate * 100) : '',
      return_loss_rate:
        run.return_loss_rate > 0 ? String(run.return_loss_rate * 100) : '',
      storage_months: run.storage_months > 0 ? String(run.storage_months) : '1',
      delivery_fee_usd:
        run.delivery_fee_usd !== undefined && run.delivery_fee_usd > 0
          ? String(run.delivery_fee_usd)
          : '',
      full_container_quantity:
        run.full_container_quantity !== undefined && run.full_container_quantity > 0
          ? String(run.full_container_quantity)
          : '',
      full_container_price_rmb:
        run.full_container_price_rmb !== undefined && run.full_container_price_rmb > 0
          ? String(run.full_container_price_rmb)
          : '',
      inbound_placement_mode: run.inbound_placement_mode,
      usd_to_rmb_rate:
        run.usd_to_rmb_rate > 0 ? String(run.usd_to_rmb_rate) : '',
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
      const response = await fetch(
        `${API_BASE}/api/v1/pricing-calculation/runs/${runId}`,
        {
          method: 'DELETE',
        },
      )

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: string
          message?: string
        } | null
        throw new Error(
          payload?.detail || payload?.message || '删除测算记录失败',
        )
      }

      setRuns((current) => current.filter((run) => run.id !== runId))
      setSelectedRunIds((current) => current.filter((id) => id !== runId))
      notify({ type: 'success', title: '运行记录已删除' })
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : '删除测算记录失败',
      )
      notify({ type: 'error', title: '删除失败', message: deleteError instanceof Error ? deleteError.message : '删除测算记录失败' })
    } finally {
      setDeletingRunId(null)
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
      await logClientOperation({
        action: 'pricing_calculation.comparison.export',
        targetType: 'pricing_calculation_run',
        after: {
          run_ids: selectedRuns.map((run) => run.id),
          row_count: selectedRuns.length,
        },
      })
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      )
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
      await exportStoreSkuTableToExcel(
        filteredStoreSkus,
        storeRows,
        selectedProjectName,
        storeCalculationMode,
      )
      await logClientOperation({
        action: 'pricing_calculation.store_table.export',
        targetType: 'store_sku_pricing_snapshot',
        targetId: selectedProject?.id,
        after: {
          project_id: selectedProject?.id ?? null,
          project_name: selectedProjectName,
          calculation_mode: storeCalculationMode,
          row_count: itemsWithResults.length,
        },
      })
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      )
    } finally {
      setExporting(false)
    }
  }

  function updateStoreDraft(
    rowId: number,
    key: keyof StoreSkuDraft,
    value: string,
  ) {
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

  async function handleStoreSkuCalculate(
    item: ProductCostItem,
    calculationMode: 'profit-calc' | 'profit-reverse' = 'profit-calc',
  ) {
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
        country: item.country,
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
        sale_price_usd:
          calculationMode === 'profit-calc' ? Number(draft.sale_price_usd) : 0,
        target_profit_rate:
          calculationMode === 'profit-reverse'
            ? Number(draft.target_profit_rate) / 100
            : 0,
        commission_rate: 0.15,
        advertising_rate: Number(draft.advertising_rate) / 100,
        return_loss_rate: Number(draft.return_loss_rate) / 100,
        storage_months: Number(draft.storage_months),
        inbound_placement_mode: draft.inbound_placement_mode,
        usd_to_rmb_rate: draft.usd_to_rmb_rate.trim()
          ? Number(draft.usd_to_rmb_rate)
          : undefined,
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
          const snapshotPayload = buildSnapshotPayload(
            item,
            createdRun,
            calculationMode,
            selectedProject.id,
          )
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
          error:
            submitError instanceof Error ? submitError.message : '店铺核算失败',
        },
      }))
    }
  }

  return (
    <div className='space-y-4'>
      <>
        <div className='grid gap-4 xl:grid-cols-[520px_minmax(0,1fr)]'>
                  <Card className='border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90'>
                    <CardHeader className='pb-3'>
                      <CardTitle className='text-lg'>测算输入</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <form className='space-y-4' onSubmit={handleSubmit}>
                        <Tabs
                          value={calculationMode}
                          onValueChange={(value) =>
                            setCalculationMode(value as CalculationMode)
                          }
                        >
                          <TabsMotionGroup id='pricing-calculation-mode-tabs'>
                            <TabsList className='grid w-full grid-cols-4 rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-1'>
                              <SlidingTabsTrigger
                                value='profit-calc'
                                activeValue={calculationMode}
                                layoutId='pricing-calculation-mode-indicator'
                              >
                                利润核算
                              </SlidingTabsTrigger>
                              <SlidingTabsTrigger
                                value='profit-reverse'
                                activeValue={calculationMode}
                                layoutId='pricing-calculation-mode-indicator'
                              >
                                利润倒算
                              </SlidingTabsTrigger>
                              <SlidingTabsTrigger
                                value='cost-reverse'
                                activeValue={calculationMode}
                                layoutId='pricing-calculation-mode-indicator'
                              >
                                成本倒推
                              </SlidingTabsTrigger>
                              <SlidingTabsTrigger
                                value='fbm-calc'
                                activeValue={calculationMode}
                                layoutId='pricing-calculation-mode-indicator'
                              >
                                FBM测算
                              </SlidingTabsTrigger>
                            </TabsList>
                          </TabsMotionGroup>
                        </Tabs>

                        <DirectionalTabTransition
                          value={calculationMode}
                          order={CALCULATION_MODE_ORDER}
                        >
                          <div className='space-y-4'>
                            {/* Row 1: 产品名称 + FOB/售价 */}
                            <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]'>
                              <Field label='产品名称'>
                                <Input
                                  value={form.product_name}
                                  onChange={(event) =>
                                    updateField(
                                      'product_name',
                                      event.target.value,
                                    )
                                  }
                                  placeholder='例如：桌面置物架'
                                  required
                                />
                              </Field>
                              {calculationMode === 'cost-reverse' ? (
                                <Field label='售价(USD)'>
                                  <Input
                                    type='number'
                                    step='0.01'
                                    value={form.sale_price_usd}
                                    onChange={(event) =>
                                      updateField(
                                        'sale_price_usd',
                                        event.target.value,
                                      )
                                    }
                                    required
                                  />
                                </Field>
                              ) : (
                                <Field label='FOB 产品成本(RMB)'>
                                  <Input
                                    type='number'
                                    step='0.01'
                                    value={form.fob_product_cost_rmb}
                                    onChange={(event) =>
                                      updateField(
                                        'fob_product_cost_rmb',
                                        event.target.value,
                                      )
                                    }
                                    required
                                  />
                                </Field>
                              )}
                            </div>
                            <div className='grid gap-3 sm:grid-cols-4'>
                              <Field label='长(cm)'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.package_length_cm}
                                  onChange={(event) =>
                                    updateField(
                                      'package_length_cm',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Field label='宽(cm)'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.package_width_cm}
                                  onChange={(event) =>
                                    updateField(
                                      'package_width_cm',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Field label='高(cm)'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.package_height_cm}
                                  onChange={(event) =>
                                    updateField(
                                      'package_height_cm',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Field label='重量(kg)'>
                                <Input
                                  type='number'
                                  step='0.001'
                                  value={form.weight_kg}
                                  onChange={(event) =>
                                    updateField('weight_kg', event.target.value)
                                  }
                                  required
                                />
                              </Field>
                            </div>

                            <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-4'>
                              {calculationMode === 'fbm-calc' ? (
                                <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]'>
                                  <div className='space-y-3'>
                                    <Field label='整柜数量'>
                                      <Input
                                        type='number'
                                        step='1'
                                        value={form.full_container_quantity}
                                        onChange={(event) =>
                                          updateField(
                                            'full_container_quantity',
                                            event.target.value,
                                          )
                                        }
                                        placeholder='请输入整柜数量'
                                      />
                                    </Field>
                                    <Field label='整柜价格(RMB)'>
                                      <Input
                                        type='number'
                                        step='0.01'
                                        value={form.full_container_price_rmb}
                                        onChange={(event) =>
                                          updateField(
                                            'full_container_price_rmb',
                                            event.target.value,
                                          )
                                        }
                                        placeholder='请输入整柜价格'
                                      />
                                    </Field>
                                  </div>
                                  <div className='rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))] p-3 dark:bg-[hsl(var(--surface-soft))]'>
                                    <p className='text-xs text-muted-foreground'>
                                      单个产品头程(RMB)
                                    </p>
                                    <p className='mt-2 text-2xl font-semibold text-foreground'>
                                      {toNumber(form.full_container_quantity) >
                                        0 &&
                                      toNumber(form.full_container_price_rmb) >
                                        0
                                        ? (
                                            toNumber(
                                              form.full_container_price_rmb,
                                            ) /
                                            toNumber(
                                              form.full_container_quantity,
                                            )
                                          ).toFixed(2)
                                        : '0.00'}
                                    </p>
                                    <p className='mt-1 text-xs text-muted-foreground'>
                                      整柜价格 ÷ 整柜数量
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]'>
                                  <div className='space-y-3'>
                                    <Field label='头程单价(RMB/kg)'>
                                      <Input
                                        type='number'
                                        step='0.01'
                                        value={form.first_leg_unit_price_rmb}
                                        onChange={(event) =>
                                          updateField(
                                            'first_leg_unit_price_rmb',
                                            event.target.value,
                                          )
                                        }
                                        placeholder='请输入头程单价'
                                      />
                                    </Field>
                                    <p className='text-xs leading-5 text-muted-foreground'>
                                      实重{' '}
                                      {formatMetric(
                                        toNumber(form.weight_kg),
                                        3,
                                      )}{' '}
                                      kg，体积重{' '}
                                      {formatMetric(volumeWeightKg, 3)}{' '}
                                      kg，计费重{' '}
                                      {formatMetric(chargeableWeightKg, 3)} kg。
                                    </p>
                                  </div>
                                  <div className='rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))] p-3 dark:bg-[hsl(var(--surface-soft))]'>
                                    <p className='text-xs text-muted-foreground'>
                                      头程成本(RMB)
                                    </p>
                                    <p className='mt-2 text-2xl font-semibold text-foreground'>
                                      {firstLegCostRmb.toFixed(2)}
                                    </p>
                                    <p className='mt-1 text-xs text-muted-foreground'>
                                      计费重 × 头程单价
                                    </p>
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className='grid gap-3 sm:grid-cols-2'>
                              {calculationMode === 'profit-calc' ? (
                                <Field label='售价(USD)'>
                                  <Input
                                    type='number'
                                    step='0.01'
                                    value={form.sale_price_usd}
                                    onChange={(event) =>
                                      updateField(
                                        'sale_price_usd',
                                        event.target.value,
                                      )
                                    }
                                    required
                                  />
                                </Field>
                              ) : calculationMode === 'fbm-calc' ? (
                                <Field label='售价(USD)'>
                                  <Input
                                    type='number'
                                    step='0.01'
                                    value={form.sale_price_usd}
                                    onChange={(event) =>
                                      updateField(
                                        'sale_price_usd',
                                        event.target.value,
                                      )
                                    }
                                    required
                                  />
                                </Field>
                              ) : (
                                <Field label='目标利润率(%)'>
                                  <Input
                                    type='number'
                                    step='0.01'
                                    value={form.target_profit_rate}
                                    onChange={(event) =>
                                      updateField(
                                        'target_profit_rate',
                                        event.target.value,
                                      )
                                    }
                                    required
                                  />
                                </Field>
                              )}
                              <Field label='平台佣金率(%)'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.commission_rate}
                                  onChange={(event) =>
                                    updateField(
                                      'commission_rate',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Field label='广告费率(%)'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.advertising_rate}
                                  onChange={(event) =>
                                    updateField(
                                      'advertising_rate',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Field label='退货折损率(%)'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.return_loss_rate}
                                  onChange={(event) =>
                                    updateField(
                                      'return_loss_rate',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              <Field label='仓储月数'>
                                <Input
                                  type='number'
                                  step='0.01'
                                  value={form.storage_months}
                                  onChange={(event) =>
                                    updateField(
                                      'storage_months',
                                      event.target.value,
                                    )
                                  }
                                  required
                                />
                              </Field>
                              {calculationMode === 'fbm-calc' && (
                                <Field label='配送费(USD)'>
                                  <Input
                                    type='number'
                                    step='0.01'
                                    value={form.delivery_fee_usd}
                                    onChange={(event) =>
                                      updateField(
                                        'delivery_fee_usd',
                                        event.target.value,
                                      )
                                    }
                                    placeholder='请输入配送费'
                                  />
                                </Field>
                              )}
                            </div>

                            <Button
                              type='submit'
                              disabled={loading}
                              className='h-10 w-full'
                            >
                              {loading ? (
                                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                              ) : (
                                <Calculator className='mr-2 h-4 w-4' />
                              )}
                              {calculationMode === 'profit-reverse'
                                ? '倒算售价'
                                : calculationMode === 'cost-reverse'
                                  ? '倒推成本'
                                  : calculationMode === 'fbm-calc'
                                    ? 'FBM测算'
                                    : '开始测算'}
                            </Button>
                          </div>
                        </DirectionalTabTransition>
                      </form>
                    </CardContent>
                  </Card>

                  <div className='flex min-h-0 flex-1 flex-col gap-4 pb-4'>
                    <Card className='border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90'>
                      <CardHeader className='pb-3'>
                        <CardTitle className='text-lg'>控制台</CardTitle>
                      </CardHeader>
                      <CardContent className='space-y-3'>
                        <div className='flex items-end gap-3'>
                          <Field label='国家站点'>
                            <Select
                              value={selectedCountry}
                              onValueChange={(value) => {
                                setSelectedCountry(value)
                                setForm((f) => ({ ...f, country: value }))
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder='选择国家站点' />
                              </SelectTrigger>
                              <SelectContent>
                                {COUNTRY_OPTIONS.map((option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field label='产品搜索'>
                            <div className='relative w-[220px]'>
                              <Search className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                              <Input
                                value={productKeyword}
                                onChange={(event) =>
                                  setProductKeyword(event.target.value)
                                }
                                placeholder='按产品名、测算类型、日期、创建人筛选'
                                className='pl-9'
                              />
                            </div>
                          </Field>
                          <Field label='测算结果' className='min-w-0 flex-1'>
                            <Popover
                              open={runPickerOpen}
                              onOpenChange={setRunPickerOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  type='button'
                                  variant='outline'
                                  className='w-full justify-between'
                                >
                                  <span className='truncate'>
                                    {selectedRunIds.length > 0
                                      ? `已选 ${selectedRunIds.length} 个测算结果`
                                      : '下拉选择测算结果'}
                                  </span>
                                  <ChevronDown className='ml-2 h-4 w-4 shrink-0 text-muted-foreground' />
                                </Button>
                              </PopoverTrigger>
                            <PopoverContent
                              align='start'
                              className='w-[min(92vw,420px)] p-0'
                            >
                              <Command>
                                <CommandInput placeholder='搜索产品名称、测算类型、日期' />
                                <CommandList>
                                  <CommandEmpty>
                                    没有匹配的测算结果
                                  </CommandEmpty>
                                  <CommandGroup
                                    heading={`可选记录 ${runPickerOptions.length} 条`}
                                  >
                                    {runPickerOptions.map(
                                      ({ run, summary }) => {
                                        const isSelected =
                                          selectedRunIds.includes(run.id)
                                        const disabled =
                                          !isSelected &&
                                          selectedRunIds.length >=
                                            MAX_SELECTED_RUNS
                                        return (
                                          <CommandItem
                                            key={run.id}
                                            value={`${run.id} ${summary} ${run.created_by ?? ''}`}
                                            disabled={disabled}
                                            onSelect={() => {
                                              toggleRunSelection(run.id)
                                              handleLoadRunData(run)
                                            }}
                                            className='items-start gap-3 py-3'
                                          >
                                            <span
                                              className={cn(
                                                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                                                isSelected
                                                  ? 'border-primary bg-primary text-primary-foreground'
                                                  : 'border-border bg-background',
                                              )}
                                            >
                                              {isSelected ? (
                                                <Check className='h-3 w-3' />
                                              ) : null}
                                            </span>
                                            <div className='min-w-0 flex-1'>
                                              <div className='truncate text-sm font-medium text-foreground'>
                                                {run.product_name}
                                              </div>
                                              <div className='mt-1 text-xs text-muted-foreground'>
                                                {
                                                  getCalculationTypeMeta(
                                                    run.calculation_type,
                                                  ).label
                                                }{' '}
                                                ·{' '}
                                                {formatCompactDate(
                                                  run.created_at,
                                                )}
                                              </div>
                                              {run.created_by ? (
                                                <div className='mt-1 text-[11px] text-muted-foreground'>
                                                  创建人：{run.created_by}
                                                </div>
                                              ) : null}
                                            </div>
                                          </CommandItem>
                                        )
                                      },
                                    )}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                            </Popover>
                          </Field>
                          <Field label=''>
                            <Button
                              type='button'
                              variant='outline'
                              onClick={() => setSelectedRunIds([])}
                              disabled={selectedRunIds.length === 0}
                            >
                              清空选择
                            </Button>
                          </Field>
                        </div>
                        <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
                          <span>筛选结果 {filteredRuns.length} 条</span>
                          {productKeyword ? (
                            <span>关键词: {productKeyword}</span>
                          ) : null}
                        </div>
                        {error ? (
                          <div className='flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'>
                            <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
                            <span>{error}</span>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>

                    <Card className='border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90'>
                      <CardHeader className='pb-3'>
                        <CardTitle className='text-lg'>最近测算</CardTitle>
                      </CardHeader>
                      <CardContent className='flex flex-1 flex-col px-6 pb-6 pt-0 md:px-7 md:pb-7 md:pt-0'>
                        <div className='grid flex-1 gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 overflow-y-auto content-start' style={{ maxHeight: 'calc(100vh - 22rem)' }}>
                          {runsLoading ? (
                            <>
                              <PricingRunCardSkeleton />
                              <PricingRunCardSkeleton />
                              <PricingRunCardSkeleton />
                              <PricingRunCardSkeleton />
                            </>
                          ) : visibleRuns.length === 0 ? (
                            <div className='rounded-2xl border border-dashed px-4 py-6 text-sm text-muted-foreground'>
                              {runs.length === 0
                                ? '暂无测算记录'
                                : '没有匹配当前筛选条件的产品'}
                            </div>
                          ) : (
                            visibleRuns.map((run) => {
                              const typeMeta = getCalculationTypeMeta(
                                run.calculation_type ?? 'profit_calc',
                              )
                              const isSelected = selectedRunIds.includes(run.id)
                              const isProfit = run.profit.profit_usd >= 0

                              return (
                                <div
                                  key={run.id}
                                  onClick={() => {
                                    toggleRunSelection(run.id)
                                    handleLoadRunData(run)
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault()
                                      toggleRunSelection(run.id)
                                      handleLoadRunData(run)
                                    }
                                  }}
                                  role='button'
                                  tabIndex={0}
                                  className={cn(
                                    'group flex min-h-[110px] flex-col rounded-xl border px-3 py-2 text-left transition-all',
                                    isSelected
                                      ? typeMeta.selectedClassName
                                      : typeMeta.cardClassName,
                                  )}
                                >
                                  <div className='grid grid-cols-[auto_1fr_auto] items-center gap-2'>
                                    <div className='flex min-w-0 items-center gap-1.5'>
                                      <Badge
                                        className={cn(
                                          'shrink-0 border px-2 py-0.5 text-[10px] font-medium',
                                          typeMeta.badgeClassName,
                                        )}
                                      >
                                        {typeMeta.label}
                                      </Badge>
                                    </div>

                                    <div className='flex min-w-0 items-center justify-center gap-1.5 text-[11px] text-muted-foreground'>
                                      <span
                                        className='truncate'
                                        title={formatCompactDate(run.created_at)}
                                      >
                                        {formatRelativeTime(run.created_at)}
                                      </span>
                                      <span className='text-muted-foreground/40'>
                                        /
                                      </span>
                                      <span className='shrink-0 text-muted-foreground/70'>
                                        {run.country
                                          ? COUNTRY_MAP[run.country] ?? run.country
                                          : '--'}
                                      </span>
                                      {run.created_by ? (
                                        <>
                                          <span className='text-muted-foreground/40'>
                                            /
                                          </span>
                                          <span className='shrink-0 truncate text-muted-foreground/70'>
                                            {run.created_by}
                                          </span>
                                        </>
                                      ) : null}
                                    </div>

                                    <div
                                      className='flex shrink-0 items-center justify-end'
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <Button
                                        type='button'
                                        variant='ghost'
                                        size='icon'
                                        className='h-7 w-7 rounded-full text-muted-foreground opacity-70 transition hover:bg-background/80 hover:text-rose-600 group-hover:opacity-100 dark:hover:text-rose-400'
                                        disabled={deletingRunId === run.id}
                                        onClick={() => void handleDeleteRun(run.id)}
                                        title='删除此测算'
                                      >
                                        {deletingRunId === run.id ? (
                                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                        ) : (
                                          <Trash2 className='h-3.5 w-3.5' />
                                        )}
                                      </Button>
                                    </div>
                                  </div>

                                  <div className='mt-2 min-w-0 flex-1'>
                                    <p className='line-clamp-2 text-sm font-semibold leading-5 text-foreground'>
                                      {run.product_name}
                                    </p>
                                  </div>

                                  <div className='mt-2 grid grid-cols-3 gap-2 border-t border-border/40 pt-2'>
                                    <div className='min-w-0'>
                                      <p className='text-[11px] text-muted-foreground'>
                                        价格
                                      </p>
                                      <p className='truncate text-sm font-semibold tabular-nums text-foreground'>
                                        {formatCurrency(run.sale_price_usd)}
                                      </p>
                                    </div>
                                    <div className='min-w-0'>
                                      <p className='text-[11px] text-muted-foreground'>
                                        利润
                                      </p>
                                      <p
                                        className={cn(
                                          'truncate text-sm font-semibold tabular-nums',
                                          isProfit
                                            ? 'text-emerald-600 dark:text-emerald-400'
                                            : 'text-rose-600 dark:text-rose-400',
                                        )}
                                      >
                                        {formatCurrency(run.profit.profit_usd)}
                                      </p>
                                    </div>
                                    <div className='min-w-0'>
                                      <p className='text-[11px] text-muted-foreground'>
                                        利润率
                                      </p>
                                      <p
                                        className={cn(
                                          'truncate text-sm font-semibold tabular-nums',
                                          isProfit
                                            ? 'text-emerald-600 dark:text-emerald-400'
                                            : 'text-rose-600 dark:text-rose-400',
                                        )}
                                      >
                                        {formatPercent(run.profit.profit_rate)}
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              )
                            })
                          )}
                        </div>
                        {runsTotal > RUNS_PAGE_SIZE && (() => {
                          const totalPages = Math.ceil(runsTotal / RUNS_PAGE_SIZE)
                          const WINDOW = 5
                          const start = Math.max(1, Math.min(runsPage - 2, totalPages - WINDOW + 1))
                          const end = Math.min(totalPages, start + WINDOW - 1)
                          const pageNumbers: (number | '...')[] = []
                          if (start > 1) {
                            pageNumbers.push(1)
                            if (start > 2) pageNumbers.push('...')
                          }
                          for (let p = start; p <= end; p++) pageNumbers.push(p)
                          if (end < totalPages) {
                            if (end < totalPages - 1) pageNumbers.push('...')
                            pageNumbers.push(totalPages)
                          }
                          return (
                            <Pagination className='mt-4'>
                              <PaginationContent>
                                <PaginationItem>
                                  <PaginationPrevious
                                    href='#'
                                    onClick={(e) => {
                                      e.preventDefault()
                                      if (runsPage > 1) void loadRuns(runsPage - 1)
                                    }}
                                    aria-disabled={runsPage <= 1}
                                    className={cn('gap-1 px-3', runsPage <= 1 ? 'pointer-events-none opacity-50' : undefined)}
                                  >
                                    <ChevronLeft className='h-4 w-4' />
                                    <span>上一页</span>
                                  </PaginationPrevious>
                                </PaginationItem>
                                {pageNumbers.map((p, i) =>
                                  p === '...' ? (
                                    <PaginationItem key={`ellipsis-${i}`}>
                                      <span className='flex h-9 w-9 items-center justify-center text-sm text-muted-foreground'>
                                        …
                                      </span>
                                    </PaginationItem>
                                  ) : (
                                    <PaginationItem key={p}>
                                      <PaginationLink
                                        href='#'
                                        onClick={(e) => {
                                          e.preventDefault()
                                          void loadRuns(p)
                                        }}
                                        isActive={p === runsPage}
                                      >
                                        {p}
                                      </PaginationLink>
                                    </PaginationItem>
                                  ),
                                )}
                                <PaginationItem>
                                  <PaginationNext
                                    href='#'
                                    onClick={(e) => {
                                      e.preventDefault()
                                      if (runsPage < totalPages) void loadRuns(runsPage + 1)
                                    }}
                                    aria-disabled={runsPage >= totalPages}
                                    className={cn('gap-1 px-3', runsPage >= totalPages ? 'pointer-events-none opacity-50' : undefined)}
                                  >
                                    <span>下一页</span>
                                    <ChevronRight className='h-4 w-4' />
                                  </PaginationNext>
                                </PaginationItem>
                              </PaginationContent>
                            </Pagination>
                          )
                        })()}
                      </CardContent>
                    </Card>
                  </div>
                </div>

                <Card className='border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90'>
                  <CardHeader className='pb-3'>
                    <div className='flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between'>
                      <div className='space-y-1'>
                        <CardTitle className='text-lg'>测算对比矩阵</CardTitle>
                      </div>
                      <Button
                        type='button'
                        variant='outline'
                        onClick={() => void handleExportComparisonMatrix()}
                        disabled={selectedRuns.length === 0 || exporting}
                      >
                        {exporting ? (
                          <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                        ) : (
                          <Download className='mr-2 h-4 w-4' />
                        )}
                        导出 Excel
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <LazyComparisonTable
                      sections={getComparisonSections() as any}
                      runs={selectedRuns}
                      formatCompactDate={formatCompactDate}
                    />
                  </CardContent>
                </Card>
              </>
    </div>
  )
}

async function requestPricingCalculation(payload: {
  calculationMode: CalculationMode
  country: string
  product_name: string
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  first_leg_unit_price_rmb?: number
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
  full_container_quantity?: number
  full_container_price_rmb?: number
  delivery_fee_usd?: number
}): Promise<PricingCalculationRunItem> {
  const endpoint =
    payload.calculationMode === 'profit-reverse'
      ? `${API_BASE}/api/v1/pricing-calculation/reverse-quote`
      : payload.calculationMode === 'cost-reverse'
        ? `${API_BASE}/api/v1/pricing-calculation/reverse-cost`
        : payload.calculationMode === 'fbm-calc'
          ? `${API_BASE}/api/v1/pricing-calculation/fbm-quote`
          : `${API_BASE}/api/v1/pricing-calculation/quote`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      country: payload.country,
      product_name: payload.product_name,
      package_length_cm: payload.package_length_cm,
      package_width_cm: payload.package_width_cm,
      package_height_cm: payload.package_height_cm,
      weight_kg: payload.weight_kg,
      fob_product_cost_rmb: payload.fob_product_cost_rmb,
      first_leg_cost_rmb: payload.first_leg_cost_rmb,
      ...(payload.first_leg_unit_price_rmb
        ? { first_leg_unit_price_rmb: payload.first_leg_unit_price_rmb }
        : {}),
      ...(payload.project_id ? { project_id: payload.project_id } : {}),
      ...(payload.sku ? { sku: payload.sku } : {}),
      ...(payload.use_historical_shipping_cost
        ? { use_historical_shipping_cost: payload.use_historical_shipping_cost }
        : {}),
      ...(payload.calculationMode === 'profit-reverse'
        ? { target_profit_rate: payload.target_profit_rate }
        : payload.calculationMode === 'cost-reverse'
          ? {
              sale_price_usd: payload.sale_price_usd,
              target_profit_rate: payload.target_profit_rate,
            }
          : { sale_price_usd: payload.sale_price_usd }),
      commission_rate: payload.commission_rate,
      advertising_rate: payload.advertising_rate,
      return_loss_rate: payload.return_loss_rate,
      storage_months: payload.storage_months,
      inbound_placement_mode: payload.inbound_placement_mode,
      ...(payload.usd_to_rmb_rate
        ? { usd_to_rmb_rate: payload.usd_to_rmb_rate }
        : {}),
      ...(payload.full_container_quantity
        ? { full_container_quantity: payload.full_container_quantity }
        : {}),
      ...(payload.full_container_price_rmb
        ? { full_container_price_rmb: payload.full_container_price_rmb }
        : {}),
      ...(payload.delivery_fee_usd
        ? { delivery_fee_usd: payload.delivery_fee_usd }
        : {}),
    }),
  })

  const body = (await response.json()) as
    | PricingCalculationRunItem
    | { detail?: string; message?: string }
  if (!response.ok) {
    const errorPayload = body as { detail?: string; message?: string }
    throw new Error(
      errorPayload.detail || errorPayload.message || '定价测算失败',
    )
  }
  return body as PricingCalculationRunItem
}

function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className='text-xs'>{label}</Label>
      {children}
    </div>
  )
}
