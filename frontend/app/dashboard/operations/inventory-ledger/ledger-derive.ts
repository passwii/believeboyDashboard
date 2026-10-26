/**
 * Pure derivation helpers for the inventory-ledger page (BLF-428 前端重构).
 *
 * Design rule (D6): the Summary + Detail raw row sets are the page's only
 * truth source. Every overview number/chart is derived here from the
 * FILTERED raw rows, so the global filter bar drives everything. Keeping
 * these functions pure makes them trivially unit-testable.
 */

import {
  ALL,
  type LedgerDetailRow,
  type LedgerFilters,
  type LedgerSummaryRow,
  type SkuMonthEom,
} from './ledger-types'

/** Format the API's month-start value (`2026-08-01`) for month selectors. */
export function formatLedgerMonthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value)
  if (!match) return value
  return `${match[1]} 年 ${Number(match[2])} 月`
}

// ── 过滤 ──────────────────────────────────────────────────────────────────────

export function summaryRowMatches(row: LedgerSummaryRow, f: LedgerFilters): boolean {
  if (f.msku !== ALL && row.msku !== f.msku) return false
  if (f.location !== ALL && row.location !== f.location) return false
  if (f.disposition !== ALL && row.disposition !== f.disposition) return false
  return true
}

export function detailRowMatches(row: LedgerDetailRow, f: LedgerFilters): boolean {
  if (f.msku !== ALL && row.msku !== f.msku) return false
  if (f.location !== ALL && row.fulfillment_center !== f.location) return false
  if (f.disposition !== ALL && row.disposition !== f.disposition) return false
  if (f.eventType !== ALL && row.event_type !== f.eventType) return false
  return true
}

export function filterSummaryRows(
  rows: LedgerSummaryRow[],
  f: LedgerFilters,
): LedgerSummaryRow[] {
  return rows.filter((r) => summaryRowMatches(r, f))
}

export function filterDetailRows(
  rows: LedgerDetailRow[],
  f: LedgerFilters,
): LedgerDetailRow[] {
  return rows.filter((r) => detailRowMatches(r, f))
}

// ── KPI ───────────────────────────────────────────────────────────────────────

export type LedgerKpis = {
  /** 筛选范围内期末总库存（每 msku×location×disposition 取末日 ending 求和） */
  endingTotal: number
  /** 其中非 SELLABLE 的期末库存 */
  damagedQty: number
  /** damagedQty / endingTotal（0 库存时为 0） */
  damagedPct: number
  /** 筛选范围内事件净变动 sum(quantity) */
  netChange: number
  /** 筛选范围内事件条数 */
  eventCount: number
}

/**
 * 期末口径：API 返回按 date desc 排序，对每个 (msku × location × disposition)
 * 分组取第一次出现的行（即该组合的最新水位），累加 ending_balance。
 */
export function latestEndingByGroup(
  rows: LedgerSummaryRow[],
): Map<string, LedgerSummaryRow> {
  const latest = new Map<string, LedgerSummaryRow>()
  for (const r of rows) {
    const key = `${r.msku}|${r.location}|${r.disposition}`
    if (!latest.has(key)) latest.set(key, r) // date desc → 首个即最新
  }
  return latest
}

export function computeKpis(
  summaryRows: LedgerSummaryRow[],
  detailRows: LedgerDetailRow[],
): LedgerKpis {
  let endingTotal = 0
  let damagedQty = 0
  for (const r of latestEndingByGroup(summaryRows).values()) {
    endingTotal += r.ending_balance
    if (r.disposition !== 'SELLABLE') damagedQty += r.ending_balance
  }
  const netChange = detailRows.reduce((s, r) => s + r.quantity, 0)
  return {
    endingTotal,
    damagedQty,
    damagedPct: endingTotal > 0 ? (damagedQty / endingTotal) * 100 : 0,
    netChange,
    eventCount: detailRows.length,
  }
}

export type OverviewKpis = LedgerKpis & {
  skuCount: number
  sellableQty: number
}

export function computeOverviewKpis(
  summaryRows: LedgerSummaryRow[],
  detailRows: LedgerDetailRow[],
): OverviewKpis {
  const base = computeKpis(summaryRows, detailRows)
  const skus = new Set<string>()
  let sellableQty = 0
  for (const r of latestEndingByGroup(summaryRows).values()) {
    skus.add(r.msku)
    if (r.disposition === 'SELLABLE') sellableQty += r.ending_balance
  }
  return { ...base, skuCount: skus.size, sellableQty }
}

export type SkuEndingSummary = {
  msku: string
  title: string | null
  endingQty: number
  sellableQty: number
  damagedQty: number
  damagedPct: number
}

