//! 平台巡检 API（P5-1，BLF-717）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/inspections.py`，与 frontend
//! `lib/inspection-api.ts` 调用口径一致）：
//! - 当前周期          → `GET  /api/v1/inspections/periods/current`
//! - 周期列表          → `GET  /api/v1/inspections/periods?limit=&offset=`
//! - 周期概览          → `GET  /api/v1/inspections/periods/{id}/overview`
//! - 单项目报告        → `GET  /api/v1/inspections/periods/{id}/projects/{pid}`
//! - 保存草稿（POST）  → `POST /api/v1/inspections/periods/{id}/projects/{pid}`
//! - 提交报告（POST）  → `POST /api/v1/inspections/periods/{id}/projects/{pid}/submit`
//! - 历史记录          → `GET  /api/v1/inspections/history?period_id=&limit=&offset=`
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 三个 header（backend `protected` 依赖读取，见 client.rs）；
//! 生产后端 dashboard 路由还需 `api_key`（`Authorization: Bearer`，BLF-711 已就绪）。

use gui_domain::operations::platform_inspection::{
    InspectionHistoryResponse, InspectionOverview, InspectionPeriod, InspectionPeriodList,
    InspectionReport, InspectionReportSave,
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /inspections/periods/current` —— 当前巡检周期
pub(crate) const CURRENT_PERIOD_PATH: &str = "/api/v1/inspections/periods/current";
/// `GET /inspections/periods` —— 周期列表
pub(crate) const PERIODS_PATH: &str = "/api/v1/inspections/periods";
/// `GET /inspections/history` —— 历史记录
pub(crate) const HISTORY_PATH: &str = "/api/v1/inspections/history";

impl Client {
    /// 当前巡检周期（对齐 frontend `fetchCurrentPeriod`；后端 get_or_create 当前周）
    pub async fn inspection_current_period(&self) -> Result<InspectionPeriod, ApiError> {
        self.get_json(CURRENT_PERIOD_PATH, &[]).await
    }

    /// 周期列表（对齐 frontend `fetchPeriods(limit, offset)`）
    pub async fn inspection_periods(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<InspectionPeriodList, ApiError> {
        let mut query = Vec::new();
        if let Some(limit) = limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(offset) = offset {
            query.push(("offset", offset.to_string()));
        }
        self.get_json(PERIODS_PATH, &query).await
    }

    /// 周期概览（对齐 frontend `fetchPeriodOverview(periodId)`：按权限过滤项目 +
    /// 提交/逾期统计 + 各项目健康快照）
    pub async fn inspection_overview(
        &self,
        period_id: i64,
    ) -> Result<InspectionOverview, ApiError> {
        let path = format!("/api/v1/inspections/periods/{period_id}/overview");
        self.get_json(&path, &[]).await
    }

    /// 单项目报告（对齐 frontend `fetchReport(periodId, projectId)`；
    /// 尚无草稿时后端返回 `null` → `Ok(None)`）
    pub async fn inspection_report(
        &self,
        period_id: i64,
        project_id: i64,
    ) -> Result<Option<InspectionReport>, ApiError> {
        let path = format!("/api/v1/inspections/periods/{period_id}/projects/{project_id}");
        self.get_json(&path, &[]).await
    }

    /// 保存草稿（对齐 frontend `saveReport(periodId, projectId, data)`：POST 创建/更新）
    pub async fn inspection_save_report(
        &self,
        period_id: i64,
        project_id: i64,
        body: &InspectionReportSave,
    ) -> Result<InspectionReport, ApiError> {
        let path = format!("/api/v1/inspections/periods/{period_id}/projects/{project_id}");
        self.request_json(reqwest::Method::POST, &path, &[], Some(body))
            .await
    }

    /// 提交报告（对齐 frontend `submitReport(periodId, projectId)`：
    /// POST .../submit，后端校验必填项并置 submitted）
    pub async fn inspection_submit_report(
        &self,
        period_id: i64,
        project_id: i64,
    ) -> Result<InspectionReport, ApiError> {
        let path = format!("/api/v1/inspections/periods/{period_id}/projects/{project_id}/submit");
        self.request_json(reqwest::Method::POST, &path, &[], None::<()>.as_ref())
            .await
    }

    /// 历史记录（对齐 frontend `fetchInspectionHistory`：周期 + 项目 + 分页筛选）
    pub async fn inspection_history(
        &self,
        period_id: Option<i64>,
        project_id: Option<i64>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<InspectionHistoryResponse, ApiError> {
        let mut query = Vec::new();
        if let Some(period_id) = period_id {
            query.push(("period_id", period_id.to_string()));
        }
        if let Some(project_id) = project_id {
            query.push(("project_id", project_id.to_string()));
        }
        if let Some(limit) = limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(offset) = offset {
            query.push(("offset", offset.to_string()));
        }
        self.get_json(HISTORY_PATH, &query).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone, Utc};
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；契约测试对齐 monthly_reports.rs）
    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试".into()),
            role_type: gui_domain::auth::UserRoleType::Operator,
            is_admin: false,
        };
        Client::new(base_url).with_session(session)
    }

    fn sample_period_json() -> &'static str {
        r#"{
            "id": 3,
            "week_start": "2026-08-10",
            "week_end": "2026-08-16",
            "deadline": "2026-08-16T10:00:00+08:00",
            "created_at": "2026-08-10T00:00:00+08:00"
        }"#
    }

    /// 契约测试：路径锁定 backend 实际路由
    #[test]
    fn inspection_paths_match_backend_routes() {
        assert_eq!(CURRENT_PERIOD_PATH, "/api/v1/inspections/periods/current");
        assert_eq!(PERIODS_PATH, "/api/v1/inspections/periods");
        assert_eq!(HISTORY_PATH, "/api/v1/inspections/history");
        assert_eq!(
            format!("/api/v1/inspections/periods/{}/overview", 7),
            "/api/v1/inspections/periods/7/overview"
        );
        assert_eq!(
            format!("/api/v1/inspections/periods/{}/projects/{}/submit", 7, 9),
            "/api/v1/inspections/periods/7/projects/9/submit"
        );
    }

    #[tokio::test]
    async fn inspection_current_period_parses_period() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", CURRENT_PERIOD_PATH)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(sample_period_json())
            .create();

        let client = session_client(&server.url());
        let period = client.inspection_current_period().await.expect("请求失败");

        m.assert();
        assert_eq!(period.id, 3);
        assert_eq!(
            period.week_start,
            NaiveDate::from_ymd_opt(2026, 8, 10).expect("合法日期")
        );
        assert_eq!(
            period.deadline,
            Utc.with_ymd_and_hms(2026, 8, 16, 2, 0, 0)
                .single()
                .expect("合法时间")
        );
    }

    #[tokio::test]
    async fn inspection_periods_sends_query_params() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PERIODS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("limit".into(), "100".into()),
                Matcher::UrlEncoded("offset".into(), "0".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "total": 0}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .inspection_periods(Some(100), Some(0))
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.total, 0);
    }

    #[tokio::test]
    async fn inspection_overview_parses_items_and_counts() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/inspections/periods/3/overview")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "period": {"id": 3, "week_start": "2026-08-10", "week_end": "2026-08-16",
                               "deadline": "2026-08-16T10:00:00+08:00", "created_at": "2026-08-10T00:00:00+08:00"},
                    "items": [
                        {
                            "project_id": 1,
                            "project_name": "测试项目 A",
                            "status": "submitted",
                            "account_health_rating": "Good",
                            "negative_feedback": 0,
                            "a2z_claims": 1,
                            "chargeback_claims": 0,
                            "late_shipment_rate": 1.5,
                            "valid_tracking_rate": 99.0,
                            "on_time_delivery_rate": 98.0,
                            "compliance_total": 2,
                            "status_summary": "正常",
                            "submitted_by": "测试",
                            "submitted_at": "2026-08-14T12:00:00+08:00",
                            "screenshots": [{"id": 11, "url": "https://r2.example/a.png"}]
                        }
                    ],
                    "total_projects": 2,
                    "submitted_count": 1,
                    "overdue_count": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let overview = client.inspection_overview(3).await.expect("请求失败");

        m.assert();
        assert_eq!(overview.period.id, 3);
        assert_eq!(overview.total_projects, 2);
        assert_eq!(overview.submitted_count, 1);
        assert_eq!(overview.overdue_count, 1);
        let item = &overview.items[0];
        assert_eq!(item.project_name, "测试项目 A");
        assert_eq!(item.status, "submitted");
        assert_eq!(item.account_health_rating.as_deref(), Some("Good"));
        assert_eq!(item.late_shipment_rate, Some(1.5));
        assert_eq!(item.compliance_total, Some(2));
        assert_eq!(item.screenshots.len(), 1);
    }

    #[tokio::test]
    async fn inspection_report_returns_none_for_missing_report() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/inspections/periods/3/projects/5")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("null")
            .create();

        let client = session_client(&server.url());
        let report = client.inspection_report(3, 5).await.expect("请求失败");

        m.assert();
        assert!(report.is_none());
    }

    #[tokio::test]
    async fn inspection_save_report_posts_json_body() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/v1/inspections/periods/3/projects/5")
            .match_header("content-type", "application/json")
            .match_body(Matcher::JsonString(
                r#"{"health_data":{"account_health_rating":"Good","late_shipment_rate":1.5}}"#
                    .into(),
            ))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 20,
                    "period_id": 3,
                    "project_id": 5,
                    "status": "draft",
                    "health_data": {"account_health_rating": "Good", "late_shipment_rate": 1.5},
                    "compliance_data": null,
                    "status_summary": null,
                    "submitted_by": null,
                    "submitted_at": null,
                    "screenshots": [],
                    "created_at": "2026-08-15T10:00:00+08:00",
                    "updated_at": "2026-08-15T10:00:00+08:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let body = InspectionReportSave {
            health_data: Some(gui_domain::operations::platform_inspection::HealthData {
                account_health_rating: Some("Good".into()),
                late_shipment_rate: Some(1.5),
                ..Default::default()
            }),
            ..Default::default()
        };
        let report = client
            .inspection_save_report(3, 5, &body)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(report.id, 20);
        assert_eq!(report.status, "draft");
        assert_eq!(
            report
                .health_data
                .as_ref()
                .and_then(|h| h.account_health_rating.as_deref()),
            Some("Good")
        );
    }

    #[tokio::test]
    async fn inspection_submit_report_posts_without_body() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/v1/inspections/periods/3/projects/5/submit")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 20,
                    "period_id": 3,
                    "project_id": 5,
                    "status": "submitted",
                    "health_data": null,
                    "compliance_data": null,
                    "status_summary": null,
                    "submitted_by": "测试",
                    "submitted_at": "2026-08-15T12:00:00+08:00",
                    "screenshots": [],
                    "created_at": "2026-08-15T10:00:00+08:00",
                    "updated_at": "2026-08-15T12:00:00+08:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let report = client
            .inspection_submit_report(3, 5)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(report.status, "submitted");
        assert_eq!(report.submitted_by.as_deref(), Some("测试"));
    }

    #[tokio::test]
    async fn inspection_history_sends_filters_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", HISTORY_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("period_id".into(), "3".into()),
                Matcher::UrlEncoded("limit".into(), "100".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
                            "id": 20,
                            "period_id": 3,
                            "week_start": "2026-08-10",
                            "week_end": "2026-08-16",
                            "project_id": 5,
                            "project_name": "测试项目 A",
                            "status": "submitted",
                            "account_health_rating": "Good",
                            "compliance_total": 0,
                            "status_summary": "正常",
                            "submitted_by": "测试",
                            "submitted_at": "2026-08-14T12:00:00+08:00",
                            "screenshots": []
                        }
                    ],
                    "total": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .inspection_history(Some(3), None, Some(100), None)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items[0].project_name, "测试项目 A");
        assert_eq!(resp.items[0].status, "submitted");
        assert_eq!(resp.items[0].week_start.to_string(), "2026-08-10");
    }

    #[tokio::test]
    async fn inspection_history_omits_optional_filters_by_default() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", HISTORY_PATH)
            .match_query(Matcher::Regex("^$".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "total": 0}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .inspection_history(None, None, None, None)
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.items.is_empty());
    }
}
