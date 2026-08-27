//! 项目目标 API（P5-1，BLF-716）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/project_goals.py`，与 frontend
//! `app/dashboard/operations/project-goals/page.tsx` 调用口径一致）：
//! - 进度概览    →  `GET /api/v1/project-goals/progress`
//!   （frontend `fetchOpsJsonCached('${API_BASE}/project-goals/progress?...')`，
//!   query：`project_id` / `country` / `year`）
//! - 目标列表    →  `GET /api/v1/project-goals`
//!   （query 同上 + 可选 `goal_type` / `metric_type`）
//! - 创建目标    →  `POST /api/v1/project-goals`（201，body = `ProjectGoalCreate`）
//! - 更新目标    →  `PUT /api/v1/project-goals/{goal_id}`（body = `{target_amount}`）
//! - 删除目标    →  `DELETE /api/v1/project-goals/{goal_id}`（204 无内容）
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id`（backend `protected` 依赖读取，见 client.rs）；生产后端
//! `require_api_key` 走 `Authorization: Bearer`（`BELIEVEBOY_TOKEN`）。

use gui_domain::operations::project_goals::{
    ProjectGoalCreateBody, ProjectGoalItem, ProjectGoalListResponse, ProjectGoalProgressResponse,
    ProjectGoalUpdateBody,
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /project-goals/progress` —— 目标进度概览（12 个月进度 + 年度进度）
const PROJECT_GOALS_PROGRESS_PATH: &str = "/api/v1/project-goals/progress";

/// `GET/POST /project-goals` —— 目标列表 / 创建
const PROJECT_GOALS_PATH: &str = "/api/v1/project-goals";

/// `PUT/DELETE /project-goals/{goal_id}` —— 更新 / 删除
fn project_goal_path(goal_id: i64) -> String {
    format!("/api/v1/project-goals/{goal_id}")
}

impl Client {
    /// 目标进度概览（当月三环指标 + 12 个月进度 + 年度进度）。
    ///
    /// 对齐 frontend `loadProgress` 的 query 口径：`project_id`（必填）+
    /// `country` + `year`（缺省时后端用当前年份）。
    pub async fn project_goals_progress(
        &self,
        project_id: i64,
        country: &str,
        year: i32,
    ) -> Result<ProjectGoalProgressResponse, ApiError> {
        let query = [
            ("project_id", project_id.to_string()),
            ("country", country.to_string()),
            ("year", year.to_string()),
        ];
        self.get_json(PROJECT_GOALS_PROGRESS_PATH, &query).await
    }

    /// 目标列表（月度 + 年度，供「目标管理」tab 与写操作前的查重）。
    ///
    /// 对齐 frontend `loadGoals`：query = `project_id` + `country` + `year`。
    pub async fn project_goals_list(
        &self,
        project_id: i64,
        country: &str,
        year: i32,
    ) -> Result<ProjectGoalListResponse, ApiError> {
        let query = [
            ("project_id", project_id.to_string()),
            ("country", country.to_string()),
            ("year", year.to_string()),
        ];
        self.get_json(PROJECT_GOALS_PATH, &query).await
    }

    /// 创建目标（月度 / 年度）。对齐 frontend `handleSave` 的 POST body
    /// （`ProjectGoalCreate`：`project_id` / `country` / `goal_type` /
    /// `period_year` / `target_amount`，月度目标带 `period_month`）。
    pub async fn create_project_goal(
        &self,
        body: &ProjectGoalCreateBody,
    ) -> Result<ProjectGoalItem, ApiError> {
        self.request_json(reqwest::Method::POST, PROJECT_GOALS_PATH, &[], Some(body))
            .await
    }

