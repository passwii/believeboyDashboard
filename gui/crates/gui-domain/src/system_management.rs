//! 系统管理 → 日志查看领域类型（P5-8，BLF-757）
//!
//! 字段对齐 backend `backend/app/schemas/system_management/audit.py`（操作审计
//! 日志）与 `agent_access_logs.py`（Agent 访问日志），与 web 端
//! `frontend/app/dashboard/system/logs/page.tsx`、
//! `frontend/components/system/agent-access-logs-panel.tsx` 的 DTO 声明同口径。
//!
//! 展示辅助（分类归属 / 动作中文标签 / 资源类型标签 / UA 解析 / 相对时间）
//! 从 web 页面内联常量 1:1 迁移，供 GUI 视图直接消费。

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 操作审计日志（GET /api/v1/system-management/audit-logs）
// ---------------------------------------------------------------------------

/// 操作审计日志单行（snake_case 直通；`created_at` 后端可能给空串，保 String
/// 由展示层解析兜底「-」）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationAuditLogItem {
    pub id: i64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub operator: Option<String>,
    pub action: String,
    pub target_type: String,
    #[serde(default)]
    pub target_id: Option<String>,
    /// `"success"` | `"failure"`（未知值按成功展示，对齐 web `getResultMeta`）
    pub result: String,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub request_method: Option<String>,
    #[serde(default)]
    pub request_path: Option<String>,
    #[serde(default)]
    pub ip_address: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    /// 变更前快照（对象或数组；详情弹层 JSON pretty 展示）
    #[serde(default)]
    pub before_json: Option<serde_json::Value>,
    /// 变更后 / 返回结果快照
    #[serde(default)]
    pub after_json: Option<serde_json::Value>,
    #[serde(default)]
    pub error_message: Option<String>,
}

/// 操作审计日志分页响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationAuditLogsResponse {
    #[serde(default)]
    pub items: Vec<OperationAuditLogItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    #[serde(default)]
    pub has_next: bool,
}

/// 模块维度汇总项
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationAuditLogModuleSummaryItem {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub success_count: i64,
    pub failure_count: i64,
}

/// 高频动作汇总项
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationAuditLogActionSummaryItem {
    pub action: String,
    pub count: i64,
}

/// 操作审计日志汇总（当前筛选条件下的统计概览）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationAuditLogsSummaryResponse {
    pub total: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub unique_operator_count: i64,
    #[serde(default)]
    pub modules: Vec<OperationAuditLogModuleSummaryItem>,
    #[serde(default)]
    pub top_actions: Vec<OperationAuditLogActionSummaryItem>,
}

// ---------------------------------------------------------------------------
// Agent 访问日志（GET /api/v1/system-management/agent-access-logs）
// ---------------------------------------------------------------------------

/// Agent API 访问日志单行（中间件每请求一行，join agent_api_keys 还原身份）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAccessLogItem {
    pub id: i64,
    #[serde(default)]
    pub created_at: String,
    pub method: String,
    pub path: String,
    pub status_code: i64,
    pub latency_ms: i64,
    #[serde(default)]
    pub ip_address: Option<String>,
    #[serde(default)]
    pub api_key_id: Option<i64>,
    /// 未鉴权请求为 None → 展示「未绑定」
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Agent 中文名即「名称」（BLF-471：join 还原 key_label）
    #[serde(default)]
    pub key_label: Option<String>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub operation_type: Option<String>,
}

/// Agent 访问日志分页响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAccessLogsResponse {
    #[serde(default)]
    pub items: Vec<AgentAccessLogItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    #[serde(default)]
    pub has_next: bool,
}

/// Agent 维度汇总项
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAccessLogAgentSummaryItem {
    pub agent_id: String,
    #[serde(default)]
    pub key_label: Option<String>,
    pub count: i64,
}

/// Agent 访问日志汇总
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAccessLogsSummaryResponse {
    pub total: i64,
    pub success_count: i64,
    pub error_count: i64,
    pub unique_agent_count: i64,
    #[serde(default)]
    pub top_agents: Vec<AgentAccessLogAgentSummaryItem>,
}

