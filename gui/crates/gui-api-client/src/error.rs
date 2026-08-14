//! API 客户端错误

use thiserror::Error;

/// 业务可识别的 API 错误
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },

    #[error("反序列化失败: {0}")]
    Deserialize(String),

    #[error("网络/IO 错误: {0}")]
    Transport(#[from] reqwest::Error),

    /// 401 —— 会话失效 / 凭据错误。
    /// 携带后端 `detail`（可能为空），展示时回退到「未登录」。
    #[error("未登录: {0}")]
    Unauthenticated(String),
}

impl ApiError {
    /// 把后端 FastAPI 抛出的 `{ detail: "..." }` 转成可读消息
    pub fn from_response(status: u16, body: &str) -> Self {
        // 401 统一归类为未登录（保留 detail 供登录窗口/横幅展示）
        if status == 401 {
            return ApiError::Unauthenticated(parse_detail(body));
        }
        // 尝试解析 FastAPI 标准错误体
        if let Some(detail) = parse_detail_opt(body) {
            return ApiError::Http {
                status,
                message: detail,
            };
        }
        ApiError::Http {
            status,
            message: body.to_string(),
        }
    }

    /// HTTP 状态码（非 HTTP 类错误返回 None）
    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Http { status, .. } => Some(*status),
            ApiError::Unauthenticated(_) => Some(401),
            _ => None,
        }
    }

    /// 是否 401（会话失效 / 凭据错误）
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, ApiError::Unauthenticated(_)) || self.status() == Some(401)
    }

    /// 给用户看的可读信息
    pub fn user_message(&self) -> String {
        match self {
            ApiError::Http { message, .. } => message.clone(),
            ApiError::Deserialize(_) => "服务器返回数据格式异常".to_string(),
            ApiError::Transport(_) => "网络连接失败，请检查网络后重试".to_string(),
            ApiError::Unauthenticated(message) => {
                if message.is_empty() {
                    "未登录".to_string()
                } else {
                    message.clone()
                }
            }
        }
    }
}

/// 尝试从 FastAPI 错误体解析 `detail`（字符串形式）；失败返回空串
fn parse_detail(body: &str) -> String {
    parse_detail_opt(body).unwrap_or_default()
}

/// 尝试从 FastAPI 错误体解析 `detail`；非标准体返回 None
fn parse_detail_opt(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("detail").and_then(|x| x.as_str()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fastapi_detail_error() {
        let err = ApiError::from_response(401, r#"{"detail":"Invalid credentials"}"#);
        assert!(matches!(err, ApiError::Unauthenticated(_)));
        assert!(err.is_unauthorized());
        assert_eq!(err.status(), Some(401));
        assert_eq!(err.user_message(), "Invalid credentials");
    }

    #[test]
    fn falls_back_to_raw_body() {
        let err = ApiError::from_response(500, "Internal Server Error");
        assert_eq!(err.status(), Some(500));
        assert!(!err.is_unauthorized());
        assert_eq!(err.user_message(), "Internal Server Error");
    }

    #[test]
    fn server_error_passes_through_detail() {
        let err = ApiError::from_response(500, r#"{"detail":"upsert failed: db locked"}"#);
        assert_eq!(err.status(), Some(500));
        assert_eq!(err.user_message(), "upsert failed: db locked");
    }

    #[test]
    fn unauthorized_without_detail_falls_back_to_login_message() {
        let err = ApiError::from_response(401, "Unauthorized");
        assert!(matches!(err, ApiError::Unauthenticated(_)));
        assert!(err.is_unauthorized());
        assert_eq!(err.user_message(), "未登录");
    }

    #[tokio::test]
    async fn transport_error_gets_friendly_message() {
        // 连一个必然拒绝的地址，拿到真实的 reqwest::Transport 错误
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        let err = client.get("http://127.0.0.1:1").send().await.unwrap_err();
        let api_err = ApiError::Transport(err);
        assert_eq!(api_err.status(), None);
        assert!(!api_err.is_unauthorized());
        assert_eq!(api_err.user_message(), "网络连接失败，请检查网络后重试");
    }

    #[test]
    fn unauthenticated_message() {
        assert_eq!(
            ApiError::Unauthenticated(String::new()).user_message(),
            "未登录"
        );
        assert!(ApiError::Unauthenticated(String::new()).is_unauthorized());
    }

    #[test]
    fn synthetic_http_401_stays_http_but_is_unauthorized() {
        // auth::login 的「账号已禁用」是合成错误，保持 Http 变体但语义仍是未登录
        let err = ApiError::Http {
            status: 401,
            message: "账号已禁用".to_string(),
        };
        assert!(err.is_unauthorized());
        assert_eq!(err.user_message(), "账号已禁用");
    }
}
