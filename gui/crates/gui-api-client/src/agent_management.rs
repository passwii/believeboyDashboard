//! 系统管理 → Agent 接入管理 API（P5-8，BLF-758）
//!
//! 端点对齐 backend：
//! - 凭据 CRUD：`backend/app/api/v1/endpoints/internal/api_keys.py`
//!   （admin-gated，`X-Is-Admin: true` 由 `Client` 会话上下文头自动携带）：
//!   - `GET    /api/v1/internal/api-keys?include_deleted=` → 凭据列表（无密钥明文）
//!   - `POST   /api/v1/internal/api-keys`                  → 创建（明文仅此一次下发）
//!   - `PATCH  /api/v1/internal/api-keys/{id}`             → 编辑 label / 双 scope
//!   - `POST   /api/v1/internal/api-keys/{id}/deactivate`  → 停用（恢复用 activate）
//!   - `POST   /api/v1/internal/api-keys/{id}/activate`    → 激活
//!   - `DELETE /api/v1/internal/api-keys/{id}`             → 软删除（204 幂等）
//! - 写操作审计：`GET /api/v1/system-management/agent-operation-logs(/summary)?…`
//!   （参数口径与 web 端 `components/system/agent-operation-logs-panel.tsx` 一致：
//!   `page/page_size=50 + keyword/result/project_id/operation_type`）
//!
//! 复用：读访问审计端点已在 BLF-757 `system_management` 模块接入
//! （`agent_access_logs(/summary)`），本模块不重复定义。
//!
//! 未接入（写入链路保留 web 端操作或低价值裁剪）：
//! - `POST …/{id}/revoke`（兼容别名，语义等同 deactivate）；
//! - 日志筛选的 `date_from` / `date_to` / `status_code`（web 面板亦未全部暴露，
//!   GUI 精简为 keyword + method + result + operation_type）。