// ---------------------------------------------------------------------------
// 分类归属（web CATEGORY_OPTIONS 前缀表 1:1）
// ---------------------------------------------------------------------------

/// 日志分类（key + 中文标签）；前缀匹配顺序对齐 web `CATEGORY_OPTIONS`
pub const LOG_CATEGORIES: &[(&str, &str, &[&str])] = &[
    (
        "commission",
        "提成与绩效",
        &["commission.", "operator.performance."],
    ),
    ("shipment", "发货管理", &["shipment_schedules."]),
    ("sku", "SKU资料", &["sku_info."]),
    ("project", "项目资料", &["projects."]),
    ("account", "账号权限", &["users."]),
    ("auth", "用户登录", &["auth."]),
    (
        "inventory",
        "库存补货",
        &[
            "inventory_analysis.",
            "inventory_replenishment.",
            "inventory_replenishment_settings.",
        ],
    ),
    ("system", "系统运维", &["system."]),
    (
        "report",
        "报表中心",
        &[
            "daily_reports.",
            "daily_analysis.",
            "monthly_reports.",
            "financial_data.",
            "product_analysis.",
            "product_analysis_reports.",
            "pricing_calculation.",
            "report_upload.",
        ],
    ),
];

/// 动作 → 分类标签（无前缀命中 = 「其他」，对齐 web `getCategoryMeta` 兜底）
pub fn operation_category_label(action: &str) -> &'static str {
    for (_key, label, prefixes) in LOG_CATEGORIES {
        if prefixes.iter().any(|p| action.starts_with(p)) {
            return label;
        }
    }
    "其他"
}

/// 分类 key → 后端 `action` 前缀过滤参数（web `CATEGORY_FILTER_ACTIONS`；
/// `other` 无对应参数——GUI 侧按分类标签客户端过滤）
pub fn category_action_query(key: &str) -> Option<&'static str> {
    match key {
        "commission" => Some("commission."),
        "shipment" => Some("shipment_schedules."),
        "sku" => Some("sku_info."),
        "project" => Some("projects."),
        "account" => Some("users."),
        "auth" => Some("auth."),
        "inventory" => Some("inventory_"),
        "system" => Some("system."),
        "report" => Some("report"),
        _ => None,
    }
}

/// 「其他」判定（与 [`operation_category_label`] 同一前缀表；供客户端过滤）
pub fn is_other_category(action: &str) -> bool {
    !LOG_CATEGORIES
        .iter()
        .any(|(_k, _l, prefixes)| prefixes.iter().any(|p| action.starts_with(p)))
}

// ---------------------------------------------------------------------------
// 动作 / 资源类型中文标签（web ACTION_LABELS / TARGET_TYPE_LABELS 1:1）
// ---------------------------------------------------------------------------

