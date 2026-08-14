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

    #[error("未登录")]
    Unauthenticated,
}

impl ApiError {
    /// 把后端 FastAPI 抛出的 `{ detail: "..." }` 转成可读消息
    pub fn from_response(status: u16, body: &str) -> Self {
        // 尝试解析 FastAPI 标准错误体
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(detail) = v.get("detail").and_then(|x| x.as_str()) {
                return ApiError::Http {
                    status,
                    message: detail.to_string(),
                };
            }
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
            _ => None,
        }
    }

    /// 是否 401（会话失效 / 凭据错误）
    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(401)
    }

    /// 给用户看的可读信息
    pub fn user_message(&self) -> String {
        match self {
            ApiError::Http { message, .. } => message.clone(),
            ApiError::Deserialize(_) => "服务器返回数据格式异常".to_string(),
            ApiError::Transport(_) => "网络连接失败，请检查网络后重试".to_string(),
            ApiError::Unauthenticated => "未登录".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fastapi_detail_error() {
        let err = ApiError::from_response(401, r#"{"detail":"Invalid credentials"}"#);
        assert!(err.is_unauthorized());
        assert_eq!(err.user_message(), "Invalid credentials");
    }

    #[test]
    fn falls_back_to_raw_body() {
        let err = ApiError::from_response(500, "Internal Server Error");
        assert_eq!(err.status(), Some(500));
        assert!(!err.is_unauthorized());
        assert_eq!(err.user_message(), "Internal Server Error");
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
        assert_eq!(api_err.user_message(), "网络连接失败，请检查网络后重试");
    }

    #[test]
    fn unauthenticated_message() {
        assert_eq!(ApiError::Unauthenticated.user_message(), "未登录");
    }
}