export function skuEndingSummary(rows: LedgerSummaryRow[]): SkuEndingSummary[] {
  const bySku = new Map<string, SkuEndingSummary>()
  for (const row of latestEndingByGroup(rows).values()) {
    const current = bySku.get(row.msku) ?? {
      msku: row.msku,
      title: row.title,
      endingQty: 0,
      sellableQty: 0,
      damagedQty: 0,
      damagedPct: 0,
    }
    current.title ??= row.title
    current.endingQty += row.ending_balance
    if (row.disposition === 'SELLABLE') current.sellableQty += row.ending_balance
    else current.damagedQty += row.ending_balance
    bySku.set(row.msku, current)
  }
  return Array.from(bySku.values())
    .map((row) => ({
      ...row,
      damagedPct: row.endingQty > 0 ? (row.damagedQty / row.endingQty) * 100 : 0,
    }))
    .sort((a, b) => b.endingQty - a.endingQty || a.msku.localeCompare(b.msku))
}

export type SkuEventTotals = {
  msku: string
  title: string | null
  receipts: number
  customerShipments: number
  customerReturns: number
  vendorReturns: number
  warehouseTransfer: number
  found: number
  lost: number
  damaged: number
  disposed: number
  otherEvents: number
  netChange: number
}

export function skuEventTotals(rows: LedgerSummaryRow[]): SkuEventTotals[] {
  const bySku = new Map<string, SkuEventTotals>()
  for (const row of rows) {
    const current = bySku.get(row.msku) ?? {
      msku: row.msku,
      title: row.title,
      receipts: 0,
      customerShipments: 0,
      customerReturns: 0,
      vendorReturns: 0,
      warehouseTransfer: 0,
      found: 0,
      lost: 0,
      damaged: 0,
      disposed: 0,
      otherEvents: 0,
      netChange: 0,
    }
    current.title ??= row.title
    current.receipts += row.receipts
    current.customerShipments += row.customer_shipments
    current.customerReturns += row.customer_returns
    current.vendorReturns += row.vendor_returns
    current.warehouseTransfer += row.warehouse_transfer_io
    current.found += row.found
    current.lost += row.lost
    current.damaged += row.damaged
    current.disposed += row.disposed
    current.otherEvents += row.other_events
    bySku.set(row.msku, current)
  }
  return Array.from(bySku.values())
    .map((row) => ({
      ...row,
      netChange:
        row.receipts +
        row.customerShipments +
        row.customerReturns +
        row.vendorReturns +
        row.warehouseTransfer +
        row.found +
        row.lost +
        row.damaged +
        row.disposed +
        row.otherEvents,
    }))
    .sort((a, b) => a.msku.localeCompare(b.msku))
}

export type WarehouseDispositionSummary = {
  location: string
  disposition: string
  startingBalance: number
  endingBalance: number
  receipts: number
  customerShipments: number
  customerReturns: number
  vendorReturns: number
  warehouseTransfer: number
  damaged: number
  disposed: number
  otherEvents: number
}

export function warehouseDispositionSummary(
  rows: LedgerSummaryRow[],
): WarehouseDispositionSummary[] {
  const latestGroups = latestEndingByGroup(rows).values()
  const byKey = new Map<string, WarehouseDispositionSummary>()
  for (const row of latestGroups) {
    const key = `${row.location}|${row.disposition}`
    const current = byKey.get(key) ?? {
      location: row.location,
      disposition: row.disposition,
      startingBalance: 0,
      endingBalance: 0,
      receipts: 0,
      customerShipments: 0,
      customerReturns: 0,
      vendorReturns: 0,
      warehouseTransfer: 0,
      damaged: 0,
      disposed: 0,
      otherEvents: 0,
    }
    current.startingBalance += row.starting_balance
    current.endingBalance += row.ending_balance
    current.receipts += row.receipts
    current.customerShipments += row.customer_shipments
    current.customerReturns += row.customer_returns
    current.vendorReturns += row.vendor_returns
    current.warehouseTransfer += row.warehouse_transfer_io
    current.damaged += row.damaged
    current.disposed += row.disposed
    current.otherEvents += row.other_events
    byKey.set(key, current)
  }
  return Array.from(byKey.values()).sort(
    (a, b) =>
      a.location.localeCompare(b.location) ||
      a.disposition.localeCompare(b.disposition),
  )
}

export type DailyEventSummary = {
  date: string
  eventCount: number
  netQty: number
  quantities: Record<string, number>
}