use gui_domain::agent_management::{
    AgentApiKeyCreateResponse, AgentApiKeyItem, AgentKeyToggleResponse,
    AgentOperationLogsResponse, AgentOperationLogsSummary,
};

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET/POST /internal/api-keys`
pub(crate) const API_KEYS_PATH: &str = "/api/v1/internal/api-keys";

/// 写操作日志路径
pub(crate) const OPERATION_LOGS_PATH: &str = "/api/v1/system-management/agent-operation-logs";

/// 凭据列表筛选（`include_deleted` 对齐 web「含已删除」勾选）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentKeyListFilter {
    /// true 时包含已软删除凭据（审计 / 回溯）
    pub include_deleted: bool,
}

/// 创建凭据请求体（backend `ApiKeyCreateRequest`；expires_at 固定 None——
/// web 创建 Dialog 亦不暴露过期设置）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentKeyCreateBody {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub expires_at: Option<String>,
    pub project_scope: String,
    pub business_scope: String,
}

/// 编辑凭据请求体（backend `ApiKeyUpdateRequest`；PATCH 只更新显式传入字段）
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AgentKeyUpdateBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub business_scope: Option<String>,
}

/// 写操作日志筛选（空条件不携带；result 取值 `success` / `failure`——
/// 写侧口径与读访问的 `success` / `error` 不同，见 backend `_apply_filters`）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentLogsFilter {
    /// 关键词（Agent ID / 对象标识 / 路径）
    pub keyword: Option<String>,
    /// 结果（success = 成功 / failure = 失败）
    pub result: Option<String>,
    /// 项目 ID（数字；≤ 0 视为未填）
    pub project_id: Option<i64>,
}

impl AgentLogsFilter {
    /// 组装 query 参数（顺序稳定便于 mockito 断言；project_id ≤ 0 视为未填）
    fn base_query(&self) -> QueryBuilder {
        QueryBuilder::new()
            .with_opt("keyword", self.keyword.as_deref().filter(|s| !s.is_empty()))
            .with_opt("result", self.result.as_deref().filter(|s| !s.is_empty()))
            .map_project_id(self.project_id)
    }
}

trait QueryProjectId {
    fn map_project_id(self, project_id: Option<i64>) -> Self;
}

impl QueryProjectId for QueryBuilder {
    fn map_project_id(mut self, project_id: Option<i64>) -> Self {
        if let Some(pid) = project_id.filter(|v| *v > 0) {
            self = self.with("project_id", pid);
        }
        self
    }
}

impl Client {
    /// 凭据列表（无密钥明文；默认隐藏已删除）
    pub async fn agent_key_list(
        &self,
        filter: &AgentKeyListFilter,
    ) -> Result<Vec<AgentApiKeyItem>, ApiError> {
        let query = QueryBuilder::new().with("include_deleted", filter.include_deleted);
        self.get_json(API_KEYS_PATH, &query.into_pairs()).await
    }

    /// 创建凭据（响应含明文 key，仅此一次下发）
    pub async fn agent_key_create(
        &self,
        body: &AgentKeyCreateBody,
    ) -> Result<AgentApiKeyCreateResponse, ApiError> {
        self.request_json(reqwest::Method::POST, API_KEYS_PATH, &[], Some(body))
            .await
    }

    /// 编辑凭据权限与业务范围（PATCH 即刻生效，无需重建凭据）
    pub async fn agent_key_update(
        &self,
        key_id: i64,
        body: &AgentKeyUpdateBody,
    ) -> Result<AgentApiKeyItem, ApiError> {
        let path = format!("{API_KEYS_PATH}/{key_id}");
        self.request_json(reqwest::Method::PATCH, &path, &[], Some(body))
            .await
    }

    /// 停用凭据（可随时重新激活，凭据本身不失效）
    pub async fn agent_key_deactivate(&self, key_id: i64) -> Result<AgentKeyToggleResponse, ApiError> {
        let path = format!("{API_KEYS_PATH}/{key_id}/deactivate");
        self.request_json(reqwest::Method::POST, &path, &[], None::<()>.as_ref())
            .await
    }

    /// 激活凭据（已删除 Key 不可激活 → 后端 404）
    pub async fn agent_key_activate(&self, key_id: i64) -> Result<AgentKeyToggleResponse, ApiError> {
        let path = format!("{API_KEYS_PATH}/{key_id}/activate");
        self.request_json(reqwest::Method::POST, &path, &[], None::<()>.as_ref())
            .await
    }

    /// 软删除凭据（204 No Content，幂等；审计日志保留）
    pub async fn agent_key_delete(&self, key_id: i64) -> Result<(), ApiError> {
        let path = format!("{API_KEYS_PATH}/{key_id}");
        self.request_discard(reqwest::Method::DELETE, &path, &[], None::<()>.as_ref())
            .await
    }

    /// 写操作日志分页（page_size 对齐 web 固定 50；读访问日志走
    /// `system_management::agent_access_logs`，BLF-757 已接入不重复定义）
    pub async fn agent_operation_logs(
        &self,
        filter: &AgentLogsFilter,
        page: i64,
    ) -> Result<AgentOperationLogsResponse, ApiError> {
        let query = filter
            .base_query()
            .with("page", page)
            .with("page_size", 50i64);
        self.get_json(OPERATION_LOGS_PATH, &query.into_pairs()).await
    }

    /// 写操作统计概览（当前筛选条件下聚合）
    pub async fn agent_operation_logs_summary(
        &self,
        filter: &AgentLogsFilter,
    ) -> Result<AgentOperationLogsSummary, ApiError> {
        self.get_json(
            &format!("{OPERATION_LOGS_PATH}/summary"),
            &filter.base_query().into_pairs(),
        )
        .await
    }
}

// 复用序列化派生（本模块仅创建 / 编辑 body 需要 Serialize）
use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；admin 上下文头自动携带）
    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试运营".into()),
            role_type: gui_domain::auth::UserRoleType::Admin,
            is_admin: true,
        };
        Client::new(base_url).with_session(session)
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(API_KEYS_PATH, "/api/v1/internal/api-keys");
        assert_eq!(
            OPERATION_LOGS_PATH,
            "/api/v1/system-management/agent-operation-logs"
        );
    }

    /// 契约：日志筛选组装——空条件 / 非法 project_id 不携带
    #[test]
    fn logs_filter_builds_query_and_skips_blank() {
        let empty = AgentLogsFilter::default();
        assert_eq!(empty.base_query().into_pairs(), vec![]);

        let full = AgentLogsFilter {
            keyword: Some("shipment-assistant".into()),
            result: Some("failure".into()),
            project_id: Some(3),
        };
        assert_eq!(
            full.base_query().into_pairs(),
            vec![
                ("keyword", "shipment-assistant".to_string()),
                ("result", "failure".to_string()),
                ("project_id", "3".to_string()),
            ]
        );

        // project_id ≤ 0 视为未填（视图侧数字输入解析失败兜底）
        let bad_pid = AgentLogsFilter {
            project_id: Some(0),
            ..Default::default()
        };
        assert_eq!(bad_pid.base_query().into_pairs(), vec![]);
    }

    /// mock HTTP：凭据列表携带 include_deleted=false + admin 会话头；响应解析
    #[tokio::test]
    async fn key_list_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", API_KEYS_PATH)
            .match_query(Matcher::UrlEncoded("include_deleted".into(), "false".into()))
            .match_header("X-User-Id", "u_1")
            .match_header("X-Is-Admin", "true")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[{
                    "id": 7, "key_prefix": "bbk_abcd", "label": "货件助理",
                    "scope": "read", "project_scope": "*", "business_scope": "shipments",
                    "agent_id": "shipment-assistant-prod",
                    "is_revoked": false, "expires_at": null,
                    "created_at": "2026-08-01T00:00:00+00:00",
                    "last_used_at": "2026-08-20T06:23:00+00:00",
                    "deleted_at": null
                }]"#,
            )
            .create();

        let client = session_client(&server.url());
        let keys = client
            .agent_key_list(&AgentKeyListFilter::default())
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].label, "货件助理");
        assert_eq!(keys[0].key_prefix, "bbk_abcd");
        assert!(!keys[0].is_revoked);
    }

    /// mock HTTP：创建凭据 POST body 序列化 + 明文一次性下发
    #[tokio::test]
    async fn key_create_posts_body_and_parses_plaintext() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", API_KEYS_PATH)
            .match_header("X-Is-Admin", "true")
            .match_body(Matcher::JsonString(
                r#"{"label":"货件助理","agent_id":"shipment-assistant-prod","expires_at":null,"project_scope":"*","business_scope":"*"}"#.into(),
            ))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 9, "key_prefix": "bbk_new1", "label": "货件助理",
                    "scope": "read", "project_scope": "*", "business_scope": "*",
                    "agent_id": "shipment-assistant-prod", "expires_at": null,
                    "created_at": "2026-08-21T00:00:00+00:00",
                    "plaintext_key": "bbk_new1_secret_plain"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let body = AgentKeyCreateBody {
            label: "货件助理".into(),
            agent_id: Some("shipment-assistant-prod".into()),
            expires_at: None,
            project_scope: "*".into(),
            business_scope: "*".into(),
        };
        let created = client.agent_key_create(&body).await.expect("请求失败");
        m.assert();
        assert_eq!(created.plaintext_key, "bbk_new1_secret_plain");
        assert_eq!(created.key_prefix, "bbk_new1");
    }

    /// mock HTTP：编辑凭据 PATCH（只传显式字段）；404 错误透传
    #[tokio::test]
    async fn key_update_patches_partial_fields() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("PATCH", "/api/v1/internal/api-keys/9")
            .match_body(Matcher::JsonString(
                r#"{"business_scope":"shipments,sales"}"#.into(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 9, "key_prefix": "bbk_new1", "label": "货件助理",
                    "scope": "read", "project_scope": "*",
                    "business_scope": "shipments,sales",
                    "agent_id": "shipment-assistant-prod",
                    "is_revoked": false, "expires_at": null,
                    "created_at": "2026-08-21T00:00:00+00:00",
                    "last_used_at": null, "deleted_at": null
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let body = AgentKeyUpdateBody {
            business_scope: Some("shipments,sales".into()),
            ..Default::default()
        };
        let updated = client.agent_key_update(9, &body).await.expect("请求失败");
        m.assert();
        assert_eq!(updated.business_scope, "shipments,sales");
    }

    /// mock HTTP：停用 → activate 切换；DELETE 软删除 204 无内容
    #[tokio::test]
    async fn key_toggle_and_delete_roundtrip() {
        let mut server = mockito::Server::new_async().await;
        let deactivate = server
            .mock("POST", "/api/v1/internal/api-keys/9/deactivate")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id": 9, "is_revoked": true}"#)
            .create();
        let activate = server
            .mock("POST", "/api/v1/internal/api-keys/9/activate")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id": 9, "is_revoked": false}"#)
            .create();
        let delete = server
            .mock("DELETE", "/api/v1/internal/api-keys/9")
            .with_status(204)
            .create();

        let client = session_client(&server.url());
        let off = client.agent_key_deactivate(9).await.expect("停用失败");
        let on = client.agent_key_activate(9).await.expect("激活失败");
        client.agent_key_delete(9).await.expect("删除失败");
        [deactivate, activate, delete].iter().for_each(|m| m.assert());
        assert!(off.is_revoked);
        assert!(!on.is_revoked);
    }

    /// mock HTTP：写操作日志 + summary 解析（top_actions 兼容缺省）
    #[tokio::test]
    async fn operation_logs_list_and_summary_parse() {
        let mut server = mockito::Server::new_async().await;
        let list = server
            .mock("GET", OPERATION_LOGS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("result".into(), "success".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "50".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [{
                        "id": 55, "created_at": "2026-08-20T07:00:00+00:00",
                        "agent_id": "shipment-assistant-prod", "agent_name": "货件助理",
                        "action": "shipment.create", "target_type": "shipment",
                        "target_id": "12", "target_label": "SH-2026-01",
                        "result": "success", "project_id": 3, "project_name": "德国店",
                        "operation_type": "shipments",
                        "request_path": "/api/v1/agent/projects/3/shipments",
                        "request_method": "POST"
                    }],
                    "total": 5, "page": 1, "page_size": 50, "has_next": false
                }"#,
            )
            .create();
        let summary = server
            .mock("GET", "/api/v1/system-management/agent-operation-logs/summary")
            .match_query(Matcher::UrlEncoded(
                "result".into(),
                "success".into(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "total": 30, "success_count": 28, "failure_count": 2,
                    "unique_agent_count": 2,
                    "top_agents": [{"agent_id": "a1", "agent_name": "助理一", "count": 20}],
                    "top_actions": [{"action": "shipment.status_advance", "count": 12}]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = AgentLogsFilter {
            result: Some("success".into()),
            ..Default::default()
        };
        let logs = client
            .agent_operation_logs(&filter, 1)
            .await
            .expect("请求失败");
        let sum = client
            .agent_operation_logs_summary(&filter)
            .await
            .expect("请求失败");
        list.assert();
        summary.assert();
        assert_eq!(logs.items.len(), 1);
        assert_eq!(logs.items[0].target_label.as_deref(), Some("SH-2026-01"));
        assert_eq!(sum.failure_count, 2);
        assert_eq!(sum.top_actions.len(), 1);
    }

    /// 服务端 403（非管理员）→ 透传错误消息
    #[tokio::test]
    async fn request_propagates_admin_error_message() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", API_KEYS_PATH)
            .match_query(Matcher::UrlEncoded("include_deleted".into(), "false".into()))
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"需要管理员权限"}"#)
            .create();

        let client = session_client(&server.url());
        let err = client
            .agent_key_list(&AgentKeyListFilter::default())
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "需要管理员权限");
    }
}
