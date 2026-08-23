//! Agent 接入管理领域类型（P5-8，BLF-758）
//!
//! 对齐 backend：
//! - `app/schemas/agent_api_key.py`（`/api/v1/internal/api-keys` 凭据 CRUD）；
//! - `app/schemas/system_management/agent_access_logs.py`（读访问审计）；
//! - `app/schemas/system_management/agent_operations.py`（写操作审计）；
//! - `frontend/lib/agent-domains.ts`（业务域注册表单一事实源，1:1 迁移）。
//!
//! 凭据生命周期状态（BLF-468 §3）：由 `deleted_at > expires_at > is_revoked`
//! 派生（对齐 web 端 `getKeyStatus`）；scope 哨兵值 `*` = 全项目 / 全业务域。

use serde::{Deserialize, Serialize};

/// Agent 业务域状态：live = 已接入 agent 命名空间；planned = 规划中（仅概览展示）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentDomainStatus {
    Live,
    Planned,
}

/// Agent 业务域注册表条目（对齐 web `AgentDomain`）
#[derive(Debug, Clone)]
pub struct AgentDomain {
    /// 后端 business_scope 取值，如 'shipments'
    pub code: &'static str,
    /// 中文名
    pub label: &'static str,
    /// 一句话说明
    pub description: &'static str,
    pub status: AgentDomainStatus,
    /// agent 命名空间路由数（展示用，人工维护）
    pub route_count: u32,
    /// 能力位（读 / 写）
    pub read: bool,
    pub write: bool,
}

/// 业务域注册表（对齐 `frontend/lib/agent-domains.ts` `AGENT_DOMAINS`；
/// 新增业务域 = 注册表加一条 + 后端挂路由，页面自动出现）
pub const AGENT_DOMAINS: &[AgentDomain] = &[
    AgentDomain {
        code: "shipments",
        label: "货件管理",
        description: "FBA 货件全生命周期：列表/详情/增删改/状态推进/费用重算",
        status: AgentDomainStatus::Live,
        route_count: 11,
        read: true,
        write: true,
    },
    AgentDomain {
        code: "shop_calculations",
        label: "店铺测算",
        description: "店铺测算数据读写与试算：列表/SKU 详情/历史/审计/追加/试算",
        status: AgentDomainStatus::Live,
        route_count: 6,
        read: true,
        write: true,
    },
    AgentDomain {
        code: "return_analysis",
        label: "退货分析",
        description: "退货/客诉归因：全量分析/per-SKU 风险清单/raw 事件/覆盖度",
        status: AgentDomainStatus::Live,
        route_count: 5,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "inventory",
        label: "库存信息",
        description: "当前库存快照：总量/库龄/缺货/单 SKU 数量（独立于补货分析）",
        status: AgentDomainStatus::Live,
        route_count: 1,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "ad_analysis",
        label: "广告分析",
        description: "10 个广告域聚合（预算/搜索词/竞品份额）",
        status: AgentDomainStatus::Live,
        route_count: 10,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "inventory_ledger",
        label: "库存台账",
        description: "月度盘点/事件/收货簇/完整性/趋势（Detailed + Summary 视图）",
        status: AgentDomainStatus::Live,
        route_count: 10,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "report_upload_status",
        label: "报表状态",
        description: "RPA 报表上传状态矩阵：15 类活跃报表缺失统计",
        status: AgentDomainStatus::Live,
        route_count: 1,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "replenishment_analysis",
        label: "补货分析",
        description: "补货决策清单/单 SKU 深挖/项目总览/覆盖度/设置（三段式体系，BLF-502）",
        status: AgentDomainStatus::Live,
        route_count: 6,
        read: true,
        write: true,
    },
    AgentDomain {
        code: "new_product_calculations",
        label: "新品测算",
        description: "新品测算快照读写与试算：列表/SKU 详情/审计/落库/试算（BLF-526）",
        status: AgentDomainStatus::Live,
        route_count: 5,
        read: true,
        write: true,
    },
    AgentDomain {
        code: "account_health",
        label: "店铺合规健康",
        description: "店铺合规/账户健康：周巡检周期列表/概览/单店明细/历史趋势（BLF-547）",
        status: AgentDomainStatus::Live,
        route_count: 5,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "sales",
        label: "销售数据",
        description: "销售订单明细/聚合统计：原始行 + ASIN×日/ASIN/日聚合（Sales Data）",
        status: AgentDomainStatus::Live,
        route_count: 1,
        read: true,
        write: false,
    },
    AgentDomain {
        code: "sku_info",
        label: "SKU 主数据",
        description: "商品主数据读+写：列表/详情/审计 + 新建/改规格成本/上下架/FNSKU 标签上传",
        status: AgentDomainStatus::Live,
        route_count: 7,
        read: true,
        write: true,
    },
    AgentDomain {
        code: "finance_profit",
        label: "财务利润",
        description: "利润/财务（月度×项目×国家），COGS 口径待定",
        status: AgentDomainStatus::Planned,
        route_count: 0,
        read: true,
        write: false,
    },
];

