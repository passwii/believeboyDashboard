//! 跨域通用类型

use serde::{Deserialize, Serialize};

/// 当前操作用户可访问的项目（来自 `useManagedProjects` → `/api/v1/projects/managed`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedProject {
    pub id: i64,
    pub name: String,
    // 后端会带更多字段（currency / timezone 等），按需展开
    #[serde(flatten)]
    pub extra: serde_json::Value,
}
