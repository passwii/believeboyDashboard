/**
 * Shared types for the inventory-ledger page (BLF-428 前端重构).
 *
 * The page is built around the two raw ledger datasets — Summary (每日水位)
 * and Detail (事件明细) — plus month-level aggregates. Everything in the
 * overview section is derived client-side from the filtered raw rows
 * (see ledger-derive.ts), so the global filter bar is the single source
 * of truth for what the page shows.
 */

export type ProjectOption = { id: number; name: string }

// ── 全局筛选状态（唯一筛选真相源） ─────────────────────────────────────────────

/** 'all' 表示不过滤；其余为具体维度值。 */
export type LedgerFilters = {
  msku: string
  location: string
  disposition: string
  eventType: string
}

export const ALL = 'all'

export const DEFAULT_FILTERS: LedgerFilters = {
  msku: ALL,
  location: ALL,
  disposition: ALL,
  eventType: ALL,
}

// ── 事件类型中文标签（与后端 Event Type 枚举一一对应） ─────────────────────────

export const EVENT_TYPE_LABELS: Record<string, string> = {
  Receipts: '入库',
  Shipments: '出库',
  WhseTransfers: '调拨',
  CustomerReturns: '客户退货',
  VendorReturns: '供应商退货',
  Adjustments: '调整',
}

export function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType
}

export const DISPOSITION_LABELS: Record<string, string> = {
  SELLABLE: '可售',
  CUSTOMER_DAMAGED: '客户损坏',
  CARRIER_DAMAGED: '承运损坏',
  WAREHOUSE_DAMAGED: '仓库损坏',
}

export function dispositionLabel(disposition: string): string {
  return DISPOSITION_LABELS[disposition] ?? disposition
}

// ── Summary 视图（22 列日水位快照） ────────────────────────────────────────────

export type LedgerSummaryRow = {
  id: number
  date: string
  fnsku: string | null
  asin: string | null
  msku: string
  title: string | null
  disposition: string
  location: string
  starting_balance: number
  in_transit_between: number
  receipts: number
  customer_shipments: number
  customer_returns: number
  vendor_returns: number
  warehouse_transfer_io: number
  found: number
  lost: number
  damaged: number
  disposed: number
  other_events: number
  ending_balance: number
  unknown_events: number
  store: string | null
  batch_id: number | null
}

export type LedgerSummaryResponse = {
  report_month: string
  rows: LedgerSummaryRow[]
}

// ── Detail 视图（16 列事件行） ─────────────────────────────────────────────────

export type LedgerDetailRow = {
  id: number
  date: string
  fnsku: string | null
  asin: string | null
  msku: string
  title: string | null
  event_type: string
  reference_id: string | null
  quantity: number
  fulfillment_center: string
  disposition: string
  reason: string | null
  country: string | null
  reconciled_quantity: number | null
  unreconciled_quantity: number | null
  date_and_time: string | null
  store: string | null
  batch_id: number | null
}

export type LedgerDetailResponse = {
  report_month: string
  rows: LedgerDetailRow[]
}

// ── 月度聚合端点（snapshot / trend / consistency / batches） ───────────────────

export type SkuMonthEom = {
  msku: string
  title: string | null
  qty_eom: number
  sellable_qty: number
  damaged_qty: number
  prev_qty_eom: number | null
  change: number | null
}

export type DispositionSummary = {
  disposition: string
  qty_eom: number
  pct_of_total: number
}

export type IntegrityMismatch = {
  msku: string
  location: string
  disposition: string
  prev_ending: number
  curr_starting: number
  diff: number
}

export type IntegrityCheck = {
  report_month: string
  status: 'OK' | 'MISMATCH' | 'PENDING'
  mismatch_count: number
  mismatches: IntegrityMismatch[]
  checked_at: string
}

export type SnapshotResponse = {
  report_month: string
  sku_count: number
  total_qty: number
  disposition_summary: DispositionSummary[]
  skus: SkuMonthEom[]
  integrity: IntegrityCheck | null
}

export type TrendMonthItem = {
  report_month: string
  sku_count: number
  total_qty_eom: number
  total_receipts: number
  total_shipments: number
  total_returns: number
  total_damaged: number
  total_lost: number
  total_disposed: number
  damaged_pct: number
}

export type TrendResponse = {
  project_id: number
  months: TrendMonthItem[]
}

export type IngestBatchInfo = {
  id: number
  project_id: number
  report_month: string
  source_filename: string
  file_hash: string
  file_size_bytes: number
  file_kind: string
  loaded_by: string | null
  loaded_at: string
  completed_at: string | null
  status: string
  rows_parsed: number
  rows_written_summary: number
  rows_written_detail: number
  rows_skipped_duplicate: number
  rows_failed_validation: number
  error_message: string | null
  consistency_check: string | null
  consistency_mismatch_count: number
}

export type IngestBatchesResponse = {
  project_id: number
  batches: IngestBatchInfo[]
}

export type ConsistencyMismatch = {
  msku: string
  location: string
  disposition: string
  detail_quantity: number
  summary_delta: number
  diff: number
}

export type ConsistencyCheckResult = {
  report_month: string
  status: 'OK' | 'MISMATCH' | 'PENDING'
  mismatch_count: number
  mismatches: ConsistencyMismatch[]
  checked_at: string
}
