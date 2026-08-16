//! 运营 → 库存分类账（P5-2，BLF-720）
//!
//! 对齐 backend `backend/app/schemas/inventory_ledger.py`（fastapi schema，
//! 字段 snake_case 1:1；带默认值的字段一律 `#[serde(default)]` 容忍缺省）与
//! frontend `app/dashboard/operations/inventory-ledger/ledger-types.ts`。
//!
//! 端点（见 `backend/app/api/v1/endpoints/inventory_ledger.py`，
//! 前缀 `/api/v1/inventory-ledger`）：
//! - `GET /months?project_id` → [`LedgerMonthsResponse`]
//! - `GET /snapshot?project_id&period` → [`LedgerSnapshotResponse`]
//! - `GET /trend?project_id&months` → [`LedgerTrendResponse`]
//! - `GET /summary?project_id&period` → [`LedgerSummaryResponse`]
//! - `GET /detail?project_id&period` → [`LedgerDetailResponse`]
//! - `GET /batches?project_id` → [`LedgerIngestBatchesResponse`]
//! - `GET /consistency?project_id&period` → [`LedgerConsistencyResult`]
//!
//! 页面数据流（对齐 web 设计决策 D6）：Summary + Detail 两个原始数据集是
//! 唯一真相源，总览 KPI / 构成全部由视图层从筛选后的原始行客户端派生；
//! snapshot（环比口径）/ trend（月份趋势）/ consistency（双表对账）为补充数据。
//!
//! datetime 字段（`checked_at` / `loaded_at` / `date_and_time` 等）一律用
//! `String`：后端可能带时区偏移（`+00:00`），`NaiveDateTime` 反序列化会失败，
//! 且页面只做展示（截断到分钟），与 web 端 `loaded_at.slice(0, 16)` 口径一致。

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 枚举中文标签（对齐 frontend `EVENT_TYPE_LABELS` / `DISPOSITION_LABELS`）
// ---------------------------------------------------------------------------

/// 事件类型中文标签（与后端 Event Type 枚举一一对应；未知值原样返回）
pub fn event_type_label(event_type: &str) -> String {
    match event_type {
        "Receipts" => "入库".to_string(),
        "Shipments" => "出库".to_string(),
        "WhseTransfers" => "调拨".to_string(),
        "CustomerReturns" => "客户退货".to_string(),
        "VendorReturns" => "供应商退货".to_string(),
        "Adjustments" => "调整".to_string(),
        _ => event_type.to_string(),
    }
}

/// Disposition 中文标签（亚马逊枚举刻意不翻译的其余值原样返回）
pub fn disposition_label(disposition: &str) -> String {
    match disposition {
        "SELLABLE" => "可售".to_string(),
        "CUSTOMER_DAMAGED" => "客户损坏".to_string(),
        "CARRIER_DAMAGED" => "承运损坏".to_string(),
        "WAREHOUSE_DAMAGED" => "仓库损坏".to_string(),
        _ => disposition.to_string(),
    }
}

// ---------------------------------------------------------------------------
// /months
// ---------------------------------------------------------------------------

/// 可用月份列表（对齐 `MonthsResponse`；`months` 为每月 1 号的日期，
/// 直接作为其余端点的 `period` 参数）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerMonthsResponse {
    pub project_id: i64,
    #[serde(default)]
    pub months: Vec<NaiveDate>,
}

// ---------------------------------------------------------------------------
// /snapshot
// ---------------------------------------------------------------------------

/// 单 SKU 期末库存（对齐 `SkuMonthEom`；`change` = 较上月期末变动，
/// 无上月数据时为 `None`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerSkuMonthEom {
    pub msku: String,
    #[serde(default)]
    pub title: Option<String>,
    pub qty_eom: i64,
    #[serde(default)]
    pub sellable_qty: i64,
    #[serde(default)]
    pub damaged_qty: i64,
    #[serde(default)]
    pub prev_qty_eom: Option<i64>,
    #[serde(default)]
    pub change: Option<i64>,
}

