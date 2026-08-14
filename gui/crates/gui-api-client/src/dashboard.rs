//! Dashboard 相关 API
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/`，与 frontend
//! `app/dashboard/page.tsx` / `app/dashboard/v1/page.tsx` 调用口径一致）：
//! - `useManagedProjects`           →  `GET /api/v1/projects/manage`（注意是 manage 不是
//!   managed，见 `backend/app/api/v1/endpoints/projects.py`）
//! - daily-analysis (聚合)          →  `GET /api/v1/daily-analysis/all`
//! - daily-analysis (按国家)        →  `GET /api/v1/daily-analysis/all-countries`
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 三个 header（backend `protected` 依赖读取，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::{
    common::ManagedProject,
    dashboard::{DailyAnalysisAllCountriesResponse, DailyAnalysisResponse},
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /projects/manage` —— backend 实际路由（`projects.py`），不是 `/projects/managed`
pub(crate) const MANAGED_PROJECTS_PATH: &str = "/api/v1/projects/manage";

/// `GET /daily-analysis/all` —— 多项目聚合
const DAILY_ANALYSIS_ALL_PATH: &str = "/api/v1/daily-analysis/all";

/// `GET /daily-analysis/all-countries` —— 单项目跨国家聚合
const DAILY_ANALYSIS_ALL_COUNTRIES_PATH: &str = "/api/v1/daily-analysis/all-countries";

impl Client {
    /// 当前用户可管理的项目列表
    pub async fn list_managed_projects(&self) -> Result<Vec<ManagedProject>, ApiError> {
        self.get_json(MANAGED_PROJECTS_PATH, &[]).await
    }

    /// 销售数据聚合（按天 + 项目分解）
    ///
    /// `project_ids` 必须是逗号分隔的整数（如 `"1,2,3"`）——backend 侧逐项
    /// `int()` 解析，传 `"all"` 会得到 422（`project_ids must be comma-separated
    /// integers`），与 frontend `v1/page.tsx` 的 `URLSearchParams` 调用一致。
    pub async fn daily_analysis_all(
        &self,
        project_ids: &str, // 逗号分隔的整数，如 "1,2,3"
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<DailyAnalysisResponse, ApiError> {
        let query = [
            ("project_ids", project_ids.to_string()),
            ("country", country.to_string()),
            ("start_date", start_date.to_string()),
            ("end_date", end_date.to_string()),
        ];
        self.get_json(DAILY_ANALYSIS_ALL_PATH, &query).await
    }

    /// 销售数据按国家分布（仅支持单 project_id）
    pub async fn daily_analysis_all_countries(
        &self,
        project_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<DailyAnalysisAllCountriesResponse, ApiError> {
        let query = [
            ("project_id", project_id.to_string()),
            ("start_date", start_date.to_string()),
            ("end_date", end_date.to_string()),
        ];
        self.get_json(DAILY_ANALYSIS_ALL_COUNTRIES_PATH, &query)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用）
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

    /// 契约测试：路径锁定 backend 实际路由 `/projects/manage`
    #[test]
    fn managed_projects_path_matches_backend_route() {
        assert_eq!(MANAGED_PROJECTS_PATH, "/api/v1/projects/manage");
    }

    /// 契约测试：`/daily-analysis/*` 路径锁定 backend 实际路由
    #[test]
    fn daily_analysis_paths_match_backend_routes() {
        assert_eq!(DAILY_ANALYSIS_ALL_PATH, "/api/v1/daily-analysis/all");
        assert_eq!(
            DAILY_ANALYSIS_ALL_COUNTRIES_PATH,
            "/api/v1/daily-analysis/all-countries"
        );
    }

    #[tokio::test]
    async fn list_managed_projects_sends_request_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", MANAGED_PROJECTS_PATH)
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id": 1, "name": "测试项目 A", "brand_name": "BelieveBoy",
                     "sort_order": 1, "is_active": true, "has_context": true, "vat_enabled": false},
                    {"id": 2, "name": "测试项目 B", "brand_name": null,
                     "sort_order": 2, "is_active": true}
                ]"#,
            )
            .create();

        let client = session_client(&server.url());
        let projects = client.list_managed_projects().await.expect("请求失败");

