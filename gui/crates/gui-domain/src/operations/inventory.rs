//! 运营 → 库存分析（P5-2，BLF-719）
//!
//! 对齐 backend `backend/app/schemas/inventory_replenishment.py` 的
//! `InventoryAnalysisSummary` / `ShipmentColumn` / `InventoryAnalysisItem` /
//! `InventoryAnalysisResponse` / `InventorySnapshotOption`（fastapi schema，
//! 字段 snake_case 1:1；带默认值的字段一律 `#[serde(default)]` 容忍缺省）。
//!
//! 端点（见 `backend/app/api/v1/endpoints/inventory_replenishment.py`）：
//! - `GET /api/v1/inventory-analysis?project_id&country&report_date?`
//!   → [`InventoryAnalysisResponse`]
//! - `GET /api/v1/inventory-snapshot-options?project_id&country`
//!   → `Vec<InventorySnapshotOption>`
//!
//! 与 frontend `app/dashboard/operations/inventory-analysis/` 的
//! `InventoryResponse` / `SnapshotOption` 类型 1:1。

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// 库存分析汇总（对齐 `InventoryAnalysisSummary`；11 个整数指标）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventoryAnalysisSummary {
    pub sku_count: i64,
    pub out_of_stock_count: i64,
    pub aging_sku_count: i64,
    pub over_aged_sku_count: i64,
    pub total_available_qty: i64,
    pub total_age_0_90_qty: i64,
    pub total_age_91_180_qty: i64,
    pub total_age_181_270_qty: i64,
    pub total_age_271_365_qty: i64,
    pub total_age_365_plus_qty: i64,
    pub action_type_count: i64,
}

/// 在途发货列定义（对齐 `ShipmentColumn`；`shipment_no` / `label` 必填，
/// 其余运输信息可空）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShipmentColumn {
    pub shipment_no: String,
    pub label: String,
    #[serde(default)]
    pub shipping_method: Option<String>,
    #[serde(default)]
    pub forwarder_name: Option<String>,
    #[serde(default)]
    pub etd_date: Option<String>,
    #[serde(default)]
    pub eta_date: Option<String>,
}

/// 单 SKU 库存行（对齐 `InventoryAnalysisItem`；`shipment_quantities` 以
/// shipment_no 为键的在途数量映射）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventoryAnalysisItem {
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub sku: String,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub product_name: Option<String>,
    pub available_qty: i64,
    pub age_0_90_qty: i64,
    pub age_91_180_qty: i64,
    pub age_181_270_qty: i64,
    pub age_271_365_qty: i64,
    pub age_365_plus_qty: i64,
    #[serde(default)]
    pub recommended_action: Option<String>,
    pub recommended_action_label: String,
    /// `out_of_stock` / `in_stock`
    pub stock_status: String,
    /// `over_aged` / `aging` / `normal`
    pub aging_status: String,
    #[serde(default)]
    pub shipment_quantities: HashMap<String, i64>,
}

/// 库存分析响应（对齐 `InventoryAnalysisResponse`；`report_date` 为「数据是几号的」
/// 业务日期，`None` = 暂无快照）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventoryAnalysisResponse {
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    #[serde(default)]
    pub report_date: Option<NaiveDate>,
    pub summary: InventoryAnalysisSummary,
    #[serde(default)]
    pub action_options: Vec<String>,
    pub items: Vec<InventoryAnalysisItem>,
    #[serde(default)]
    pub shipment_columns: Vec<ShipmentColumn>,
    #[serde(default)]
    pub shipment_column_totals: HashMap<String, i64>,
}

