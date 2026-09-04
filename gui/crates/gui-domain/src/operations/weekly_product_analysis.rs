//! 运营 → 按周产品分析（P5-2，BLF-723）
//!
//! 对齐 backend `backend/app/api/v1/endpoints/product_analysis.py` 的
//! 4 个端点（字段 snake_case 1:1；可选 / 带默认值字段一律
//! `#[serde(default)]` 容忍缺省）：
//! - `GET /api/v1/product-analysis/weekly?project_id&country[&start_date][&end_date]`
//!   → `Vec<`[`WeeklyProductRow`]`>`（周度汇总行列表，含 `summary_row`
//!   中文键指标字典）；
//! - `GET /api/v1/product-analysis/pt1/{pt1_id}/details?country&page&page_size`
//!   → [`Pt1DetailsResponse`]（单周 SKU 明细，`raw_row` 为中文键原始行）；
//! - `GET /api/v1/product-analysis/inventory/current?project_id&country&start_date&end_date`
//!   → [`InventorySnapshotResponse`]（区间内最新库存快照，用于明细「库存」列）；
//! - `POST /api/v1/product-analysis/weekly/recompute?project_id&country[&start_date][&end_date]`
//!   → [`WeeklyRecomputeResponse`]（历史周报重算并持久化）。
//!
//! 与 frontend `app/dashboard/operations/weekly-product-analysis/` 的
//! `WeeklyDataRow` / `PT1DetailsResponse` 类型 1:1。
//!
//! `summary_row` / `raw_row` 是后端按中文列名组织的指标字典
//! （如「总销量」/「广告花费」/「实际销售额」），键集合随报告版本可变，
//! 故用 [`serde_json::Value`] 承载、由视图层按需取数（对齐 web
//! `buildSummaryForRow` / `buildDetailRow` 的口径）。

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// 周度产品分析汇总行（对齐 backend `list_product_analysis_weekly`
/// 的 enriched / fallback 两条返回路径共有的字段集）
///
/// `total_sales` / `total_units` / `total_ad_spend` 由后端从 `summary_row`
/// 预提取（实际销售额 / 实际销售量 / 广告花费，缺失时回退总口径）；
/// `summary_row` 为中文键指标字典（可能含 `_is_partial` / `_completeness`
/// 元信息），`weekly_summary_raw` 与其同值（后端冗余字段，缺省容忍）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeeklyProductRow {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub report_start_date: NaiveDate,
    pub report_end_date: NaiveDate,
    pub version: i64,
    pub is_current: bool,
    #[serde(default)]
    pub row_count: i64,
    #[serde(default)]
    pub total_sales: f64,
    #[serde(default)]
    pub total_units: i64,
    #[serde(default)]
    pub total_ad_spend: f64,
    /// 中文键指标字典（如「总销量」/「广告花费」）；旧数据可能为空
    #[serde(default)]
    pub summary_row: Option<serde_json::Value>,
    /// 后端冗余回显（与 summary_row 同值）；缺省容忍
    #[serde(default)]
    pub weekly_summary_raw: Option<serde_json::Value>,
}

/// 单周 SKU 明细行（对齐 backend `list_product_analysis_pt1_details`
/// 的 rows 条目；`raw_row` 为中文键原始行字典）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pt1DetailRow {
    pub id: i64,
    pub source_row_no: i64,
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub sku_sort_order: Option<i64>,
    #[serde(default)]
    pub raw_row: Option<serde_json::Value>,
}

/// 单周 SKU 明细响应（对齐 backend `pt1/{pt1_id}/details` 返回体）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pt1DetailsResponse {
    pub pt1_id: i64,
    #[serde(default)]
    pub project_id: i64,
    #[serde(default)]
    pub project_name: String,
    pub report_start_date: NaiveDate,
    pub report_end_date: NaiveDate,
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
    pub has_next: bool,
    pub rows: Vec<Pt1DetailRow>,
}

/// 库存快照行（仅取明细「库存」列合并所需的 sku / available_qty；
/// 后端 rows 为宽字典，其余键忽略）
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct InventorySnapshotRow {
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub available_qty: Option<f64>,
}

/// 区间内最新库存快照响应（对齐 `CurrentInventorySnapshotResponse`；
/// `source` 为 34 字段的 `AnalysisSourceFileItem`，GUI 不消费，
/// 用 [`serde_json::Value`] 承载避免契约耦合）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventorySnapshotResponse {
    #[serde(default)]
    pub source: serde_json::Value,
    pub rows: Vec<InventorySnapshotRow>,
}