/// 已知动作的中文标签（web `ACTION_LABELS` 全量迁移）
pub fn operation_action_label(action: &str) -> Option<&'static str> {
    Some(match action {
        "auth.login.success" => "登录成功",
        "auth.login.failed" => "登录失败",
        "auth.login.account_disabled" => "登录失败（账号已禁用）",
        "users.list" => "查看账号列表",
        "users.create" => "创建账号",
        "users.update" => "更新账号",
        "projects.list" => "查看项目列表",
        "projects.create" => "创建项目",
        "projects.update" => "更新项目",
        "projects.options.view" => "查看项目选项",
        "projects.operator_options.view" => "查看项目运营人选项",
        "sku_info.list" => "查看 SKU 资料",
        "sku_info.upsert" => "新增或更新 SKU 资料",
        "sku_info.bulk_upsert" => "批量新增或更新 SKU 资料",
        "sku_info.update" => "更新 SKU 资料",
        "sku_info.move_sort" => "调整 SKU 排序",
        "sku_info.import_csv" => "导入 SKU CSV",
        "sku_info.export" => "导出 SKU 数据",
        "sku_info.import_default_file" => "导入默认 SKU 文件",
        "sku_info.recalculate_first_leg_costs" => "重算头程成本",
        "shipment_schedules.list" => "查看发货计划列表",
        "shipment_schedules.detail.view" => "查看发货计划详情",
        "shipment_schedules.cost_summary.view" => "查看发货成本汇总",
        "shipment_schedules.sku_summary.view" => "查看 SKU 头程均价汇总",
        "shipment_schedules.fba_box_details.view" => "查看箱规明细",
        "shipment_schedules.create" => "创建发货计划",
        "shipment_schedules.import_csv" => "导入发货计划 CSV",
        "shipment_schedules.update" => "更新发货计划",
        "shipment_schedules.delete" => "删除发货计划",
        "shipment_schedules.import_items_csv" => "导入发货明细 CSV",
        "shipment_schedules.calculate_costs" => "计算发货成本",
        "shipment_schedules.overview.export" => "导出船期批次总览",
        "shipment_schedules.costs.export" => "导出发货费用",
        "shipment_schedules.sku_summary.export" => "导出 SKU 汇总",
        "shipment_schedules.fba_box_details.export" => "导出 FBA 箱单明细",
        "inventory_analysis.view" => "查看库存分析",
        "inventory_analysis.export" => "导出库存分析",
        "inventory_replenishment.list" => "查看补货分析列表",
        "inventory_replenishment.shipments.view" => "查看补货在途记录",
        "inventory_replenishment.export" => "导出补货分析",
        "inventory_replenishment_settings.upsert" => "维护补货参数",
        "system.data_management.status.view" => "查看数据状态",
        "system.data_management.overview.view" => "查看系统数据总览",
        "system.data_status.update" => "更新数据状态",
        "commission.bonus_records.view" => "查看提成明细",
        "commission.bonus_records.upsert" => "导入提成明细",
        "commission.bonus.recompute" => "重算提成数据",
        "commission.bonus_record.payment_status.update" => "更新个人提成打款状态",
        "commission.project_months.view" => "查看项目提成汇总",
        "commission.summary.monthly.view" => "查看年度月度汇总",
        "commission.summary.project.view" => "查看项目年度汇总",
        "commission.project_commission.payment.update" => "更新项目回款状态",
        "commission.ratio_overrides.view" => "查看提成比例覆盖",
        "commission.ratio_overrides.upsert" => "维护提成比例覆盖",
        "commission.role_assignments.view" => "查看项目角色分配",
        "commission.role_assignments.upsert" => "维护项目角色分配",
        "operator.performance.view" => "查看运营绩效",
        "operator.performance.upsert" => "维护运营绩效",
        "daily_reports.create" => "生成日报",
        "daily_reports.result.view" => "查看日报结果",
        "daily_reports.result.export" => "导出日报结果",
        "daily_analysis.export" => "导出销售数据分析",
        "monthly_reports.create" => "生成月报",
        "monthly_reports.result.view" => "查看月报结果",
        "monthly_reports.result.export" => "导出月报任务结果",
        "monthly_reports.export" => "导出月报",
        "financial_data.export" => "导出月度财务分析",
        "product_analysis.weekly.recompute" => "重新核算周报",
        "product_analysis.weekly.export" => "导出周报分析",
        "product_analysis_reports.create" => "生成产品分析报表",
        "product_analysis_reports.result.view" => "查看产品分析报表",
        "product_analysis_reports.result.export" => "导出产品分析报表",
        "pricing_calculation.run.create" => "发起报价测算",
        "pricing_calculation.run.delete" => "删除报价测算",
        "pricing_calculation.run.recalculate" => "重新核算报价测算",
        "pricing_calculation.run.view" => "查看报价测算结果",
        "pricing_calculation.comparison.export" => "导出测算对比矩阵",
        "pricing_calculation.store_table.export" => "导出店铺 SKU 核算表",
        "pricing_calculation.store_snapshot.upsert" => "保存店铺 SKU 核算快照",
        "report_upload.status.view" => "查看报表上传状态",
        "report_upload.recognize" => "识别报表内容",
        "report_upload.commit" => "提交报表入库",
        _ => return None,
    })
}

