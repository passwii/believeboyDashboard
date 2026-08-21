//! 订单信息领域类型（P5-4，BLF-731）
//!
//! 报表中心 → 订单信息。字段对齐 backend `backend/app/schemas/order_info.py`
//! 的 Pydantic 模型（`OrderInfoItem` / `OrderInfoStats` / `OrderInfoOverview` /
//! `OrderInfoFilterOptions` / `OrderInfoExportResponse` / `OrderInfoUpdate`），
//! 数据源为 Amazon 按 SKU 订单报告（`AnalysisSalesOrderRow`）。
//!
//! 时间字段沿用后端序列化契约以字符串承载：
//! - `purchase_at_utc` / `created_at` / `shipped_at` / `updated_at`：UTC ISO8601
//!   （后端 `_serialize_utc` 强制 UTC 发出，视图层负责转北京时间展示）；
//! - `purchase_at_pt`：PT naive datetime ISO（无时区后缀，原样）；
//! - `purchase_date_pt`：`YYYY-MM-DD`（PT 日期，按日聚合口径）。

use serde::{Deserialize, Serialize};

/// 单条订单（一条 = 一个 SKU 行；backend `OrderInfoItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderInfoItem {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    #[serde(default)]
    pub brand_name: Option<String>,
    pub source_file_id: i64,
    /// UTC ISO8601（后端强制 UTC 发出）
    pub purchase_at_utc: String,
    /// PT naive datetime ISO（无时区后缀）
    pub purchase_at_pt: String,
    /// `YYYY-MM-DD`，PT 日期
    pub purchase_date_pt: String,
    pub amazon_order_id: String,
    pub order_status: String,
    /// Amazon 原始：FBA=`Amazon`，FBM=`Merchant`
    pub fulfillment_channel: String,
    /// `FBA（亚马逊配送）` | `FBM（自发货配送）`
    pub fulfillment_label: String,
    #[serde(default)]
    pub ship_service_level: Option<String>,
    #[serde(default)]
    pub sku: Option<String>,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub product_name: Option<String>,
    pub quantity: i64,
    pub item_price: f64,
    pub shipping_price: f64,
    #[serde(default)]
    pub currency: Option<String>,
    pub country: String,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub postal_code: Option<String>,
    pub is_counted_sales: bool,
    pub created_at: String,
    // ===== FBM 自发货补录字段（迁移 20260627_200 新增）=====
    #[serde(default)]
    pub carrier: Option<String>,
    #[serde(default)]
    pub tracking_no: Option<String>,
    /// UTC ISO8601；`None` = 未补录
    #[serde(default)]
    pub shipped_at: Option<String>,
    #[serde(default)]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl OrderInfoItem {
    /// FBM 自发货（Amazon 原始 `Merchant`）；FBM 物流列 / 编辑入口的判定
    pub fn is_fbm(&self) -> bool {
        self.fulfillment_channel == "Merchant"
    }
}

/// 顶部统计（backend `OrderInfoStats` 1:1；数值字段后端有默认 0）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderInfoStats {
    #[serde(default)]
    pub total_orders: i64,
    #[serde(default)]
    pub total_quantity: i64,
    #[serde(default)]
    pub total_amount: f64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub fba_count: i64,
    #[serde(default)]
    pub fbm_count: i64,
}

/// `/overview` 一次返回 列表 + 统计（backend `OrderInfoOverview` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderInfoOverview {
    pub items: Vec<OrderInfoItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub stats: OrderInfoStats,
}

/// 筛选下拉单项（backend `FilterOption` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderInfoFilterOption {
    pub value: String,
    pub label: String,
}

/// 筛选下拉选项（backend `OrderInfoFilterOptions` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderInfoFilterOptions {
    pub projects: Vec<OrderInfoFilterOption>,
    pub order_statuses: Vec<OrderInfoFilterOption>,
    pub fulfillment_channels: Vec<OrderInfoFilterOption>,
    pub countries: Vec<OrderInfoFilterOption>,
    pub currencies: Vec<OrderInfoFilterOption>,
}

/// 导出 CSV 响应（backend `OrderInfoExportResponse` 1:1；GUI 暂只透传给 web 端）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderInfoExportResponse {
    pub filename: String,
    pub content_type: String,
    /// utf-8 csv 内容 base64 编码
    pub content_base64: String,
}

// ---------------------------------------------------------------------------
// 展示辅助（对齐 web `lib/order-status.ts` / `lib/country.ts` 公共映射）
// ---------------------------------------------------------------------------

/// 亚马逊订单状态 → 中文展示标签（对齐 web `getOrderStatusLabel`）。
/// 大小写不敏感；`Canceled`/`Cancelled` 两种拼写都识别；未识别状态原样返回。
pub fn order_status_label(status: &str) -> &str {
    match status.trim() {
        "" => "—",
        s => {
            let key = format!(
                "{}{}",
                s.chars().next().map(|c| c.to_ascii_uppercase()).unwrap_or('_'),
                s.chars().skip(1).map(|c| c.to_ascii_lowercase()).collect::<String>()
            );
            match key.as_str() {
                "Pending" => "处理中",
                "Shipping" => "发货中",
                "Shipped" => "已发货",
                "Cancelled" | "Canceled" => "已取消",
                _ => s,
            }
        }
    }
}