/// Disposition 构成行（对齐 `DispositionSummary`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerDispositionSummary {
    pub disposition: String,
    pub qty_eom: i64,
    pub pct_of_total: f64,
}

/// 跨月连续性单条不一致（对齐 `IntegrityMismatch`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerIntegrityMismatch {
    pub msku: String,
    pub location: String,
    pub disposition: String,
    pub prev_ending: i64,
    pub curr_starting: i64,
    pub diff: i64,
}

/// 跨月连续性校验结果（对齐 `IntegrityCheckResult`；
/// status = `OK` / `MISMATCH` / `PENDING`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerIntegrityCheck {
    pub report_month: NaiveDate,
    pub status: String,
    pub mismatch_count: i64,
    #[serde(default)]
    pub mismatches: Vec<LedgerIntegrityMismatch>,
    pub checked_at: String,
}

/// 月度快照响应（对齐 `MonthlySnapshotResponse`；`integrity` 在无上月数据
/// 或非整月口径时为 `None`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerSnapshotResponse {
    pub report_month: NaiveDate,
    pub sku_count: i64,
    pub total_qty: i64,
    #[serde(default)]
    pub disposition_summary: Vec<LedgerDispositionSummary>,
    #[serde(default)]
    pub skus: Vec<LedgerSkuMonthEom>,
    #[serde(default)]
    pub integrity: Option<LedgerIntegrityCheck>,
}

// ---------------------------------------------------------------------------
// /trend
// ---------------------------------------------------------------------------

/// 单月聚合指标（对齐 `TrendMonthItem`；`report_month` 为 `YYYY-MM` 字符串）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerTrendMonthItem {
    pub report_month: String,
    #[serde(default)]
    pub sku_count: i64,
    #[serde(default)]
    pub total_qty_eom: i64,
    #[serde(default)]
    pub total_receipts: i64,
    #[serde(default)]
    pub total_shipments: i64,
    #[serde(default)]
    pub total_returns: i64,
    #[serde(default)]
    pub total_damaged: i64,
    #[serde(default)]
    pub total_lost: i64,
    #[serde(default)]
    pub total_disposed: i64,
    #[serde(default)]
    pub damaged_pct: f64,
}

/// 多月趋势响应（对齐 `TrendResponse`；项目级口径，不参与维度筛选）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerTrendResponse {
    pub project_id: i64,
    #[serde(default)]
    pub months: Vec<LedgerTrendMonthItem>,
}

// ---------------------------------------------------------------------------
// /summary（22 列日水位）
// ---------------------------------------------------------------------------

/// Summary 视图单行（对齐 `LedgerSummaryRow`）：
/// 1 行 = 1 (FNSKU × FC × Disposition × Date) 水位快照；稀疏账本——
/// 亚马逊只在该组合当日有变动时产出行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerSummaryRow {
    pub id: i64,
    pub date: NaiveDate,
    #[serde(default)]
    pub fnsku: Option<String>,
    #[serde(default)]
    pub asin: Option<String>,
    pub msku: String,
    #[serde(default)]
    pub title: Option<String>,
    pub disposition: String,
    pub location: String,
    #[serde(default)]
    pub starting_balance: i64,
    #[serde(default)]
    pub in_transit_between: i64,
    #[serde(default)]
    pub receipts: i64,
    #[serde(default)]
    pub customer_shipments: i64,
    #[serde(default)]
    pub customer_returns: i64,
    #[serde(default)]
    pub vendor_returns: i64,
    #[serde(default)]
    pub warehouse_transfer_io: i64,
    #[serde(default)]
    pub found: i64,
    #[serde(default)]
    pub lost: i64,
    #[serde(default)]
    pub damaged: i64,
    #[serde(default)]
    pub disposed: i64,
    #[serde(default)]
    pub other_events: i64,
    #[serde(default)]
    pub ending_balance: i64,
    #[serde(default)]
    pub unknown_events: i64,
    #[serde(default)]
    pub store: Option<String>,
    #[serde(default)]
    pub batch_id: Option<i64>,
}

