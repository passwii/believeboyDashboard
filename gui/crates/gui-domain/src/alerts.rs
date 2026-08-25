//! 告警中心领域类型（Stage13，BLF-804）
//!
//! 字段对齐 backend `backend/app/schemas/alert.py`（`AlertStatsResponse` /
//! `AlertEventItem`），与 web `frontend/lib/alerts-api.ts` 同口径。
//!
//! GUI 只读主面消费：统计卡 + 事件列表；规则/偏好写链路走 web 端。

use serde::{Deserialize, Serialize};

/// `GET /alerts/stats` 响应，字段对齐 backend `AlertStatsResponse`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AlertStats {
    pub total_active: i64,
    pub critical_count: i64,
    pub warning_count: i64,
    pub info_count: i64,
    pub acknowledged_today: i64,
    pub resolved_today: i64,
}

/// 一条告警事件，字段对齐 backend `AlertEventItem`（GUI 消费子集；
/// 对账扩展字段 match_rate 等按需透传）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertEvent {
    pub id: i64,
    #[serde(default)]
    pub rule_id: i64,
    #[serde(default)]
    pub project_id: i64,
    /// 指标 key（如 sales_drop_pct）
    pub metric: String,
    pub current_value: f64,
    #[serde(default)]
    pub baseline_value: f64,
    pub deviation_pct: f64,
    /// 严重级别（critical/warning/info）
    pub severity: String,
    pub message: String,
    /// 事件状态（open/acknowledged/resolved）
    pub status: String,
    /// 触发时刻（ISO 8601 字符串原样透传，展示层格式化）
    pub triggered_at: String,
}

impl AlertEvent {
    /// 严重级别 → 中文标签（未知原样返回）
    pub fn severity_label(&self) -> String {
        match self.severity.as_str() {
            "critical" => "严重",
            "warning" => "警告",
            "info" => "信息",
            other => return other.to_string(),
        }
        .to_string()
    }

    /// 事件状态 → 中文标签
    pub fn status_label(&self) -> String {
        match self.status.as_str() {
            "open" => "待处理",
            "acknowledged" => "已确认",
            "resolved" => "已解决",
            other => return other.to_string(),
        }
        .to_string()
    }
}

/// 告警事件分页结果（backend 返回 page/page_size，GUI 固定单页大表口径，
/// 只保留 items + total）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AlertEventPage {
    #[serde(default)]
    pub items: Vec<AlertEvent>,
    #[serde(default)]
    pub total: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alert_event_parses_snake_case() {
        let payload = r#"{
            "id": 9, "rule_id": 2, "project_id": 7,
            "metric": "sales_drop_pct", "current_value": -35.0,
            "baseline_value": 0.0, "deviation_pct": 35.0,
            "severity": "critical", "message": "销售额骤降",
            "status": "open", "triggered_at": "2026-08-25T10:00:00+08:00"
        }"#;
        let ev: AlertEvent = serde_json::from_str(payload).unwrap();
        assert_eq!(ev.severity_label(), "严重");
        assert_eq!(ev.status_label(), "待处理");
    }

    #[test]
    fn alert_stats_defaults_empty() {
        let stats = AlertStats::default();
        assert_eq!(stats.total_active, 0);
    }
}
