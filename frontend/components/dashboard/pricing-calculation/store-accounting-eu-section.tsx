'use client'

import { useEffect, useMemo, useState } from 'react'
import { Package, Search } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { StoreAccountingEuTable } from '@/components/dashboard/pricing-calculation/store-accounting-eu-table'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { logClientOperation } from '@/lib/operation-audit'
import { useNotifications } from '@/components/notifications'
import { applyBorder, applyHeaderBorder } from '@/lib/excel-styles'
import type {
  PricingCalculationRunItem,
  ProductCostItem,
  ProductCostsResponse,
  ProjectManageOption,
  StoreAccountingItem,
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
    const errorPayload = (await response.json().catch(() => ({ detail: '测算请求失败' }))) as { detail?: string; message?: string }
    throw new Error(errorPayload.detail || errorPayload.message || '定价测算失败')
  }
  return response.json() as Promise<PricingCalculationRunItem>
}

async function requestSaveSnapshot(payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${API_BASE}/api/v1/store-accounting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ detail: '保存快照失败' }))) as { detail?: string; message?: string }
    throw new Error(errorPayload.detail || errorPayload.message || '保存快照失败')
  }
  return response.json()
}

/** Convert a StoreAccountingItem (from DB) to a PricingCalculationRunItem */
function snapshotToResult(
  snapshot: StoreAccountingItem,
  projectName: string,
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
    profit: snapshot.profit,
    warnings: snapshot.warnings,
    created_by: snapshot.created_by,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
  }
}

interface StoreAccountingEuSectionProps {
  selectedCountry: string
  projects: ProjectManageOption[]
  projectsLoading: boolean
  selectedProjectName: string
  selectedProjectId: number | null
  skuKeyword: string
  onProjectChange: (name: string) => void
  onSkuKeywordChange: (keyword: string) => void
}

