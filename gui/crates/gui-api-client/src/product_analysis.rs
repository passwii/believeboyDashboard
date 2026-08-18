//! 报表中心 → 产品分析 API（P5-4，BLF-727）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/product_analysis.py`
//! （check L663 / run L689），与 frontend `app/dashboard/reports/
//! product-analysis/components/product-analysis-panel.tsx`「产品分析核算」tab
//! 的 `handleCheck` / `handleRun` 口径一致（POST + JSON 请求体，无 query）：
//! - `POST /api/v1/product-analysis/calculation/check` → 数据可用性
//!   （`ProductAnalysisCheckResponse`：单日缺失 / 周期覆盖 / 回款覆盖 /
//!   按周可用性栅格 + `has_minimum_data` 判定）；
//! - `POST /api/v1/product-analysis/calculation/run` → 执行核算并持久化
//!   （`ProductAnalysisRunResponse`：周期列表，中文键 summary + SKU details）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头（含 `X-Is-Admin`，backend
//! `project_service.ensure_project_access` 消费）；生产后端 dashboard 路由
//! 另需 `api_key`（`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。
//!
//! 设计取舍（BLF-727）：
//! - **preview 端点**（`POST /calculation/preview`，月度 SKU 临时核算不入库）：
//!   依赖三类报表上传 + recognize 的 temp_file_id，GUI 暂无上传基建，
//!   本期不接（对齐 research_analysis 导入端点取舍）；
//! - **recognize / commit 上传链路**：手动核算 tab 专用，同款拆后续 issue。

use chrono::NaiveDate;
use gui_domain::operations::product_analysis::{
    ProductAnalysisCheckBody, ProductAnalysisCheckResponse, ProductAnalysisRunBody,
    ProductAnalysisRunResponse,
};

use crate::client::Client;
use crate::error::ApiError;

/// `POST /api/v1/product-analysis/calculation/check` —— 数据可用性检查
pub(crate) const CALCULATION_CHECK_PATH: &str = "/api/v1/product-analysis/calculation/check";

/// `POST /api/v1/product-analysis/calculation/run` —— 执行核算并持久化
pub(crate) const CALCULATION_RUN_PATH: &str = "/api/v1/product-analysis/calculation/run";

