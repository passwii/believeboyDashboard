//! 财务资金领域类型（P3-4，BLF-704）
//!
//! 平台回款数据源：FastAPI `/api/v1/platform-revenues`。
//! 字段对齐 frontend `app/dashboard/finance/platform-revenue/page.tsx` 的
//! `PlatformRevenue` 接口，再逐一对照后端 `backend/app/schemas/platform_revenue.py`
//! 的 Pydantic 模型。

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// 回款附件（backend `PlatformRevenueAttachment` 1:1；`stored_path` 缺省容忍）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformRevenueAttachment {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub size: i64,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub stored_path: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub thumb_url: Option<String>,
}

/// 平台回款条目（backend `PlatformRevenueItem` 1:1）
///
/// `exchange_rate` / `note` / `screenshot_r2_*` 缺省容忍（老数据可能没有）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformRevenueItem {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub received_date: NaiveDate,
    /// 后端为 Decimal，序列化为字符串（如 "11693.69"）；用字符串承载避免精度损失
    pub amount: String,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default)]
    pub exchange_rate: Option<f64>,
    #[serde(default = "default_revenue_type")]
    pub revenue_type: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub attachments: Vec<PlatformRevenueAttachment>,
    #[serde(default)]
    pub screenshot_r2_key: Option<String>,
    #[serde(default)]
    pub screenshot_r2_url: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 平台回款分页响应（backend `PlatformRevenueListResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlatformRevenueListResponse {
    pub items: Vec<PlatformRevenueItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub total_pages: i64,
}

fn default_currency() -> String {
    "USD".to_string()
}

fn default_revenue_type() -> String {
    "订单回款".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// backend `/platform-revenues` 的真实响应形态（含附件数组）
    #[test]
    fn platform_revenue_list_deserializes_backend_sample() {
        let json = r#"{
            "items": [
                {
                    "id": 12,
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "received_date": "2026-08-05",
                    "amount": "11693.69",
                    "currency": "USD",
                    "exchange_rate": null,
                    "revenue_type": "订单回款",
                    "note": null,
                    "attachments": [
                        {
                            "id": "att-1",
                            "filename": "回款截图.png",
                            "url": "https://cdn.example.com/a.png",
                            "size": 20480,
                            "created_at": "2026-08-05T10:00:00Z",
                            "stored_path": "platform-revenue/att-1.png"
                        }
                    ],
                    "screenshot_r2_key": null,
                    "screenshot_r2_url": null,
                    "created_by": "甲",
                    "created_at": "2026-08-05T10:00:00Z",
                    "updated_at": "2026-08-05T10:00:00Z"
                }
            ],
            "total": 1,
            "page": 1,
            "page_size": 20,
            "total_pages": 1
        }"#;
        let resp: PlatformRevenueListResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.total, 1);
        assert_eq!(resp.page_size, 20);
        assert_eq!(resp.items.len(), 1);
        let item = &resp.items[0];
        assert_eq!(item.id, 12);
        assert_eq!(item.project_name, "测试项目 A");
        assert_eq!(item.received_date.to_string(), "2026-08-05");
        assert_eq!(item.amount, "11693.69");
        assert_eq!(item.currency, "USD");
        assert_eq!(item.revenue_type, "订单回款");
        // 缺省字段容忍
        assert_eq!(item.exchange_rate, None);
        assert_eq!(item.note, None);
        assert_eq!(item.attachments.len(), 1);
        assert_eq!(item.attachments[0].filename, "回款截图.png");
        assert_eq!(
            item.attachments[0].stored_path.as_deref(),
            Some("platform-revenue/att-1.png")
        );
    }

    /// 老数据无 currency / revenue_type / attachments 时也能反序列化（Pydantic 默认值）
    #[test]
    fn platform_revenue_item_tolerates_missing_defaulted_fields() {
        let json = r#"{
            "id": 1,
            "project_id": 1,
            "project_name": "P",
            "country": "US",
            "received_date": "2026-01-01",
            "amount": "100.00",
            "created_by": "x",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#;
        let item: PlatformRevenueItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.currency, "USD");
        assert_eq!(item.revenue_type, "订单回款");
        assert!(item.attachments.is_empty());
    }
}
