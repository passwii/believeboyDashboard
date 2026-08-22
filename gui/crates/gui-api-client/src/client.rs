//! HTTP 客户端封装
//!
//! 单一所有权 + 内部可变性：`Client` 内部持有 `reqwest::Client`（clone 廉价）和会话。
//! 调用方通过 `client.with_session(...)` 或 `auth::login` 拿到带会话的 client。
//!
//! 鉴权模型（后端 FastAPI，非 JWT）：
//! 登录后持有 `AuthSession { user_id, email, session_id, ... }`，后续每个请求带上
//! `X-User-Id` / `X-User-Email` / `X-Session-Id` 三个身份头，外加上下文头
//! `X-User-Name` / `X-Operator` / `X-Role-Type` / `X-Is-Admin`（与 Web 端
//! Vercel 代理 backend-auth.ts 同一契约；`/projects/manage` 依赖这些过滤）。

use std::time::Duration;

use gui_domain::auth::UserRoleType;

use crate::error::ApiError;

/// 百分号编码（等价 Web 端 `encodeURIComponent`：仅保留 unreserved 字符，UTF-8 逐字节
/// `%XX`）。backend 侧用 `urllib.parse.unquote` 读取这些上下文头（见 deps.py
/// `_decode_header_value`），所以中文姓名 / 运营别名必须编码后才能放进 HTTP header。
fn percent_encode(input: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if UNRESERVED.contains(&b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

/// 登录后的会话凭据（对应 backend 读取的 X-User-Id / X-User-Email / X-Session-Id
/// 及其余上下文头：X-User-Name / X-Operator / X-Role-Type / X-Is-Admin）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSession {
    pub user_id: String,
    pub email: String,
    pub session_id: String,
    /// 显示名（X-User-Name）
    pub user_name: Option<String>,
    /// 运营别名（X-Operator）
    pub operator_name_zh: Option<String>,
    /// 角色（X-Role-Type）
    pub role_type: UserRoleType,
    /// 是否管理员（X-Is-Admin: true）——backend `/projects/manage` 据此返回全部项目
    pub is_admin: bool,
}

impl AuthSession {
    /// 从 `POST /api/v1/auth/login` 响应构造会话
    pub fn from_login(resp: &gui_domain::auth::LoginResponse) -> Self {
        Self {
            user_id: resp.id.clone(),
            email: resp.email.clone(),
            session_id: resp.session_id.clone(),
            user_name: Some(resp.name.clone()),
            operator_name_zh: resp.operator_name_zh.clone(),
            role_type: resp.role_type,
            is_admin: resp.is_admin,
        }
    }
}

/// API base URL（不带尾斜杠）+ 可选会话 + 可选 API key
#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub base_url: String,
    pub session: Option<AuthSession>,
    /// 生产后端 dashboard 路由要求 API key（`require_api_key`，与 Web 端 Vercel
    /// 代理 `?api_key=` 同源）。来源优先级：登录下发的专属 key（BLF-711，BLF-787
    /// 起 login()/Keychain 恢复自动挂载）> 环境变量 `BELIEVEBOY_TOKEN` > 无。
    pub api_key: Option<String>,
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
                api_key: None,
            },
        }
    }

    /// 派生一个带 API key 的客户端（生产后端 dashboard 路由需要，`Authorization: Bearer`）
    pub fn with_api_key(&self, api_key: impl Into<String>) -> Self {
        Self {
            http: self.http.clone(),
            config: ClientConfig {
                base_url: self.config.base_url.clone(),
                session: self.config.session.clone(),
                api_key: Some(api_key.into()),
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
                api_key: self.config.api_key.clone(),
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
                api_key: self.config.api_key.clone(),
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
        if let Some(api_key) = &self.config.api_key {
            req = req.bearer_auth(api_key);
        }
        if let Some(session) = &self.config.session {
            req = req
                .header("X-User-Id", &session.user_id)
                // backend 侧用 unquote() 读取，原样发送即可（邮箱本身不含 %xx 转义）
                .header("X-User-Email", &session.email)
                .header("X-Session-Id", &session.session_id);
            // 上下文头：与 Web 端 Vercel 代理（backend-auth.ts）同一契约——
            // `/projects/manage` 依赖 X-Is-Admin / X-Operator 决定返回哪些项目
            if let Some(name) = &session.user_name {
                req = req.header("X-User-Name", percent_encode(name));
            }
            if let Some(op) = &session.operator_name_zh {
                req = req.header("X-Operator", percent_encode(op));
            }
            req = req.header("X-Role-Type", session.role_type.as_str());
            if session.is_admin {
                req = req.header("X-Is-Admin", "true");
            }
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

    /// 发起请求并返回原始响应（流式消费用，BLF-737 AI Chat SSE）。
    ///
    /// 与 [`Self::request_json`] 同一鉴权 / query / body 管线，但：
    /// - 不读响应体——调用方用 `Response::chunk()` 逐块消费（SSE 流式）；
    /// - `timeout` 覆盖 client 级 30s 总超时（流式对话可持续数分钟，
    ///   reqwest 的 per-request timeout 从建连到响应体读完整体计时）。
    ///
    /// 非 2xx 时读尽响应体转 [`ApiError::from_response`]。
    pub(crate) async fn request_stream<B: serde::Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&B>,
        accept: &str,
        timeout: std::time::Duration,
    ) -> Result<reqwest::Response, ApiError> {
        let url = format!("{}{}", self.config.base_url, path);
        let mut req = self
            .http
            .request(method, &url)
            .timeout(timeout)
            .header(reqwest::header::ACCEPT, accept);
        if let Some(api_key) = &self.config.api_key {
            req = req.bearer_auth(api_key);
        }
        if let Some(session) = &self.config.session {
            req = req
                .header("X-User-Id", &session.user_id)
                .header("X-User-Email", &session.email)
                .header("X-Session-Id", &session.session_id);
            if let Some(name) = &session.user_name {
                req = req.header("X-User-Name", percent_encode(name));
            }
            if let Some(op) = &session.operator_name_zh {
                req = req.header("X-Operator", percent_encode(op));
            }
            req = req.header("X-Role-Type", session.role_type.as_str());
            if session.is_admin {
                req = req.header("X-Is-Admin", "true");
            }
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(b);
        }

        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            // 流式端点失败时返回普通 JSON/文本错误体——读尽后走统一错误解析
            let bytes = resp.bytes().await?;
            let body = String::from_utf8_lossy(&bytes).to_string();
            return Err(ApiError::from_response(status.as_u16(), &body));
        }
        Ok(resp)
    }

    /// 发起请求并丢弃响应体（DELETE 204 No Content 等无内容成功响应）。
    ///
    /// 与 [`Self::request_json`] 同一鉴权 / query / body 管线，仅成功时不要求
    /// 响应体可反序列化——后端 `204` 返回空 body，走 `request_json` 会因空体
    /// 反序列化失败而误报错误。
    pub(crate) async fn request_discard<B: serde::Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&B>,
    ) -> Result<(), ApiError> {
        let url = format!("{}{}", self.config.base_url, path);
        let mut req = self.http.request(method, &url);
        if let Some(api_key) = &self.config.api_key {
            req = req.bearer_auth(api_key);
        }
        if let Some(session) = &self.config.session {
            req = req
                .header("X-User-Id", &session.user_id)
                .header("X-User-Email", &session.email)
                .header("X-Session-Id", &session.session_id);
            if let Some(name) = &session.user_name {
                req = req.header("X-User-Name", percent_encode(name));
            }
            if let Some(op) = &session.operator_name_zh {
                req = req.header("X-Operator", percent_encode(op));
            }
            req = req.header("X-Role-Type", session.role_type.as_str());
            if session.is_admin {
                req = req.header("X-Is-Admin", "true");
            }
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
        Ok(())
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
            api_key: String::new(),
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
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试".into()),
            role_type: UserRoleType::Operator,
            is_admin: false,
        };
        let authed = client.with_session(session.clone());
        assert!(!client.is_authenticated());
        assert!(authed.is_authenticated());
        assert_eq!(authed.session(), Some(&session));
        assert_eq!(authed.base_url(), "https://api.example.com");
    }

    #[test]
    fn with_api_key_preserves_session_and_base_url() {
        let client = Client::new("https://api.example.com");
        let session = AuthSession {
            user_id: "u".into(),
            email: "e@x.com".into(),
            session_id: "s".into(),
            user_name: None,
            operator_name_zh: None,
            role_type: UserRoleType::Admin,
            is_admin: true,
        };
        let authed = client.with_session(session.clone()).with_api_key("k123");
        assert_eq!(authed.config.api_key.as_deref(), Some("k123"));
        assert_eq!(authed.session(), Some(&session));
        // 派生链保持 API key：登录返回的带会话 client 不应丢 key
        let again = authed.with_session(session.clone());
        assert_eq!(again.config.api_key.as_deref(), Some("k123"));
    }

    #[tokio::test]
    async fn session_context_headers_match_web_proxy_contract() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/projects/manage")
            .match_header("X-User-Id", "u")
            .match_header("X-User-Email", "e@x.com")
            .match_header("X-Session-Id", "s")
            .match_header("X-User-Name", "%E6%B5%8B%E8%AF%95")
            .match_header("X-Operator", "%E6%B5%8B%E8%AF%95%E8%BF%90%E8%90%A5")
            .match_header("X-Role-Type", "admin")
            .match_header("X-Is-Admin", "true")
            .match_header("Authorization", "Bearer k123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let session = AuthSession {
            user_id: "u".into(),
            email: "e@x.com".into(),
            session_id: "s".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试运营".into()),
            role_type: UserRoleType::Admin,
            is_admin: true,
        };
        let client = Client::new(server.url()).with_api_key("k123").with_session(session);
        let result: Vec<serde_json::Value> = client
            .get_json("/api/v1/projects/manage", &[])
            .await
            .expect("请求失败");

        m.assert();
        assert!(result.is_empty());
    }
}