/// 全域放行哨兵值（与后端 server_default 对齐）
pub const BUSINESS_SCOPE_ALL: &str = "*";

/// 按 code 查注册表条目（未知 code → None）
pub fn get_agent_domain(code: &str) -> Option<&'static AgentDomain> {
    AGENT_DOMAINS.iter().find(|d| d.code == code)
}

/// 已接入（live）域列表：创建凭据时可选
pub fn live_agent_domains() -> impl Iterator<Item = &'static AgentDomain> {
    AGENT_DOMAINS
        .iter()
        .filter(|d| d.status == AgentDomainStatus::Live)
}

/// 归一化 scope（项目 / 业务域通用）：空串 / '*' → '*'；其余 trim 后保持原样
pub fn normalize_scope(scope: Option<&str>) -> String {
    match scope.map(str::trim) {
        None | Some("") | Some("*") => BUSINESS_SCOPE_ALL.to_string(),
        Some(v) => v.to_string(),
    }
}

/// 判断 scope 是否覆盖某域：'*' 恒 true；否则 ',' 分隔白名单包含
pub fn scope_has_domain(scope: Option<&str>, code: &str) -> bool {
    let normalized = normalize_scope(scope);
    if normalized == BUSINESS_SCOPE_ALL {
        return true;
    }
    normalized.split(',').any(|part| part.trim() == code)
}

/// 格式化业务域 scope 为可读文案：'*' → 全部业务域；否则域中文名列表
pub fn format_business_scope(scope: Option<&str>) -> String {
    let normalized = normalize_scope(scope);
    if normalized == BUSINESS_SCOPE_ALL {
        return "全部业务域".to_string();
    }
    join_labels(&normalized, |code| {
        get_agent_domain(code).map(|d| d.label.to_string())
    })
}

/// 格式化项目 scope 为可读文案：'*' → 全部项目；否则按 id 映射项目名
/// （未知 id 回退 `#id`，对齐 web `formatProjectScope`）
pub fn format_project_scope(scope: Option<&str>, projects: &[(i64, String)]) -> String {
    let normalized = normalize_scope(scope);
    if normalized == BUSINESS_SCOPE_ALL {
        return "全部项目".to_string();
    }
    join_labels(&normalized, |id| {
        id.parse::<i64>()
            .ok()
            .and_then(|pid| {
                projects
                    .iter()
                    .find(|(pid_known, _)| *pid_known == pid)
                    .map(|(_, name)| name.clone())
            })
            .or_else(|| Some(format!("#{id}")))
    })
}

/// 解析 ',' 分隔的 scope 成片段数组（'*' → 空，编辑 Dialog 预填用）
pub fn parse_scope_parts(scope: Option<&str>) -> Vec<String> {
    let normalized = normalize_scope(scope);
    if normalized == BUSINESS_SCOPE_ALL {
        return Vec::new();
    }
    normalized
        .split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn join_labels(normalized: &str, resolve: impl Fn(&str) -> Option<String>) -> String {
    let parts: Vec<String> = normalized
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| resolve(p).unwrap_or_else(|| format!("#{p}")))
        .collect();
    parts.join("、")
}

// ---------------------------------------------------------------------------
// 凭据（agent_api_keys）
// ---------------------------------------------------------------------------

