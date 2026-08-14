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
}
