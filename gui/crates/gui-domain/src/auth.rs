//! 鉴权领域类型（与 `backend/app/api/v1/endpoints/auth.py` 1:1）
//!
//! 后端采用**会话（session）鉴权**而非 JWT：
//! - `POST /api/v1/auth/login` 返回 `LoginResponse`（含 `session_id`）
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
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: LoginResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back, resp);
        // 角色枚举走 lowercase（与 backend UserRoleType 一致）
        assert!(json.contains(r#""role_type":"operator""#));
    }

    #[test]
    fn login_response_tolerates_missing_optional_fields() {
        // backend 任何一期没返回可选字段时也要能反序列化
        let json = r#"{"id":"u_2","name":"n","email":"e@x.com","is_admin":false,"is_active":true,"session_id":"s1"}"#;
        let resp: LoginResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.role_type, UserRoleType::Operator);
        assert_eq!(resp.operator_name_zh, None);
    }

    #[test]
    fn role_type_serializes_to_backend_names() {
        assert_eq!(serde_json::to_string(&UserRoleType::Admin).unwrap(), r#""admin""#);
        assert_eq!(
            serde_json::to_string(&UserRoleType::Businessdev).unwrap(),
            r#""businessdev""#
        );
    }
}