/// Agent API 凭据条目（backend `ApiKeyItem` 1:1；无密钥明文）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentApiKeyItem {
    pub id: i64,
    pub key_prefix: String,
    pub label: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub project_scope: String,
    #[serde(default)]
    pub business_scope: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub is_revoked: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// 软删除 tombstone（BLF-468）；默认列表隐藏
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// 创建凭据响应（backend `ApiKeyCreateResponse`）：明文仅此一次下发
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentApiKeyCreateResponse {
    pub id: i64,
    pub key_prefix: String,
    pub label: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub project_scope: String,
    #[serde(default)]
    pub business_scope: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub created_at: String,
    pub plaintext_key: String,
}

/// 停用 / 激活响应（backend `ApiKeyDeactivateResponse` / `…ActivateResponse` 同形）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentKeyToggleResponse {
    pub id: i64,
    pub is_revoked: bool,
}

/// 凭据生命周期状态（BLF-468 §3；派生优先级 deleted > expired > inactive > active）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKeyStatus {
    Active,
    Inactive,
    Expired,
    Deleted,
}

impl AgentKeyStatus {
    /// 由凭据字段派生（对齐 web `getKeyStatus`：expires_at ≤ now 判过期）
    pub fn derive(item: &AgentApiKeyItem, now_ms: i64) -> Self {
        if item.deleted_at.is_some() {
            return Self::Deleted;
        }
        if let Some(expires_at) = &item.expires_at {
            if let Ok(ms) = parse_iso_to_ms(expires_at) {
                if ms <= now_ms {
                    return Self::Expired;
                }
            }
        }
        if item.is_revoked {
            Self::Inactive
        } else {
            Self::Active
        }
    }

    /// 状态中文标签（对齐 web `STATUS_META.label`）
    pub fn label(self) -> &'static str {
        match self {
            Self::Active => "激活",
            Self::Inactive => "停用",
            Self::Expired => "已过期",
            Self::Deleted => "已删除",
        }
    }
}

/// ISO 时间戳 → Unix 毫秒（rfc3339 带偏移或 naive-UTC isoformat 都接受；
/// 解析失败返回 Err——与 web `Number.isNaN(date.getTime())` 一致不误判过期）
#[allow(clippy::result_unit_err)] // 解析失败无需错误详情，单元错误类型即契约
pub fn parse_iso_to_ms(iso: &str) -> Result<i64, ()> {
    let trimmed = iso.trim();
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .map(|dt| dt.timestamp_millis())
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|naive| {
                    use chrono::TimeZone;
                    chrono::Utc
                        .from_utc_datetime(&naive)
                        .timestamp_millis()
                })
                .map_err(|_| ())
        })
}

// ---------------------------------------------------------------------------
// 操作日志（写；读访问审计复用 `system_management::AgentAccessLog*`，BLF-757 已接入）
// ---------------------------------------------------------------------------

/// Agent 写操作日志行（backend `AgentOperationLogItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentOperationLogItem {
    pub id: i64,
    pub created_at: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
    pub action: String,
    pub target_type: String,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub target_label: Option<String>,
    pub result: String,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub operation_type: Option<String>,
    #[serde(default)]
    pub request_path: Option<String>,
    #[serde(default)]
    pub request_method: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

/// 写操作日志分页响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentOperationLogsResponse {
    #[serde(default)]
    pub items: Vec<AgentOperationLogItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub has_next: bool,
}

/// Top Agent 操作计数
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentOperationLogTopAgent {
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    pub count: i64,
}

/// Top 动作计数
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentOperationLogTopAction {
    pub action: String,
    pub count: i64,
}

