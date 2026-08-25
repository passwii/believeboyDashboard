//! 报表中心 → 定时报告领域类型（P3-5，BLF-705）
//!
//! 数据源：
//! - `GET /api/v1/scheduled-reports/subscriptions` —— 订阅列表
//!   （frontend `app/dashboard/reports/scheduled-reports/_components/api.ts`
//!   `fetchSubscriptions` 同口径）；
//! - `GET /api/v1/scheduled-reports/ledger` —— 调度台账
//!   （frontend `fetchLedger` 同口径，query：`start_date` / `end_date` /
//!   `frequency` / `status_filter` / `email` / `limit`）。
//!
//! 字段命名沿用后端 Pydantic 模型（snake_case）1:1，逐一对照
//! `backend/app/schemas/scheduled_report.py`；后端模型带默认值的字段
//! （`dispatch_hour=15` / `ai_summary_status="pending"` 等）用
//! `#[serde(default)]` 容忍缺省，保证存量 / 字段缺失场景可反序列化。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 订阅条目（backend `SubscriptionItem` 1:1；`from_attributes` 输出全部字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Subscription {
    pub id: i64,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub email: Option<String>,
    pub project_ids: String,
    pub country: String,
    pub frequency: String,
    #[serde(default)]
    pub dispatch_hour: i64,
    #[serde(default)]
    pub dispatch_minute: i64,
    #[serde(default)]
    pub dispatch_weekday: Option<i64>,
    #[serde(default)]
    pub dispatch_day: Option<i64>,
    #[serde(default)]
    pub ai_model: Option<String>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 订阅列表响应（backend `SubscriptionListResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionListResponse {
    pub items: Vec<Subscription>,
    pub total: i64,
}

/// 台账汇总（backend `LedgerSummary` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerSummary {
    pub expected: i64,
    pub sent: i64,
    pub failed: i64,
    pub missing: i64,
    pub resendable: i64,
}

fn default_ai_summary_status() -> String {
    "pending".to_string()
}

/// 台账条目（backend `LedgerItem` 1:1）
///
/// `status` 取值：`sent` / `failed` / `missing`；`frequency` 取值：
/// `daily` / `weekly` / `monthly`；`ai_summary_status` 取值：
/// `pending` / `generating` / `done` / `failed`（后端有默认值，容忍缺省）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerItem {
    pub id: i64,
    pub ledger_key: String,
    /// 预计日期（`yyyy-MM-dd`，上海时区口径；台账按日分组的键）
    pub expected_date: String,
    pub expected_at: DateTime<Utc>,
    pub frequency: String,
    pub subscription_id: i64,
    #[serde(default)]
    pub email: Option<String>,
    pub project_ids: String,
    #[serde(default)]
    pub project_names: Vec<String>,
    pub country: String,
    pub status: String,
    #[serde(default)]
    pub latest_delivery_log_id: Option<i64>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub sent_at: Option<DateTime<Utc>>,
    pub can_resend: bool,
    #[serde(default)]
    pub last_checked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub screenshot_r2_url: Option<String>,
    #[serde(default)]
    pub screenshot_r2_thumb_url: Option<String>,
    #[serde(default)]
    pub ai_summary: Option<String>,
    #[serde(default = "default_ai_summary_status")]
    pub ai_summary_status: String,
    #[serde(default)]
    pub ai_summary_error: Option<String>,
    #[serde(default)]
    pub ai_summary_model: Option<String>,
    #[serde(default)]
    pub ai_summary_updated_at: Option<DateTime<Utc>>,
}

/// 台账列表响应（backend `LedgerListResponse` 1:1；`total` 可能 > 已加载行数）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerListResponse {
    pub items: Vec<LedgerItem>,
    pub total: i64,
    pub summary: LedgerSummary,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：订阅条目按 backend `SubscriptionItem` 真实响应形态反序列化，
    /// 缺省字段（dispatch_weekday / dispatch_day / ai_model）容忍缺失。
    #[test]
    fn subscription_deserializes_subscription_item_sample() {
        let json = r#"{
            "id": 5,
            "user_id": 3,
            "email": "ops@believeboy.com",
            "project_ids": "1,2",
            "country": "US",
            "frequency": "daily",
            "dispatch_hour": 15,
            "dispatch_minute": 0,
            "dispatch_weekday": null,
            "dispatch_day": null,
            "ai_model": "deepseek-v4",
            "enabled": true,
            "created_at": "2026-08-14T03:00:00Z",
            "updated_at": "2026-08-15T04:00:00+08:00"
        }"#;
        let s: Subscription = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(s.id, 5);
        assert_eq!(s.frequency, "daily");
        assert_eq!(s.dispatch_hour, 15);
        assert!(s.enabled);
        assert_eq!(s.ai_model.as_deref(), Some("deepseek-v4"));
        // tz-aware 时间正常解析（含 +08:00 偏移 → 自动转 UTC）
        assert_eq!(s.updated_at.timestamp(), 1786737600);
    }

    /// 契约：台账条目按 backend `LedgerItem` 真实响应形态反序列化，
    /// 缺省字段（screenshot / ai_summary / sent_at 等）容忍缺失。
    #[test]
    fn ledger_item_deserializes_ledger_item_sample() {
        let json = r#"{
            "id": 11,
            "ledger_key": "5:2026-08-15",
            "expected_date": "2026-08-15",
            "expected_at": "2026-08-15T15:00:00+08:00",
            "frequency": "daily",
            "subscription_id": 5,
            "email": "ops@believeboy.com",
            "project_ids": "1,2",
            "project_names": ["项目 A", "项目 B"],
            "country": "US",
            "status": "sent",
            "latest_delivery_log_id": 88,
            "error_message": null,
            "sent_at": "2026-08-15T07:02:00Z",
            "can_resend": false,
            "last_checked_at": "2026-08-15T07:02:00Z",
            "screenshot_r2_url": "https://r2.example.com/shot.png",
            "screenshot_r2_thumb_url": null,
            "ai_summary": "本周销售环比 +12%",
            "ai_summary_status": "done",
            "ai_summary_error": null,
            "ai_summary_model": "deepseek-v4",
            "ai_summary_updated_at": "2026-08-15T07:02:30Z"
        }"#;
        let item: LedgerItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.ledger_key, "5:2026-08-15");
        assert_eq!(item.status, "sent");
        assert_eq!(item.project_names.len(), 2);
        assert_eq!(
            item.screenshot_r2_url.as_deref(),
            Some("https://r2.example.com/shot.png")
        );
        assert_eq!(item.ai_summary_status, "done");
        assert!(!item.can_resend);
    }

    /// 契约：台账条目最小载荷（无 delivery_log / 无截图）也能反序列化。
    #[test]
    fn ledger_item_tolerates_minimal_payload() {
        let json = r#"{
            "id": 12,
            "ledger_key": "6:2026-08-14",
            "expected_date": "2026-08-14",
            "expected_at": "2026-08-14T15:00:00+08:00",
            "frequency": "weekly",
            "subscription_id": 6,
            "email": null,
            "project_ids": "*",
            "project_names": [],
            "country": "DE",
            "status": "missing",
            "latest_delivery_log_id": null,
            "error_message": null,
            "sent_at": null,
            "can_resend": true,
            "last_checked_at": "2026-08-14T05:00:00Z"
        }"#;
        let item: LedgerItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.status, "missing");
        assert!(item.can_resend);
        assert_eq!(item.screenshot_r2_url, None);
        assert_eq!(item.ai_summary, None);
        // ai_summary_status 缺省 → "pending"
        assert_eq!(item.ai_summary_status, "pending");
        assert!(item.project_names.is_empty());
    }

    /// 契约：台账汇总 + 列表响应形态（LedgerListResponse 1:1）
    #[test]
    fn ledger_list_response_deserializes() {
        let json = r#"{
            "items": [],
            "total": 0,
            "summary": {"expected": 14, "sent": 12, "failed": 1, "missing": 1, "resendable": 2}
        }"#;
        let resp: LedgerListResponse = serde_json::from_str(json).expect("反序列化失败");
        assert!(resp.items.is_empty());
        assert_eq!(resp.total, 0);
        assert_eq!(resp.summary.expected, 14);
        assert_eq!(resp.summary.resendable, 2);
    }
}
