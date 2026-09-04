//! AI 智能域 API（BLF-803 Stage12）
//!
//! 端点对齐 backend：
//! - `GET /api/v1/ai-insights` → 洞察列表（`endpoints/ai_insight.py::list_insights`）；
//! - `GET /api/v1/ai-insights/{id}` → 洞察详情（含 markdown 正文）；
//! - `GET|POST /api/v1/digital-employees` → 数字员工列表
//!   （`endpoints/digital_employees.py::list_employees_endpoint`，只读接入）；
//!
//! 只读边界：洞察生成 / SSE 进度流 / 重试 / 编辑与数字员工 CRUD 均走 web 端
//! （对齐 BLF-726 起「写入走 web 端」取舍；GUI v1 提供查看主面）。
//!
//! 请求鉴权：`Client` 会话头管线见 client.rs。

use gui_domain::ai::{AiInsightDetail, AiInsightListResponse, DigitalEmployeeListResponse};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /ai-insights` —— AI 洞察列表
pub(crate) const INSIGHTS_PATH: &str = "/api/v1/ai-insights";
/// `GET /digital-employees` —— 数字员工列表
pub(crate) const DIGITAL_EMPLOYEES_PATH: &str = "/api/v1/digital-employees";

impl Client {
    /// AI 洞察列表（按 created_at 倒序；后端按 X-Operator 投影可见项目）
    ///
    /// 对齐 frontend `page.tsx::loadInsights` 的 query 口径：project_id /
    /// country / status_filter / insight_type 可选，limit 默认 20。
    ///
    /// `insight_type`：`Some("ad_analysis")` 供「AI 广告分析」页过滤广告域
    /// 洞察（backend `list_insights::insight_type`）；AI洞察主面不传（None，
    /// 与 web 端列表口径一致）。
    pub async fn ai_insight_list(
        &self,
        project_id: Option<i64>,
        country: Option<&str>,
        insight_type: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<AiInsightListResponse, ApiError> {
        let mut query = vec![("limit", limit.to_string()), ("offset", offset.to_string())];
        if let Some(id) = project_id {
            query.push(("project_id", id.to_string()));
        }
        if let Some(c) = country {
            query.push(("country", c.to_string()));
        }
        if let Some(t) = insight_type {
            query.push(("insight_type", t.to_string()));
        }
        self.get_json(INSIGHTS_PATH, &query).await
    }

    /// AI 洞察详情（含 markdown 正文）
    pub async fn ai_insight_detail(&self, insight_id: i64) -> Result<AiInsightDetail, ApiError> {
        let path = format!("{INSIGHTS_PATH}/{insight_id}");
        self.get_json(&path, &[]).await
    }

    /// 数字员工列表（管理列表数据源；只读）
    pub async fn digital_employee_list(&self) -> Result<DigitalEmployeeListResponse, ApiError> {
        self.get_json(DIGITAL_EMPLOYEES_PATH, &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试运营".into()),
            role_type: gui_domain::auth::UserRoleType::Operator,
            is_admin: false,
        };
        Client::new(base_url)
            .with_session(session)
            .with_api_key("k123")
    }

    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(INSIGHTS_PATH, "/api/v1/ai-insights");
        assert_eq!(DIGITAL_EMPLOYEES_PATH, "/api/v1/digital-employees");
    }

    #[tokio::test]
    async fn ai_insight_list_sends_query_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INSIGHTS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("limit".into(), "20".into()),
                Matcher::UrlEncoded("offset".into(), "0".into()),
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
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
                            "created_by": "damon",
                            "created_at": "2026-08-18T10:00:00+00:00",
                            "updated_at": "2026-08-18T10:05:00+00:00"
                        }
                    ],
                    "total": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ai_insight_list(Some(3), Some("US"), None, 20, 0)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].title, "近7天销售洞察");
    }

    #[tokio::test]
    async fn ai_insight_list_sends_insight_type_filter() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INSIGHTS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("limit".into(), "50".into()),
                Matcher::UrlEncoded("offset".into(), "0".into()),
                Matcher::UrlEncoded("insight_type".into(), "ad_analysis".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "total": 0}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ai_insight_list(None, None, Some("ad_analysis"), 50, 0)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.total, 0);
    }

    #[tokio::test]
    async fn ai_insight_detail_parses_content() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/ai-insights/5")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 5,
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "title": "近7天销售洞察",
                    "insight_type": "custom",
                    "date_range_start": "2026-08-11",
                    "date_range_end": "2026-08-18",
                    "status": "completed",
                    "created_by": "damon",
                    "created_at": "2026-08-18T10:00:00+00:00",
                    "updated_at": "2026-08-18T10:05:00+00:00",
                    "content": "结论：销售环比上涨。"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let detail = client.ai_insight_detail(5).await.expect("请求失败");
        m.assert();
        assert_eq!(detail.item.id, 5);
        assert!(detail.content.contains("结论"));
    }

    #[tokio::test]
    async fn digital_employee_list_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DIGITAL_EMPLOYEES_PATH)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
                            "id": 1,
                            "name": "货件助理",
                            "employee_type": "rpa_bot",
                            "status": "running"
                        }
                    ],
                    "total": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.digital_employee_list().await.expect("请求失败");
        m.assert();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items[0].name, "货件助理");
    }
}