impl Client {
    /// 数据可用性检查（对齐 frontend `handleCheck` 的 POST body：
    /// `project_id` / `country` / `start_date` / `end_date`）。
    ///
    /// - `country`：`US` / `DE` / `UK`（backend `_normalize_country` 严格模式，
    ///   非法值 422）；
    /// - 日期双端必填（backend 请求模型无默认值，缺省 422）。
    pub async fn product_analysis_check(
        &self,
        project_id: i64,
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<ProductAnalysisCheckResponse, ApiError> {
        let body = ProductAnalysisCheckBody {
            project_id,
            country: country.to_string(),
            start_date,
            end_date,
        };
        self.request_json(
            reqwest::Method::POST,
            CALCULATION_CHECK_PATH,
            &[],
            Some(&body),
        )
        .await
    }

    /// 执行核算并持久化（对齐 frontend `handleRun`：同 check 参数 +
    /// `current_only=true`——只算当前版本数据）。
    pub async fn product_analysis_run(
        &self,
        project_id: i64,
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
        current_only: bool,
    ) -> Result<ProductAnalysisRunResponse, ApiError> {
        let body = ProductAnalysisRunBody {
            project_id,
            country: country.to_string(),
            start_date,
            end_date,
            current_only,
        };
        self.request_json(
            reqwest::Method::POST,
            CALCULATION_RUN_PATH,
            &[],
            Some(&body),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 weekly_product_analysis.rs 同款）
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
        Client::new(base_url).with_session(session)
    }

    fn start() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期")
    }

    fn end() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn calculation_paths_match_backend_routes() {
        assert_eq!(
            CALCULATION_CHECK_PATH,
            "/api/v1/product-analysis/calculation/check"
        );
        assert_eq!(
            CALCULATION_RUN_PATH,
            "/api/v1/product-analysis/calculation/run"
        );
    }

    /// mock HTTP：check 为 POST + JSON 请求体（无 query）；携带会话身份头；
    /// 响应按 ProductAnalysisCheckResponse 解析（含按周可用性栅格）
    #[tokio::test]
    async fn check_posts_body_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", CALCULATION_CHECK_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "project_id": 3,
                "country": "US",
                "start_date": "2026-08-03",
                "end_date": "2026-08-09"
            })))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "business_report_missing": [],
                    "ad_report_missing": ["2026-08-05"],
                    "inventory_missing": [],
                    "payment_periods_overlapping": [],
                    "payment_full_period_covered": false,
                    "payment_daily_covered_dates": [],
                    "has_minimum_data": true,
                    "weekly_availability": [
                        {
                            "iso_year": 2026,
                            "iso_week": 32,
                            "week_start_date": "2026-08-03",
                            "week_end_date": "2026-08-09",
                            "total_days": 7,
                            "business_report_available_days": 7,
                            "ad_report_available_days": 6,
                            "payment_covered": false,
                            "can_calculate": true,
                            "is_partial": true,
                            "ad_missing_dates": ["2026-08-05"]
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .product_analysis_check(3, "US", start(), end())
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.has_minimum_data);
        assert_eq!(resp.ad_report_missing, vec!["2026-08-05".to_string()]);
        assert_eq!(resp.weekly_availability.len(), 1);
        assert_eq!(resp.weekly_availability[0].ad_report_available_days, 6);
        assert!(resp.weekly_availability[0].is_partial);
    }

    /// mock HTTP：run 为 POST + JSON 请求体（含 current_only）；
    /// 响应按 ProductAnalysisRunResponse 解析（中文键 summary + details）
    #[tokio::test]
    async fn run_posts_body_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", CALCULATION_RUN_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "project_id": 3,
                "country": "US",
                "start_date": "2026-08-03",
                "end_date": "2026-08-09",
                "current_only": true
            })))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "total_periods": 1,
                    "periods": [
                        {
                            "report_start_date": "2026-08-03",
                            "report_end_date": "2026-08-09",
                            "summary": {
                                "总销售额": 15320.5,
                                "利润": 3064.1,
                                "利润率": 0.2,
                                "ACOS": 0.137
                            },
                            "details": [
                                { "SKU": "SKU-A", "ASIN": "B0TEST123", "总销量": 120 }
                            ],
                            "is_partial": false,
                            "persisted": true,
                            "pt1_id": 101,
                            "version": 2
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .product_analysis_run(3, "US", start(), end(), true)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.total_periods, 1);
        assert_eq!(resp.periods.len(), 1);
        assert_eq!(
            resp.periods[0].summary.get("利润率").and_then(|v| v.as_f64()),
            Some(0.2)
        );
        assert_eq!(resp.periods[0].details.len(), 1);
        assert!(resp.periods[0].persisted);
        assert_eq!(resp.periods[0].pt1_id, Some(101));
    }

    /// 契约：`current_only=false` 如实透传（历史版本核算入口保留）
    #[tokio::test]
    async fn run_sends_current_only_false() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", CALCULATION_RUN_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "project_id": 7,
                "country": "DE",
                "start_date": "2026-08-03",
                "end_date": "2026-08-09",
                "current_only": false
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 7, "project_name": "测试项目 B",
                    "country": "DE", "total_periods": 0, "periods": []
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .product_analysis_run(7, "DE", start(), end(), false)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.periods.is_empty());
    }

    /// 服务端 422（如 country 非法）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn check_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", CALCULATION_CHECK_PATH)
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"不支持的国家站点: ALL"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .product_analysis_check(3, "ALL", start(), end())
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "不支持的国家站点: ALL");
    }

    /// 服务端 400（如日期区间无数据可算）→ detail 透传
    #[tokio::test]
    async fn run_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", CALCULATION_RUN_PATH)
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"区间内无可核算数据"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .product_analysis_run(3, "US", start(), end(), true)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(400));
        assert_eq!(err.user_message(), "区间内无可核算数据");
    }
}
