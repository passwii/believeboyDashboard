'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Package,
  Search,
} from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ShopCalculationTable } from '@/components/dashboard/pricing-calculation/shop-calculation-table'
import { logClientOperation } from '@/lib/operation-audit'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import type {
  PricingCalculationRunItem,
  ProductCostItem,
  ProductCostsResponse,
  ProjectManageOption,
  ShopCalculationItem,
} from '@/lib/pricing-calculation-types'
import {
  requestPricingCalculation,
  requestSaveShopCalculation,
  type ShopCalculationPayload,
} from '@/lib/pricing-calculation-api'
import { applyBorder, applyHeaderBorder } from '@/lib/excel-styles'

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

function toNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Convert a ShopCalculationItem (from DB) to a PricingCalculationRunItem
 * so it can be used as `result` in the table row state.
 */
function snapshotToResult(
  snapshot: ShopCalculationItem,
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

function buildSnapshotPayload(
  item: ProductCostItem,
  result: PricingCalculationRunItem,
  projectId: number,
): ShopCalculationPayload {
  return {
    project_id: projectId,
    project_name: item.project_name,
    sku: item.sku,
    asin: item.asin || null,
    country: item.country || null,
    accounting_type: 'profit_calc',
    package_length_cm: result.package_length_cm,
    package_width_cm: result.package_width_cm,
    package_height_cm: result.package_height_cm,
    weight_kg: result.weight_kg,
    fob_product_cost_rmb: result.fob_product_cost_rmb,
    first_leg_cost_rmb: result.first_leg_cost_rmb,
    ddp_cost_rmb: result.profit.ddp_cost_rmb,
    ddp_cost_usd: result.profit.ddp_cost_usd,
    sale_price_usd: result.sale_price_usd,
    advertising_rate: result.advertising_rate,
    return_loss_rate: result.return_loss_rate,
    storage_months: result.storage_months,
    inbound_placement_mode: result.inbound_placement_mode,
    usd_to_rmb_rate: result.usd_to_rmb_rate,
    usd_to_rmb_rate_source: result.usd_to_rmb_rate_source,
    size_tier: result.size_tier,
    size_tier_label: result.size_tier_label,
    price_band: result.price_band,
    price_band_label: result.price_band_label,
    longest_side_in: result.dimensions.longest_side_in,
    middle_side_in: result.dimensions.middle_side_in,
    shortest_side_in: result.dimensions.shortest_side_in,
    length_plus_girth_in: result.dimensions.length_plus_girth_in,
    volume_cubic_in: result.dimensions.volume_cubic_in,
    volume_cubic_ft: result.dimensions.volume_cubic_ft,
    product_weight_lb: result.weights.product_weight_lb,
    product_weight_oz: result.weights.product_weight_oz,
    dimensional_weight_lb: result.weights.dimensional_weight_lb,
    chargeable_weight_lb: result.weights.chargeable_weight_lb,
    chargeable_weight_oz: result.weights.chargeable_weight_oz,
    chargeable_weight_rule: result.weights.chargeable_weight_rule,
    fulfillment_fee_rule_label: result.fulfillment_fee_rule_label,
    inbound_config_fee_rule_label: result.inbound_config_fee_rule_label,
    storage_fee_rule_label: result.storage_fee_rule_label,
    referral_fee_usd: result.fees.referral_fee_usd,
    advertising_fee_usd: result.fees.advertising_fee_usd,
    return_loss_usd: result.fees.return_loss_usd,
    fba_fulfillment_fee_usd: result.fees.fba_fulfillment_fee_usd,
    inbound_config_fee_usd: result.fees.inbound_config_fee_usd,
    storage_fee_usd: result.fees.storage_fee_usd,
    total_fee_usd: result.fees.total_fee_usd,
    payout_usd: result.profit.payout_usd,
    profit_usd: result.profit.profit_usd,
    profit_rate: result.profit.profit_rate,
    warnings: result.warnings,
  }
}

interface ShopCalculationUsSectionProps {
  selectedCountry: string
  selectedProjectName: string
  selectedProjectId: number | null
  skuKeyword: string
  onProjectChange: (name: string) => void
  onSkuKeywordChange: (keyword: string) => void
  /** Sync storeRows back to parent for export (avoids stale snapshot data) */
  onStoreRowsChange: (rows: Record<number, StoreSkuRowState>) => void
}

export function ShopCalculationUsSection({
  selectedCountry,
  selectedProjectName,
  selectedProjectId,
  skuKeyword,
  onSkuKeywordChange,
  onStoreRowsChange,
}: ShopCalculationUsSectionProps) {
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
            `${API_BASE}/api/v1/sku-info?project_name=${encodeURIComponent(selectedProjectName)}&country=${encodeURIComponent(selectedCountry)}&is_active=true&page=1&page_size=200&include_total=true`,
            { cache: 'no-store' },
          ),
          fetch(`/api/exchange-rates?currency=USD&page=1&pageSize=1`, {
            cache: 'no-store' as RequestCache,
          }),
          // Load existing snapshots for this project + country
          fetch(
            `${API_BASE}/api/v1/shop-calculation?project_id=${selectedProjectId}&country=${encodeURIComponent(selectedCountry)}&page=1&page_size=200`,
            { cache: 'no-store' as RequestCache },
          ),
        ])
        if (!skuSearch.ok) throw new Error('SKU 列表加载失败')

        const skuPayload = (await skuSearch.json()) as ProductCostsResponse
        const exchangePayload = (await exchangeSearch.json()) as {
          data?: Array<{ rate: number }>
        }

        const rate =
          exchangePayload?.data?.[0]?.rate
            ? String(exchangePayload.data[0].rate)
            : ''
        setSystemExchangeRate(rate)

        const countrySkus = skuPayload.items.filter(
          (item) => item.country === selectedCountry && item.is_active,
        )
        setStoreSkus(countrySkus)

        // Parse existing snapshots from DB
        let snapshotPayload: { items?: ShopCalculationItem[]; total?: number } = { items: [] }
        if (snapshotSearch.ok) {
          snapshotPayload = await snapshotSearch.json() as { items?: ShopCalculationItem[]; total?: number }
        } else {
          // Log 422/500 snapshot errors so we know if API validation fails
          const body = await snapshotSearch.text().catch(() => '')
          console.error('[shop-calculation] 快照加载失败:', snapshotSearch.status, body)
          // Surface the error to the user so they know data may be missing
          setSnapshotError(`店铺历史加载失败（HTTP ${snapshotSearch.status}），价格信息可能无法显示`)
        }
        const snapshotMap = new Map<string, ShopCalculationItem>()
        for (const s of snapshotPayload.items ?? []) {
          snapshotMap.set(s.sku, s)
        }

        // Initialize row state: existing snapshots restore result + draft
        setStoreRows((_current) => {
          const next: Record<number, StoreSkuRowState> = {}
          countrySkus.forEach((item) => {
            const snapshot = snapshotMap.get(item.sku)

            if (snapshot) {
              // Restore from DB snapshot: pre-fill draft + result
              next[item.id] = {
                draft: {
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
                  sale_price_usd: String(snapshot.sale_price_usd ?? ''),
                  advertising_rate: String((snapshot.advertising_rate ?? 0.12) * 100),
                  return_loss_rate: String((snapshot.return_loss_rate ?? 0.04) * 100),
                  storage_months: String(snapshot.storage_months),
                  inbound_placement_mode: snapshot.inbound_placement_mode,
                  usd_to_rmb_rate: rate || String(snapshot.usd_to_rmb_rate),
                },
                loading: false,
                result: snapshotToResult(snapshot, item.project_name),
                error: null,
              }
            } else {
              // Brand new item (never calculated before)
              next[item.id] = {
                draft: {
                  package_length_cm:
                    item.package_length_cm > 0
                      ? String(item.package_length_cm)
                      : '',
                  package_width_cm:
                    item.package_width_cm > 0
                      ? String(item.package_width_cm)
                      : '',
                  package_height_cm:
                    item.package_height_cm > 0
                      ? String(item.package_height_cm)
                      : '',
                  weight_kg: item.weight_kg > 0 ? String(item.weight_kg) : '',
                  first_leg_cost_rmb:
                    item.first_leg_cost_rmb > 0
                      ? String(item.first_leg_cost_rmb)
                      : '5',
                  sale_price_usd: '',
                  advertising_rate: '12',
                  return_loss_rate: '4',
                  storage_months: '1',
                  inbound_placement_mode: 'single_destination',
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

        if (snapshotSearch.ok && snapshotSearch.status !== 200) {
          console.warn('快照加载失败:', snapshotSearch.status)
        }
      } catch (err) {
        setStoreSkusError(
          err instanceof Error ? err.message : 'SKU 列表加载失败',
        )
        setStoreSkus([])
      } finally {
        setStoreSkusLoading(false)
      }
    }
    void loadSkusAndSnapshots()
  }, [selectedProjectName, selectedProjectId, selectedCountry])

    const filteredSkus = useMemo(() => {
    if (!skuKeyword.trim()) return storeSkus
    const kw = skuKeyword.trim().toLowerCase()
    return storeSkus.filter(
      (item) =>
        item.sku.toLowerCase().includes(kw) ||
        item.asin.toLowerCase().includes(kw),
    )
  }, [skuKeyword, storeSkus])

  // Sync storeRows to parent whenever it changes (so export gets latest data)
  useEffect(() => {
    onStoreRowsChange(storeRows)
  }, [storeRows, onStoreRowsChange])

  function updateDraft(
    rowId: number,
    key: keyof StoreSkuDraft,
    value: string,
  ) {
    setStoreRows((current) => {
      const row = current[rowId]
      if (!row) return current
      return {
        ...current,
        [rowId]: { ...row, draft: { ...row.draft, [key]: value } },
      }
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
      const createdRun = await requestPricingCalculation({
        calculationMode: 'profit-calc',
        country: item.country,
        product_name: `${item.project_name} / ${item.sku}`,
        package_length_cm: toNumber(draft.package_length_cm),
        package_width_cm: toNumber(draft.package_width_cm),
        package_height_cm: toNumber(draft.package_height_cm),
        weight_kg: toNumber(draft.weight_kg),
        fob_product_cost_rmb: item.fob_unit_cost,
        first_leg_cost_rmb: toNumber(draft.first_leg_cost_rmb),
        sale_price_usd: toNumber(draft.sale_price_usd),
        target_profit_rate: 0,
        commission_rate: 0.15,
        advertising_rate: toNumber(draft.advertising_rate) / 100,
        return_loss_rate: toNumber(draft.return_loss_rate) / 100,
        storage_months: toNumber(draft.storage_months),
        inbound_placement_mode: draft.inbound_placement_mode,
        project_id: selectedProjectId ?? undefined,
        sku: item.sku,
        use_historical_shipping_cost: true,
        usd_to_rmb_rate: draft.usd_to_rmb_rate.trim()
          ? toNumber(draft.usd_to_rmb_rate)
          : undefined,
      })

      setStoreRows((current) => ({
        ...current,
        [item.id]: { ...current[item.id], loading: false, result: createdRun },
      }))

      if (selectedProjectId) {
        try {
          const snapshotPayload = buildSnapshotPayload(item, createdRun, selectedProjectId)
          await requestSaveShopCalculation(snapshotPayload)
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
      const worksheet = workbook.addWorksheet('美国店铺SKU核算')
      worksheet.views = [{ showGridLines: false }]

      // ── Title row (row 1, spans all 27 columns) ──────────────────────────────
      worksheet.mergeCells(1, 1, 1, 27)
      const titleCell = worksheet.getCell(1, 1)
      titleCell.value = `美国店铺SKU核算表 - ${selectedProjectName}`
      titleCell.font = { name: 'Microsoft YaHei', size: 14, bold: true }
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
      worksheet.getRow(1).height = 24

      // ── Group header rows (rows 2-3, one per group) ──────────────────────────
      // Group structure: [name, startCol, endCol, headerDarkArgb, headerSubArgb]
      const groups = [
        { name: '店铺产品',       start: 1,  end: 1,  dark: 'FF312E81', sub: 'FFE0E7FF' },
        { name: '货品数据',       start: 2,  end: 7,  dark: 'FF0C4A6E', sub: 'FFE0F2FE' },
        { name: 'DDP成本',        start: 8,  end: 11, dark: 'FF78350F', sub: 'FFFEF3C7' },
        { name: '费用支出',       start: 12, end: 21, dark: 'FF881337', sub: 'FFFFE4E6' },
        { name: '利润核算',       start: 22, end: 25, dark: 'FF064E3B', sub: 'FFD1FAE5' },
        { name: '产品核定',       start: 26, end: 27, dark: 'FF4C1D95', sub: 'FFEDE9FE' },
      ]

      // Row 2: group header labels with dark background + white bold text
      const groupHeaderRow = worksheet.addRow(groups.map(() => null))
      groupHeaderRow.height = 20
      groups.forEach((g) => {
        const cell = groupHeaderRow.getCell(g.start)
        cell.value = g.name
        cell.font = { name: 'Microsoft YaHei', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.dark } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        applyHeaderBorder(cell)
        // Merge across group columns
        if (g.end > g.start) {
          worksheet.mergeCells(2, g.start, 2, g.end)
        }
      })

      // Row 3: column headers
      const headers = [
        'SKU', 'FOB(RMB)', '长', '宽', '高', '重量(kg)', '计费重',
        '头程(RMB)', 'DDP(RMB)', 'DDP(USD)', '汇率',
        '售价(USD)', '广告费率%', '广告费', '退货折损率%', '退货损耗',
        '佣金', '派送费', '配置费', '仓储月数', '仓储费',
        '费用合计', '回款', '利润', '利润率',
        '尺寸等级', '售价带', '规则',
      ]
      const headerRow = worksheet.addRow(headers)
      headerRow.height = 20
      headerRow.font = { name: 'Microsoft YaHei', size: 9, bold: true }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      // Assign sub-background per group (matches ShopCalculationTable)
      headerRow.eachCell({ includeEmpty: true }, (cell) => {
        const colLetter = cell.address.replace(/\d+$/, '')
        const colNum = colLetter.charCodeAt(0) - 64
        const group = groups.find((g) => colNum >= g.start && colNum <= g.end)
        if (group) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: group.sub } }
        }
        applyHeaderBorder(cell)
      })

      // ── Column-level alignment ───────────────────────────────────────────────
      const LEFT_COLS = new Set([1, 27])           // SKU, 规则
      const CENTER_COLS = new Set([22, 23, 24, 25]) // size_tier, price_band
      const RIGHT_COLS = new Set(
        Array.from({ length: 27 }, (_, i) => i + 1).filter(
          (c) => !LEFT_COLS.has(c) && !CENTER_COLS.has(c),
        ),
      )

      // ── Data rows (row 4+) ───────────────────────────────────────────────────
      // Map each item to a 27-element array matching the header order
      const dataRows = itemsWithResults.map((item, idx) => {
        const result = storeRows[item.id]!.result!
        const draft = storeRows[item.id]!.draft
        const adRate = toNumber(draft.advertising_rate)
        const returnLossRate = toNumber(draft.return_loss_rate)
        const storageMonths = toNumber(draft.storage_months)
        const chargeableWeight = Math.max(
          item.weight_kg,
          (item.package_length_cm * item.package_width_cm * item.package_height_cm) / 6000,
        )
        const profit = result.profit.profit_usd
        const profitRate = result.profit.profit_rate

        return [
          item.sku,
          item.fob_unit_cost,
          item.package_length_cm,
          item.package_width_cm,
          item.package_height_cm,
          item.weight_kg,
          chargeableWeight,
          toNumber(draft.first_leg_cost_rmb),
          result.profit.ddp_cost_rmb,
          result.profit.ddp_cost_usd,
          result.usd_to_rmb_rate,
          result.sale_price_usd,
          adRate,
          result.fees.advertising_fee_usd,
          returnLossRate,
          result.fees.return_loss_usd,
          result.fees.referral_fee_usd,
          result.fees.fba_fulfillment_fee_usd,
          result.fees.inbound_config_fee_usd,
          storageMonths,
          result.fees.storage_fee_usd,
          result.fees.total_fee_usd,
          result.profit.payout_usd,
          profit,
          profitRate,
          result.size_tier_label,
          result.price_band_label,
          `${result.fulfillment_fee_rule_label} / ${result.inbound_config_fee_rule_label} / ${result.storage_fee_rule_label}`,
        ]
      })

      // Add rows and apply alternating fill + profit color-coding
      dataRows.forEach((rowData, idx) => {
        const row = worksheet.addRow(rowData)
        row.height = 20
        const isOdd = idx % 2 === 0       // 0-based: odd-index rows = light gray
        const oddBg = 'FFF8FAFC'
        const evenBg = 'FFFFFFFF'

        row.eachCell({ includeEmpty: true }, (cell) => {
          const colLetter = cell.address.replace(/\d+$/, '')
          const colNum = colLetter.charCodeAt(0) - 64
          const val = rowData[colNum - 1]
          const num = Number(val)

          // Background
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isOdd ? oddBg : evenBg } }
          cell.font = { name: 'Microsoft YaHei', size: 9 }
          applyBorder(cell)

          cell.alignment = { horizontal: 'center', vertical: 'middle' }

          // Number format
          if (Number.isFinite(num)) {
            cell.numFmt = '#,##0.####'
          }

          // Profit / profit rate color: green >= 0, red < 0
          if (colNum === 24 || colNum === 25) {
            // col 24 = 利润 (index 23), col 25 = 利润率 (index 24)
            if (colNum === 25) {
              // 利润率：显示为百分比
              cell.numFmt = '0.00%'
            }
            if (num >= 0) {
              cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF16A34A' } }
            } else {
              cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FFDC2626' } }
            }
          }
        })
      })

      // ── Auto-fit column widths via openpyxl column_dimensions ─────────────────
      const colWidths: number[] = Array.from({ length: 27 }, () => 0)

      const measureText = (text: string, size = 9): number => {
        const chars = String(text ?? '').length
        return Math.max(chars * size * 0.6 + size * 0.2, size)
      }

      worksheet.eachRow({ includeEmpty: true }, (excelRow) => {
        excelRow.eachCell({ includeEmpty: true }, (cell) => {
          const colLetter = cell.address.replace(/\d+$/, '')
          const colNum = colLetter.charCodeAt(0) - 64
          if (colNum >= 1 && colNum <= 27) {
            const w = measureText(String(cell.value ?? ''))
            if (w > colWidths[colNum - 1]) colWidths[colNum - 1] = w
          }
        })
      })
      for (let i = 0; i < 27; i++) {
        worksheet.getColumn(i + 1).width = Math.max(colWidths[i] * 0.12, 4)
      }

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `美国店铺SKU核算-${selectedProjectName}-${formatLocalTimestampForFilename()}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

      await logClientOperation({
        action: 'pricing_calculation.us_store_table.export',
        targetType: 'store_sku_pricing_snapshot',
        targetId: selectedProjectId ?? undefined,
        after: { project_id: selectedProjectId, project_name: selectedProjectName, row_count: itemsWithResults.length },
      })
    } catch (err) {
      notify({ type: 'error', title: '导出失败', message: err instanceof Error ? err.message : '导出失败' })
    } finally {
      setExporting(false)
    }
  }

  const hasCalculatedRows = filteredSkus.filter((i) => storeRows[i.id]?.result != null).length > 0

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
          <div className='flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-3 text-sm text-destructive'>
            <span className='flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-destructive/15 text-[10px] font-bold'>!</span>
            {storeSkusError}
          </div>
        ) : !selectedProjectName ? (
          <div className='flex flex-col items-center justify-center gap-2 py-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]'>
              <Package className='h-5 w-5 text-muted-foreground/40' />
            </div>
            <p className='text-sm text-muted-foreground'>请选择项目以加载 SKU 数据</p>
          </div>
        ) : filteredSkus.length === 0 ? (
          <div className='flex flex-col items-center justify-center gap-2 py-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]'>
              <Search className='h-5 w-5 text-muted-foreground/40' />
            </div>
            <p className='text-sm text-muted-foreground'>
              {skuKeyword
                ? `没有找到匹配的 SKU（${skuKeyword}）`
                : `该项目在美国站下没有活跃 SKU`}
            </p>
            {skuKeyword && (
              <button
                onClick={() => onSkuKeywordChange('')}
                className='text-xs text-[hsl(var(--primary))] underline-offset-2 hover:underline'
              >
                清除搜索
              </button>
            )}
          </div>
        ) : (
          <ShopCalculationTable
            items={filteredSkus}
            rowStates={storeRows}
            onDraftChange={updateDraft}
            onCalculate={handleCalculate}
            systemExchangeRate={systemExchangeRate}
          />
        )}
      </div>
    </div>
  )
}