/// 历史周报重算响应（对齐 `ProductAnalysisWeeklyRecomputeResponse`；
/// periods 明细 GUI 不逐条消费，仅用 recomputed / skipped 计数）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeeklyRecomputeResponse {
    pub project_id: i64,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub country: String,
    pub recomputed: i64,
    #[serde(default)]
    pub skipped: i64,
    #[serde(default)]
    pub periods: Vec<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反序列化契约：backend `/product-analysis/weekly` 真实响应形态
    /// （enriched 路径：中文键 summary_row + 预提取合计 + 冗余 raw 字段）
    #[test]
    fn weekly_row_deserializes_backend_shape() {
        let json = r#"[
            {
                "id": 101,
                "project_id": 3,
                "project_name": "测试项目 A",
                "country": "US",
                "report_start_date": "2026-08-03",
                "report_end_date": "2026-08-09",
                "version": 2,
                "is_current": true,
                "row_count": 12,
                "total_sales": 15320.5,
                "total_units": 421,
                "total_ad_spend": 2100.25,
                "summary_row": {
                    "总销量": 421,
                    "总销售额": "15,320.50",
                    "广告花费": 2100.25,
                    "实际销售额": 15320.5,
                    "_is_partial": false
                },
                "weekly_summary_raw": {
                    "总销量": 421
                }
            },
            {
                "id": 100,
                "project_id": 3,
                "project_name": "测试项目 A",
                "country": "US",
                "report_start_date": "2026-07-27",
                "report_end_date": "2026-08-02",
                "version": 1,
                "is_current": true
            }
        ]"#;
        let rows: Vec<WeeklyProductRow> = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, 101);
        assert_eq!(rows[0].total_sales, 15320.5);
        assert_eq!(rows[0].total_units, 421);
        assert_eq!(
            rows[0].report_start_date,
            NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期")
        );
        let summary = rows[0].summary_row.as_ref().expect("summary_row 存在");
        assert_eq!(summary.get("总销量").and_then(|v| v.as_i64()), Some(421));
        // 缺省字段（row_count / 合计 / summary_row）容忍反序列化
        assert_eq!(rows[1].row_count, 0);
        assert_eq!(rows[1].total_sales, 0.0);
        assert_eq!(rows[1].summary_row, None);
        assert_eq!(rows[1].weekly_summary_raw, None);
    }

    /// 反序列化契约：backend `pt1/{id}/details` 真实响应形态
    #[test]
    fn pt1_details_deserializes_backend_shape() {
        let json = r#"{
            "pt1_id": 101,
            "project_id": 3,
            "project_name": "测试项目 A",
            "report_start_date": "2026-08-03",
            "report_end_date": "2026-08-09",
            "version": 2,
            "page": 1,
            "page_size": 1000,
            "has_next": false,
            "rows": [
                {
                    "id": 9001,
                    "source_row_no": 2,
                    "sku": "SKU-A",
                    "asin": "B0TEST123",
                    "sku_sort_order": 1,
                    "raw_row": {
                        "日期": "2026-08-03",
                        "SKU": "SKU-A",
                        "总销量": 12,
                        "总销售额": 456.78,
                        "库存": 100
                    }
                },
                {
                    "id": 9002,
                    "source_row_no": 3
                }
            ]
        }"#;
        let resp: Pt1DetailsResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.pt1_id, 101);
        assert!(!resp.has_next);
        assert_eq!(resp.rows.len(), 2);
        assert_eq!(resp.rows[0].sku.as_deref(), Some("SKU-A"));
        let raw = resp.rows[0].raw_row.as_ref().expect("raw_row 存在");
        assert_eq!(raw.get("总销量").and_then(|v| v.as_i64()), Some(12));
        // 缺省字段（sku / asin / raw_row）容忍反序列化
        assert_eq!(resp.rows[1].sku, None);
        assert_eq!(resp.rows[1].raw_row, None);
    }

    /// 反序列化契约：库存快照（宽字典 rows 只取 sku / available_qty）
    #[test]
    fn inventory_snapshot_deserializes_backend_shape() {
        let json = r#"{
            "source": { "id": 55, "report_type": "inventory" },
            "rows": [
                { "sku": "SKU-A", "available_qty": 100, "asin": "B0TEST123" },
                { "sku": null, "available_qty": null }
            ]
        }"#;
        let resp: InventorySnapshotResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.rows.len(), 2);
        assert_eq!(resp.rows[0].sku.as_deref(), Some("SKU-A"));
        assert_eq!(resp.rows[0].available_qty, Some(100.0));
        assert_eq!(resp.rows[1].sku, None);
        assert_eq!(resp.rows[1].available_qty, None);
    }

    /// 反序列化契约：重算响应（recomputed / skipped 计数 + periods 容忍）
    #[test]
    fn recompute_response_deserializes_backend_shape() {
        let json = r#"{
            "project_id": 3,
            "project_name": "测试项目 A",
            "country": "US",
            "recomputed": 8,
            "skipped": 1,
            "periods": [{ "pt1_id": 101, "row_count": 12 }]
        }"#;
        let resp: WeeklyRecomputeResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.recomputed, 8);
        assert_eq!(resp.skipped, 1);
        assert_eq!(resp.periods.len(), 1);

        // periods 缺省容忍
        let minimal = r#"{ "project_id": 3, "recomputed": 0 }"#;
        let resp: WeeklyRecomputeResponse = serde_json::from_str(minimal).expect("反序列化失败");
        assert_eq!(resp.recomputed, 0);
        assert!(resp.periods.is_empty());
    }
}
