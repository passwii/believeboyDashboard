//! 告警中心 API（Stage13，BLF-804）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/alerts.py`（prefix `/alerts`，
//! `protected` 会话鉴权），与 web `frontend/lib/alerts-api.ts` 调用口径一致：
//! - `GET /api/v1/alerts/stats` → 统计卡（活跃/严重/警告/信息/今日已确认/已解决）
//! - `GET /api/v1/alerts/events` → 告警事件分页（severity/status 过滤）
//!
//! GUI 只读主面：规则管理与通知偏好编辑走 web 端（模块头注明，PR 说明）。

use gui_domain::alerts::{AlertEventPage, AlertStats};
use serde::Deserialize;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /alerts/stats`
pub(crate) const ALERT_STATS_PATH: &str = "/api/v1/alerts/stats";
/// `GET /alerts/events`
pub(crate) const ALERT_EVENTS_PATH: &str = "/api/v1/alerts/events";

/// 告警事件响应原始形状（backend `AlertEventListResponse`；items 逐条映射到
/// [`gui_domain::alerts::AlertEvent`]）
#[derive(Debug, Deserialize)]
struct AlertEventListResponse {
    #[serde(default)]
    items: Vec<gui_domain::alerts::AlertEvent>,
    #[serde(default)]
    total: i64,
}

impl Client {
    /// 告警统计（对齐 web `fetchAlertStats`；无参数全项目口径）
    pub async fn alert_stats(&self) -> Result<AlertStats, ApiError> {
        self.get_json(ALERT_STATS_PATH, &[]).await
    }

    /// 告警事件分页（severity/status：None = 不过滤；page 1 起，上限 100）
    pub async fn alert_events(
        &self,
        severity: Option<&str>,
        status: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<AlertEventPage, ApiError> {
        let mut query: Vec<(&str, String)> = Vec::with_capacity(4);
        if let Some(s) = severity {
            query.push(("severity", s.to_string()));
        }
        if let Some(s) = status {
            query.push(("status", s.to_string()));
        }
        query.push(("page", page.to_string()));
        query.push(("page_size", page_size.to_string()));
        let resp: AlertEventListResponse = self.get_json(ALERT_EVENTS_PATH, &query).await?;
        Ok(AlertEventPage {
            items: resp.items,
            total: resp.total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试运营".into()),
            role_type: gui_domain::auth::UserRoleType::Operator,
            is_admin: false,
        };
        Client::new(base_url).with_session(session)
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(ALERT_STATS_PATH, "/api/v1/alerts/stats");
        assert_eq!(ALERT_EVENTS_PATH, "/api/v1/alerts/events");
    }

    /// mock HTTP：stats 六字段解析
    #[tokio::test]
    async fn alert_stats_parses_six_fields() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", ALERT_STATS_PATH)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"total_active": 12, "critical_count": 2, "warning_count": 5,
                    "info_count": 5, "acknowledged_today": 3, "resolved_today": 1}"#,
            )
            .create();

        let client = session_client(&server.url());
        let stats = client.alert_stats().await.expect("请求失败");
        m.assert();
        assert_eq!(stats.total_active, 12);
        assert_eq!(stats.critical_count, 2);
        assert_eq!(stats.resolved_today, 1);
    }

    /// mock HTTP：events 携带 severity 过滤 + 分页解析
    #[tokio::test]
    async fn alert_events_send_filters_and_parse() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", ALERT_EVENTS_PATH)
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("severity".into(), "critical".into()),
                mockito::Matcher::UrlEncoded("status".into(), "open".into()),
                mockito::Matcher::UrlEncoded("page".into(), "1".into()),
                mockito::Matcher::UrlEncoded("page_size".into(), "50".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [{"id": 9, "rule_id": 2, "project_id": 7,
                    "metric": "sales_drop_pct", "current_value": -35.0,
                    "baseline_value": 0.0, "deviation_pct": 35.0,
                    "severity": "critical", "message": "销售额骤降",
                    "status": "open", "triggered_at": "2026-08-25T10:00:00+08:00"}],
                    "total": 1, "page": 1, "page_size": 50}"#,
            )
            .create();

        let client = session_client(&server.url());
        let page = client
            .alert_events(Some("critical"), Some("open"), 1, 50)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].message, "销售额骤降");
        assert_eq!(page.items[0].severity, "critical");
    }
}
