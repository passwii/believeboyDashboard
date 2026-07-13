'use client'

import { useEffect, useMemo, useState } from 'react'
import { Package, Search } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { ShopCalculationEuTable } from '@/components/dashboard/pricing-calculation/shop-calculation-eu-table'
import type {
  PricingCalculationRunItem,
  ProductCostItem,
  ProductCostsResponse,
  ProjectManageOption,
  ShopCalculationItem,
} from '@/lib/pricing-calculation-types'

const API_BASE = '/api/backend'

type StoreSkuDraft = {
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  first_leg_cost_rmb: string
  sale_price_usd: string
  advertising_rate: string
  return_loss_rate: string
  delivery_fee_usd: string
  inbound_config_fee_usd: string
  storage_fee_usd: string
  usd_to_rmb_rate: string
}

type StoreSkuRowState = {
  draft: StoreSkuDraft
  loading: boolean
  result: PricingCalculationRunItem | null
  error: string | null
}

export const EU_COUNTRY_OPTIONS = [
  { value: 'DE', label: '德国站 (DE)', vatLabel: '19% VAT' },
  { value: 'UK', label: '英国站 (UK)', vatLabel: '20% VAT' },
] as const

function toNumber(value: string | number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function requestEUPricingCalculation(payload: {
  country: string
  product_name: string
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
  delivery_fee_usd: number
  inbound_config_fee_usd: number
  storage_fee_usd: number
  project_id?: number
  sku?: string
  usd_to_rmb_rate?: number
}): Promise<PricingCalculationRunItem> {
  const response = await fetch(`${API_BASE}/api/v1/pricing-calculation/eu-quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ detail: '测算请求失败' }))) as {
      detail?: string
      message?: string
    }
    throw new Error(errorPayload.detail || errorPayload.message || '定价测算失败')
  }
  return response.json() as Promise<PricingCalculationRunItem>
}

async function requestSaveSnapshot(payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${API_BASE}/api/v1/shop-calculation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ detail: '保存快照失败' }))) as {
      detail?: string
      message?: string
    }
    throw new Error(errorPayload.detail || errorPayload.message || '保存快照失败')
  }
  return response.json()
}

/** Convert a ShopCalculationItem (from DB) to a PricingCalculationRunItem */
function snapshotToResult(
  snapshot: ShopCalculationItem,
  projectName: string
): PricingCalculationRunItem {
  return {
    id: snapshot.id,
    country: snapshot.country ?? undefined,
    product_name: `${projectName} / ${snapshot.sku}`,
    calculation_type: snapshot.accounting_type,
    project_id: snapshot.project_id,
    sku: snapshot.sku,
    package_length_cm: snapshot.package_length_cm,
    package_width_cm: snapshot.package_width_cm,
    package_height_cm: snapshot.package_height_cm,
    weight_kg: snapshot.weight_kg,
    fob_product_cost_rmb: snapshot.fob_product_cost_rmb,
    first_leg_cost_rmb: snapshot.first_leg_cost_rmb,
    sale_price_usd: snapshot.sale_price_usd,
    // ShopCalculationItem does not echo commission_rate; PricingCalculationRunItem
    // requires it. Use the standard US default; if the backend later exposes
    // per-snapshot commission, plumb it through here.
    commission_rate: 0.15,
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
    // ShopCalculationProfit is a subset of PricingCalculationProfit (no
    // delivery_fee_usd / full_container_*). Map explicitly so the difference
    // is visible at the call site.
    profit: {
      ddp_cost_rmb: snapshot.profit.ddp_cost_rmb,
      ddp_cost_usd: snapshot.profit.ddp_cost_usd,
      payout_usd: snapshot.profit.payout_usd,
      profit_usd: snapshot.profit.profit_usd,
      profit_rate: snapshot.profit.profit_rate,
      vat_usd: snapshot.profit.vat_usd,
      profit_after_vat_usd: snapshot.profit.profit_after_vat_usd ?? null,
      profit_after_vat_rate: snapshot.profit.profit_after_vat_rate ?? null,
      delivery_fee_usd: 0,
      full_container_quantity: 0,
      full_container_price_rmb: 0,
    },
    warnings: snapshot.warnings ?? [],
    created_by: snapshot.created_by,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
    delivery_fee_usd: 0,
    full_container_quantity: 0,
    full_container_price_rmb: 0,
  }
}

interface ShopCalculationEuSectionProps {
  selectedCountry: string
  projects: ProjectManageOption[]
  projectsLoading: boolean
  selectedProjectName: string
  selectedProjectId: number | null
  skuKeyword: string
  onProjectChange: (name: string) => void
  onSkuKeywordChange: (keyword: string) => void
  onDataReady?: (data: { items: ProductCostItem[]; rows: Record<number, StoreSkuRowState> }) => void
  onHasCalculatedRowsChange?: (hasRows: boolean) => void
  /** 定价历史快照 ID（null = 实时数据） */
  selectedSnapshotId?: number | null
  /** 快照数据无法加载时通知父组件退出快照模式 */
  onSnapshotInvalid?: () => void
}

export function ShopCalculationEuSection({
  selectedCountry,
  projects,
  projectsLoading,
  selectedProjectName,
  selectedProjectId,
  skuKeyword,
  onSkuKeywordChange,
  onDataReady,
  onHasCalculatedRowsChange,
  selectedSnapshotId = null,
  onSnapshotInvalid,
}: ShopCalculationEuSectionProps) {
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [storeSkusLoading, setStoreSkusLoading] = useState(false)
  const [storeSkusError, setStoreSkusError] = useState<string | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [storeRows, setStoreRows] = useState<Record<number, StoreSkuRowState>>({})
  const [systemExchangeRate, setSystemExchangeRate] = useState<string>('')

  useEffect(() => {
    setStoreRows({})
  }, [selectedProjectName, selectedCountry, selectedSnapshotId])

  useEffect(() => {
    async function loadSkusAndSnapshots() {
      if (!selectedProjectName) {
        setStoreSkus([])
        setStoreRows({})
        setStoreSkusError(null)
        setSystemExchangeRate('')
        return
      }
      // Guard: selectedProjectId must be set before making API calls
      // Prevents 422 from project_id=null/NaN during React render batching
      if (selectedProjectId === null || selectedProjectId === undefined) {
        return
      }
      setStoreSkusLoading(true)
      setStoreSkusError(null)
      setSnapshotError(null)
      try {
        // ── 快照模式：从 pricing-calculation-snapshots 拉取快照明细 ──────────
        if (selectedSnapshotId !== null) {
          const snapshotResponse = await fetch(
            `${API_BASE}/api/v1/pricing-calculation-snapshots/${selectedSnapshotId}/items`,
            { cache: 'no-store' }
          )
          if (!snapshotResponse.ok) {
            const body = await snapshotResponse.text().catch(() => '')
            console.error('[eu-shop-calculation] 历史快照加载失败:', snapshotResponse.status, body)
            setSnapshotError(`历史快照加载失败（HTTP ${snapshotResponse.status}），已退出快照模式`)
            onSnapshotInvalid?.()
            setStoreSkus([])
            setStoreRows({})
            return
          }
          const payload = (await snapshotResponse.json()) as { items: ShopCalculationItem[] }
          const items = payload.items ?? []

          // 转换快照明细 → ProductCostItem 形状（用 fob_product_cost_rmb 充 fob_unit_cost）
          const syntheticSkus: ProductCostItem[] = items.map((s, idx) => ({
            id: s.id ?? idx + 1,
            project_name: s.project_name,
            sku: s.sku,
            asin: s.asin ?? '',
            fnsku: null,
            fob_unit_cost: s.fob_product_cost_rmb,
            first_leg_cost_rmb: s.first_leg_cost_rmb,
            package_length_cm: s.package_length_cm,
            package_width_cm: s.package_width_cm,
            package_height_cm: s.package_height_cm,
            weight_kg: s.weight_kg,
            carton_length_cm: 0,
            carton_width_cm: 0,
            carton_height_cm: 0,
            carton_weight_kg: 0,
            units_per_carton: 0,
            currency: 'USD',
            country: s.country ?? selectedCountry,
            sort_order: idx,
            is_active: true,
          }))
          setStoreSkus(syntheticSkus)

          const snapshotMap = new Map<string, ShopCalculationItem>()
          for (const s of items) {
            snapshotMap.set(s.sku, s)
          }

          setStoreRows(() => {
            const next: Record<number, StoreSkuRowState> = {}
            syntheticSkus.forEach((item) => {
              const snapshot = snapshotMap.get(item.sku)
              if (!snapshot) return
              next[item.id] = {
                draft: {
                  package_length_cm: String(snapshot.package_length_cm ?? ''),
                  package_width_cm: String(snapshot.package_width_cm ?? ''),
                  package_height_cm: String(snapshot.package_height_cm ?? ''),
                  weight_kg: String(snapshot.weight_kg ?? ''),
                  first_leg_cost_rmb: String(snapshot.first_leg_cost_rmb ?? ''),
                  sale_price_usd: String(snapshot.sale_price_usd ?? ''),
                  advertising_rate: String((snapshot.advertising_rate ?? 0.12) * 100),
                  return_loss_rate: String((snapshot.return_loss_rate ?? 0.04) * 100),
                  delivery_fee_usd: String(snapshot.fees?.delivery_fee_usd ?? 0),
                  inbound_config_fee_usd: String(snapshot.fees?.inbound_config_fee_manual_usd ?? 0),
                  storage_fee_usd: String(snapshot.fees?.storage_fee_manual_usd ?? 0),
                  usd_to_rmb_rate: String(snapshot.usd_to_rmb_rate ?? ''),
                },
                loading: false,
                result: snapshotToResult(snapshot, item.project_name),
                error: null,
              }
            })
            return next
          })
          return
        }

        // ── 实时模式：拉 SKU 列表 + 当前态快照 ─────────────────────────────
        const [skuSearch, exchangeSearch, snapshotSearch] = await Promise.all([
          fetch(
            `${API_BASE}/api/v1/sku-info?project_name=${encodeURIComponent(selectedProjectName)}&country=${selectedCountry}&is_active=true&page=1&page_size=200&include_total=true`,
            { cache: 'no-store' }
          ),
          fetch(
            `/api/exchange-rates?currency=${selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'}&page=1&pageSize=1`,
            { cache: 'no-store' }
          ),
          // Load existing EU snapshots
          fetch(
            `${API_BASE}/api/v1/shop-calculation?project_id=${selectedProjectId}&country=${selectedCountry}&page=1&page_size=200`,
            { cache: 'no-store' }
          ),
        ])
        if (!skuSearch.ok) throw new Error('SKU 列表加载失败')

        const skuPayload = (await skuSearch.json()) as ProductCostsResponse
        const exchangePayload = (await exchangeSearch.json()) as {
          data?: Array<{ rate: number }>
        }
        const rate = exchangePayload?.data?.[0]?.rate ? String(exchangePayload.data[0].rate) : ''
        setSystemExchangeRate(rate)

        const euSkus = skuPayload.items.filter(
          (item) => item.country === selectedCountry && item.is_active
        )
        setStoreSkus(euSkus)

        // Parse existing snapshots
        let snapshotPayload: { items?: ShopCalculationItem[]; total?: number } = { items: [] }
        if (snapshotSearch.ok) {
          snapshotPayload = (await snapshotSearch.json()) as {
            items?: ShopCalculationItem[]
            total?: number
          }
        } else {
          const body = await snapshotSearch.text().catch(() => '')
          console.error('[eu-shop-calculation] 快照加载失败:', snapshotSearch.status, body)
          setSnapshotError(
            `店铺历史加载失败（HTTP ${snapshotSearch.status}），价格信息可能无法显示`
          )
        }
        const snapshotMap = new Map<string, ShopCalculationItem>()
        for (const s of snapshotPayload.items ?? []) {
          snapshotMap.set(s.sku, s)
        }

        // Initialize row state
        setStoreRows((current) => {
          const next: Record<number, StoreSkuRowState> = {}
          euSkus.forEach((item) => {
            const existing = current[item.id]
            const snapshot = snapshotMap.get(item.sku)

            if (snapshot) {
              next[item.id] = {
                draft: existing?.draft ?? {
                  package_length_cm:
                    snapshot.package_length_cm > 0
                      ? String(snapshot.package_length_cm)
                      : item.package_length_cm > 0
                        ? String(item.package_length_cm)
                        : '',
                  package_width_cm:
                    snapshot.package_width_cm > 0
                      ? String(snapshot.package_width_cm)
                      : item.package_width_cm > 0
                        ? String(item.package_width_cm)
                        : '',
                  package_height_cm:
                    snapshot.package_height_cm > 0
                      ? String(snapshot.package_height_cm)
                      : item.package_height_cm > 0
                        ? String(item.package_height_cm)
                        : '',
                  weight_kg:
                    snapshot.weight_kg > 0
                      ? String(snapshot.weight_kg)
                      : item.weight_kg > 0
                        ? String(item.weight_kg)
                        : '',
                  first_leg_cost_rmb:
                    snapshot.first_leg_cost_rmb > 0
                      ? String(snapshot.first_leg_cost_rmb)
                      : item.first_leg_cost_rmb > 0
                        ? String(item.first_leg_cost_rmb)
                        : '5',
                  sale_price_usd: String(snapshot.sale_price_usd),
                  advertising_rate: String(snapshot.advertising_rate * 100),
                  return_loss_rate: String(snapshot.return_loss_rate * 100),
                  delivery_fee_usd: String(snapshot.fees?.delivery_fee_usd ?? 0),
                  inbound_config_fee_usd: String(snapshot.fees?.inbound_config_fee_manual_usd ?? 0),
                  storage_fee_usd: String(snapshot.fees?.storage_fee_manual_usd ?? 0),
                  usd_to_rmb_rate: rate || String(snapshot.usd_to_rmb_rate),
                },
                loading: false,
                result: snapshotToResult(snapshot, item.project_name),
                error: existing?.error ?? null,
              }
            } else if (existing) {
              next[item.id] = existing
            } else {
              next[item.id] = {
                draft: {
                  package_length_cm:
                    item.package_length_cm > 0 ? String(item.package_length_cm) : '',
                  package_width_cm: item.package_width_cm > 0 ? String(item.package_width_cm) : '',
                  package_height_cm:
                    item.package_height_cm > 0 ? String(item.package_height_cm) : '',
                  weight_kg: item.weight_kg > 0 ? String(item.weight_kg) : '',
                  first_leg_cost_rmb:
                    item.first_leg_cost_rmb > 0 ? String(item.first_leg_cost_rmb) : '5',
                  sale_price_usd: '',
                  advertising_rate: '12',
                  return_loss_rate: '4',
                  delivery_fee_usd: '0',
                  inbound_config_fee_usd: '0',
                  storage_fee_usd: '0',
                  usd_to_rmb_rate: rate,
                },
                loading: false,
                result: null,
                error: null,
              }
            }
          })
          return next
        })
      } catch (err) {
        setStoreSkusError(err instanceof Error ? err.message : 'SKU 列表加载失败')
        setStoreSkus([])
      } finally {
        setStoreSkusLoading(false)
      }
    }
    void loadSkusAndSnapshots()
    // onSnapshotInvalid 来自父组件，本节保持稳定引用以避免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectName, selectedCountry, selectedProjectId, selectedSnapshotId])

  const filteredSkus = useMemo(() => {
    if (!skuKeyword.trim()) return storeSkus
    const kw = skuKeyword.trim().toLowerCase()
    return storeSkus.filter(
      (item) => item.sku.toLowerCase().includes(kw) || item.asin.toLowerCase().includes(kw)
    )
  }, [skuKeyword, storeSkus])

  // 通知父组件数据变化
  useEffect(() => {
    onDataReady?.({ items: filteredSkus, rows: storeRows })
  }, [filteredSkus, storeRows, onDataReady])

  useEffect(() => {
    const hasRows = Object.values(storeRows).some((r) => r.result != null)
    onHasCalculatedRowsChange?.(hasRows)
  }, [storeRows, onHasCalculatedRowsChange])

  function updateDraft(rowId: number, key: keyof StoreSkuDraft, value: string) {
    setStoreRows((current) => {
      const row = current[rowId]
      if (!row) return current
      return { ...current, [rowId]: { ...row, draft: { ...row.draft, [key]: value } } }
    })
  }

  async function handleCalculate(item: ProductCostItem) {
    const rowState = storeRows[item.id]
    if (!rowState) return
    setStoreRows((current) => ({
      ...current,
      [item.id]: { ...current[item.id], loading: true, error: null },
    }))

    try {
      const draft = rowState.draft
      const createdRun = await requestEUPricingCalculation({
        country: selectedCountry,
        product_name: `${item.project_name} / ${item.sku}`,
        package_length_cm: toNumber(draft.package_length_cm),
        package_width_cm: toNumber(draft.package_width_cm),
        package_height_cm: toNumber(draft.package_height_cm),
        weight_kg: toNumber(draft.weight_kg),
        fob_product_cost_rmb: item.fob_unit_cost,
        first_leg_cost_rmb: toNumber(draft.first_leg_cost_rmb),
        sale_price_usd: toNumber(draft.sale_price_usd),
        commission_rate: 0.15,
        advertising_rate: toNumber(draft.advertising_rate) / 100,
        return_loss_rate: toNumber(draft.return_loss_rate) / 100,
        delivery_fee_usd: toNumber(draft.delivery_fee_usd),
        inbound_config_fee_usd: toNumber(draft.inbound_config_fee_usd),
        storage_fee_usd: toNumber(draft.storage_fee_usd),
        project_id: selectedProjectId ?? undefined,
        sku: item.sku,
        usd_to_rmb_rate: draft.usd_to_rmb_rate.trim() ? toNumber(draft.usd_to_rmb_rate) : undefined,
      })

      setStoreRows((current) => ({
        ...current,
        [item.id]: { ...current[item.id], loading: false, result: createdRun },
      }))

      if (selectedProjectId) {
        try {
          await requestSaveSnapshot({
            project_id: selectedProjectId,
            project_name: item.project_name,
            sku: item.sku,
            asin: item.asin,
            country: selectedCountry,
            accounting_type: 'eu_accounting',
            package_length_cm: createdRun.package_length_cm,
            package_width_cm: createdRun.package_width_cm,
            package_height_cm: createdRun.package_height_cm,
            weight_kg: createdRun.weight_kg,
            fob_product_cost_rmb: createdRun.fob_product_cost_rmb,
            first_leg_cost_rmb: createdRun.first_leg_cost_rmb,
            ddp_cost_rmb: createdRun.profit.ddp_cost_rmb,
            ddp_cost_usd: createdRun.profit.ddp_cost_usd,
            sale_price_usd: createdRun.sale_price_usd,
            advertising_rate: createdRun.advertising_rate,
            return_loss_rate: createdRun.return_loss_rate,
            storage_months: 1,
            inbound_placement_mode: 'single_destination',
            usd_to_rmb_rate: createdRun.usd_to_rmb_rate,
            usd_to_rmb_rate_source: '',
            size_tier: createdRun.size_tier,
            size_tier_label: createdRun.size_tier_label,
            price_band: createdRun.price_band,
            price_band_label: createdRun.price_band_label,
            longest_side_in: createdRun.dimensions.longest_side_in,
            middle_side_in: createdRun.dimensions.middle_side_in,
            shortest_side_in: createdRun.dimensions.shortest_side_in,
            length_plus_girth_in: createdRun.dimensions.length_plus_girth_in,
            volume_cubic_in: createdRun.dimensions.volume_cubic_in,
            volume_cubic_ft: createdRun.dimensions.volume_cubic_ft,
            product_weight_lb: createdRun.weights.product_weight_lb,
            product_weight_oz: createdRun.weights.product_weight_oz,
            dimensional_weight_lb: createdRun.weights.dimensional_weight_lb,
            chargeable_weight_lb: createdRun.weights.chargeable_weight_lb,
            chargeable_weight_oz: createdRun.weights.chargeable_weight_oz,
            chargeable_weight_rule: createdRun.weights.chargeable_weight_rule,
            fulfillment_fee_rule_label: createdRun.fulfillment_fee_rule_label,
            inbound_config_fee_rule_label: createdRun.inbound_config_fee_rule_label,
            storage_fee_rule_label: createdRun.storage_fee_rule_label,
            referral_fee_usd: createdRun.fees.referral_fee_usd,
            advertising_fee_usd: createdRun.fees.advertising_fee_usd,
            return_loss_usd: createdRun.fees.return_loss_usd,
            fba_fulfillment_fee_usd: createdRun.fees.fba_fulfillment_fee_usd,
            inbound_config_fee_usd: createdRun.fees.inbound_config_fee_usd,
            storage_fee_usd: createdRun.fees.storage_fee_usd,
            total_fee_usd: createdRun.fees.total_fee_usd,
            platform_fee_usd: createdRun.fees.platform_fee_usd ?? 0,
            payout_usd: createdRun.profit.payout_usd,
            profit_usd: createdRun.profit.profit_usd,
            profit_rate: createdRun.profit.profit_rate,
            warnings: createdRun.warnings,
            delivery_fee_usd: toNumber(draft.delivery_fee_usd),
            inbound_config_fee_manual_usd: toNumber(draft.inbound_config_fee_usd),
            storage_fee_manual_usd: toNumber(draft.storage_fee_usd),
            vat_usd: createdRun.profit.vat_usd ?? 0,
            profit_after_vat_usd: createdRun.profit.profit_after_vat_usd ?? null,
            profit_after_vat_rate: createdRun.profit.profit_after_vat_rate ?? null,
          })
        } catch (snapshotErr) {
          console.warn('保存快照失败:', snapshotErr)
        }
      }
    } catch (calcErr) {
      setStoreRows((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          loading: false,
          error: calcErr instanceof Error ? calcErr.message : '店铺核算失败',
        },
      }))
    }
  }

  const hasCalculatedRows = filteredSkus.filter((i) => storeRows[i.id]?.result != null).length > 0
  const euOption = EU_COUNTRY_OPTIONS.find((o) => o.value === selectedCountry)
  const euCountryLabel = euOption?.label ?? selectedCountry
  const vatLabel = euOption?.vatLabel ?? ''

  return (
    <div className="space-y-3">
      {/* Snapshot loading error banner */}
      {snapshotError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-300 text-amber-900 font-bold">
            !
          </span>
          <span>{snapshotError}</span>
        </div>
      )}

      {/* Table Body */}
      <div>
        {storeSkusLoading ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : storeSkusError ? (
          <div className="m-4 flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-3 text-sm text-destructive">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-destructive/15 text-[10px] font-bold">
              !
            </span>
            {storeSkusError}
          </div>
        ) : !selectedProjectName ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]">
              <Package className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <p className="text-sm text-muted-foreground">请选择项目和站点以加载 SKU 数据</p>
          </div>
        ) : filteredSkus.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]">
              <Search className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <p className="text-sm text-muted-foreground">
              {skuKeyword
                ? `没有找到匹配的 SKU（${skuKeyword}）`
                : `该项目在 ${euCountryLabel} 下没有活跃 SKU`}
            </p>
            {skuKeyword && (
              <button
                onClick={() => onSkuKeywordChange('')}
                className="text-xs text-[hsl(var(--chart-3))] underline-offset-2 hover:underline"
              >
                清除搜索
              </button>
            )}
          </div>
        ) : (
          <ShopCalculationEuTable
            items={filteredSkus}
            rowStates={storeRows}
            onDraftChange={updateDraft}
            onCalculate={handleCalculate}
            systemExchangeRate={systemExchangeRate}
            selectedCountry={selectedCountry}
            isSnapshotMode={selectedSnapshotId !== null}
          />
        )}
      </div>
    </div>
  )
}
