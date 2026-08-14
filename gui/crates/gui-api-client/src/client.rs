//! HTTP 客户端封装
//!
//! 单一所有权 + 内部可变性：`Client` 内部持有 `reqwest::Client`（clone 廉价）和 token。
//! 调用方通过 `client.with_token(...)` 或 `auth::login` 拿到带 token 的 client。

use std::time::Duration;

use crate::error::ApiError;

/// API base URL（不带尾斜杠）+ 可选 bearer token
#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub base_url: String,
    pub token: Option<String>,
}

/// API 客户端（cheap to clone：`reqwest::Client` 内部 Arc）
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    config: ClientConfig,
}

impl Client {
    /// 创建一个无 token 的客户端
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
                token: None,
            },
        }
    }

    /// 派生一个带新 token 的客户端（不动 self）
    pub fn with_token(&self, token: impl Into<String>) -> Self {
        Self {
            http: self.http.clone(),
            config: ClientConfig {
                base_url: self.config.base_url.clone(),
                token: Some(token.into()),
            },
        }
    }

    /// 派生一个不带 token 的客户端
    pub fn without_token(&self) -> Self {
        Self {
            http: self.http.clone(),
            config: ClientConfig {
                base_url: self.config.base_url.clone(),
                token: None,
            },
        }
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    pub fn token(&self) -> Option<&str> {
        self.config.token.as_deref()
    }

    /// 发起一次 GET 请求，自动拼 base_url + 携带 bearer
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
        if let Some(tok) = &self.config.token {
            req = req.bearer_auth(tok);
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
