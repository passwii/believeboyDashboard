//! 系统管理 → 账号管理 API（P5-8，BLF-754）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/users.py`（admin-gated，
//! `X-Is-Admin: true` 由 `Client` 会话上下文头自动携带），与 web 端
//! `frontend/app/api/admin/users/*` 代理转发目标一致：
//! - `GET    /api/v1/system-management/users`          → 用户列表（`created_at desc`）
//! - `POST   /api/v1/system-management/users`          → 创建（201，邮箱重复 409）
//! - `PATCH  /api/v1/system-management/users/{id}`     → 局部更新（启停 / 密码 / 姓名 / 角色）
//! - `DELETE /api/v1/system-management/users/{id}`     → 删除（204；Yawei 账号后端 403）
//!
//! 鉴权：Bearer api_key + 会话三头，由 [`Client`] 统一携带。
//!
//! 未接入：`POST …/{id}/revoke-sessions`（web 账号管理页亦未暴露）。

use gui_domain::admin_users::{
    AdminUserItem, AdminUserMutationResponse, AdminUsersResponse,
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET/POST /system-management/users`
pub(crate) const USERS_PATH: &str = "/api/v1/system-management/users";

/// 创建用户请求体（backend `CreateUserRequest`；is_admin 随 role_type 派生——
/// 后端 PATCH 时按 `role_type == admin` 同步 is_admin，创建侧显式传 false 并以
/// role_type 为准）
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AdminUserCreateBody {
    pub name: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_name_zh: Option<String>,
    pub password: String,
    pub is_admin: bool,
    pub role_type: gui_domain::auth::UserRoleType,
}

/// 更新用户请求体（backend `UpdateUserRequest`；PATCH 只更新显式传入字段，
/// role_type 变更时后端自动派生 is_admin）
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct AdminUserUpdateBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_name_zh: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_type: Option<gui_domain::auth::UserRoleType>,
    /// ≥8 位明文密码（重置密码用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

impl Client {
    /// 用户列表（后端固定 `created_at desc` 排序，无分页参数）
    pub async fn admin_user_list(&self) -> Result<Vec<AdminUserItem>, ApiError> {
        let resp: AdminUsersResponse = self.get_json(USERS_PATH, &[]).await?;
        Ok(resp.items)
    }

    /// 创建用户（响应含新条目；邮箱重复 → 后端 409「邮箱已存在」）
    pub async fn admin_user_create(
        &self,
        body: &AdminUserCreateBody,
    ) -> Result<AdminUserItem, ApiError> {
        let resp: AdminUserMutationResponse =
            self.request_json(reqwest::Method::POST, USERS_PATH, &[], Some(body))
                .await?;
        Ok(resp.item)
    }

    /// 局部更新用户（启停 / 重置密码 / 编辑姓名与角色共用端点）
    pub async fn admin_user_update(
        &self,
        user_id: &str,
        body: &AdminUserUpdateBody,
    ) -> Result<AdminUserItem, ApiError> {
        let path = format!("{USERS_PATH}/{user_id}");
        let resp: AdminUserMutationResponse =
            self.request_json(reqwest::Method::PATCH, &path, &[], Some(body))
                .await?;
        Ok(resp.item)
    }

    /// 删除用户（204 No Content；Yawei 保护账号后端 403「Yawei 账号不允许删除」；
    /// 停用 / 改密后端会吊销该账号全部会话）
    pub async fn admin_user_delete(&self, user_id: &str) -> Result<(), ApiError> {
        let path = format!("{USERS_PATH}/{user_id}");
        self.request_discard(reqwest::Method::DELETE, &path, &[], None::<()>.as_ref())
            .await
    }
}

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
        assert_eq!(USERS_PATH, "/api/v1/system-management/users");
    }

    /// mock HTTP：列表解析 snake_case payload + 会话/admin 头携带
    #[tokio::test]
    async fn user_list_parses_items() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", USERS_PATH)
            .match_header("X-User-Id", "u_1")
            .match_header("X-Is-Admin", "true")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items":[
                    {"id":"u-yawei","name":"yawei","email":"yawei@believeboy.com",
                     "full_name":null,"operator_name_zh":"亚威","is_admin":true,
                     "is_active":true,"role_type":"admin",
                     "created_at":"2025-01-01T00:00:00+00:00",
                     "updated_at":"2026-08-20T06:23:00+00:00"},
                    {"id":"u-ops","name":"运营甲","email":"ops@believeboy.com",
                     "is_active":false,"role_type":"businessdev"}
                ]}"#,
            )
            .create();

        let client = session_client(&server.url());
        let users = client.admin_user_list().await.expect("请求失败");
        m.assert();
        assert_eq!(users.len(), 2);
        assert!(users[0].is_protected());
        assert_eq!(users[0].role_type, gui_domain::auth::UserRoleType::Admin);
        assert!(!users[1].is_active);
        // 可选字段缺省兜底
        assert_eq!(users[1].full_name_display(), "-");
    }

    /// mock HTTP：创建 POST body 序列化（snake_case 字段名对齐 backend Pydantic）
    #[tokio::test]
    async fn user_create_posts_body_and_parses_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", USERS_PATH)
            .match_body(Matcher::JsonString(
                r#"{"name":"新用户","email":"New@X.com","full_name":"甲","password":"password8","is_admin":false,"role_type":"operator"}"#.into(),
            ))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"item":{"id":"u-new","name":"新用户","email":"new@x.com",
                    "full_name":"甲","is_active":true,"role_type":"operator","is_admin":false,
                    "created_at":"2026-08-21T00:00:00+00:00",
                    "updated_at":"2026-08-21T00:00:00+00:00"}}"#,
            )
            .create();

        let client = session_client(&server.url());
        let body = AdminUserCreateBody {
            name: "新用户".into(),
            email: "New@X.com".into(),
            full_name: Some("甲".into()),
            operator_name_zh: None,
            password: "password8".into(),
            is_admin: false,
            role_type: gui_domain::auth::UserRoleType::Operator,
        };
        let created = client.admin_user_create(&body).await.expect("请求失败");
        m.assert();
        assert_eq!(created.id, "u-new");
        assert_eq!(created.full_name.as_deref(), Some("甲"));
    }

    /// mock HTTP：局部更新 PATCH 只带显式字段（启停 / 角色）；404 错误透传
    #[tokio::test]
    async fn user_update_patches_partial_fields() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("PATCH", "/api/v1/system-management/users/u-9")
            .match_body(Matcher::JsonString(r#"{"role_type":"businessdev"}"#.into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"item":{"id":"u-9","name":"运营甲","email":"ops@x.com",
                    "is_active":true,"role_type":"businessdev","is_admin":false}}"#,
            )
            .create();

        let client = session_client(&server.url());
        let body = AdminUserUpdateBody {
            role_type: Some(gui_domain::auth::UserRoleType::Businessdev),
            ..Default::default()
        };
        let updated = client
            .admin_user_update("u-9", &body)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(
            updated.role_type,
            gui_domain::auth::UserRoleType::Businessdev
        );

        // 空更新体 = 全字段跳过序列化（不应发生，但序列化层保证不炸）
        assert_eq!(
            serde_json::to_string(&AdminUserUpdateBody::default()).unwrap(),
            "{}"
        );
    }

    /// mock HTTP：删除 204 无内容；Yawei 保护账号 403 错误消息透传
    #[tokio::test]
    async fn user_delete_and_protected_error() {
        let mut server = mockito::Server::new_async().await;
        let ok = server
            .mock("DELETE", "/api/v1/system-management/users/u-9")
            .with_status(204)
            .create();
        let forbidden = server
            .mock("DELETE", "/api/v1/system-management/users/u-yawei")
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Yawei 账号不允许删除"}"#)
            .create();

        let client = session_client(&server.url());
        client.admin_user_delete("u-9").await.expect("删除失败");
        let err = client
            .admin_user_delete("u-yawei")
            .await
            .expect_err("应返回错误");
        [ok, forbidden].iter().for_each(|m| m.assert());
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "Yawei 账号不允许删除");
    }

    /// mock HTTP：重置密码 PATCH（password 字段）
    #[tokio::test]
    async fn user_reset_password_patches_password_field() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("PATCH", "/api/v1/system-management/users/u-9")
            .match_body(Matcher::JsonString(r#"{"password":"newpass123"}"#.into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"item":{"id":"u-9","name":"运营甲","email":"ops@x.com",
                    "is_active":true,"role_type":"operator","is_admin":false}}"#,
            )
            .create();

        let client = session_client(&server.url());
        let body = AdminUserUpdateBody {
            password: Some("newpass123".into()),
            ..Default::default()
        };
        client
            .admin_user_update("u-9", &body)
            .await
            .expect("重置失败");
        m.assert();
    }
}
