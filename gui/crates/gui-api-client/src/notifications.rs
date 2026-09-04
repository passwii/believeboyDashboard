//! 站内通知 API（BLF-797 Footer 未读徽标）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/notifications.py`，与 web 端
//! `frontend/lib/notifications-api.ts` / `server-notifications-context.tsx`
//! 的消费口径一致。本期 GUI 只需要**未读数轮询**（Footer 徽标，30s 一次，
//! 对齐 web `POLL_MS = 30_000`）；列表 / 已读标记等管理端点留待通知中心
//! 视图立项时按需接入（对齐 research_analysis「未接端点不预埋」先例）。
//!
//! 用户识别：backend 从 `X-User-Id` header 取 user_id，[`Client`] 带会话时
//! 自动携带。

use gui_domain::notification::NotificationUnreadCount;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/notifications/unread-count`
pub(crate) const UNREAD_COUNT_PATH: &str = "/api/v1/notifications/unread-count";

impl Client {
    /// 当前用户未读通知数（Footer 徽标轮询；失败由调用方降级为占位）
    pub async fn notifications_unread_count(&self) -> Result<NotificationUnreadCount, ApiError> {
        let query = QueryBuilder::new();
        self.get_json(UNREAD_COUNT_PATH, &query.into_pairs()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(UNREAD_COUNT_PATH, "/api/v1/notifications/unread-count");
    }

    /// mock HTTP：携带会话头；响应 `{count}` 解析为 u64
    #[tokio::test]
    async fn unread_count_sends_session_and_parses_count() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", UNREAD_COUNT_PATH)
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"count": 12}"#)
            .create();

        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: None,
            role_type: gui_domain::auth::UserRoleType::Operator,
            is_admin: false,
        };
        let client = Client::new(server.url()).with_session(session);
        let resp = client.notifications_unread_count().await.expect("请求失败");
        m.assert();
        assert_eq!(resp.count, 12);
    }

    /// 服务端错误透传（401 无会话场景）——调用方降级为占位符的依据
    #[tokio::test]
    async fn unread_count_propagates_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", UNREAD_COUNT_PATH)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"boom"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .notifications_unread_count()
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(500));
    }
}
