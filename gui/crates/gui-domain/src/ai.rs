//! AI 智能领域类型（BLF-803 Stage12）
//!
//! 字段对齐 backend `backend/app/schemas/ai_insight.py`（`InsightItem` /
//! `InsightListResponse` / `InsightDetail`）与
//! `backend/app/schemas/digital_employee.py`（`DigitalEmployeeResponse`）、
//! `backend/app/services/digital/office_service.py::_enrich` 的办公室快照条目。
//!
//! 口径说明：
//! - 时间戳沿用后端序列化字符串原样展示（对齐 ai_chat.rs 约定）；
//! - 金额类字段后端为 float，直接 f64 承载。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// AI 洞察（backend schemas/ai_insight.py 1:1）
// ---------------------------------------------------------------------------

/// AI 洞察列表条目（backend `InsightItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiInsightItem {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub title: String,
    pub insight_type: String,
    pub date_range_start: String,
    pub date_range_end: String,
    /// `pending` / `running` / `completed` / `failed`
    pub status: String,
    #[serde(default)]
    pub sub_status: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

/// AI 洞察详情 = 列表条目 + markdown 正文（backend `InsightDetail`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiInsightDetail {
    #[serde(flatten)]
    pub item: AiInsightItem,
    #[serde(default)]
    pub content: String,
}

/// AI 洞察列表响应（backend `InsightListResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiInsightListResponse {
    pub items: Vec<AiInsightItem>,
    pub total: i64,
}

/// 洞察状态的展示标签与语义色调档位（GUI 展示辅助，非后端字段）
impl AiInsightItem {
    /// 状态展示标签（对齐 web 徽标文案）
    pub fn status_label(&self) -> &'static str {
        match self.status.as_str() {
            "completed" => "已完成",
            "running" => "生成中",
            "pending" => "排队中",
            "failed" => "失败",
            _ => "未知",
        }
    }

    /// 状态是否为终态（终态才可点开详情）
    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }
}

// ---------------------------------------------------------------------------
// 数字员工（backend schemas/digital_employee.py 1:1 子集 + 办公室快照）
// ---------------------------------------------------------------------------

/// 数字员工管理列表条目（backend `DigitalEmployeeResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DigitalEmployeeItem {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// `auto_report_upload` / `scheduled_job` / `rpa_bot` / `ai_agent` /
    /// `monitoring` / `database` / `custom`
    pub employee_type: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `idle` / `running` / `succeeded` / `failed` / `suspended`
    pub status: String,
    #[serde(default)]
    pub last_heartbeat_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// 数字员工列表响应（backend `DigitalEmployeeListResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DigitalEmployeeListResponse {
    pub items: Vec<DigitalEmployeeItem>,
    pub total: i64,
}

/// 员工人设（办公室快照；backend `_enrich.persona`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfficePersona {
    pub emoji: String,
    pub color_key: String,
    pub tagline: String,
}

/// 虚拟办公室员工快照（backend office_service `_enrich` dict 1:1；
/// 与 frontend `OfficeEmployee` 同构）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfficeEmployee {
    pub employee_id: i64,
    pub name: String,
    pub persona: OfficePersona,
    /// `WORKING` / `PAUSING` / `IDLE` / `OFFLINE` / `FAILED`
    pub display_status: String,
    /// `IDLE` / `NORMAL` / `BUSY` / `SWAMPED`
    pub busy_level: String,
    pub queued_count: i64,
    pub pace: f64,
    #[serde(default)]
    pub current_task: Option<OfficeCurrentTask>,
    #[serde(default)]
    pub work_item: Option<OfficeWorkItem>,
    pub virtual_progress: f64,
    #[serde(default)]
    pub step_label: String,
    pub today_done: i64,
    pub success_rate: f64,
    #[serde(default)]
    pub last_heartbeat_at: Option<String>,
}

/// 当前任务摘要（办公室快照内嵌）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfficeCurrentTask {
    pub task_id: String,
    pub task_name: String,
    /// `pending` / `running` / `succeeded` / `failed` / `cancelled`
    pub status: String,
}