        m.assert();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, 1);
        assert_eq!(projects[0].name, "测试项目 A");
        assert_eq!(projects[0].brand_name.as_deref(), Some("BelieveBoy"));
        // 缺省字段（commission_rate 等）容忍反序列化
        assert_eq!(projects[1].commission_rate, None);
        assert!(projects[1].is_active);
    }

    #[tokio::test]
    async fn daily_analysis_all_sends_query_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DAILY_ANALYSIS_ALL_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_ids".into(), "1,2,3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-07".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-13".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "summary_rows": [
                        {
                            "date": "2026-08-13",
                            "order_qty": 42,
                            "sales_amount": 3100.5,
                            "impressions": 12000,
                            "clicks": 350,
                            "cpc": 0.62,
                            "ad_spend": 217.0,
                            "ad_orders": 6,
                            "available_qty": 180
                        }
                    ],
                    "detail_rows": [],
                    "available_dates": {
                        "sales_report": ["2026-08-13"],
                        "ad_product_report": ["2026-08-13"],
                        "inventory_report": [],
                        "business_report": []
                    },
                    "project_breakdown": {
                        "1": {
                            "project_name": "测试项目 A",
                            "summary_rows": [],
                            "detail_rows": []
                        }
                    }
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let resp = client
            .daily_analysis_all("1,2,3", "US", start, end)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.summary_rows.len(), 1);
        assert_eq!(resp.summary_rows[0].order_qty, 42);
        assert_eq!(resp.summary_rows[0].date.to_string(), "2026-08-13");
        let proj = resp.project_breakdown.get(&1).expect("缺少项目 1");
        assert_eq!(proj.project_name, "测试项目 A");
    }

    #[tokio::test]
    async fn daily_analysis_all_countries_sends_query_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DAILY_ANALYSIS_ALL_COUNTRIES_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "1".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-07".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-13".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "console": {
                        "project_id": 1,
                        "project_name": "测试项目 A",
                        "country": "ALL",
                        "start_date": "2026-08-07",
                        "end_date": "2026-08-13",
                        "requested_days": 7,
                        "summary_days": 7,
                        "detail_rows": 0,
                        "sales_source_days": 7,
                        "ad_source_days": 7,
                        "inventory_source_days": 5,
                        "business_source_days": 6,
                        "missing_dates": [],
                        "latest_sales_date": null,
                        "latest_ad_date": null,
                        "latest_inventory_date": null,
                        "latest_business_date": null
                    },
                    "summary_rows": [],
                    "detail_rows": [],
                    "available_dates": {},
                    "country_breakdown": {
                        "US": {"summary_rows": [], "detail_rows": [], "currency": "USD", "source_currency": "USD"},
                        "DE": {"summary_rows": [], "detail_rows": [], "currency": "USD", "source_currency": "EUR"}
                    },
                    "currency": "USD",
                    "currency_note": null
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let resp = client
            .daily_analysis_all_countries(1, start, end)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.console.project_id, 1);
        assert_eq!(resp.console.country, "ALL");
        assert_eq!(resp.currency, "USD");
        let de = resp.country_breakdown.get("DE").expect("缺少 DE");
        assert_eq!(de.source_currency.as_deref(), Some("EUR"));
    }

    #[tokio::test]
    async fn unauthenticated_response_maps_to_unauthenticated_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", MANAGED_PROJECTS_PATH)
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Invalid or expired session"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .list_managed_projects()
            .await
            .expect_err("应返回错误");

        m.assert();
        assert!(matches!(err, ApiError::Unauthenticated(_)));
        assert!(err.is_unauthorized());
        assert_eq!(err.user_message(), "Invalid or expired session");
    }

    #[tokio::test]
    async fn server_error_passes_through_detail_message() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DAILY_ANALYSIS_ALL_PATH)
            .match_query(Matcher::Any)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"upsert failed: connection reset"}"#)
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let err = client
            .daily_analysis_all("1", "US", start, end)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(500));
        assert!(!err.is_unauthorized());
        assert_eq!(err.user_message(), "upsert failed: connection reset");
    }

    #[tokio::test]
    async fn missing_required_param_is_passed_through_as_422() {
        // backend 对空 / 非法 project_ids 返回 422（FastAPI HTTPException detail）
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DAILY_ANALYSIS_ALL_PATH)
            .match_query(Matcher::Any)
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"at least one project_id is required"}"#)
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let err = client
            .daily_analysis_all("", "US", start, end)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "at least one project_id is required");
    }
}
