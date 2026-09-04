//! 运营 → 季节性补货分析（P5-2，BLF-722）
//!
//! 对齐 backend `backend/app/schemas/inventory_replenishment.py` 的
//! `SeasonalReplenishmentListItem` / `SeasonalReplenishmentListResponse`
//! （fastapi schema，字段 snake_case 1:1；带默认值的字段一律
//! `#[serde(default)]` 容忍缺省）。
//!
//! 端点（见 `backend/app/api/v1/endpoints/inventory_replenishment.py`）：
//! - `GET /api/v1/seasonal-replenishment-analysis?project_id&country&from_date&to_date[&compare_year_offset][&keyword][&page][&page_size]`
//!   → [`SeasonalReplenishmentResponse`]
//!
//! 与 frontend `app/dashboard/operations/seasonal-replenishment/` 的
//! `SeasonalRow` / `Summary` / `SeasonalResponse` 类型 1:1。
//!
//! 与常规补货分析（`/inventory-replenishment-analysis`）的区别（backend 文档）：
//! - 销量窗口由 `from_date` / `to_date` 决定（不是 `date.today()`）；
//! - 加权权重 90D×40% + 30D×30% + 14D×20% + 7D×10%（长周期高权重）；
//! - **不判定** risk_status（响应无该字段）；
//! - 售卖截止锚点 = `to_date` + sellable_days（不是 today + sellable_days）；
//! - 可选去年同期对照（`compare_year_offset`：0=关闭 / 1=去年同期 / 2=前年同期）。
//!
//! summary 复用 backend `InventoryReplenishmentSummary` 的 7 个基础字段；
//! 季节性页面不判定风险，`out_of_stock_risk_count` / `slow_moving_count`
//! 固定返回 0（前端不展示对应统计卡）。v1.2 三段式 / 分布字段季节性端点
//! 不返回，全部 `#[serde(default)]` 容忍。

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// 季节性补货分析单行（对齐 `SeasonalReplenishmentListItem`）
///
/// 4 个主窗口 DMS（90/30/14/7）+ 可选去年同期对照（`*_yoy`）；
/// `base_dms` = 加权前基础 DMS，`weighted_dms` = 加权并叠加安全系数后的 DMS；
/// `sellout_date` / `sellout_date_with_transit` 锚点 = `to_date`（非 today）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeasonalReplenishmentItem {
    pub project_id: i64,
    pub project_name: String,
    pub sku: String,
    pub country: String,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub product_name: Option<String>,
    pub available_inventory: i64,
    pub in_transit_quantity: i64,
    #[serde(default)]
    pub dms_90: Option<f64>,
    #[serde(default)]
    pub dms_30: Option<f64>,
    #[serde(default)]
    pub dms_14: Option<f64>,
    #[serde(default)]
    pub dms_7: Option<f64>,
    #[serde(default)]
    pub dms_90_yoy: Option<f64>,
    #[serde(default)]
    pub dms_30_yoy: Option<f64>,
    #[serde(default)]
    pub dms_14_yoy: Option<f64>,
    #[serde(default)]
    pub dms_7_yoy: Option<f64>,
    #[serde(default)]
    pub base_dms: Option<f64>,
    #[serde(default)]
    pub weighted_dms: Option<f64>,
    #[serde(default)]
    pub sellable_days: Option<f64>,
    #[serde(default)]
    pub sellout_date: Option<String>,
    #[serde(default)]
    pub sellout_date_with_transit: Option<String>,
    pub production_lead_days: i64,
    pub shipping_days: i64,
    #[serde(default)]
    pub estimated_replenishment_quantity: Option<i64>,
}

/// 季节性补货分析汇总（对齐 backend `InventoryReplenishmentSummary` 的
/// 7 个基础字段；风险计数固定 0，v1.2 字段缺省容忍）
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct SeasonalReplenishmentSummary {
    pub sku_count: i64,
    #[serde(default)]
    pub out_of_stock_risk_count: i64,
    #[serde(default)]
    pub healthy_count: i64,
    #[serde(default)]
    pub slow_moving_count: i64,
    #[serde(default)]
    pub pending_data_count: i64,
    #[serde(default)]
    pub total_available_inventory: i64,
    #[serde(default)]
    pub total_in_transit_quantity: i64,
}