export function StoreAccountingEuSection({
  selectedCountry,
  projects,
  projectsLoading,
  selectedProjectName,
  selectedProjectId,
  skuKeyword,
  onSkuKeywordChange,
}: StoreAccountingEuSectionProps) {
  const { notify } = useNotifications()
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [storeSkusLoading, setStoreSkusLoading] = useState(false)
  const [storeSkusError, setStoreSkusError] = useState<string | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [storeRows, setStoreRows] = useState<Record<number, StoreSkuRowState>>({})
  const [systemExchangeRate, setSystemExchangeRate] = useState<string>('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    setStoreRows({})
  }, [selectedProjectName, selectedCountry])

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
        const [skuSearch, exchangeSearch, snapshotSearch] = await Promise.all([
          fetch(
            `${API_BASE}/api/v1/sku-info?project_name=${encodeURIComponent(selectedProjectName)}&country=${selectedCountry}&is_active=true&page=1&page_size=200&include_total=true`,
            { cache: 'no-store' },
          ),
          fetch(`/api/exchange-rates?currency=${selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'}&page=1&pageSize=1`, { cache: 'no-store' }),
          // Load existing EU snapshots
          fetch(
            `${API_BASE}/api/v1/store-accounting?project_id=${selectedProjectId}&country=${selectedCountry}&page=1&page_size=200`,
            { cache: 'no-store' },
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
          (item) => item.country === selectedCountry && item.is_active,
        )
        setStoreSkus(euSkus)

        // Parse existing snapshots
        let snapshotPayload: { items?: StoreAccountingItem[]; total?: number } = { items: [] }
        if (snapshotSearch.ok) {
          snapshotPayload = await snapshotSearch.json() as { items?: StoreAccountingItem[]; total?: number }
        } else {
          const body = await snapshotSearch.text().catch(() => '')
          console.error('[eu-store-accounting] 快照加载失败:', snapshotSearch.status, body)
          setSnapshotError(`店铺历史加载失败（HTTP ${snapshotSearch.status}），价格信息可能无法显示`)
        }
        const snapshotMap = new Map<string, StoreAccountingItem>()
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
                  advertising_rate: String((snapshot.advertising_rate) * 100),
                  return_loss_rate: String((snapshot.return_loss_rate) * 100),
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
                  package_width_cm:
                    item.package_width_cm > 0 ? String(item.package_width_cm) : '',
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
  }, [selectedProjectName, selectedCountry, selectedProjectId])

  const filteredSkus = useMemo(() => {
    if (!skuKeyword.trim()) return storeSkus
    const kw = skuKeyword.trim().toLowerCase()
    return storeSkus.filter(
      (item) =>
        item.sku.toLowerCase().includes(kw) ||
        item.asin.toLowerCase().includes(kw),
    )
  }, [skuKeyword, storeSkus])

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

  async function handleExport() {
    const itemsWithResults = filteredSkus.filter((i) => storeRows[i.id]?.result != null)
    if (itemsWithResults.length === 0) {
      notify({ type: 'error', title: '没有可导出的数据' })
      return
    }
    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('欧洲店铺SKU核算')
      worksheet.views = [{ showGridLines: false }]
      const countryLabel = EU_COUNTRY_OPTIONS.find((o) => o.value === selectedCountry)?.label ?? selectedCountry
      const ddpCurrency = selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'
      const saleCurrency = ddpCurrency

      worksheet.mergeCells(1, 1, 1, 25)
      const titleCell = worksheet.getCell(1, 1)
      titleCell.value = `欧洲店铺SKU核算表 - ${selectedProjectName} - ${countryLabel}`
      titleCell.font = { name: 'Microsoft YaHei', size: 14, bold: true }
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      // Group header row — mirrors US section group header style
      // Groups: 店铺产品(1), 货品数据(7), DDP成本(4), 费用支出(7), 利润核算(4) = cols 1-22
      // But table has 24 cols, so: 店铺产品(1), 货品数据(7), DDP成本(4), 费用支出(7), 利润核算(4) = 23, plus 操作(2)
      // From spec: cols 1, 2-8, 9-12, 13-19, 20-23 (店铺产品, 货品数据, DDP成本, 费用支出, 利润核算)
      // Total data cols: 1+7+4+7+4 = 23; we have 24 headers so we span 操作(2) separately
      const groupHeaderRow = worksheet.addRow([''])
      groupHeaderRow.values = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']

      const groupDefs: Array<{ label: string; color: string; colStart: number; colEnd: number }> = [
        { label: '店铺产品',  color: 'FF312E81', colStart: 1,  colEnd: 1  },
        { label: '货品数据',  color: 'FF0C4A6E', colStart: 2,  colEnd: 8  },
        { label: 'DDP成本',  color: 'FF78350F', colStart: 9,  colEnd: 12 },
        { label: '费用支出',  color: 'FF881337', colStart: 13, colEnd: 20 },
        { label: '利润核算',  color: 'FF064E3B', colStart: 21, colEnd: 24 },
      ]

      for (const g of groupDefs) {
        worksheet.mergeCells(groupHeaderRow.number, g.colStart, groupHeaderRow.number, g.colEnd)
        const cell = worksheet.getCell(groupHeaderRow.number, g.colStart)
        cell.value = g.label
        cell.font = { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.color } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        applyHeaderBorder(cell)
      }

      const headers = [
        'SKU', '项目', 'FOB(RMB)', '长', '宽', '高', '重量(kg)', '计费重',
        '头程(RMB)', 'DDP(RMB)', `DDP(${ddpCurrency})`, '汇率',
        `售价(${saleCurrency})`, '广告费率%', '广告费', '退货损耗',
        '派送费', '配置费', '仓储费', '费用合计',
        '回款', '增值税', '利润(扣税后)', '利润率(扣税)',
      ]
      const headerRow = worksheet.addRow(headers)
      headerRow.font = { name: 'Microsoft YaHei', bold: true }
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCBD5E1' } }
      headerRow.eachCell((cell) => { applyHeaderBorder(cell) })

      itemsWithResults.forEach((item, rowIdx) => {
        const result = storeRows[item.id]!.result!
        const profitVal = result.profit.profit_after_vat_usd ?? result.profit.profit_usd
        const row = worksheet.addRow([
          item.sku, item.project_name, item.fob_unit_cost,
          toNumber(item.package_length_cm), toNumber(item.package_width_cm),
          toNumber(item.package_height_cm), item.weight_kg,
          Math.max(item.weight_kg, (toNumber(item.package_length_cm) * toNumber(item.package_width_cm) * toNumber(item.package_height_cm)) / 6000),
          toNumber(storeRows[item.id]!.draft.first_leg_cost_rmb),
          result.profit.ddp_cost_rmb, result.profit.ddp_cost_usd, result.usd_to_rmb_rate,
          result.sale_price_usd,
          toNumber(storeRows[item.id]!.draft.advertising_rate),
          result.fees.advertising_fee_usd, result.fees.return_loss_usd,
          toNumber(storeRows[item.id]!.draft.delivery_fee_usd),
          toNumber(storeRows[item.id]!.draft.inbound_config_fee_usd),
          toNumber(storeRows[item.id]!.draft.storage_fee_usd),
          result.fees.total_fee_usd,
          result.profit.payout_usd,
          result.profit.vat_usd ?? 0,
          profitVal,
          result.profit.profit_after_vat_rate ?? result.profit.profit_rate,
        ])
        row.font = { name: 'Microsoft YaHei' }
        // Alternating row colors
        const bgColor = rowIdx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
        for (let c = 1; c <= 25; c++) {
          const cell = worksheet.getCell(row.number, c)
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
          cell.alignment = { horizontal: 'center', vertical: 'middle' }
          applyBorder(cell)
        }
        // Color-code profit amount column (col 22): green if >=0, red if <0
        const profitCell = worksheet.getCell(row.number, 22)
        if (profitVal != null && !Number.isNaN(profitVal)) {
          if (profitVal >= 0) {
            profitCell.font = { name: 'Microsoft YaHei', color: { argb: 'FF059669' } }
          } else {
            profitCell.font = { name: 'Microsoft YaHei', color: { argb: 'FFE11D48' } }
          }
        }
        // Format profit rate column (col 23) as percentage
        const profitRateCell = worksheet.getCell(row.number, 23)
        const profitRateVal = result.profit.profit_after_vat_rate ?? result.profit.profit_rate
        if (profitRateVal != null && !Number.isNaN(profitRateVal)) {
          profitRateCell.numFmt = '0.00%'
          if (profitRateVal >= 0) {
            profitRateCell.font = { name: 'Microsoft YaHei', color: { argb: 'FF059669' } }
          } else {
            profitRateCell.font = { name: 'Microsoft YaHei', color: { argb: 'FFE11D48' } }
          }
        }
      })

      // Auto-fit column widths via openpyxl column_dimensions
      const colWidths: number[] = Array.from({ length: 25 }, () => 0)
      const measureText = (text: string, size = 9): number => {
        const chars = String(text ?? '').length
        return Math.max(chars * size * 0.6 + size * 0.2, size)
      }
      worksheet.eachRow({ includeEmpty: true }, (excelRow) => {
        excelRow.eachCell({ includeEmpty: true }, (cell) => {
          const colNum = cell.address.replace(/[A-Z]+/, '').split('').reduce((acc, c) => {
            return acc + (c.charCodeAt(0) - 48) * Math.pow(10, cell.address.indexOf(c))
          }, 0)
          const colLetter = cell.address.replace(/\d+$/, '')
          const n = colLetter.charCodeAt(0) - 64
          if (n >= 1 && n <= 25) {
            const w = measureText(String(cell.value ?? ''))
            if (w > colWidths[n - 1]) colWidths[n - 1] = w
          }
        })
      })
      for (let i = 0; i < 25; i++) {
        worksheet.getColumn(i + 1).width = Math.max(colWidths[i] * 0.12, 4)
      }

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `欧洲店铺SKU核算-${selectedProjectName}-${formatLocalTimestampForFilename()}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

      await logClientOperation({
        action: 'pricing_calculation.eu_store_table.export',
        targetType: 'store_sku_pricing_snapshot',
        targetId: selectedProjectId ?? undefined,
        after: { project_id: selectedProjectId, project_name: selectedProjectName, country: selectedCountry, row_count: itemsWithResults.length },
      })
    } catch (err) {
      notify({ type: 'error', title: '导出失败', message: err instanceof Error ? err.message : '导出失败' })
    } finally {
      setExporting(false)
    }
  }

  const hasCalculatedRows = filteredSkus.filter((i) => storeRows[i.id]?.result != null).length > 0
  const euOption = EU_COUNTRY_OPTIONS.find((o) => o.value === selectedCountry)
  const euCountryLabel = euOption?.label ?? selectedCountry
  const vatLabel = euOption?.vatLabel ?? ''

  return (
    <div className='space-y-3'>
      {/* Snapshot loading error banner */}
      {snapshotError && (
        <div className='flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300'>
          <span className='flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-300 text-amber-900 font-bold'>!</span>
          <span>{snapshotError}</span>
        </div>
      )}

      {/* Table Body */}
      <div>
        {storeSkusLoading ? (
            <div className='flex h-48 flex-col items-center justify-center gap-3 p-4'>
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : storeSkusError ? (
            <div className='m-4 flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-3 text-sm text-destructive'>
              <span className='flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-destructive/15 text-[10px] font-bold'>!</span>
              {storeSkusError}
            </div>
          ) : !selectedProjectName ? (
            <div className='flex h-48 flex-col items-center justify-center gap-2 text-center'>
              <div className='flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]'>
                <Package className='h-5 w-5 text-muted-foreground/40' />
              </div>
              <p className='text-sm text-muted-foreground'>请选择项目和站点以加载 SKU 数据</p>
            </div>
          ) : filteredSkus.length === 0 ? (
            <div className='flex h-48 flex-col items-center justify-center gap-2 text-center'>
              <div className='flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]'>
                <Search className='h-5 w-5 text-muted-foreground/40' />
              </div>
              <p className='text-sm text-muted-foreground'>
                {skuKeyword
                  ? `没有找到匹配的 SKU（${skuKeyword}）`
                  : `该项目在 ${euCountryLabel} 下没有活跃 SKU`}
              </p>
              {skuKeyword && (
                <button
                  onClick={() => onSkuKeywordChange('')}
                  className='text-xs text-[hsl(var(--chart-3))] underline-offset-2 hover:underline'
                >
                  清除搜索
                </button>
              )}
            </div>
          ) : (
            <StoreAccountingEuTable
              items={filteredSkus}
              rowStates={storeRows}
              onDraftChange={updateDraft}
              onCalculate={handleCalculate}
              systemExchangeRate={systemExchangeRate}
              selectedCountry={selectedCountry}
            />
          )}
      </div>
    </div>
  )
}
