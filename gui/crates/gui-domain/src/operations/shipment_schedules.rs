//! 发货管理（P5-3，BLF-726）
//!
//! frontend `app/dashboard/operations/shipment-management` 的 GPUI 数据层：
//! `GET /api/v1/shipment-schedules`（backend
//! `app/api/v1/endpoints/shipment_schedules.py`，Redis 缓存 → 物化查询）。
//!
//! 字段命名沿用后端 Pydantic 模型（`backend/app/schemas/shipment_schedule.py`）
//! 1:1（snake_case）；可空字段用 `Option`，数值字段带 Pydantic 默认值的用
//! `#[serde(default)]` 容忍缺省。
//!
//! 状态机（backend `shipment_status` 取值，对齐 frontend `STATUS_OPTIONS`）：
//! `draft`（草稿）→ `in_transit`（在途）→ `completed`（已完成）。
//!
//! GUI 取舍（BLF-726）：本模块只建模 GUI 消费的读取端点类型
//! （list / detail / cost-summary / sku-summary）；写入端点
//! （create / update / delete / import-csv / costs/calculate）与
//! FBA 箱单明细（`fba-box-details`，依赖图片 / 标签下载链路）暂不建模，
//! 相关操作走 web 端。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 状态 / 运输方式常量（对齐 frontend STATUS_OPTIONS / METHOD_OPTIONS）
// ---------------------------------------------------------------------------

/// 发货状态：草稿
pub const STATUS_DRAFT: &str = "draft";
/// 发货状态：在途
pub const STATUS_IN_TRANSIT: &str = "in_transit";
/// 发货状态：已完成
pub const STATUS_COMPLETED: &str = "completed";

/// 运输方式（backend `shipping_method` 取值，对齐 frontend `METHOD_OPTIONS`）
pub const METHOD_OPTIONS: [(&str, &str); 6] = [
    ("sea", "海运"),
    ("air", "空运"),
    ("express", "快递"),
    ("truck", "卡航/汽运"),
    ("rail", "铁路"),
    ("other", "其他"),
];

/// 状态中文标签（未知状态原样返回，对齐 frontend `statusMeta` 兜底）
pub fn status_label(status: &str) -> String {
    match status {
        STATUS_DRAFT => "草稿".to_string(),
        STATUS_IN_TRANSIT => "在途".to_string(),
        STATUS_COMPLETED => "已完成".to_string(),
        other => other.to_string(),
    }
}

/// 运输方式中文标签（未知方式原样返回，对齐 frontend `methodLabel`）
pub fn method_label(method: &str) -> String {
    METHOD_OPTIONS
        .iter()
        .find(|(value, _)| *value == method)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| method.to_string())
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/// 发货计划列表项（backend `ShipmentScheduleListItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShipmentScheduleListItem {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub shipment_no: String,
    #[serde(default)]
    pub tracking_no: Option<String>,
    #[serde(default)]
    pub warehouse_code: Option<String>,
    #[serde(default)]
    pub forwarder_name: Option<String>,
    pub shipping_method: String,
    /// 发货日期（YYYY-MM-DD）
    #[serde(default)]
    pub created_date: Option<String>,
    /// 预计离港（YYYY-MM-DD）
    #[serde(default)]
    pub etd_date: Option<String>,
    /// 预计到港（YYYY-MM-DD）
    #[serde(default)]
    pub eta_date: Option<String>,
    /// 实际入仓（YYYY-MM-DD）
    #[serde(default)]
    pub actual_inbound_date: Option<String>,
    /// `draft` / `in_transit` / `completed`
    pub shipment_status: String,
    #[serde(default)]
    pub remark: Option<String>,
    pub sku_count: i64,
    pub total_quantity: i64,
    /// 物流单价（元/kg）
    #[serde(default)]
    pub logistics_unit_price: f64,
    /// 总体积（m³）
    #[serde(default)]
    pub total_volume_m3: f64,
    /// 总计费重量（kg）
    #[serde(default)]
    pub total_chargeable_weight_kg: f64,
    /// 物流总价
    #[serde(default)]
    pub logistics_total_price: f64,
    /// 是否计入历史运费核算
    #[serde(default)]
    pub include_in_history_shipping_calc: bool,
    pub updated_at: String,
    /// 导入批次号（CSV 批量导入同源）
    #[serde(default)]
    pub shipment_batch: Option<String>,
}

/// 发货计划列表响应（backend `ShipmentScheduleListResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShipmentScheduleListResponse {
    pub items: Vec<ShipmentScheduleListItem>,
    pub page: i64,
    pub page_size: i64,
    /// `include_total=false` 时后端返回 null
    #[serde(default)]
    pub total: Option<i64>,
    pub has_next: bool,
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

/// 发货计划明细行（backend `ShipmentScheduleItemRow` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShipmentScheduleItemRow {
    pub id: i64,
    #[serde(default)]
    pub item_date: Option<String>,
    pub sku: String,
    pub quantity: i64,
    #[serde(default)]
    pub carton_count: Option<i64>,
    #[serde(default)]
    pub remark: Option<String>,
    #[serde(default)]
    pub volume_m3: f64,
    #[serde(default)]
    pub actual_weight_kg: f64,
    #[serde(default)]
    pub volumetric_weight_kg: f64,
    #[serde(default)]
    pub chargeable_weight_kg: f64,
    #[serde(default)]
    pub estimated_logistics_cost: f64,
    #[serde(default)]
    pub average_logistics_unit_price: f64,
}