/// 业务日期快照选项（对齐 `InventorySnapshotOption`；`is_current` 标记最新一期）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventorySnapshotOption {
    pub report_date: NaiveDate,
    pub is_current: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反序列化契约：backend `/inventory-analysis` 真实响应形态（含 shipment
    /// 动态列 + 缺省字段容忍）
    #[test]
    fn inventory_analysis_response_deserializes_backend_shape() {
        let json = r#"{
            "project_id": 3,
            "project_name": "测试项目 A",
            "country": "US",
            "report_date": "2026-08-15",
            "summary": {
                "sku_count": 2,
                "out_of_stock_count": 1,
                "aging_sku_count": 1,
                "over_aged_sku_count": 1,
                "total_available_qty": 150,
                "total_age_0_90_qty": 100,
                "total_age_91_180_qty": 30,
                "total_age_181_270_qty": 10,
                "total_age_271_365_qty": 5,
                "total_age_365_plus_qty": 5,
                "action_type_count": 3
            },
            "action_options": ["补货", "清货", "观察"],
            "items": [
                {
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "sku": "SKU-A",
                    "asin": "B0TEST123",
                    "product_name": "测试产品",
                    "available_qty": 100,
                    "age_0_90_qty": 80,
                    "age_91_180_qty": 20,
                    "age_181_270_qty": 0,
                    "age_271_365_qty": 0,
                    "age_365_plus_qty": 0,
                    "recommended_action": "replenish",
                    "recommended_action_label": "建议补货",
                    "stock_status": "in_stock",
                    "aging_status": "normal",
                    "shipment_quantities": {"SHIP-1": 50}
                },
                {
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "sku": "SKU-B",
                    "available_qty": 50,
                    "age_0_90_qty": 20,
                    "age_91_180_qty": 10,
                    "age_181_270_qty": 10,
                    "age_271_365_qty": 5,
                    "age_365_plus_qty": 5,
                    "recommended_action_label": "建议清货",
                    "stock_status": "out_of_stock",
                    "aging_status": "over_aged"
                }
            ],
            "shipment_columns": [
                {
                    "shipment_no": "SHIP-1",
                    "label": "在途 1",
                    "shipping_method": "海运",
                    "forwarder_name": "货代甲",
                    "etd_date": "2026-08-20",
                    "eta_date": "2026-09-05"
                }
            ],
            "shipment_column_totals": {"SHIP-1": 50}
        }"#;
        let resp: InventoryAnalysisResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.project_id, 3);
        assert_eq!(
            resp.report_date,
            Some(NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"))
        );
        assert_eq!(resp.summary.sku_count, 2);
        assert_eq!(resp.summary.total_age_365_plus_qty, 5);
        // 缺省字段（product_name / shipment_quantities）容忍反序列化
        assert_eq!(resp.items[1].product_name, None);
        assert!(resp.items[1].shipment_quantities.is_empty());
        // 动态 shipment 列解析
        assert_eq!(resp.shipment_columns.len(), 1);
        assert_eq!(resp.shipment_columns[0].shipment_no, "SHIP-1");
        assert_eq!(resp.shipment_columns[0].eta_date.as_deref(), Some("2026-09-05"));
        assert_eq!(resp.shipment_column_totals["SHIP-1"], 50);
        assert_eq!(resp.items[0].shipment_quantities["SHIP-1"], 50);
        assert_eq!(resp.action_options, vec!["补货", "清货", "观察"]);
    }

    /// report_date 为 null（暂无快照）→ `None`（前端「暂无快照」文案的判定依据）
    #[test]
    fn inventory_analysis_report_date_null_maps_to_none() {
        let json = r#"{
            "project_id": 1,
            "project_name": "P",
            "country": "US",
            "report_date": null,
            "summary": {
                "sku_count": 0, "out_of_stock_count": 0, "aging_sku_count": 0,
                "over_aged_sku_count": 0, "total_available_qty": 0,
                "total_age_0_90_qty": 0, "total_age_91_180_qty": 0,
                "total_age_181_270_qty": 0, "total_age_271_365_qty": 0,
                "total_age_365_plus_qty": 0, "action_type_count": 0
            },
            "action_options": [],
            "items": [],
            "shipment_columns": [],
            "shipment_column_totals": {}
        }"#;
        let resp: InventoryAnalysisResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.report_date, None);
        assert!(resp.items.is_empty());
    }

    /// 快照选项反序列化（`is_current` 标记）
    #[test]
    fn inventory_snapshot_option_deserializes() {
        let json = r#"[
            {"report_date": "2026-08-15", "is_current": true},
            {"report_date": "2026-08-08", "is_current": false}
        ]"#;
        let opts: Vec<InventorySnapshotOption> = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(opts.len(), 2);
        assert!(opts[0].is_current);
        assert_eq!(
            opts[0].report_date,
            NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期")
        );
        assert!(!opts[1].is_current);
    }
}
