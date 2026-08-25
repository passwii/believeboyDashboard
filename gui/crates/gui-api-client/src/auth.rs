//! 鉴权 API
//!
//! 后端会话模型（`backend/app/api/v1/endpoints/auth.py`，与 Web 端 next-auth 共用）：
//! - `POST /api/v1/auth/login`：`{ email, password }` → `LoginResponse`（含 `session_id`
//!   与 BLF-711 下发的专属 `api_key`，每次登录轮换；BLF-787 起 GUI 自动接住挂到 client）
//! - `GET  /api/v1/auth/me`：用 `X-User-Id` / `X-User-Email` / `X-Session-Id` 头校验会话
//! - **无 refresh token 端点**：会话由 Redis 滑动窗口续期，每次 `me()` 即续期

use gui_domain::auth::{LoginRequest, LoginResponse, MeResponse};

use crate::client::{AuthSession, Client};
use crate::error::ApiError;

impl Client {
    /// 用邮箱 + 密码登录，拿到带会话的新 client
    pub async fn login(
        &self,
        email: &str,
        password: &str,
    ) -> Result<(Self, LoginResponse), ApiError> {
        let body = LoginRequest {
            email: email.trim().to_lowercase(),
            password: password.to_string(),
        };
        let payload: LoginResponse = self
            .request_json(
                reqwest::Method::POST,
                "/api/v1/auth/login",
                &[],
                Some(&body),
            )
            .await?;

        if !payload.is_active {
            return Err(ApiError::Http {
                status: 401,
                message: "账号已禁用".to_string(),
            });
        }

        // BLF-711/BLF-787：登录响应携带按账号下发的专属 API key（每次登录轮换）。
        // 生产后端 dashboard 业务路由 `require_api_key` 要求 Bearer 凭据——不接住的
        // 话登录成功但所有业务请求 401。空串（后端降级未签发）时保持原样，
        // 由环境变量 BELIEVEBOY_TOKEN（若有）兜底。
        let new_client = self.with_session(AuthSession::from_login(&payload));
        let new_client = if payload.api_key.is_empty() {
            new_client
        } else {
            new_client.with_api_key(payload.api_key.clone())
        };
        Ok((new_client, payload))
    }

    /// 校验 / 续期当前会话（启动时调用；401 表示会话已失效需要重新登录）
    pub async fn me(&self) -> Result<MeResponse, ApiError> {
        self.get_json("/api/v1/auth/me", &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::auth::UserRoleType;

    fn login_body(api_key: &str) -> String {
        format!(
            r#"{{"id":"u_1","name":"测试","email":"demo@believeboy.com","operator_name_zh":null,
                "is_admin":false,"is_active":true,"role_type":"operator",
                "session_id":"sess_1","api_key":"{api_key}"}}"#
        )
    }

    /// BLF-787 契约：登录响应下发 api_key 时，登录后的业务请求必须携带
    /// `Authorization: Bearer <key>`——生产 dashboard 路由 `require_api_key` 的
    /// 硬要求；缺失即"登录成功但业务模块全 401"。回归锁。
    #[tokio::test]
    async fn login_attaches_bearer_from_issued_api_key() {
        let mut server = mockito::Server::new_async().await;

        let m_login = server
            .mock("POST", "/api/v1/auth/login")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(login_body("blf_test_rotated_key"))
            .create();
        let m_me = server
            .mock("GET", "/api/v1/auth/me")
            // 关键断言：后续请求必须带登录下发的 key
            .match_header("Authorization", "Bearer blf_test_rotated_key")
            .match_header("X-User-Id", "u_1")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"u_1","email":"demo@believeboy.com","name":"测试","is_admin":false,"is_active":true,"role_type":"operator"}"#)
            .create();

        let client = Client::new(server.url());
        let (authed, resp) = client
            .login("Demo@BelieveBoy.com", "pw")
            .await
            .expect("登录失败");
        assert_eq!(resp.api_key, "blf_test_rotated_key");
        authed.me().await.expect("me() 失败");

        m_login.assert();
        m_me.assert();
    }

    /// 后端降级（DB 异常）时 api_key=""：不附加空 Bearer，仍可发请求
    /// （本地/带 BELIEVEBOY_TOKEN 场景不受影响）。
    #[tokio::test]
    async fn login_with_empty_api_key_sends_no_bearer() {
        let mut server = mockito::Server::new_async().await;

        let m_login = server
            .mock("POST", "/api/v1/auth/login")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(login_body(""))
            .create();
        let m_me = server
            .mock("GET", "/api/v1/auth/me")
            .match_header("Authorization", mockito::Matcher::Missing)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"u_1","email":"demo@believeboy.com","name":"测试","is_admin":false,"is_active":true,"role_type":"operator"}"#)
            .create();

        let client = Client::new(server.url());
        let (authed, _) = client.login("a@x.com", "pw").await.expect("登录失败");
        authed.me().await.expect("me() 失败");

        m_login.assert();
        m_me.assert();
    }

    /// 角色字段完整性冒烟：UserRoleType 引入仅为避免 unused 警告的显式引用
    #[test]
    fn role_type_round_trip_smoke() {
        assert_eq!(UserRoleType::Operator.as_str(), "operator");
    }
}
