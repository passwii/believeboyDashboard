//! 补货分析 DTO（对齐 backend `app/schemas/inventory_replenishment.py` 补货分析段）
//!
//! Web 参照：`frontend/app/dashboard/operations/inventory-replenishment/`。
//! GUI 首版按 macOS 习惯简化（issue BLF-721 允许）：只做**实时补货分析**主表
//! （`/inventory-replenishment-analysis`），快照模式 / 日历视图 / 决策驾驶舱 tab /
//! Excel 导出 / 内联参数编辑暂不迁移；DTO 仅保留主表 + 汇总所需字段，后端可选字段
//! 一律 `#[serde(default)]` 容错。字段 snake_case 1:1（backend Pydantic 默认
//! snake_case 输出，与 `operations/inventory.rs` 同口径）。

use serde::{Deserialize, Serialize};

/// 补货分析单行（对齐 `InventoryReplenishmentListItem` 的 GUI 消费子集）
///
/// 后端字段全部 camelCase；GUI 不展示的字段（age bucket / signals / decision_path
/// 等）不建模——serde 默认忽略未知字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplenishmentItem {
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
    pub dms_30: Option<f64>,
    #[serde(default)]
    pub dms_14: Option<f64>,
    #[serde(default)]
    pub dms_7: Option<f64>,
    #[serde(default)]
    pub dms_3: Option<f64>,
    #[serde(default)]
    pub base_dms: Option<f64>,
    pub safety_factor: f64,
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
    pub replenishment_order_date: Option<String>,
    #[serde(default)]
    pub warehouse_entry_date: Option<String>,
    #[serde(default)]
    pub estimated_replenishment_quantity: Option<i64>,
    pub risk_status: String,
    /// v1.2 三段式判断维度（critical/deteriorating/watch/healthy/unknown）
    #[serde(default = "default_inventory_state")]
    pub inventory_state: String,
    /// v1.2 动作维度（ReplenishmentAction 枚举值）
    #[serde(default = "default_replenishment_action")]
    pub replenishment_action: String,
    /// BLF-630：最晚下单日（补货周期锚点）
    #[serde(default)]
    pub latest_order_date: Option<String>,
    /// BLF-630：目标覆盖天数（补货量动态化基准）
    #[serde(default = "default_target_days")]
    pub target_days: i64,
}

fn default_inventory_state() -> String {
    "unknown".to_string()
}

fn default_replenishment_action() -> String {
    "NO_ACTION".to_string()
}

fn default_target_days() -> i64 {
    90
}

/// 补货分析汇总（对齐 `InventoryReplenishmentSummary` 的 GUI 消费子集）
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReplenishmentSummary {
    #[serde(default)]
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
    /// v1.2 三段式计数
    #[serde(default)]
    pub critical_count: i64,
    #[serde(default)]
    pub deteriorating_count: i64,
}

/// 补货分析响应（对齐 `InventoryReplenishmentListResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplenishmentResponse {
    pub items: Vec<ReplenishmentItem>,
    pub summary: ReplenishmentSummary,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub has_next: bool,
}

// ---------------------------------------------------------------------------
// 展示助手（对齐 web riskMeta / stateMeta / actionMeta 文案）
// ---------------------------------------------------------------------------

/// 风险状态展示文案（web `riskMeta` 的 label 部分；未知值原样返回）
pub fn risk_label(risk_status: &str) -> &str {
    match risk_status {
        "长期断货" | "短期断货" | "断货风险" | "健康库存" | "滞销" | "严重滞销" | "待补数据" => {
            risk_status
        }
        other => other,
    }
}

/// 三段式 state 展示文案（web `stateMeta`）
pub fn state_label(state: &str) -> &str {
    match state {
        "critical" => "危险",
        "deteriorating" => "趋势转差",
        "watch" => "关注",
        "healthy" => "健康",
        _ => "数据缺失",
    }
}

/// 补货动作展示文案（web `actionMeta`；枚举值对齐 backend `ReplenishmentAction`）
pub fn action_label(action: &str) -> &str {
    match action {
        "REPLENISH_NOW" => "紧急补货",
        "REPLENISH_NORMAL" => "按计划补货",
        "HOLD" => "暂停补货",
        "REDUCE_PRICE" => "降价清货",
        "REMOVE" => "创建移除订单",
        "NO_ACTION" => "不动",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：snake_case 反序列化 + 可选字段缺省容错（后端精简响应不炸）
    #[test]
    fn parses_minimal_item() {
        let json = r#"{
            "project_id": 1,
            "project_name": "P1",
            "sku": "SKU-1",
            "country": "US",
            "available_inventory": 100,
            "in_transit_quantity": 20,
            "safety_factor": 1.2,
            "production_lead_days": 30,
            "shipping_days": 35,
            "risk_status": "断货风险"
        }"#;
        let item: ReplenishmentItem = serde_json::from_str(json).expect("解析失败");
        assert_eq!(item.sku, "SKU-1");
        assert_eq!(item.inventory_state, "unknown");
        assert_eq!(item.replenishment_action, "NO_ACTION");
        assert_eq!(item.target_days, 90);
        assert_eq!(item.dms_30, None);
    }

    /// 契约：完整响应解析（items + summary + 分页字段）
    #[test]
    fn parses_full_response() {
        let json = r#"{
            "items": [{
                "project_id": 1, "project_name": "P1", "sku": "S", "country": "US",
                "asin": "B0001", "product_name": "产品",
                "available_inventory": 5, "in_transit_quantity": 0,
                "dms_30": 2.5, "weighted_dms": 2.1, "sellable_days": 2.4,
                "sellout_date": "2026-08-20", "safety_factor": 1.0,
                "production_lead_days": 30, "shipping_days": 40,
                "estimated_replenishment_quantity": 300,
                "risk_status": "短期断货", "inventory_state": "critical",
                "replenishment_action": "REPLENISH_NOW",
                "latest_order_date": "2026-08-18", "target_days": 60
            }],
            "summary": {
                "sku_count": 1, "out_of_stock_risk_count": 1, "healthy_count": 0,
                "slow_moving_count": 0, "pending_data_count": 0,
                "total_available_inventory": 5, "total_in_transit_quantity": 0,
                "critical_count": 1, "deteriorating_count": 0
            },
            "page": 1, "page_size": 50, "total": 1, "has_next": false
        }"#;
        let resp: ReplenishmentResponse = serde_json::from_str(json).expect("解析失败");
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.summary.critical_count, 1);
        assert_eq!(resp.items[0].replenishment_action, "REPLENISH_NOW");
        assert!(!resp.has_next);
    }

    /// 展示助手：已知/未知值
    #[test]
    fn label_helpers() {
        assert_eq!(risk_label("断货风险"), "断货风险");
        assert_eq!(risk_label("自定义"), "自定义");
        assert_eq!(state_label("critical"), "危险");
        assert_eq!(state_label("bogus"), "数据缺失");
        assert_eq!(action_label("REPLENISH_NOW"), "紧急补货");
        assert_eq!(action_label("X"), "X");
    }
}