/// 动作展示标签：已知映射优先；未知动作按末段动词兜底
/// 「{分类} · {动词}」（web `formatActionLabel` 口径），再退回原始动作
pub fn format_action_label(action: &str) -> String {
    if let Some(label) = operation_action_label(action) {
        return label.to_string();
    }
    let verb = action.rsplit('.').next().unwrap_or(action);
    let verb_label = match verb {
        "list" => Some("查看列表"),
        "view" => Some("查看详情"),
        "create" => Some("新建"),
        "update" => Some("更新"),
        "delete" => Some("删除"),
        "upsert" => Some("新增或更新"),
        "export" => Some("导出"),
        "recompute" => Some("重算"),
        _ => None,
    };
    match verb_label {
        Some(v) => format!("{} · {v}", operation_category_label(action)),
        None => action.to_string(),
    }
}

/// 资源类型中文标签（web `TARGET_TYPE_LABELS` 全量迁移；未知值原样透传）
pub fn target_type_label(target_type: &str) -> &str {
    match target_type {
        "user_account" => "账号",
        "project" => "项目",
        "project_operator" => "项目运营人",
        "sku_info" => "SKU 资料",
        "shipment_schedule" => "发货计划",
        "inventory_analysis" => "库存分析",
        "inventory_replenishment" => "补货分析",
        "inventory_replenishment_setting" => "补货参数",
        "system_management" => "系统管理",
        "system_management_data_state" => "数据状态",
        "commission_bonus_record" => "提成记录",
        "commission_project_month" => "项目提成汇总",
        "commission_ratio_override" => "提成比例覆盖",
        "project_role_assignment" => "项目角色分配",
        "operator_performance_record" => "运营绩效",
        "commission_summary" => "提成汇总",
        "daily_report_task" => "日报任务",
        "monthly_report_task" => "月报任务",
        "monthly_report" => "月报",
        "product_analysis_report_task" => "产品分析任务",
        "report_upload" => "报表入库",
        "report_upload_temp_file" => "报表临时文件",
        "pricing_calculation_run" => "定价测算",
        "new_product_calculation" => "店铺 SKU 核算快照",
        "product_analysis_weekly" => "周报分析",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// 时间 / 设备展示辅助
// ---------------------------------------------------------------------------

/// 宽松解析 ISO 8601 → UTC（rfc3339；解析失败返回 None）
fn parse_iso_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

/// ISO 时间 → 本机时区 `YYYY-MM-DD HH:MM`（解析失败原样返回；空串 → `-`，
/// 对齐 crm::format_audit_time 口径但容忍后端空串兜底）
pub fn format_log_time(created_at: &str) -> String {
    if created_at.is_empty() {
        return "-".to_string();
    }
    match parse_iso_utc(created_at) {
        Some(dt) => dt.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string(),
        None => created_at.to_string(),
    }
}

/// ISO 时间 → 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 落本地日期；
/// web `formatTimeAgo` 口径；解析失败或空串 → `-`）
pub fn format_time_ago(created_at: &str) -> String {
    let Some(dt) = parse_iso_utc(created_at) else {
        return "-".to_string();
    };
    let diff = (Utc::now() - dt).num_seconds().max(0);
    if diff < 60 {
        return "刚刚".to_string();
    }
    let minutes = diff / 60;
    if minutes < 60 {
        return format!("{minutes} 分钟前");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours} 小时前");
    }
    let days = hours / 24;
    if days < 7 {
        return format!("{days} 天前");
    }
    dt.with_timezone(&Local).format("%Y-%m-%d").to_string()
}

/// User-Agent → （操作系统，浏览器）粗解析（web `parseUserAgent` 口径精简：
/// 图标由 GUI 主题图标替代，不迁移 emoji）
pub fn parse_user_agent(ua: Option<&str>) -> (String, String) {
    let Some(ua) = ua else {
        return ("未知".to_string(), "未知".to_string());
    };
    let lower = ua.to_lowercase();

    let os = if lower.contains("windows") {
        "Windows"
    } else if lower.contains("mac os x") {
        "macOS"
    } else if lower.contains("android") {
        "Android"
    } else if lower.contains("iphone") || lower.contains("ipad") {
        "iOS"
    } else if lower.contains("linux") {
        "Linux"
    } else {
        "未知"
    };

    let browser = if lower.contains("edg/") && !lower.contains("edge/") {
        "Edge"
    } else if lower.contains("chrome/") && !lower.contains("chromium") {
        "Chrome"
    } else if lower.contains("firefox/") {
        "Firefox"
    } else if lower.contains("safari/") && !lower.contains("chrome") {
        "Safari"
    } else if lower.contains("opera") || lower.contains("opr/") {
        "Opera"
    } else {
        "未知"
    };

    (os.to_string(), browser.to_string())
}

// ---------------------------------------------------------------------------
// 数据管理 → 数据库状态（BLF-797 Footer 同步引擎段；数据库状态页同源接口）
// ---------------------------------------------------------------------------

/// `GET /api/v1/system-management/data-management/status` 的 database 段
/// （对齐 backend `app/schemas/system_management/data_management.py::DatabaseStatus`；
/// 其余响应字段 footer 不消费，serde 默认忽略未知字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatabaseStatus {
    pub engine: String,
    #[serde(default)]
    pub source: Option<String>,
    /// 主库连通性（`SELECT 1` 探测结果）
    pub healthy: bool,
    /// 本次检查时刻（ISO8601 字符串；注意这是**探测时刻**而非真实「最近同步
    /// 完成时刻」——同步引擎心跳端点待后端补齐，见 gui-app views/footer.rs 注释）
    pub checked_at: String,
}