/// 国家代码 → 中文站点名（对齐 web `COUNTRY_LABELS`；未知代码原样返回）。
pub fn country_label(code: &str) -> String {
    match code.to_ascii_uppercase().as_str() {
        "US" => "美国站".into(),
        "DE" => "德国站".into(),
        "UK" => "英国站".into(),
        "JP" => "日本站".into(),
        "FR" => "法国站".into(),
        "IT" => "意大利站".into(),
        "ES" => "西班牙站".into(),
        "CA" => "加拿大站".into(),
        "MX" => "墨西哥站".into(),
        "AU" => "澳大利亚站".into(),
        "IN" => "印度站".into(),
        "BR" => "巴西站".into(),
        "NL" => "荷兰站".into(),
        "SE" => "瑞典站".into(),
        "PL" => "波兰站".into(),
        "TR" => "土耳其站".into(),
        "SG" => "新加坡站".into(),
        "AE" => "阿联酋站".into(),
        "BE" => "比利时站".into(),
        "SA" => "沙特站".into(),
        other => other.to_string(),
    }
}

/// 国家筛选选项（对齐 web `COUNTRY_OPTIONS`：`美国站 (US)` 格式）
pub const COUNTRY_FILTER_OPTIONS: [(&str, &str); 20] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
    ("JP", "日本站 (JP)"),
    ("FR", "法国站 (FR)"),
    ("IT", "意大利站 (IT)"),
    ("ES", "西班牙站 (ES)"),
    ("CA", "加拿大站 (CA)"),
    ("MX", "墨西哥站 (MX)"),
    ("AU", "澳大利亚站 (AU)"),
    ("IN", "印度站 (IN)"),
    ("BR", "巴西站 (BR)"),
    ("NL", "荷兰站 (NL)"),
    ("SE", "瑞典站 (SE)"),
    ("PL", "波兰站 (PL)"),
    ("TR", "土耳其站 (TR)"),
    ("SG", "新加坡站 (SG)"),
    ("AE", "阿联酋站 (AE)"),
    ("BE", "比利时站 (BE)"),
    ("SA", "沙特站 (SA)"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_item_deserializes_with_defaults() {
        let item: OrderInfoItem = serde_json::from_str(
            r#"{
                "id": 1, "project_id": 3, "project_name": "测试店铺",
                "source_file_id": 9,
                "purchase_at_utc": "2026-08-20T06:23:00+00:00",
                "purchase_at_pt": "2026-08-19T23:23:00",
                "purchase_date_pt": "2026-08-19",
                "amazon_order_id": "111-3084457-2750632",
                "order_status": "Shipped",
                "fulfillment_channel": "Amazon",
                "fulfillment_label": "FBA（亚马逊配送）",
                "quantity": 2, "item_price": 25.98, "shipping_price": 0.0,
                "country": "US", "is_counted_sales": true,
                "created_at": "2026-08-21T00:00:00+00:00"
            }"#,
        )
        .expect("反序列化失败");
        assert_eq!(item.id, 1);
        assert_eq!(item.sku, None);
        assert_eq!(item.brand_name, None);
        assert!(!item.is_fbm());
        assert_eq!(item.shipped_at, None);
    }

    #[test]
    fn is_fbm_matches_merchant_channel() {
        let mut item = serde_json::from_str::<OrderInfoItem>(
            r#"{
                "id": 1, "project_id": 3, "project_name": "测试店铺",
                "source_file_id": 9,
                "purchase_at_utc": "2026-08-20T06:23:00+00:00",
                "purchase_at_pt": "2026-08-19T23:23:00",
                "purchase_date_pt": "2026-08-19",
                "amazon_order_id": "111-3084457-2750632",
                "order_status": "Shipped",
                "fulfillment_channel": "Merchant",
                "fulfillment_label": "FBM（自发货配送）",
                "quantity": 2, "item_price": 25.98, "shipping_price": 0.0,
                "country": "US", "is_counted_sales": true,
                "created_at": "2026-08-21T00:00:00+00:00"
            }"#,
        )
        .expect("反序列化失败");
        assert!(item.is_fbm());
        item.fulfillment_channel = "Amazon".into();
        assert!(!item.is_fbm());
    }

    #[test]
    fn overview_parses_with_stats() {
        let overview: OrderInfoOverview = serde_json::from_str(
            r#"{
                "items": [], "total": 0, "page": 1, "page_size": 50,
                "stats": {"total_orders": 12, "total_quantity": 34,
                          "total_amount": 567.89, "currency": "USD",
                          "fba_count": 10, "fbm_count": 2}
            }"#,
        )
        .expect("反序列化失败");
        assert_eq!(overview.stats.total_orders, 12);
        assert_eq!(overview.stats.currency.as_deref(), Some("USD"));
    }

    #[test]
    fn order_status_label_maps_known_statuses() {
        assert_eq!(order_status_label("Pending"), "处理中");
        assert_eq!(order_status_label("pending"), "处理中");
        assert_eq!(order_status_label("Shipping"), "发货中");
        assert_eq!(order_status_label("Shipped"), "已发货");
        assert_eq!(order_status_label("Cancelled"), "已取消");
        assert_eq!(order_status_label("Canceled"), "已取消");
        assert_eq!(order_status_label(""), "—");
        // 未识别状态原样返回（保留可观测性）
        assert_eq!(order_status_label("WeirdStatus"), "WeirdStatus");
    }

    #[test]
    fn country_label_maps_known_codes_and_passthrough_unknown() {
        assert_eq!(country_label("US"), "美国站");
        assert_eq!(country_label("uk"), "英国站");
        assert_eq!(country_label("XX"), "XX");
    }
}