    /// 更新目标金额。对齐 frontend 编辑保存的 PUT body（`{target_amount}`）。
    pub async fn update_project_goal(
        &self,
        goal_id: i64,
        target_amount: f64,
    ) -> Result<ProjectGoalItem, ApiError> {
        let body = ProjectGoalUpdateBody { target_amount };
        self.request_json(
            reqwest::Method::PUT,
            &project_goal_path(goal_id),
            &[],
            Some(&body),
        )
        .await
    }

    /// 删除目标（backend 返回 204 无内容，走 `request_discard` 丢弃响应体）。
    pub async fn delete_project_goal(&self, goal_id: i64) -> Result<(), ApiError> {
        self.request_discard(
            reqwest::Method::DELETE,
            &project_goal_path(goal_id),
            &[],
            None::<()>.as_ref(),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 契约测试：路径锁定 backend 实际路由
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(
            PROJECT_GOALS_PROGRESS_PATH,
            "/api/v1/project-goals/progress"
        );
        assert_eq!(PROJECT_GOALS_PATH, "/api/v1/project-goals");
        assert_eq!(project_goal_path(7), "/api/v1/project-goals/7");
    }

    #[tokio::test]
    async fn project_goals_progress_sends_query_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PROJECT_GOALS_PROGRESS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "1".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("year".into(), "2026".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 1,
                    "country": "US",
                    "year": 2026,
                    "currency": "USD",
                    "monthly_progress": [
                        {
                            "year": 2026,
                            "month": 8,
                            "month_label": "2026年8月",
                            "target_amount": 50000,
                            "achieved_amount": 20000,
                            "completion_rate": 0.4,
                            "days_in_month": 31,
                            "today_day": 15,
                            "daily_target": 1612.9,
                            "cumulative_daily_target": 24193.5,
                            "completion_vs_daily": 0.8267,
                            "completion_vs_monthly": 0.4,
                            "currency": "USD"
                        }
                    ],
                    "annual_progress": {
                        "year": 2026,
                        "target_amount": 600000,
                        "achieved_amount": 300000,
                        "completion_rate": 0.5,
                        "currency": "USD"
                    }
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let resp = client
            .project_goals_progress(1, "US", 2026)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 1);
        assert_eq!(resp.currency, "USD");
        assert_eq!(resp.monthly_progress.len(), 1);
        assert_eq!(resp.monthly_progress[0].month, 8);
        assert_eq!(resp.monthly_progress[0].month_label, "2026年8月");
        assert_eq!(resp.monthly_progress[0].completion_vs_daily, 0.8267);
        let annual = resp.annual_progress.expect("annual_progress 应存在");
        assert_eq!(annual.target_amount, 600000.0);
        assert_eq!(annual.completion_rate, 0.5);
    }