/// Summary 响应（对齐 `LedgerSummaryResponse`；行按 date desc 排序）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerSummaryResponse {
    pub report_month: NaiveDate,
    #[serde(default)]
    pub rows: Vec<LedgerSummaryRow>,
}

// ---------------------------------------------------------------------------
// /detail（16 列事件行）
// ---------------------------------------------------------------------------

/// Detail 视图单行（对齐 `LedgerDetailRow`）：1 行 = 1 笔事件
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerDetailRow {
    pub id: i64,
    pub date: NaiveDate,
    #[serde(default)]
    pub fnsku: Option<String>,
    #[serde(default)]
    pub asin: Option<String>,
    pub msku: String,
    #[serde(default)]
    pub title: Option<String>,
    pub event_type: String,
    #[serde(default)]
    pub reference_id: Option<String>,
    pub quantity: i64,
    pub fulfillment_center: String,
    pub disposition: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub reconciled_quantity: Option<i64>,
    #[serde(default)]
    pub unreconciled_quantity: Option<i64>,
    #[serde(default)]
    pub date_and_time: Option<String>,
    #[serde(default)]
    pub store: Option<String>,
    #[serde(default)]
    pub batch_id: Option<i64>,
}

/// Detail 响应（对齐 `LedgerDetailResponse`；行按 date desc 排序）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerDetailResponse {
    pub report_month: NaiveDate,
    #[serde(default)]
    pub rows: Vec<LedgerDetailRow>,
}

// ---------------------------------------------------------------------------
// /batches
// ---------------------------------------------------------------------------

/// 单次 CSV 导入批次（对齐 `IngestBatchInfo`；追溯用元数据）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerIngestBatchInfo {
    pub id: i64,
    pub project_id: i64,
    pub report_month: NaiveDate,
    pub source_filename: String,
    pub file_hash: String,
    pub file_size_bytes: i64,
    /// `summary` / `detail` / `unknown`
    pub file_kind: String,
    #[serde(default)]
    pub loaded_by: Option<String>,
    pub loaded_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    /// `pending` / `running` / `success` / `failed` / `partial`
    pub status: String,
    #[serde(default)]
    pub rows_parsed: i64,
    #[serde(default)]
    pub rows_written_summary: i64,
    #[serde(default)]
    pub rows_written_detail: i64,
    #[serde(default)]
    pub rows_skipped_duplicate: i64,
    #[serde(default)]
    pub rows_failed_validation: i64,
    #[serde(default)]
    pub error_message: Option<String>,
    /// `ok` / `mismatch` / `not_run`
    #[serde(default)]
    pub consistency_check: Option<String>,
    #[serde(default)]
    pub consistency_mismatch_count: i64,
}

/// 导入批次列表响应（对齐 `IngestBatchesResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerIngestBatchesResponse {
    pub project_id: i64,
    #[serde(default)]
    pub batches: Vec<LedgerIngestBatchInfo>,
}

// ---------------------------------------------------------------------------
// /consistency
// ---------------------------------------------------------------------------

/// 双表对账单条不一致（对齐 `ConsistencyMismatch`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerConsistencyMismatch {
    pub msku: String,
    pub location: String,
    pub disposition: String,
    pub detail_quantity: i64,
    pub summary_delta: i64,
    pub diff: i64,
}

