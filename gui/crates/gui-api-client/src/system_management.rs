//! 系统管理 API（P5-8，BLF-757 日志查看）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/system_management/audit.py`
//! 与 `agent_access.py`，与 web `frontend/app/dashboard/system/logs/page.tsx`、
//! `frontend/components/system/agent-access-logs-panel.tsx` 调用口径一致）：
//! - 操作审计日志 →  `GET /api/v1/system-management/audit-logs`（+ `/summary`）
//! - Agent 访问日志 →  `GET /api/v1/system-management/agent-access-logs`（+ `/summary`）
//!
//! 鉴权：Bearer api_key（生产 dashboard 路由 `require_api_key`）+ 会话三头，
//! 由 [`Client`] 统一携带。

use gui_domain::system_management::{
    AgentAccessLogsResponse, AgentAccessLogsSummaryResponse, OperationAuditLogsResponse,
    OperationAuditLogsSummaryResponse,
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /system-management/audit-logs` —— 操作审计日志分页端点
pub(crate) const AUDIT_LOGS_PATH: &str = "/api/v1/system-management/audit-logs";
/// `GET /system-management/audit-logs/summary` —— 审计汇总端点
pub(crate) const AUDIT_LOGS_SUMMARY_PATH: &str = "/api/v1/system-management/audit-logs/summary";
/// `GET /system-management/agent-access-logs` —— Agent 访问日志分页端点
pub(crate) const AGENT_ACCESS_LOGS_PATH: &str = "/api/v1/system-management/agent-access-logs";
/// `GET /system-management/agent-access-logs/summary` —— Agent 访问汇总端点
pub(crate) const AGENT_ACCESS_LOGS_SUMMARY_PATH: &str =
    "/api/v1/system-management/agent-access-logs/summary";

impl Client {
    /// 操作审计日志分页查询（对齐 web `fetchLogs` 的 query 口径）
    ///
    /// - `operator` / `action` / `keyword`：`None` = 不过滤；
    ///   `action` 传分类前缀（如 `"auth."`、`"report"`，见
    ///   `gui_domain::system_management::category_action_query`）；
    /// - `page` 1 起；`page_size` 上限 100（后端 Query 校验）。
    pub async fn system_audit_logs(
        &self,
        operator: Option<&str>,
        action: Option<&str>,
        keyword: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<OperationAuditLogsResponse, ApiError> {
        let mut query: Vec<(&str, String)> = vec![
            ("page", page.to_string()),
            ("page_size", page_size.to_string()),
        ];
        if let Some(v) = operator {
            if !v.is_empty() {
                query.push(("operator", v.to_string()));
            }
        }
        if let Some(v) = action {
            if !v.is_empty() {
                query.push(("action", v.to_string()));
            }
        }
        if let Some(v) = keyword {
            if !v.is_empty() {
                query.push(("keyword", v.to_string()));
            }
        }
        self.get_json(AUDIT_LOGS_PATH, &query).await
    }

    /// 操作审计日志汇总（与列表同筛选参数；对齐 web 并行拉取口径）
    pub async fn system_audit_logs_summary(
        &self,
        operator: Option<&str>,
        action: Option<&str>,
        keyword: Option<&str>,
    ) -> Result<OperationAuditLogsSummaryResponse, ApiError> {
        let mut query: Vec<(&str, String)> = Vec::new();
        for (key, value) in [
            ("operator", operator),
            ("action", action),
            ("keyword", keyword),
        ] {
            if let Some(v) = value {
                if !v.is_empty() {
                    query.push((key, v.to_string()));
                }
            }
        }
        self.get_json(AUDIT_LOGS_SUMMARY_PATH, &query).await
    }

    /// Agent 访问日志分页查询（对齐 web `AgentAccessLogsPanel.fetchLogs`；
    /// `result`：`None` / `Some("success")` / `Some("error")`）
    pub async fn agent_access_logs(
        &self,
        keyword: Option<&str>,
        method: Option<&str>,
        result: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<AgentAccessLogsResponse, ApiError> {
        let mut query: Vec<(&str, String)> = vec![
            ("page", page.to_string()),
            ("page_size", page_size.to_string()),
        ];
        for (key, value) in [("keyword", keyword), ("method", method), ("result", result)] {
            if let Some(v) = value {
                if !v.is_empty() {
                    query.push((key, v.to_string()));
                }
            }
        }
        self.get_json(AGENT_ACCESS_LOGS_PATH, &query).await
    }

    /// Agent 访问日志汇总（与列表同筛选参数）
    pub async fn agent_access_logs_summary(
        &self,
        keyword: Option<&str>,
        method: Option<&str>,
        result: Option<&str>,
    ) -> Result<AgentAccessLogsSummaryResponse, ApiError> {
        let mut query: Vec<(&str, String)> = Vec::new();
        for (key, value) in [("keyword", keyword), ("method", method), ("result", result)] {
            if let Some(v) = value {
                if !v.is_empty() {
                    query.push((key, v.to_string()));
                }
            }
        }
        self.get_json(AGENT_ACCESS_LOGS_SUMMARY_PATH, &query)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个带会话的 client（与主测试模块同款）
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
        assert_eq!(
            AUDIT_LOGS_PATH,
            "/api/v1/system-management/audit-logs"
        );
        assert_eq!(
            AUDIT_LOGS_SUMMARY_PATH,
            "/api/v1/system-management/audit-logs/summary"
        );
        assert_eq!(
            AGENT_ACCESS_LOGS_PATH,
            "/api/v1/system-management/agent-access-logs"
        );
        assert_eq!(
            AGENT_ACCESS_LOGS_SUMMARY_PATH,
            "/api/v1/system-management/agent-access-logs/summary"
        );
    }

    /// mock HTTP：审计日志筛选 + 分页 query 携带；snake_case 响应解析
    #[tokio::test]
    async fn audit_logs_sends_filters_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AUDIT_LOGS_PATH)
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("page".into(), "2".into()),
                mockito::Matcher::UrlEncoded("page_size".into(), "20".into()),
                mockito::Matcher::UrlEncoded("operator".into(), "张三".into()),
                mockito::Matcher::UrlEncoded("action".into(), "auth.".into()),
                mockito::Matcher::UrlEncoded("keyword".into(), "login".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [{
                        "id": 3,
                        "created_at": "2026-08-21T10:30:00+08:00",
                        "operator": "张三",
                        "action": "auth.login.success",
                        "target_type": "user_account",
                        "target_id": "u-1",
                        "result": "success"
                    }],
                    "total": 42,
                    "page": 2,
                    "page_size": 20,
                    "has_next": true
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .system_audit_logs(Some("张三"), Some("auth."), Some("login"), 2, 20)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.total, 42);
        assert!(resp.has_next);
        assert_eq!(resp.items[0].action, "auth.login.success");
    }

    /// mock HTTP：全空筛选不带可选 query（仅分页参数）
    #[tokio::test]
    async fn audit_logs_without_filters_sends_pagination_only() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AUDIT_LOGS_PATH)
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("page".into(), "1".into()),
                mockito::Matcher::UrlEncoded("page_size".into(), "20".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items":[],"total":0,"page":1,"page_size":20,"has_next":false}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .system_audit_logs(None, None, None, 1, 20)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
    }

    /// mock HTTP：审计汇总解析（modules / top_actions）
    #[tokio::test]
    async fn audit_summary_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AUDIT_LOGS_SUMMARY_PATH)
            .match_query(mockito::Matcher::UrlEncoded(
                "action".into(),
                "report".into(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "total": 30, "success_count": 28, "failure_count": 2,
                    "unique_operator_count": 4,
                    "modules": [],
                    "top_actions": [{"action": "monthly_reports.export", "count": 12}]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .system_audit_logs_summary(None, Some("report"), None)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.total, 30);
        assert_eq!(resp.top_actions[0].count, 12);
    }

    /// mock HTTP：Agent 访问日志 query + 解析（未绑定 agent 可空字段）
    #[tokio::test]
    async fn agent_access_logs_sends_filters_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AGENT_ACCESS_LOGS_PATH)
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("page".into(), "1".into()),
                mockito::Matcher::UrlEncoded("page_size".into(), "50".into()),
                mockito::Matcher::UrlEncoded("method".into(), "GET".into()),
                mockito::Matcher::UrlEncoded("result".into(), "error".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [{
                        "id": 9,
                        "created_at": "2026-08-21T10:31:00+08:00",
                        "method": "GET",
                        "path": "/api/v1/agent/inventory/snapshot",
                        "status_code": 500,
                        "latency_ms": 88,
                        "ip_address": null,
                        "api_key_id": null,
                        "agent_id": null,
                        "key_label": null,
                        "project_id": null,
                        "project_name": null,
                        "operation_type": "read"
                    }],
                    "total": 1,
                    "page": 1,
                    "page_size": 50,
                    "has_next": false
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .agent_access_logs(None, Some("GET"), Some("error"), 1, 50)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.total, 1);
        assert!(resp.items[0].agent_id.is_none(), "未鉴权请求未绑定 agent");
        assert_eq!(resp.items[0].status_code, 500);
    }

    /// mock HTTP：Agent 汇总解析（top_agents）
    #[tokio::test]
    async fn agent_access_summary_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AGENT_ACCESS_LOGS_SUMMARY_PATH)
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("result".into(), "success".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "total": 100, "success_count": 95, "error_count": 5,
                    "unique_agent_count": 2,
                    "top_agents": [{"agent_id": "simon-inventory", "key_label": "库存运营 Simon", "count": 60}]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .agent_access_logs_summary(None, None, Some("success"))
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.success_count, 95);
        assert_eq!(resp.unique_agent_count, 2);
    }

    /// 非 2xx → ApiError（消息透出后端 detail）
    #[tokio::test]
    async fn audit_logs_surfaces_http_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", AUDIT_LOGS_PATH)
            .match_query(mockito::Matcher::Any)
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"仅管理员可访问"}"#)
            .create();

        let client = session_client(&server.url());
        let err = client
            .system_audit_logs(None, None, None, 1, 20)
            .await
            .expect_err("403 应转错误");
        assert_eq!(err.status(), Some(403));
    }
}