/// `GET /api/v1/system-management/data-management/status` 响应（footer 只消费
/// `server_time` + `database` 两段，字段收窄声明——多余字段被 serde 忽略）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataManagementStatus {
    pub server_time: String,
    pub database: DatabaseStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 响应解析 ----------

    /// BLF-797：data-management/status 收窄声明——多余字段（summary 等）被
    /// serde 忽略，database 段完整解析
    #[test]
    fn data_management_status_parses_narrow_shape() {
        let payload = r#"{
            "server_time": "2026-08-23T12:00:00+08:00",
            "database": {
                "engine": "postgresql",
                "source": "10.0.0.8/BLF",
                "healthy": true,
                "checked_at": "2026-08-23T12:00:00+08:00"
            },
            "cache_enabled": false,
            "summary": {"total_tables": 0, "total_rows": 0, "stale_tables": 0, "data_status": "active"},
            "data_status_note": null,
            "data_status_updated_at": null,
            "data_status_updated_by": null
        }"#;
        let parsed: DataManagementStatus = serde_json::from_str(payload).expect("解析失败");
        assert!(parsed.database.healthy);
        assert_eq!(parsed.database.engine, "postgresql");
        assert_eq!(parsed.database.source.as_deref(), Some("10.0.0.8/BLF"));
        assert_eq!(parsed.server_time, "2026-08-23T12:00:00+08:00");
    }

    /// 操作审计日志 snake_case 解析（含 before/after JSON 与可空字段）
    #[test]
    fn operation_audit_log_page_parses_snake_case() {
        let payload = r#"{
            "items": [{
                "id": 11,
                "created_at": "2026-08-21T10:30:00+08:00",
                "operator": "张三",
                "action": "shipment_schedules.create",
                "target_type": "shipment_schedule",
                "target_id": "42",
                "result": "success",
                "trace_id": "trace-1",
                "request_method": "POST",
                "request_path": "/api/v1/shipment-schedules",
                "ip_address": "10.0.0.1",
                "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "before_json": null,
                "after_json": {"id": 42},
                "error_message": null
            }],
            "total": 100,
            "page": 2,
            "page_size": 20,
            "has_next": true
        }"#;
        let page: OperationAuditLogsResponse =
            serde_json::from_str(payload).expect("操作审计日志分页应可解析");
        assert_eq!(page.total, 100);
        assert!(page.has_next);
        let row = &page.items[0];
        assert_eq!(row.operator.as_deref(), Some("张三"));
        assert_eq!(
            row.after_json,
            Some(serde_json::json!({"id": 42})),
            "after_json 应保留结构化 JSON"
        );
    }

    /// 空串 created_at / 缺省字段不炸（backend `_to_iso(...) or ""` 兜底口径）
    #[test]
    fn operation_audit_log_tolerates_empty_created_at() {
        let payload = r#"{"items":[{"id":1,"created_at":"","action":"x","target_type":"t","result":"success"}],"total":0,"page":1,"page_size":20,"has_next":false}"#;
        let page: OperationAuditLogsResponse = serde_json::from_str(payload).expect("空串时间应可解析");
        assert_eq!(page.items[0].created_at, "");
        assert_eq!(page.items[0].operator, None);
    }

    /// 汇总响应解析（modules / top_actions 可缺省）
    #[test]
    fn audit_summary_parses() {
        let payload = r#"{
            "total": 30, "success_count": 28, "failure_count": 2,
            "unique_operator_count": 4,
            "modules": [{"key":"auth","label":"用户登录","count":10,"success_count":9,"failure_count":1}],
            "top_actions": [{"action":"auth.login.success","count":9}]
        }"#;
        let summary: OperationAuditLogsSummaryResponse =
            serde_json::from_str(payload).expect("汇总应可解析");
        assert_eq!(summary.modules.len(), 1);
        assert_eq!(summary.top_actions[0].count, 9);

        let bare: OperationAuditLogsSummaryResponse =
            serde_json::from_str(r#"{"total":0,"success_count":0,"failure_count":0,"unique_operator_count":0}"#)
                .expect("缺省 modules/top_actions 应可解析");
        assert!(bare.modules.is_empty() && bare.top_actions.is_empty());
    }

    /// Agent 访问日志 snake_case 解析（未绑定 agent 可空字段齐全）
    #[test]
    fn agent_access_log_page_parses_snake_case() {
        let payload = r#"{
            "items": [{
                "id": 7,
                "created_at": "2026-08-21T10:31:00+08:00",
                "method": "GET",
                "path": "/api/v1/agent/inventory/snapshot",
                "status_code": 200,
                "latency_ms": 123,
                "ip_address": "10.0.0.9",
                "api_key_id": 3,
                "agent_id": "simon-inventory",
                "key_label": "库存运营 Simon",
                "project_id": 5,
                "project_name": "测试项目",
                "operation_type": "read"
            }],
            "total": 1,
            "page": 1,
            "page_size": 50,
            "has_next": false
        }"#;
        let page: AgentAccessLogsResponse = serde_json::from_str(payload).expect("Agent 访问日志应可解析");
        let row = &page.items[0];
        assert_eq!(row.key_label.as_deref(), Some("库存运营 Simon"));
        assert_eq!(row.status_code, 200);
        assert_eq!(row.latency_ms, 123);
    }

    // ---------- 分类归属 ----------

    /// 前缀匹配顺序对齐 web CATEGORY_OPTIONS；未命中 = 其他
    #[test]
    fn operation_category_matches_prefixes() {
        assert_eq!(operation_category_label("commission.bonus.recompute"), "提成与绩效");
        assert_eq!(operation_category_label("operator.performance.view"), "提成与绩效");
        assert_eq!(operation_category_label("shipment_schedules.create"), "发货管理");
        assert_eq!(operation_category_label("sku_info.export"), "SKU资料");
        assert_eq!(operation_category_label("projects.update"), "项目资料");
        assert_eq!(operation_category_label("users.create"), "账号权限");
        assert_eq!(operation_category_label("auth.login.success"), "用户登录");
        assert_eq!(operation_category_label("inventory_replenishment.list"), "库存补货");
        assert_eq!(operation_category_label("system.data_status.update"), "系统运维");
        assert_eq!(operation_category_label("monthly_reports.export"), "报表中心");
        assert_eq!(operation_category_label("pricing_calculation.run.view"), "报表中心");
        assert_eq!(operation_category_label("weird.unknown.action"), "其他");
    }

    /// 分类 key → query 前缀参数（other 无参数走客户端过滤）
    #[test]
    fn category_action_query_maps_keys() {
        assert_eq!(category_action_query("commission"), Some("commission."));
        assert_eq!(category_action_query("inventory"), Some("inventory_"));
        assert_eq!(category_action_query("report"), Some("report"));
        assert_eq!(category_action_query("other"), None);
        assert_eq!(category_action_query("unknown"), None);
    }

    /// 「其他」判定与前缀表一致
    #[test]
    fn is_other_category_agrees_with_prefix_table() {
        assert!(!is_other_category("auth.login.success"));
        assert!(is_other_category("weird.unknown"));
    }

    // ---------- 动作 / 资源类型标签 ----------

    /// 已知动作命中映射；未知动作按末段动词兜底「{分类} · {动词}」；再退回原文
    #[test]
    fn format_action_label_known_fallback_and_raw() {
        assert_eq!(format_action_label("auth.login.success"), "登录成功");
        assert_eq!(format_action_label("shipment_schedules.create"), "创建发货计划");
        assert_eq!(
            format_action_label("sku_info.weird_verb"),
            "sku_info.weird_verb",
            "未知非动词末段原样透传"
        );
        assert_eq!(format_action_label("projects.mystery.list"), "项目资料 · 查看列表");
        assert_eq!(format_action_label("totally-unknown"), "totally-unknown");
    }

    /// 资源类型映射：已知中文化、未知透传
    #[test]
    fn target_type_label_maps_known_and_passes_unknown() {
        assert_eq!(target_type_label("user_account"), "账号");
        assert_eq!(target_type_label("pricing_calculation_run"), "定价测算");
        assert_eq!(target_type_label("future_type"), "future_type");
    }

    // ---------- 时间 / 设备 ----------

    /// 时间格式化：带时区 ISO → 本机 YYYY-MM-DD HH:MM；空串 → -；乱串原样
    #[test]
    fn format_log_time_handles_all_shapes() {
        use chrono::TimeZone;
        let local = Local
            .with_ymd_and_hms(2026, 8, 21, 18, 30, 0)
            .unwrap();
        let utc = local.with_timezone(&Utc);
        let iso = utc.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        assert_eq!(format_log_time(&iso), "2026-08-21 18:30");
        assert_eq!(format_log_time(""), "-");
        assert_eq!(format_log_time("not-a-date"), "not-a-date");
    }

    /// 相对时间分桶：刚刚 / 分钟 / 小时 / 天 / 7 天外落日期
    #[test]
    fn format_time_ago_buckets() {
        assert_eq!(format_time_ago(""), "-");
        assert_eq!(format_time_ago("garbage"), "-");

        let now = Utc::now();
        let iso = |secs: i64| {
            (now - chrono::Duration::seconds(secs))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        };
        assert_eq!(format_time_ago(&iso(10)), "刚刚");
        assert_eq!(format_time_ago(&iso(120)), "2 分钟前");
        assert_eq!(format_time_ago(&iso(3 * 3600)), "3 小时前");
        assert_eq!(format_time_ago(&iso(2 * 24 * 3600)), "2 天前");
        assert_eq!(format_time_ago(&iso(9 * 24 * 3600)).len(), 10, "7 天外落 YYYY-MM-DD");
    }

    /// UA 粗解析：OS / 浏览器二元组；None 与未知串兜底「未知」
    #[test]
    fn parse_user_agent_os_and_browser() {
        let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
        assert_eq!(parse_user_agent(Some(chrome)), ("macOS".into(), "Chrome".into()));

        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
        assert_eq!(parse_user_agent(Some(edge)), ("Windows".into(), "Edge".into()));

        let firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";
        assert_eq!(parse_user_agent(Some(firefox)), ("Windows".into(), "Firefox".into()));

        assert_eq!(parse_user_agent(None), ("未知".into(), "未知".into()));
        assert_eq!(parse_user_agent(Some("curl/8.0")), ("未知".into(), "未知".into()));
    }
}
