//! 鉴权领域类型（与 `backend/app/api/v1/endpoints/auth.py` 1:1）
//!
//! 后端采用**会话（session）鉴权**而非 JWT：
//! - `POST /api/v1/auth/login` 返回 `LoginResponse`（含 `session_id` 与 BLF-711
//!   下发的专属 `api_key`——每次登录轮换，旧 key 立即失效）
//! - 后续请求通过 `X-User-Id` / `X-User-Email` / `X-Session-Id` 三个 header 声明身份；
//!   生产后端 dashboard 业务路由另要求 API key（`Authorization: Bearer`），桌面端用
//!   登录下发的 `api_key` 充当（BLF-787：此前 GUI 丢弃该字段，登录成功但业务模块全 401）
//! - 后续请求通过 `X-User-Id` / `X-User-Email` / `X-Session-Id` 三个 header 声明身份
//! - 会话活跃由 Redis 滑动窗口续期（`GET /api/v1/auth/me` 每次调用即续期）
//! - **后端没有 refresh token 端点**，无 access_token / expires_in 概念

use serde::{Deserialize, Serialize};

/// 用户角色（backend `UserRoleType`：admin / operator / businessdev）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRoleType {
    Admin,
    Operator,
    Businessdev,
}

impl UserRoleType {
    /// 后端 `X-Role-Type` 头的字符串值（与 serde lowercase 一致）
    pub fn as_str(self) -> &'static str {
        match self {
            UserRoleType::Admin => "admin",
            UserRoleType::Operator => "operator",
            UserRoleType::Businessdev => "businessdev",
        }
    }
}

fn default_role_type() -> UserRoleType {
    UserRoleType::Operator
}

/// `POST /api/v1/auth/login` 请求体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// `POST /api/v1/auth/login` 响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoginResponse {
    pub id: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub operator_name_zh: Option<String>,
    pub is_admin: bool,
    pub is_active: bool,
    #[serde(default = "default_role_type")]
    pub role_type: UserRoleType,
    #[serde(default)]
    pub session_id: String,
    /// BLF-711：登录按账号下发的专属 API key（`blf_` 前缀明文，仅本次响应返回；
    /// hash-only 存储下每次登录轮换、旧 key 立即失效）。生产后端 dashboard 业务
    /// 路由的 `require_api_key` 接受它充当 Bearer 凭据。空串 = 后端降级未签发
    /// （DB 异常不阻断登录），此时回退环境变量 `BELIEVEBOY_TOKEN` 或无鉴权。
    #[serde(default)]
    pub api_key: String,
}

/// `GET /api/v1/auth/me` 响应（启动时校验 / 续期会话）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeResponse {
    pub id: String,
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub operator_name_zh: Option<String>,
    pub is_admin: bool,
    pub is_active: bool,
    #[serde(default = "default_role_type")]
    pub role_type: UserRoleType,
    #[serde(default)]
    pub password_changed_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_response_round_trips_json() {
        let resp = LoginResponse {
            id: "u_1".into(),
            name: "测试".into(),
            email: "demo@believeboy.com".into(),
            operator_name_zh: Some("操作员甲".into()),
            is_admin: false,
            is_active: true,
            role_type: UserRoleType::Operator,
            session_id: "abc123".into(),
            api_key: "blf_demo_key".into(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: LoginResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back, resp);
        // 角色枚举走 lowercase（与 backend UserRoleType 一致）；key 随 JSON 往返持久化
        assert!(json.contains(r#""role_type":"operator""#));
        assert!(json.contains(r#""api_key":"blf_demo_key""#));
    }

    #[test]
    fn login_response_tolerates_missing_optional_fields() {
        // backend 任何一期没返回可选字段时也要能反序列化
        let json = r#"{"id":"u_2","name":"n","email":"e@x.com","is_admin":false,"is_active":true,"session_id":"s1"}"#;
        let resp: LoginResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.role_type, UserRoleType::Operator);
        assert_eq!(resp.operator_name_zh, None);
        // BLF-787：旧 Keychain 条目（无 api_key 字段）必须仍能反序列化为空串
        assert_eq!(resp.api_key, "");
    }

    #[test]
    fn role_type_serializes_to_backend_names() {
        assert_eq!(
            serde_json::to_string(&UserRoleType::Admin).unwrap(),
            r#""admin""#
        );
        assert_eq!(
            serde_json::to_string(&UserRoleType::Businessdev).unwrap(),
            r#""businessdev""#
        );
    }
}