/// 季节性补货分析响应（对齐 `SeasonalReplenishmentListResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeasonalReplenishmentResponse {
    pub items: Vec<SeasonalReplenishmentItem>,
    pub summary: SeasonalReplenishmentSummary,
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub has_next: bool,
    pub from_date: NaiveDate,
    pub to_date: NaiveDate,
    #[serde(default)]
    pub compare_year_offset: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反序列化契约：backend `/seasonal-replenishment-analysis` 真实响应形态
    /// （含同比字段 + 缺省字段容忍）
    #[test]
    fn seasonal_response_deserializes_backend_shape() {
        let json = r#"{
            "items": [
                {
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "sku": "SKU-A",
                    "country": "US",
                    "asin": "B0TEST123",
                    "product_name": "测试产品",
                    "available_inventory": 100,
                    "in_transit_quantity": 50,
                    "dms_90": 1.5,
                    "dms_30": 2.0,
                    "dms_14": 2.5,
                    "dms_7": 3.0,
                    "dms_90_yoy": 1.2,
                    "dms_30_yoy": 1.8,
                    "dms_14_yoy": 2.2,
                    "dms_7_yoy": 2.6,
                    "base_dms": 1.85,
                    "weighted_dms": 2.4,
                    "sellable_days": 41.67,
                    "sellout_date": "2026-09-26",
                    "sellout_date_with_transit": "2026-10-17",
                    "production_lead_days": 30,
                    "shipping_days": 35,
                    "estimated_replenishment_quantity": 156
                },
                {
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "sku": "SKU-B",
                    "country": "US",
                    "available_inventory": 0,
                    "in_transit_quantity": 0,
                    "production_lead_days": 30,
                    "shipping_days": 35
                }
            ],
            "summary": {
                "sku_count": 2,
                "out_of_stock_risk_count": 0,
                "healthy_count": 1,
                "slow_moving_count": 0,
                "pending_data_count": 1,
                "total_available_inventory": 100,
                "total_in_transit_quantity": 50
            },
            "page": 1,
            "page_size": 200,
            "total": 2,
            "has_next": false,
            "from_date": "2026-05-18",
            "to_date": "2026-08-15",
            "compare_year_offset": 1
        }"#;
        let resp: SeasonalReplenishmentResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].sku, "SKU-A");
        assert_eq!(resp.items[0].dms_90, Some(1.5));
        assert_eq!(resp.items[0].dms_7_yoy, Some(2.6));
        assert_eq!(resp.items[0].estimated_replenishment_quantity, Some(156));
        // 缺省字段（asin / product_name / 各 DMS / 售卖截止）容忍反序列化
        assert_eq!(resp.items[1].asin, None);
        assert_eq!(resp.items[1].product_name, None);
        assert_eq!(resp.items[1].dms_90, None);
        assert_eq!(resp.items[1].sellout_date, None);
        assert_eq!(resp.items[1].estimated_replenishment_quantity, None);
        // summary 基础字段
        assert_eq!(resp.summary.sku_count, 2);
        assert_eq!(resp.summary.healthy_count, 1);
        assert_eq!(resp.summary.pending_data_count, 1);
        assert_eq!(resp.summary.total_available_inventory, 100);
        // 分页 + 窗口回显
        assert_eq!(resp.total, 2);
        assert!(!resp.has_next);
        assert_eq!(
            resp.from_date,
            NaiveDate::from_ymd_opt(2026, 5, 18).expect("合法日期")
        );
        assert_eq!(
            resp.to_date,
            NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期")
        );
        assert_eq!(resp.compare_year_offset, 1);
    }

    /// `compare_year_offset` 缺省（backend 默认 0）→ 0
    #[test]
    fn seasonal_response_defaults_compare_offset_to_zero() {
        let json = r#"{
            "items": [],
            "summary": {
                "sku_count": 0,
                "out_of_stock_risk_count": 0,
                "healthy_count": 0,
                "slow_moving_count": 0,
                "pending_data_count": 0,
                "total_available_inventory": 0,
                "total_in_transit_quantity": 0
            },
            "page": 1,
            "page_size": 200,
            "total": 0,
            "has_next": false,
            "from_date": "2026-05-18",
            "to_date": "2026-08-15"
        }"#;
        let resp: SeasonalReplenishmentResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.compare_year_offset, 0);
        assert!(resp.items.is_empty());
        assert_eq!(resp.summary.sku_count, 0);
    }
}