/// 写操作统计概览
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentOperationLogsSummary {
    pub total: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub unique_agent_count: i64,
    #[serde(default)]
    pub top_agents: Vec<AgentOperationLogTopAgent>,
    #[serde(default)]
    pub top_actions: Vec<AgentOperationLogTopAction>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_item() -> AgentApiKeyItem {
        AgentApiKeyItem {
            id: 1,
            key_prefix: "bbk_abcd".into(),
            label: "货件助理".into(),
            scope: "read".into(),
            project_scope: "*".into(),
            business_scope: "*".into(),
            agent_id: Some("shipment-assistant-prod".into()),
            is_revoked: false,
            expires_at: None,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            last_used_at: None,
            deleted_at: None,
        }
    }

    #[test]
    fn registry_matches_web_source_of_truth() {
        // 与 frontend/lib/agent-domains.ts 条数一致（12 live + 1 planned）
        assert_eq!(AGENT_DOMAINS.len(), 13);
        assert_eq!(live_agent_domains().count(), 12);
        // 关键域 code 锁定（business_scope 取值必须与后端一致）
        assert!(get_agent_domain("shipments").is_some());
        assert!(get_agent_domain("sku_info").is_some());
        assert_eq!(get_agent_domain("finance_profit").unwrap().status, AgentDomainStatus::Planned);
        assert!(get_agent_domain("nonexistent").is_none());
    }

    #[test]
    fn scope_helpers_follow_sentinel_semantics() {
        assert_eq!(normalize_scope(None), "*");
        assert_eq!(normalize_scope(Some("")), "*");
        assert_eq!(normalize_scope(Some(" * ")), "*");
        assert_eq!(normalize_scope(Some("shipments,sales")), "shipments,sales");

        assert!(scope_has_domain(Some("*"), "sales"));
        assert!(scope_has_domain(Some("shipments,sales"), "sales"));
        assert!(!scope_has_domain(Some("shipments"), "sales"));
        assert!(scope_has_domain(None, "anything"));

        assert_eq!(format_business_scope(Some("*")), "全部业务域");
        assert_eq!(
            format_business_scope(Some("shipments,sales")),
            "货件管理、销售数据"
        );
        assert_eq!(format_business_scope(Some("unknown_code")), "#unknown_code");

        assert_eq!(parse_scope_parts(Some("*")), Vec::<String>::new());
        assert_eq!(
            parse_scope_parts(Some("shipments, sales")),
            vec!["shipments".to_string(), "sales".to_string()]
        );
    }

    #[test]
    fn project_scope_formats_with_name_mapping() {
        let projects = vec![(1i64, "美国店".to_string()), (3, "德国店".to_string())];
        assert_eq!(format_project_scope(Some("*"), &projects), "全部项目");
        assert_eq!(
            format_project_scope(Some("1,3"), &projects),
            "美国店、德国店"
        );
        // 未知 id 回退 #id（对齐 web）
        assert_eq!(format_project_scope(Some("1,9"), &projects), "美国店、#9");
    }

    #[test]
    fn key_status_derivation_priority() {
        let mut item = sample_item();
        assert_eq!(AgentKeyStatus::derive(&item, 0), AgentKeyStatus::Active);

        // revoked → inactive
        item.is_revoked = true;
        assert_eq!(AgentKeyStatus::derive(&item, 0), AgentKeyStatus::Inactive);

        // 过期优先于 revoked（now 已越过 2020 到期点）
        item.expires_at = Some("2020-01-01T00:00:00Z".into());
        assert_eq!(
            AgentKeyStatus::derive(&item, 1_600_000_000_000),
            AgentKeyStatus::Expired
        );
        // 未到期不算过期（now 在到期点之前）
        assert_eq!(AgentKeyStatus::derive(&item, 1_000), AgentKeyStatus::Inactive);

        // deleted 最高优先级（即使已过期 / 已停用）
        item.deleted_at = Some("2026-08-02T00:00:00+00:00".into());
        assert_eq!(AgentKeyStatus::derive(&item, 1_000), AgentKeyStatus::Deleted);

        // 非法 expires_at 不误判过期（对齐 web NaN 行为）
        let mut bad = sample_item();
        bad.expires_at = Some("not-a-date".into());
        assert_eq!(AgentKeyStatus::derive(&bad, i64::MAX), AgentKeyStatus::Active);

        assert_eq!(AgentKeyStatus::Active.label(), "激活");
        assert_eq!(AgentKeyStatus::Expired.label(), "已过期");
    }

    #[test]
    fn parse_iso_accepts_offset_and_naive() {
        assert_eq!(
            parse_iso_to_ms("2020-01-01T00:00:00Z").unwrap(),
            1_577_836_800_000
        );
        assert_eq!(
            parse_iso_to_ms("2020-01-01T00:00:00+08:00").unwrap(),
            1_577_808_000_000
        );
        assert_eq!(
            parse_iso_to_ms("2020-01-01T00:00:00").unwrap(),
            1_577_836_800_000
        );
        assert!(parse_iso_to_ms("").is_err());
    }
}