/// 双表（Detail 累加 vs Summary 水位变动）对账结果（对齐
/// `ConsistencyCheckResult`；status = `OK` / `MISMATCH` / `PENDING`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerConsistencyResult {
    pub report_month: NaiveDate,
    pub status: String,
    pub mismatch_count: i64,
    #[serde(default)]
    pub mismatches: Vec<LedgerConsistencyMismatch>,
    pub checked_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标签映射契约（对齐 frontend EVENT_TYPE_LABELS / DISPOSITION_LABELS）
    #[test]
    fn labels_match_frontend_glossary() {
        assert_eq!(event_type_label("Receipts"), "入库");
        assert_eq!(event_type_label("Shipments"), "出库");
        assert_eq!(event_type_label("WhseTransfers"), "调拨");
        assert_eq!(event_type_label("CustomerReturns"), "客户退货");
        assert_eq!(event_type_label("VendorReturns"), "供应商退货");
        assert_eq!(event_type_label("Adjustments"), "调整");
        assert_eq!(event_type_label("Mystery"), "Mystery");

        assert_eq!(disposition_label("SELLABLE"), "可售");
        assert_eq!(disposition_label("CUSTOMER_DAMAGED"), "客户损坏");
        assert_eq!(disposition_label("CARRIER_DAMAGED"), "承运损坏");
        assert_eq!(disposition_label("WAREHOUSE_DAMAGED"), "仓库损坏");
        assert_eq!(disposition_label("DEFECTIVE"), "DEFECTIVE");
    }

    /// /months 反序列化（月份为每月 1 号日期）
    #[test]
    fn months_response_deserializes() {
        let json = r#"{"project_id": 3, "months": ["2026-07-01", "2026-06-01"]}"#;
        let resp: LedgerMonthsResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.months.len(), 2);
        assert_eq!(
            resp.months[0],
            NaiveDate::from_ymd_opt(2026, 7, 1).expect("合法日期")
        );
    }

    /// /snapshot 反序列化（含 integrity；缺省字段容忍）
    #[test]
    fn snapshot_response_deserializes_backend_shape() {
        let json = r#"{
            "report_month": "2026-07-01",
            "sku_count": 2,
            "total_qty": 150,
            "disposition_summary": [
                {"disposition": "SELLABLE", "qty_eom": 140, "pct_of_total": 93.3},
                {"disposition": "CUSTOMER_DAMAGED", "qty_eom": 10, "pct_of_total": 6.7}
            ],
            "skus": [
                {"msku": "SKU-A", "title": "测试产品", "qty_eom": 100,
                 "sellable_qty": 95, "damaged_qty": 5, "prev_qty_eom": 90, "change": 10},
                {"msku": "SKU-B", "qty_eom": 50}
            ],
            "integrity": {
                "report_month": "2026-07-01",
                "status": "MISMATCH",
                "mismatch_count": 1,
                "mismatches": [{
                    "msku": "SKU-A", "location": "ONT8", "disposition": "SELLABLE",
                    "prev_ending": 90, "curr_starting": 88, "diff": -2
                }],
                "checked_at": "2026-08-15T10:00:00+00:00"
            }
        }"#;
        let resp: LedgerSnapshotResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.sku_count, 2);
        assert_eq!(resp.disposition_summary.len(), 2);
        assert_eq!(resp.skus[0].change, Some(10));
        // 缺省字段容忍（title / sellable / change 均缺）
        assert_eq!(resp.skus[1].title, None);
        assert_eq!(resp.skus[1].change, None);
        let integrity = resp.integrity.expect("应有 integrity");
        assert_eq!(integrity.status, "MISMATCH");
        assert_eq!(integrity.mismatches[0].diff, -2);
    }

    /// /snapshot integrity 为 null（无上月数据）→ None
    #[test]
    fn snapshot_integrity_null_maps_to_none() {
        let json = r#"{
            "report_month": "2026-07-01", "sku_count": 0, "total_qty": 0,
            "disposition_summary": [], "skus": [], "integrity": null
        }"#;
        let resp: LedgerSnapshotResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.integrity, None);
    }

    /// /trend 反序列化（report_month 为 YYYY-MM 字符串）
    #[test]
    fn trend_response_deserializes() {
        let json = r#"{
            "project_id": 3,
            "months": [
                {"report_month": "2026-06", "sku_count": 2, "total_qty_eom": 120,
                 "total_receipts": 50, "total_shipments": 30, "total_returns": 5,
                 "total_damaged": 3, "total_lost": 1, "total_disposed": 0,
                 "damaged_pct": 2.5},
                {"report_month": "2026-07"}
            ]
        }"#;
        let resp: LedgerTrendResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.months.len(), 2);
        assert_eq!(resp.months[0].total_qty_eom, 120);
        assert!((resp.months[0].damaged_pct - 2.5).abs() < f64::EPSILON);
        // 缺省字段全部落默认值
        assert_eq!(resp.months[1].total_qty_eom, 0);
    }

    /// /summary 反序列化（22 列；缺省数值列容忍）
    #[test]
    fn summary_response_deserializes_backend_shape() {
        let json = r#"{
            "report_month": "2026-07-01",
            "rows": [{
                "id": 1, "date": "2026-07-15", "fnsku": "X001", "asin": "B0TEST",
                "msku": "SKU-A", "title": "测试产品", "disposition": "SELLABLE",
                "location": "ONT8", "starting_balance": 100, "receipts": 20,
                "customer_shipments": 15, "ending_balance": 105, "batch_id": 7
            }]
        }"#;
        let resp: LedgerSummaryResponse = serde_json::from_str(json).expect("反序列化失败");
        let row = &resp.rows[0];
        assert_eq!(row.msku, "SKU-A");
        assert_eq!(row.starting_balance, 100);
        assert_eq!(row.ending_balance, 105);
        // 缺省数值列 → 0
        assert_eq!(row.in_transit_between, 0);
        assert_eq!(row.damaged, 0);
        assert_eq!(row.batch_id, Some(7));
        assert_eq!(
            row.date,
            NaiveDate::from_ymd_opt(2026, 7, 15).expect("合法日期")
        );
    }

    /// /detail 反序列化（16 列；datetime 字段为字符串，可带时区偏移）
    #[test]
    fn detail_response_deserializes_backend_shape() {
        let json = r#"{
            "report_month": "2026-07-01",
            "rows": [{
                "id": 9, "date": "2026-07-10", "msku": "SKU-A",
                "event_type": "Receipts", "reference_id": "REF-1", "quantity": 20,
                "fulfillment_center": "ONT8", "disposition": "SELLABLE",
                "date_and_time": "2026-07-10T08:30:00+00:00", "batch_id": 7
            }]
        }"#;
        let resp: LedgerDetailResponse = serde_json::from_str(json).expect("反序列化失败");
        let row = &resp.rows[0];
        assert_eq!(row.event_type, "Receipts");
        assert_eq!(row.quantity, 20);
        assert_eq!(
            row.date_and_time.as_deref(),
            Some("2026-07-10T08:30:00+00:00")
        );
        assert_eq!(row.reason, None);
    }

    /// /batches 反序列化（追溯元数据；状态 / 对账字段为字符串枚举）
    #[test]
    fn batches_response_deserializes() {
        let json = r#"{
            "project_id": 3,
            "batches": [{
                "id": 7, "project_id": 3, "report_month": "2026-07-01",
                "source_filename": "ledger-summary.csv", "file_hash": "abc",
                "file_size_bytes": 1024, "file_kind": "summary",
                "loaded_at": "2026-08-01T09:00:00+00:00", "status": "success",
                "rows_parsed": 100, "rows_written_summary": 100,
                "consistency_check": "ok"
            }]
        }"#;
        let resp: LedgerIngestBatchesResponse = serde_json::from_str(json).expect("反序列化失败");
        let b = &resp.batches[0];
        assert_eq!(b.file_kind, "summary");
        assert_eq!(b.status, "success");
        assert_eq!(b.rows_written_summary, 100);
        assert_eq!(b.consistency_check.as_deref(), Some("ok"));
        assert_eq!(b.loaded_by, None);
    }

    /// /consistency 反序列化（双表对账）
    #[test]
    fn consistency_result_deserializes() {
        let json = r#"{
            "report_month": "2026-07-01",
            "status": "MISMATCH",
            "mismatch_count": 1,
            "mismatches": [{
                "msku": "SKU-A", "location": "ONT8", "disposition": "SELLABLE",
                "detail_quantity": 20, "summary_delta": 18, "diff": 2
            }],
            "checked_at": "2026-08-15T10:00:00+00:00"
        }"#;
        let resp: LedgerConsistencyResult = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.status, "MISMATCH");
        assert_eq!(resp.mismatches[0].diff, 2);
    }
}