    #[tokio::test]
    async fn project_goals_progress_allows_null_annual() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PROJECT_GOALS_PROGRESS_PATH)
            .match_query(Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 2,
                    "country": "DE",
                    "year": 2026,
                    "currency": "EUR",
                    "monthly_progress": [],
                    "annual_progress": null
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let resp = client
            .project_goals_progress(2, "DE", 2026)
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.monthly_progress.is_empty());
        assert!(resp.annual_progress.is_none());
        assert_eq!(resp.currency, "EUR");
    }

    #[tokio::test]
    async fn project_goals_list_parses_goals_and_total() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PROJECT_GOALS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "1".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("year".into(), "2026".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "goals": [
                        {
                            "id": 11,
                            "project_id": 1,
                            "country": "US",
                            "goal_type": "monthly",
                            "metric_type": "sales_amount",
                            "period_year": 2026,
                            "period_month": 8,
                            "target_amount": 50000,
                            "currency": "USD",
                            "created_at": "2026-08-01T00:00:00Z",
                            "updated_at": "2026-08-01T00:00:00Z"
                        },
                        {
                            "id": 12,
                            "project_id": 1,
                            "country": "US",
                            "goal_type": "annual",
                            "metric_type": "sales_amount",
                            "period_year": 2026,
                            "period_month": null,
                            "target_amount": 600000,
                            "currency": "USD",
                            "created_at": "2026-08-01T00:00:00Z",
                            "updated_at": "2026-08-01T00:00:00Z"
                        }
                    ],
                    "total": 2
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let resp = client
            .project_goals_list(1, "US", 2026)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 2);
        assert_eq!(resp.goals.len(), 2);
        assert_eq!(resp.goals[0].goal_type, "monthly");
        assert_eq!(resp.goals[0].period_month, Some(8));
        assert!(resp.goals[1].period_month.is_none());
        assert_eq!(resp.goals[1].target_amount, 600000.0);
    }

    #[tokio::test]
    async fn create_project_goal_posts_body_and_parses_created() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", PROJECT_GOALS_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "project_id": 1,
                "country": "US",
                "goal_type": "monthly",
                "metric_type": "sales_amount",
                "period_year": 2026,
                "period_month": 9,
                "target_amount": 45000.0
            })))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 21,
                    "project_id": 1,
                    "country": "US",
                    "goal_type": "monthly",
                    "metric_type": "sales_amount",
                    "period_year": 2026,
                    "period_month": 9,
                    "target_amount": 45000,
                    "currency": "USD",
                    "created_at": "2026-08-15T00:00:00Z",
                    "updated_at": "2026-08-15T00:00:00Z"
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let body = ProjectGoalCreateBody {
            project_id: 1,
            country: "US".into(),
            goal_type: "monthly".into(),
            metric_type: "sales_amount".into(),
            period_year: 2026,
            period_month: Some(9),
            target_amount: 45000.0,
        };
        let goal = client.create_project_goal(&body).await.expect("创建失败");

        m.assert();
        assert_eq!(goal.id, 21);
        assert_eq!(goal.period_month, Some(9));
        assert_eq!(goal.target_amount, 45000.0);
    }

    #[tokio::test]
    async fn update_project_goal_puts_target_amount() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("PUT", "/api/v1/project-goals/21")
            .match_body(Matcher::Json(serde_json::json!({"target_amount": 52000.0})))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 21,
                    "project_id": 1,
                    "country": "US",
                    "goal_type": "monthly",
                    "metric_type": "sales_amount",
                    "period_year": 2026,
                    "period_month": 9,
                    "target_amount": 52000,
                    "currency": "USD",
                    "created_at": "2026-08-15T00:00:00Z",
                    "updated_at": "2026-08-15T01:00:00Z"
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let goal = client
            .update_project_goal(21, 52000.0)
            .await
            .expect("更新失败");

        m.assert();
        assert_eq!(goal.target_amount, 52000.0);
    }

    #[tokio::test]
    async fn delete_project_goal_accepts_204_no_content() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("DELETE", "/api/v1/project-goals/21")
            .with_status(204)
            .create();

        let client = Client::new(server.url());
        client.delete_project_goal(21).await.expect("删除失败");

        m.assert();
    }

    #[tokio::test]
    async fn delete_project_goal_surfaces_error_detail() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("DELETE", "/api/v1/project-goals/99")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"目标不存在"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .delete_project_goal(99)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(404));
        assert_eq!(err.user_message(), "目标不存在");
    }

    #[tokio::test]
    async fn create_project_goal_surfaces_409_conflict() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", PROJECT_GOALS_PATH)
            .with_status(409)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"该月份目标已存在"}"#)
            .create();

        let client = Client::new(server.url());
        let body = ProjectGoalCreateBody {
            project_id: 1,
            country: "US".into(),
            goal_type: "monthly".into(),
            metric_type: "sales_amount".into(),
            period_year: 2026,
            period_month: Some(8),
            target_amount: 100.0,
        };
        let err = client
            .create_project_goal(&body)
            .await
            .expect_err("应返回 409");

        m.assert();
        assert_eq!(err.status(), Some(409));
        assert_eq!(err.user_message(), "该月份目标已存在");
    }
}
