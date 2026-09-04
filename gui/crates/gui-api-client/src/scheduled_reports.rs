//! 定时报告相关 API
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/scheduled_reports.py`，
//! 与 frontend `app/dashboard/reports/scheduled-reports/_components/api.ts`
//! 调用口径一致）：
//! - `subscriptions` → `GET /api/v1/scheduled-reports/subscriptions`
//!   （frontend `fetchSubscriptions`：无 query，返回 `{ items, total }`）
//! - `ledger`        → `GET /api/v1/scheduled-reports/ledger`
//!   （frontend `fetchLedger`：query `start_date` / `end_date` / `frequency` /
//!   `status_filter` / `email` / `limit`，返回 `{ items, total, summary }`）
//!
//! 只读：本模块仅提供查看能力；订阅增删改 / 重发 / AI 摘要重新生成等写操作
//! 不在 GUI 范围内（P3-5 范围边界：不触发生成 / 重发，仅查看）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id`（backend `protected` 依赖读取，见 client.rs）；生产后端
//! `require_api_key` 走 `Authorization: Bearer`（`BELIEVEBOY_TOKEN`）。

use chrono::NaiveDate;
use gui_domain::scheduled_reports::{LedgerListResponse, SubscriptionListResponse};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /scheduled-reports/subscriptions` —— 订阅列表
const SUBSCRIPTIONS_PATH: &str = "/api/v1/scheduled-reports/subscriptions";

/// `GET /scheduled-reports/ledger` —— 调度台账
const LEDGER_PATH: &str = "/api/v1/scheduled-reports/ledger";

impl Client {
    /// 订阅列表（查看订阅：频率 / 发送计划 / 国家 / 项目 / 邮箱 / 启用状态）。
    ///
    /// 对齐 frontend `fetchSubscriptions`：`GET /scheduled-reports/subscriptions`
    /// 无 query 参数，返回 `{ items, total }`（backend 按当前操作人过滤）。
    pub async fn list_subscriptions(&self) -> Result<SubscriptionListResponse, ApiError> {
        self.get_json(SUBSCRIPTIONS_PATH, &[]).await
    }

    /// 调度台账（按天分组的调度记录：状态 / 预计时间 / 项目 / 截图 / AI 摘要）。
    ///
    /// 对齐 frontend `fetchLedger` 的 query 口径：`start_date` / `end_date`
    /// 必填（`yyyy-MM-dd`）；`frequency` / `status_filter` 传 `"all"` 表示不限；
    /// `email` 可选（传空串时省略）；`limit` 后端解释为「最近多少天」，
    /// 范围上限 500（frontend 按时间范围天数传，UI 预设最多 90 天）。
    pub async fn list_ledger(
        &self,
        start_date: NaiveDate,
        end_date: NaiveDate,
        frequency: &str,
        status_filter: &str,
        email: Option<&str>,
        limit: i64,
    ) -> Result<LedgerListResponse, ApiError> {
        let mut query = vec![
            ("start_date", start_date.to_string()),
            ("end_date", end_date.to_string()),
            ("frequency", frequency.to_string()),
            ("status_filter", status_filter.to_string()),
            ("limit", limit.clamp(1, 500).to_string()),
        ];
        if let Some(email) = email.filter(|e| !e.trim().is_empty()) {
            query.push(("email", email.trim().to_string()));
        }
        self.get_json(LEDGER_PATH, &query).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 契约：路径锁定 backend 实际路由
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(
            SUBSCRIPTIONS_PATH,
            "/api/v1/scheduled-reports/subscriptions"
        );
        assert_eq!(LEDGER_PATH, "/api/v1/scheduled-reports/ledger");
    }

    /// 契约：订阅列表无 query、解析 `{ items, total }`
    #[tokio::test]
    async fn list_subscriptions_sends_no_query_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SUBSCRIPTIONS_PATH)
            .match_query(Matcher::Regex(r"^$".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
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
                            "ai_model": null,
                            "enabled": true,
                            "created_at": "2026-08-14T03:00:00Z",
                            "updated_at": "2026-08-15T04:00:00+08:00"
                        },
                        {
                            "id": 6,
                            "user_id": 3,
                            "email": null,
                            "project_ids": "*",
                            "country": "DE",
                            "frequency": "weekly",
                            "dispatch_hour": 16,
                            "dispatch_minute": 0,
                            "dispatch_weekday": 0,
                            "dispatch_day": null,
                            "ai_model": "deepseek-v4",
                            "enabled": false,
                            "created_at": "2026-08-10T02:00:00Z",
                            "updated_at": "2026-08-13T05:00:00Z"
                        }
                    ],
                    "total": 2
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let resp = client.list_subscriptions().await.expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 2);
        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].frequency, "daily");
        assert_eq!(resp.items[0].dispatch_hour, 15);
        assert!(resp.items[0].enabled);
        assert_eq!(resp.items[1].frequency, "weekly");
        assert_eq!(resp.items[1].dispatch_weekday, Some(0));
        assert!(!resp.items[1].enabled);
    }

    /// 契约：台账 query 全量携带（start/end/frequency/status/limit），
    /// email 空串时省略
    #[tokio::test]
    async fn list_ledger_sends_query_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("start_date".into(), "2026-08-09".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-15".into()),
                Matcher::UrlEncoded("frequency".into(), "all".into()),
                Matcher::UrlEncoded("status_filter".into(), "sent".into()),
                Matcher::UrlEncoded("limit".into(), "7".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
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
                        }
                    ],
                    "total": 7,
                    "summary": {"expected": 14, "sent": 12, "failed": 1, "missing": 1, "resendable": 2}
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 9).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        let resp = client
            .list_ledger(start, end, "all", "sent", Some(""), 7)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 7);
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].ledger_key, "5:2026-08-15");
        assert_eq!(resp.items[0].status, "sent");
        assert_eq!(resp.items[0].ai_summary_status, "done");
        assert_eq!(resp.summary.sent, 12);
        assert_eq!(resp.summary.resendable, 2);
    }

    /// 契约：email 非空时携带；limit 超出后端上限 500 时收敛到 500
    #[tokio::test]
    async fn list_ledger_sends_email_and_clamps_limit() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("start_date".into(), "2026-08-01".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-15".into()),
                Matcher::UrlEncoded("frequency".into(), "weekly".into()),
                Matcher::UrlEncoded("status_filter".into(), "all".into()),
                Matcher::UrlEncoded("email".into(), "ops@believeboy.com".into()),
                Matcher::UrlEncoded("limit".into(), "500".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [], "total": 0, "summary": {"expected": 0, "sent": 0, "failed": 0, "missing": 0, "resendable": 0}}"#,
            )
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        let resp = client
            .list_ledger(
                start,
                end,
                "weekly",
                "all",
                Some("  ops@believeboy.com  "),
                999,
            )
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.summary.expected, 0);
    }

    /// 契约：后端 400（frequency 参数无效）→ ApiError 携带后端 detail
    #[tokio::test]
    async fn list_ledger_handles_server_error_detail() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_PATH)
            .match_query(Matcher::Any)
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"frequency 参数无效"}"#)
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 9).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        let err = client
            .list_ledger(start, end, "bogus", "all", None, 7)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(400));
        assert_eq!(err.user_message(), "frequency 参数无效");
    }
}
