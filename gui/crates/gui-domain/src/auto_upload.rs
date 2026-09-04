//! 报表自动化（RPA 自动上传）领域类型（P5-4，BLF-730）
//!
//! 数据源：`GET /api/v1/rpa-reports/status`（对齐 frontend
//! `frontend/app/dashboard/reports/auto-upload/page.tsx` 的 `loadStatus`：
//! query `report_date` / `country`，返回 `{ country, items }`）。
//!
//! 字段命名沿用后端 Pydantic 模型（`backend/app/schemas/rpa_report.py`）：
//! `RpaReportStatusResponseSchema` / `ProjectReportStatusSchema` /
//! `ReportTypeStatusSchema` 1:1。本模块纯数据，无 IO / GUI 依赖。

use serde::{Deserialize, Serialize};

/// 单报表类型的上传状态（backend `ReportTypeStatusSchema` 1:1）
///
/// `has_data` 表示后端是否识别到该报表类型的数据；`is_uploaded` 表示是否已
/// 成功上传；`latest_date` 是报表实际业务日期（period_end_date / snapshot_at）；
/// `status_source` 标注数据来源（如 `rpa`）。后端对可选字段有默认值 / 可缺省，
/// 用 `#[serde(default)]` 容忍缺省，保证存量 / 字段缺失场景可反序列化。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportTypeStatus {
    pub report_type: String,
    #[serde(default)]
    pub has_data: bool,
    pub is_uploaded: bool,
    #[serde(default)]
    pub latest_date: Option<String>,
    #[serde(default)]
    pub original_filename: Option<String>,
    #[serde(default)]
    pub status_source: Option<String>,
}

/// 单项目 × 全部报表类型的状态（backend `ProjectReportStatusSchema` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectReportStatus {
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub statuses: Vec<ReportTypeStatus>,
}

/// RPA 报表状态响应（backend `RpaReportStatusResponseSchema` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpaReportStatusResponse {
    pub country: String,
    pub items: Vec<ProjectReportStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：项目 × 报表类型状态矩阵按 backend `RpaReportStatusResponseSchema`
    /// 真实响应形态反序列化（含全部字段）。
    #[test]
    fn status_response_deserializes_backend_sample() {
        let json = r#"{
            "country": "US",
            "items": [
                {
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "statuses": [
                        {
                            "report_type": "inventory_report",
                            "has_data": true,
                            "is_uploaded": true,
                            "latest_date": "2026-08-15",
                            "original_filename": "inv.csv",
                            "status_source": "rpa"
                        },
                        {
                            "report_type": "sales_report",
                            "has_data": true,
                            "is_uploaded": false,
                            "latest_date": "2026-08-15",
                            "original_filename": null,
                            "status_source": "rpa"
                        }
                    ]
                }
            ]
        }"#;
        let resp: RpaReportStatusResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.country, "US");
        assert_eq!(resp.items.len(), 1);
        let project = &resp.items[0];
        assert_eq!(project.project_name, "测试项目 A");
        assert_eq!(project.statuses.len(), 2);
        // 第一个报表类型：已上传
        assert_eq!(project.statuses[0].report_type, "inventory_report");
        assert!(project.statuses[0].has_data);
        assert!(project.statuses[0].is_uploaded);
        assert_eq!(
            project.statuses[0].latest_date.as_deref(),
            Some("2026-08-15")
        );
        // 第二个报表类型：有数据但未上传
        assert_eq!(project.statuses[1].report_type, "sales_report");
        assert!(project.statuses[1].has_data);
        assert!(!project.statuses[1].is_uploaded);
        assert_eq!(project.statuses[1].original_filename, None);
    }

    /// 契约：可选字段（latest_date / original_filename / status_source）缺省时
    /// 容忍反序列化（存量数据 / 未识别类型场景）。
    #[test]
    fn status_cell_tolerates_minimal_payload() {
        let json = r#"{
            "country": "DE",
            "items": [
                {
                    "project_id": 7,
                    "project_name": "项目 B",
                    "country": "DE",
                    "statuses": [
                        { "report_type": "business_report", "has_data": false, "is_uploaded": false }
                    ]
                }
            ]
        }"#;
        let resp: RpaReportStatusResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.country, "DE");
        let cell = &resp.items[0].statuses[0];
        assert_eq!(cell.report_type, "business_report");
        assert!(!cell.has_data);
        assert!(!cell.is_uploaded);
        // 缺省字段 → None
        assert_eq!(cell.latest_date, None);
        assert_eq!(cell.original_filename, None);
        assert_eq!(cell.status_source, None);
    }

    /// 契约：空项目列表也能反序列化（驱动视图进入 Empty 态）。
    #[test]
    fn status_response_tolerates_empty_items() {
        let json = r#"{ "country": "US", "items": [] }"#;
        let resp: RpaReportStatusResponse = serde_json::from_str(json).expect("反序列化失败");
        assert!(resp.items.is_empty());
        assert_eq!(resp.country, "US");
    }
}