export function dailyEventSummary(rows: LedgerDetailRow[]): DailyEventSummary[] {
  const byDate = new Map<string, DailyEventSummary>()
  for (const row of rows) {
    const current = byDate.get(row.date) ?? {
      date: row.date,
      eventCount: 0,
      netQty: 0,
      quantities: {},
    }
    current.eventCount += 1
    current.netQty += row.quantity
    current.quantities[row.event_type] =
      (current.quantities[row.event_type] ?? 0) + row.quantity
    byDate.set(row.date, current)
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 环比变动：来自 /snapshot 的 per-SKU change（月份级口径）。
 * SKU 筛选生效时只累加该 SKU；仓库/状态/事件筛选不参与环比
 * （snapshot 聚合没有这些维度，设计文档 §2.2 已注明）。
 * 全部 SKU 都无上月数据时返回 null。
 */
export function computeMomChange(
  skus: SkuMonthEom[],
  mskuFilter: string,
): number | null {
  const scoped = mskuFilter === ALL ? skus : skus.filter((s) => s.msku === mskuFilter)
  const withChange = scoped.filter((s) => s.change !== null)
  if (withChange.length === 0) return null
  return withChange.reduce((s, r) => s + (r.change ?? 0), 0)
}

// ── 图表派生 ──────────────────────────────────────────────────────────────────

export type EventTypeGroup = {
  event_type: string
  count: number
  net_qty: number
}

/** 按事件类型分组（count 降序）— 总览"事件构成"图。 */
export function groupDetailByEventType(rows: LedgerDetailRow[]): EventTypeGroup[] {
  const map = new Map<string, EventTypeGroup>()
  for (const r of rows) {
    const g = map.get(r.event_type) ?? { event_type: r.event_type, count: 0, net_qty: 0 }
    g.count += 1
    g.net_qty += r.quantity
    map.set(r.event_type, g)
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
}

export type DispositionSlice = {
  disposition: string
  qty: number
  pct: number
}

/** 期末 Disposition 构成 — 总览"可售 vs 损坏"。 */
export function dispositionBreakdown(rows: LedgerSummaryRow[]): DispositionSlice[] {
  const totals = new Map<string, number>()
  let grand = 0
  for (const r of latestEndingByGroup(rows).values()) {
    totals.set(r.disposition, (totals.get(r.disposition) ?? 0) + r.ending_balance)
    grand += r.ending_balance
  }
  return Array.from(totals.entries())
    .map(([disposition, qty]) => ({
      disposition,
      qty,
      pct: grand > 0 ? (qty / grand) * 100 : 0,
    }))
    .sort((a, b) => b.qty - a.qty)
}

export type LocationSlice = {
  location: string
  qty: number
}

/** 期末 Top 仓库分布 — 总览。 */
export function topLocations(rows: LedgerSummaryRow[], topN = 5): LocationSlice[] {
  const totals = new Map<string, number>()
  for (const r of latestEndingByGroup(rows).values()) {
    totals.set(r.location, (totals.get(r.location) ?? 0) + r.ending_balance)
  }
  return Array.from(totals.entries())
    .map(([location, qty]) => ({ location, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, topN)
}

// ── Summary tab 水位线序列 ────────────────────────────────────────────────────

export type WaterLevelDatum = { date: string } & Record<string, number | string>

/**
 * 每 SKU 的每日期末水位（跨 location/disposition 求和），透视成 recharts
 * 行数据：[{ date, 'SKU-A': 12, 'SKU-B': 5 }, ...]，日期升序。
 */
export function waterLevelSeries(rows: LedgerSummaryRow[]): {
  mskus: string[]
  data: WaterLevelDatum[]
} {
  // 每 (msku × date) 取最新一行的 ending（同组合同日理论上唯一，防御性取首行）
  const seen = new Set<string>()
  const perSkuDate = new Map<string, Map<string, number>>() // msku → date → ending
  for (const r of rows) {
    // rows date desc：同 msku+date 多 location/disposition 需要求和，不能跳过
    const dedupeKey = `${r.msku}|${r.location}|${r.disposition}|${r.date}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    let dates = perSkuDate.get(r.msku)
    if (!dates) {
      dates = new Map()
      perSkuDate.set(r.msku, dates)
    }
    dates.set(r.date, (dates.get(r.date) ?? 0) + r.ending_balance)
  }

  const dateSet = new Set<string>()
  for (const dates of perSkuDate.values()) {
    for (const d of dates.keys()) dateSet.add(d)
  }
  const sortedDates = Array.from(dateSet).sort()
  const mskus = Array.from(perSkuDate.keys()).sort()

  const data: WaterLevelDatum[] = sortedDates.map((date) => {
    const datum: WaterLevelDatum = { date }
    for (const msku of mskus) {
      const v = perSkuDate.get(msku)?.get(date)
      if (v !== undefined) datum[msku] = v
    }
    return datum
  })
  return { mskus, data }
}