/// 发货计划详情（backend `ShipmentScheduleDetail` 1:1 = 列表项字段 + items）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShipmentScheduleDetail {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub shipment_no: String,
    #[serde(default)]
    pub tracking_no: Option<String>,
    #[serde(default)]
    pub warehouse_code: Option<String>,
    #[serde(default)]
    pub forwarder_name: Option<String>,
    pub shipping_method: String,
    #[serde(default)]
    pub created_date: Option<String>,
    #[serde(default)]
    pub etd_date: Option<String>,
    #[serde(default)]
    pub eta_date: Option<String>,
    #[serde(default)]
    pub actual_inbound_date: Option<String>,
    #[serde(default)]
    pub remark: Option<String>,
    pub shipment_status: String,
    pub sku_count: i64,
    pub total_quantity: i64,
    #[serde(default)]
    pub logistics_unit_price: f64,
    #[serde(default)]
    pub total_volume_m3: f64,
    #[serde(default)]
    pub total_chargeable_weight_kg: f64,
    #[serde(default)]
    pub logistics_total_price: f64,
    #[serde(default)]
    pub include_in_history_shipping_calc: bool,
    /// SKU 明细行
    #[serde(default)]
    pub items: Vec<ShipmentScheduleItemRow>,
    pub updated_at: String,
    #[serde(default)]
    pub shipment_batch: Option<String>,
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/// 发货费用汇总（backend `ShipmentScheduleCostSummary` 1:1；
/// `GET /shipment-schedules/cost-summary` 响应）
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ShipmentScheduleCostSummary {
    pub shipment_count: i64,
    pub total_sku: i64,
    pub total_quantity: i64,
    pub total_chargeable_weight_kg: f64,
    pub total_logistics_cost: f64,
}

/// SKU 汇总项（backend `ShipmentSkuSummaryItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShipmentSkuSummaryItem {
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub sku: String,
    pub shipment_count: i64,
    pub total_quantity: i64,
    pub total_chargeable_weight_kg: f64,
    pub total_logistics_cost: f64,
    pub average_logistics_unit_price: f64,
}

/// SKU 汇总响应（backend `ShipmentSkuSummaryResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ShipmentSkuSummaryResponse {
    #[serde(default)]
    pub items: Vec<ShipmentSkuSummaryItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_label_covers_known_statuses_and_falls_back() {
        assert_eq!(status_label("draft"), "草稿");
        assert_eq!(status_label("in_transit"), "在途");
        assert_eq!(status_label("completed"), "已完成");
        assert_eq!(status_label("unknown"), "unknown");
    }

    #[test]
    fn method_label_covers_known_methods_and_falls_back() {
        assert_eq!(method_label("sea"), "海运");
        assert_eq!(method_label("air"), "空运");
        assert_eq!(method_label("express"), "快递");
        assert_eq!(method_label("truck"), "卡航/汽运");
        assert_eq!(method_label("rail"), "铁路");
        assert_eq!(method_label("other"), "其他");
        assert_eq!(method_label("drone"), "drone");
    }

    /// 反序列化契约：backend 列表项 JSON（可空字段缺失时也能解析）
    #[test]
    fn list_item_deserializes_from_backend_json() {
        let json = r#"{
            "id": 7, "project_id": 3, "project_name": "测试项目",
            "country": "US", "shipment_no": "FBA123", "shipping_method": "sea",
            "shipment_status": "in_transit",
            "sku_count": 2, "total_quantity": 100,
            "logistics_unit_price": 9.5, "total_volume_m3": 1.2,
            "total_chargeable_weight_kg": 320.0, "logistics_total_price": 3040.0,
            "include_in_history_shipping_calc": true,
            "updated_at": "2026-08-01T00:00:00"
        }"#;
        let item: ShipmentScheduleListItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.id, 7);
        assert_eq!(item.tracking_no, None);
        assert_eq!(item.created_date, None);
        assert_eq!(item.shipment_batch, None);
        assert!(item.include_in_history_shipping_calc);
    }

    /// 反序列化契约：列表响应 total 可为 null（include_total=false）
    #[test]
    fn list_response_total_is_optional() {
        let json = r#"{"items": [], "page": 1, "page_size": 20, "total": null, "has_next": false}"#;
        let resp: ShipmentScheduleListResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.total, None);
        assert!(!resp.has_next);
    }

    /// 反序列化契约：详情嵌套 items（数值字段缺省走 Pydantic 默认 0）
    #[test]
    fn detail_deserializes_nested_items_with_defaults() {
        let json = r#"{
            "id": 7, "project_id": 3, "project_name": "测试项目",
            "country": "US", "shipment_no": "FBA123", "shipping_method": "sea",
            "shipment_status": "draft",
            "sku_count": 1, "total_quantity": 50,
            "items": [
                {"id": 11, "sku": "SKU-A", "quantity": 50}
            ],
            "updated_at": "2026-08-01T00:00:00"
        }"#;
        let detail: ShipmentScheduleDetail = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].volume_m3, 0.0);
        assert_eq!(detail.items[0].carton_count, None);
    }
}