/// 工作项上下文（项目名 / 报表名，来自任务 metadata）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfficeWorkItem {
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub report_label: Option<String>,
}

/// 办公室整墙快照（SSE 首帧 `snapshot` 事件 / 轮询兜底）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfficeSnapshot {
    pub server_time: String,
    pub employees: Vec<OfficeEmployee>,
}

/// 员工展示状态 → 语义色档位（GUI 展示辅助）。
/// 返回 `(状态标签, 是否在岗)`。
pub fn office_status_label(status: &str) -> (&'static str, bool) {
    match status {
        "WORKING" => ("工作中", true),
        "PAUSING" => ("收尾", true),
        "IDLE" => ("待命", true),
        "SWAMPED" => ("爆忙", true),
        "BUSY" => ("忙碌", true),
        "FAILED" => ("异常", false),
        "OFFLINE" => ("离线", false),
        _ => ("未知", false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// backend `/ai-insights` 真实响应形态反序列化
    #[test]
    fn ai_insight_list_deserializes_backend_sample() {
        let json = r#"{
            "items": [
                {
                    "id": 5,
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "title": "近7天销售洞察",
                    "insight_type": "custom",
                    "date_range_start": "2026-08-11",
                    "date_range_end": "2026-08-18",
                    "status": "completed",
                    "sub_status": null,
                    "error_message": null,
                    "created_by": "damon",
                    "created_at": "2026-08-18T10:00:00+00:00",
                    "updated_at": "2026-08-18T10:05:00+00:00"
                }
            ],
            "total": 1
        }"#;
        let resp: AiInsightListResponse = serde_json::from_str(json).expect("解析失败");
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items[0].status_label(), "已完成");
        assert!(resp.items[0].is_terminal());
    }

    /// 办公室快照：persona 完整形态反序列化 + 状态标签映射
    #[test]
    fn office_snapshot_deserializes_and_maps_status() {
        let json = r#"{
            "server_time": "2026-08-25T09:00:00+00:00",
            "employees": [
                {
                    "employee_id": 1,
                    "name": "报表员小安",
                    "persona": {"emoji": "📦", "color_key": "blue", "tagline": "报表小能手"},
                    "display_status": "WORKING",
                    "busy_level": "NORMAL",
                    "queued_count": 2,
                    "pace": 1.0,
                    "current_task": {"task_id": "t1", "task_name": "上传库存报表", "status": "running"},
                    "work_item": {"project_name": "项目A", "report_label": "库存月报"},
                    "virtual_progress": 55.5,
                    "step_label": "上传库存报表",
                    "today_done": 12,
                    "success_rate": 98.5,
                    "last_heartbeat_at": null
                }
            ]
        }"#;
        let snap: OfficeSnapshot = serde_json::from_str(json).expect("解析失败");
        assert_eq!(snap.employees.len(), 1);
        let e = &snap.employees[0];
        assert_eq!(e.persona.emoji, "📦");
        assert_eq!(
            e.current_task.as_ref().map(|t| t.task_name.as_str()),
            Some("上传库存报表")
        );
        let (label, on_duty) = office_status_label(&e.display_status);
        assert_eq!(label, "工作中");
        assert!(on_duty);
    }

    /// 数字员工列表：employee_type / status 字符串直传（视图层判断字面量）
    #[test]
    fn digital_employee_list_deserializes_backend_sample() {
        let json = r#"{
            "items": [
                {
                    "id": 1,
                    "name": "货件助理",
                    "avatar_url": null,
                    "employee_type": "rpa_bot",
                    "description": "自动发货",
                    "status": "running",
                    "last_heartbeat_at": "2026-08-25T08:59:00+00:00",
                    "is_silent_alert_threshold_minutes": 30,
                    "created_at": "2026-07-01T00:00:00+00:00",
                    "updated_at": "2026-08-25T08:59:00+00:00"
                }
            ],
            "total": 1
        }"#;
        let resp: DigitalEmployeeListResponse = serde_json::from_str(json).expect("解析失败");
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items[0].employee_type, "rpa_bot");
    }
}
