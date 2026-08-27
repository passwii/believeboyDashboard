//! 系统管理 → 账号管理领域类型（P5-8，BLF-754）
//!
//! 字段对齐 backend `backend/app/api/v1/endpoints/users.py` 的 `UserItem`
//! （snake_case 直通），与 web 端
//! `frontend/app/dashboard/system/account-management/page.tsx` 消费口径一致：
//! - 列表：`GET /api/v1/system-management/users` → `{ items: [UserItem] }`
//! - 变更：`POST` / `PATCH /{id}` → `{ item: UserItem }`
//!
//! 展示辅助（Yawei 保护账号判定 / 展示名归一 / 角色中文标签）从 web 页面内联
//! 逻辑 1:1 迁移，供 GUI 视图直接消费。

use crate::auth::UserRoleType;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 用户条目与响应（backend users.py UserItem / UsersResponse / UpdateUserResponse）
// ---------------------------------------------------------------------------

/// 用户账号单行（snake_case 与后端 Pydantic 模型 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminUserItem {
    /// 后端 `id::text`，字符串 UUID
    pub id: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default)]
    pub operator_name_zh: Option<String>,
    #[serde(default)]
    pub is_admin: bool,
    #[serde(default = "default_true")]
    pub is_active: bool,
    /// 缺省回退 operator（对齐 backend `_to_item` 兜底）
    #[serde(default = "default_role_type")]
    pub role_type: UserRoleType,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_true() -> bool {
    true
}

fn default_role_type() -> UserRoleType {
    UserRoleType::Operator
}

/// `GET /system-management/users` 响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminUsersResponse {
    #[serde(default)]
    pub items: Vec<AdminUserItem>,
}

/// `POST` / `PATCH /{id}` 变更响应（统一 `{ item }` 包装）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdminUserMutationResponse {
    pub item: AdminUserItem,
}

// ---------------------------------------------------------------------------
// 请求体（api-client 侧序列化用；PATCH 只更新显式传入字段）
// ---------------------------------------------------------------------------

impl AdminUserItem {
    /// Yawei 保护账号判定（对齐 web `isYaweiAccount` 与 backend DELETE 守卫）：
    /// name 精确等于 `yawei` 或 email 以 `yawei@` 开头——不允许停用 / 删除。
    pub fn is_protected(&self) -> bool {
        is_protected_account(&self.name, &self.email)
    }

    /// 展示名归一（对齐 web `getAccountDisplayName`）：保护账号固定展示 `Yawei`
    pub fn display_name(&self) -> &str {
        if self.is_protected() {
            "Yawei"
        } else {
            &self.name
        }
    }

    /// 姓名/运营姓名展示兜底（web：`fullName || operatorNameZh || '-'`）
    pub fn full_name_display(&self) -> String {
        self.full_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or(self
                .operator_name_zh
                .as_deref()
                .filter(|s| !s.trim().is_empty()))
            .unwrap_or("-")
            .to_string()
    }
}

/// Yawei 保护账号判定（name 归一小写精确匹配 + email 前缀匹配，trim 后比较）
pub fn is_protected_account(name: &str, email: &str) -> bool {
    let name = name.trim().to_lowercase();
    let email = email.trim().to_lowercase();
    name == "yawei" || email.starts_with("yawei@")
}

/// 角色中文标签（对齐 web ROLE_TYPE_OPTIONS；admin=管理员 / operator=运营 /
/// businessdev=招商）
pub fn role_type_label(role: UserRoleType) -> &'static str {
    match role {
        UserRoleType::Admin => "管理员",
        UserRoleType::Operator => "运营",
        UserRoleType::Businessdev => "招商",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str, email: &str) -> AdminUserItem {
        AdminUserItem {
            id: format!("u-{name}"),
            name: name.into(),
            email: email.into(),
            full_name: None,
            operator_name_zh: None,
            is_admin: false,
            is_active: true,
            role_type: UserRoleType::Operator,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-20T06:23:00+00:00".into(),
        }
    }

    #[test]
    fn users_response_parses_snake_case_payload() {
        let json = r#"{"items":[{"id":"abc","name":"yawei","email":"yawei@believeboy.com",
            "full_name":null,"operator_name_zh":"亚威","is_admin":true,"is_active":true,
            "role_type":"admin","created_at":"2025-01-01T00:00:00+00:00",
            "updated_at":"2026-08-20T06:23:00+00:00"}]}"#;
        let resp: AdminUsersResponse = serde_json::from_str(json).expect("解析失败");
        assert_eq!(resp.items.len(), 1);
        let u = &resp.items[0];
        assert_eq!(u.role_type, UserRoleType::Admin);
        assert!(u.is_protected());
        assert_eq!(u.display_name(), "Yawei");
        assert_eq!(u.full_name_display(), "亚威");
    }

    #[test]
    fn optional_fields_tolerate_missing() {
        // 后端任何一期少发可选字段也要能反序列化
        let json = r#"{"id":"u1","name":"n","email":"e@x.com"}"#;
        let u: AdminUserItem = serde_json::from_str(json).expect("解析失败");
        assert!(u.is_active, "is_active 缺省按启用");
        assert_eq!(u.role_type, UserRoleType::Operator);
        assert_eq!(u.full_name_display(), "-");
    }

    #[test]
    fn protected_account_rules_align_with_web_and_backend() {
        // name 精确匹配（大小写 / 空白不敏感）
        assert!(is_protected_account("yawei", "any@x.com"));
        assert!(is_protected_account("  Yawei ", "a@b.c"));
        // email 前缀匹配
        assert!(is_protected_account("someone", "yawei@believeboy.com"));
        // 非保护：yawei 出现在 name 中段 / email 用户名非 yawei 开头
        assert!(!is_protected_account("notyawei", "x@y.com"));
        assert!(!is_protected_account("n", "ya wei@x.com"));
        assert!(!is_protected_account("n", "prefix.yawei@x.com"));

        let mut u = user("ops", "ops@believeboy.com");
        assert!(!u.is_protected());
        assert_eq!(u.display_name(), "ops");
        u.name = "Yawei".into();
        assert_eq!(u.display_name(), "Yawei", "保护账号展示名归一");
    }

    #[test]
    fn role_labels_match_web_options() {
        assert_eq!(role_type_label(UserRoleType::Admin), "管理员");
        assert_eq!(role_type_label(UserRoleType::Operator), "运营");
        assert_eq!(role_type_label(UserRoleType::Businessdev), "招商");
    }

    #[test]
    fn mutation_response_round_trips() {
        let json = r#"{"item":{"id":"u9","name":"新用户","email":"new@x.com",
            "is_active":true,"role_type":"operator","is_admin":false}}"#;
        let resp: AdminUserMutationResponse = serde_json::from_str(json).expect("解析失败");
        assert_eq!(resp.item.name, "新用户");
        assert_eq!(resp.item.email, "new@x.com");
    }
}
