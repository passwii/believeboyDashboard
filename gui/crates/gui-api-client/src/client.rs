//! HTTP 客户端封装
//!
//! 单一所有权 + 内部可变性：`Client` 内部持有 `reqwest::Client`（clone 廉价）和会话。
//! 调用方通过 `client.with_session(...)` 或 `auth::login` 拿到带会话的 client。
//!
//! 鉴权模型（后端 FastAPI，非 JWT）：
//! 登录后持有 `AuthSession { user_id, email, session_id }`，后续每个请求带上
//! `X-User-Id` / `X-User-Email` / `X-Session-Id` 三个 header 声明身份。

use std::time::Duration;

use crate::error::ApiError;

/// 登录后的会话凭据（对应 backend 读取的 X-User-Id / X-User-Email / X-Session-Id）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSession {
    pub user_id: String,
    pub email: String,
    pub session_id: String,
}

impl AuthSession {
    /// 从 `POST /api/v1/auth/login` 响应构造会话
    pub fn from_login(resp: &gui_domain::auth::LoginResponse) -> Self {
        Self {
            user_id: resp.id.clone(),
            email: resp.email.clone(),
            session_id: resp.session_id.clone(),
        }
    }
}

/// API base URL（不带尾斜杠）+ 可选会话
#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub base_url: String,
    pub session: Option<AuthSession>,
}

/// API 客户端（cheap to clone：`reqwest::Client` 内部 Arc）
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    config: ClientConfig,
}

impl Client {
    /// 创建一个未登录的客户端
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("believeboy-gui/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client must build");
        Self {
            http,
            config: ClientConfig {
                base_url: base_url.into(),
                session: None,
            },
        }
    }

    /// 派生一个带会话的客户端（不动 self）
    pub fn with_session(&self, session: AuthSession) -> Self {
        Self {
            http: self.http.clone(),
            config: ClientConfig {
                base_url: self.config.base_url.clone(),
                session: Some(session),
            },
        }
    }

    /// 派生一个不带会话的客户端
    pub fn without_session(&self) -> Self {
        Self {
            http: self.http.clone(),
            config: ClientConfig {
                base_url: self.config.base_url.clone(),
                session: None,
            },
        }
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    /// 当前会话（未登录返回 None）
    pub fn session(&self) -> Option<&AuthSession> {
        self.config.session.as_ref()
    }

    /// 是否已登录（持有会话）
    pub fn is_authenticated(&self) -> bool {
        self.config.session.is_some()
    }

    /// 发起一次 GET 请求，自动拼 base_url + 携带会话头
    pub(crate) async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, ApiError> {
        self.request_json(reqwest::Method::GET, path, query, None::<()>.as_ref())
            .await
    }

    /// 通用 JSON 请求
    pub(crate) async fn request_json<B: serde::Serialize, T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&B>,
    ) -> Result<T, ApiError> {
        let url = format!("{}{}", self.config.base_url, path);
        let mut req = self.http.request(method, &url);
        if let Some(session) = &self.config.session {
            req = req
                .header("X-User-Id", &session.user_id)
                // backend 侧用 unquote() 读取，原样发送即可（邮箱本身不含 %xx 转义）
                .header("X-User-Email", &session.email)
                .header("X-Session-Id", &session.session_id);
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(b);
        }

        let resp = req.send().await?;
        let status = resp.status();
        let bytes = resp.bytes().await?;

        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes).to_string();
            return Err(ApiError::from_response(status.as_u16(), &body));
        }

        serde_json::from_slice(&bytes).map_err(|e| ApiError::Deserialize(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::auth::LoginResponse;

    #[test]
    fn auth_session_from_login_response() {
        let resp = LoginResponse {
            id: "u_1".into(),
            name: "测试".into(),
            email: "demo@believeboy.com".into(),
            operator_name_zh: None,
            is_admin: false,
            is_active: true,
            role_type: gui_domain::auth::UserRoleType::Operator,
            session_id: "sess_1".into(),
        };
        let session = AuthSession::from_login(&resp);
        assert_eq!(session.user_id, "u_1");
        assert_eq!(session.email, "demo@believeboy.com");
        assert_eq!(session.session_id, "sess_1");
    }

    #[test]
    fn with_session_does_not_mutate_self() {
        let client = Client::new("https://api.example.com");
        let session = AuthSession {
            user_id: "u".into(),
            email: "e@x.com".into(),
            session_id: "s".into(),
        };
        let authed = client.with_session(session.clone());
        assert!(!client.is_authenticated());
        assert!(authed.is_authenticated());
        assert_eq!(authed.session(), Some(&session));
        assert_eq!(authed.base_url(), "https://api.example.com");
    }
}
