//! 鉴权相关
//!
//! 后端登录：复用 frontend 已经走通的 `next-auth` 链路使用的同一组端点
//! （通常为 `/api/v1/auth/login` 或 `/api/auth/callback/credentials`），
//! GUI 端不依赖 next-auth，直接 POST 用户名密码拿 JWT。

use serde::{Deserialize, Serialize};

use crate::client::Client;
use crate::error::ApiError;

/// 登录请求体（与 backend FastAPI 端点对齐；具体字段在 issue 0.2 联调时定）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// 登录响应（字段名与后端实际返回对齐，issue 0.2 时补全）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

impl Client {
    /// 用邮箱 + 密码登录，拿到带 token 的新 client
    pub async fn login(&self, email: &str, password: &str) -> Result<(Self, LoginResponse), ApiError> {
        // TODO(issue 0.2): 与 backend 联调确认 path / 字段
        // 占位 path：暂用 /api/v1/auth/login
        let path = "/api/v1/auth/login";
        let body = LoginRequest {
            email: email.to_string(),
            password: password.to_string(),
        };
        // 走 request_json
        let url = format!("{}{}", self.base_url(), path);
        let resp = self
            .http()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::Transport)?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(ApiError::Transport)?;
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes).to_string();
            return Err(ApiError::from_response(status.as_u16(), &body));
        }
        let payload: LoginResponse = serde_json::from_slice(&bytes)
            .map_err(|e| ApiError::Deserialize(e.to_string()))?;
        let new_client = self.with_token(&payload.access_token);
        Ok((new_client, payload))
    }
}


