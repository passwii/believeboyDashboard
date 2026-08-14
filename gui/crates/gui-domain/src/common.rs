//! 跨域通用类型

use serde::{Deserialize, Serialize};

/// 当前操作用户可访问的项目（frontend `ProjectItem` 1:1）
///
/// 数据源：`useManagedProjects` → `GET /api/v1/projects/manage`（注意是 manage 不是
/// managed，backend `app/api/v1/endpoints/projects.py` 的 `/projects/manage` 路由）。
/// 字段对齐 frontend `frontend/types/api-generated/api.d.ts` 的 `ProjectItem` schema；
/// 带 `#[serde(default)]` 的字段对应 Pydantic 默认值（is_active=true /
/// has_context=false / vat_enabled=false），缺省时也能反序列化。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManagedProject {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub brand_name: Option<String>,
    #[serde(default)]
    pub store_address: Option<String>,
    #[serde(default)]
    pub project_operator: Option<String>,
    #[serde(default)]
    pub assistant_operator: Option<String>,
    #[serde(default)]
    pub commission_basis: Option<String>,
    #[serde(default)]
    pub commission_rate: Option<f64>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "default_true")]
    pub is_active: bool,
    #[serde(default)]
    pub source_file: Option<String>,
    #[serde(default)]
    pub has_context: bool,
    #[serde(default)]
    pub project_tier: Option<String>,
    #[serde(default)]
    pub vat_enabled: bool,
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_project_deserializes_project_item_sample() {
        // backend /projects/manage 的真实响应形态（ProjectItem）
        let json = r#"{
            "id": 3,
            "name": "测试项目 A",
            "brand_name": "BelieveBoy",
            "store_address": "US-FBA",
            "project_operator": "甲",
            "assistant_operator": "乙",
            "commission_basis": "sales",
            "commission_rate": 5.0,
            "sort_order": 1,
            "is_active": true,
            "source_file": "2026-08.csv",
            "has_context": true,
            "project_tier": "A",
            "vat_enabled": false
        }"#;
        let p: ManagedProject = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(p.id, 3);
        assert_eq!(p.name, "测试项目 A");
        assert_eq!(p.brand_name.as_deref(), Some("BelieveBoy"));
        assert_eq!(p.project_operator.as_deref(), Some("甲"));
        assert_eq!(p.commission_rate, Some(5.0));
        assert_eq!(p.sort_order, 1);
        assert!(p.is_active);
        assert!(p.has_context);
        assert!(!p.vat_enabled);
    }

    #[test]
    fn managed_project_tolerates_missing_optional_fields() {
        // 只给必填（id/name），其余字段按 Pydantic 默认值兜底
        let json = r#"{"id": 7, "name": "极简载荷"}"#;
        let p: ManagedProject = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(p.id, 7);
        assert_eq!(p.name, "极简载荷");
        assert_eq!(p.brand_name, None);
        assert_eq!(p.commission_rate, None);
        assert_eq!(p.sort_order, 0);
        assert!(p.is_active);
        assert!(!p.has_context);
        assert!(!p.vat_enabled);
    }
}
