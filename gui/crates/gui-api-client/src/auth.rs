//! 鉴权 API
//!
//! 后端会话模型（`backend/app/api/v1/endpoints/auth.py`，与 Web 端 next-auth 共用）：
//! - `POST /api/v1/auth/login`：`{ email, password }` → `LoginResponse`（含 `session_id`）
//! - `GET  /api/v1/auth/me`：用 `X-User-Id` / `X-User-Email` / `X-Session-Id` 头校验会话
//! - **无 refresh token 端点**：会话由 Redis 滑动窗口续期，每次 `me()` 即续期

use gui_domain::auth::{LoginRequest, LoginResponse, MeResponse};

use crate::client::{AuthSession, Client};
use crate::error::ApiError;

impl Client {
    /// 用邮箱 + 密码登录，拿到带会话的新 client
    pub async fn login(&self, email: &str, password: &str) -> Result<(Self, LoginResponse), ApiError> {
        let body = LoginRequest {
            email: email.trim().to_lowercase(),
            password: password.to_string(),
        };
        let payload: LoginResponse = self
            .request_json(reqwest::Method::POST, "/api/v1/auth/login", &[], Some(&body))
            .await?;

        if !payload.is_active {
            return Err(ApiError::Http {
                status: 401,
                message: "账号已禁用".to_string(),
            });
        }

        let new_client = self.with_session(AuthSession::from_login(&payload));
        Ok((new_client, payload))
    }

    /// 校验 / 续期当前会话（启动时调用；401 表示会话已失效需要重新登录）
    pub async fn me(&self) -> Result<MeResponse, ApiError> {
        self.get_json("/api/v1/auth/me", &[]).await
    }
}
