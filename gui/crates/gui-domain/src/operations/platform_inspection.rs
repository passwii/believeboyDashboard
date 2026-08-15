//! 平台巡检领域类型（P5-1，BLF-717）
//!
//! 对齐 backend `app/schemas/inspection.py`（单一事实源）与 frontend
//! `lib/inspection-api.ts` 的 DTO 形状；字段名沿用 Pydantic snake_case，
//! 保证 api-client 与后端 JSON 1:1 互通。可选字段统一 `Option` + `#[serde(default)]`
//! （对齐后端 `Optional[...] = None` 语义，缺失即 `None`）。

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// 账户健康数据（`HealthData`；概览 / 报告共用）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HealthData {
    /// 账户健康评级（Healthy / Good / At Risk / Critical）
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub account_health_rating: Option<String>,
    /// 负面反馈
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub negative_feedback: Option<i64>,
    /// 亚马逊 A-to-Z 索赔
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub a2z_claims: Option<i64>,
    /// 信用卡拒付
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub chargeback_claims: Option<i64>,
    /// 迟发率（%）
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub late_shipment_rate: Option<f64>,
    /// 配送前取消率（%）
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub pre_fulfillment_cancel_rate: Option<f64>,
    /// 有效追踪率（%）
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub valid_tracking_rate: Option<f64>,
    /// 准时交付率（%）
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub on_time_delivery_rate: Option<f64>,
}

/// 政策与合规数据（`ComplianceData`；全部为数量计数，`None` = 未填写）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ComplianceData {
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub ip_infringement: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub ip_complaints: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub product_authenticity_complaints: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub product_condition_complaints: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub food_product_safety: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub listing_policy_violations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub restricted_product_violations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub review_policy_violations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub other_policy_violations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]

    pub regulatory_compliance: Option<i64>,
}

/// 巡检周期（`InspectionPeriodItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InspectionPeriod {
    pub id: i64,
    pub week_start: NaiveDate,
    pub week_end: NaiveDate,
    pub deadline: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// 周期列表（`InspectionPeriodListResponse`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionPeriodList {
    pub items: Vec<InspectionPeriod>,
    pub total: i64,
}

/// 截图引用（概览 / 历史行共用：id + 展示 URL；GUI v1 仅展示数量与信息，不渲染图片）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionScreenshotRef {
    pub id: i64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub caption: Option<String>,
}

/// 概览项目行（`InspectionOverviewItem`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionOverviewItem {
    pub project_id: i64,
    pub project_name: String,
    /// submitted / draft / overdue / pending
    pub status: String,
    #[serde(default)]
    pub account_health_rating: Option<String>,
    #[serde(default)]
    pub negative_feedback: Option<i64>,
    #[serde(default)]
    pub a2z_claims: Option<i64>,
    #[serde(default)]
    pub chargeback_claims: Option<i64>,
    #[serde(default)]
    pub late_shipment_rate: Option<f64>,
    #[serde(default)]
    pub valid_tracking_rate: Option<f64>,
    #[serde(default)]
    pub on_time_delivery_rate: Option<f64>,
    #[serde(default)]
    pub compliance_total: Option<i64>,
    #[serde(default)]
    pub status_summary: Option<String>,
    #[serde(default)]
    pub submitted_by: Option<String>,
    #[serde(default)]
    pub submitted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub screenshots: Vec<InspectionScreenshotRef>,
}

/// 概览响应（`InspectionOverviewResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InspectionOverview {
    pub period: InspectionPeriod,
    pub items: Vec<InspectionOverviewItem>,
    pub total_projects: i64,
    pub submitted_count: i64,
    pub overdue_count: i64,
}

/// 巡检报告（`InspectionReportItem`；编辑表单加载 / 保存 / 提交的返回类型）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionReport {
    pub id: i64,
    pub period_id: i64,
    pub project_id: i64,
    pub status: String,
    #[serde(default)]
    pub health_data: Option<HealthData>,
    #[serde(default)]
    pub compliance_data: Option<ComplianceData>,
    #[serde(default)]
    pub status_summary: Option<String>,
    #[serde(default)]
    pub submitted_by: Option<String>,
    #[serde(default)]
    pub submitted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub screenshots: Vec<InspectionScreenshotRef>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 保存草稿请求体（`InspectionReportCreate`；空字段省略 → 后端 `exclude_unset` 语义）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionReportSave {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_data: Option<HealthData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compliance_data: Option<ComplianceData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_summary: Option<String>,
    /// GUI v1 不上传截图，保持空列表（对齐后端默认 `[]`）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshot_ids: Vec<i64>,
}

/// 历史行（`InspectionHistoryItem`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionHistoryItem {
    pub id: i64,
    pub period_id: i64,
    pub week_start: NaiveDate,
    pub week_end: NaiveDate,
    pub project_id: i64,
    pub project_name: String,
    pub status: String,
    #[serde(default)]
    pub account_health_rating: Option<String>,
    #[serde(default)]
    pub compliance_total: Option<i64>,
    #[serde(default)]
    pub status_summary: Option<String>,
    #[serde(default)]
    pub submitted_by: Option<String>,
    #[serde(default)]
    pub submitted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub screenshots: Vec<InspectionScreenshotRef>,
}

/// 历史响应（`InspectionHistoryResponse`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InspectionHistoryResponse {
    pub items: Vec<InspectionHistoryItem>,
    pub total: i64,
}
