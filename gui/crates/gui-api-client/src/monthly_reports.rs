//! 报表中心 API（P3-4，BLF-704）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/monthly_reports.py`，与 frontend
//! `app/dashboard/reports/monthly-report/display/display-client.tsx` 调用口径一致）：
//! - 财务序列（月度汇总 + 趋势）→  `GET /api/v1/monthly-reports/financial-series`
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 三个 header（backend `protected` 依赖读取，见 client.rs）。

use gui_domain::reports::FinancialSeriesResponse;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /monthly-reports/financial-series` —— 财务月报主端点（月度汇总 + 趋势）
pub(crate) const FINANCIAL_SERIES_PATH: &str = "/api/v1/monthly-reports/financial-series";

impl Client {
    /// 财务序列（月度汇总 + 趋势）
    ///
    /// 对齐 frontend `display-client.tsx` 的 `URLSearchParams` 调用口径：
    /// - `project_id`：必填（>0）；
    /// - `country`：`US` / `DE` / `UK`（后端 `normalize_country` 归一化）；
    /// - `start_month` / `end_month`：`YYYY-MM`，省略时后端默认近 12 个月
    ///   （`fill_missing=true` 补齐无源报表月份）；
    /// - `fill_missing`：`true` 时缺失月份以零填充行（对齐 frontend 默认）。
    pub async fn monthly_financial_series(
        &self,
        project_id: i64,
        country: &str,
        start_month: Option<&str>,
        end_month: Option<&str>,
        fill_missing: bool,
    ) -> Result<FinancialSeriesResponse, ApiError> {
        let mut query = vec![
            ("project_id", project_id.to_string()),
            ("country", country.to_string()),
            ("fill_missing", fill_missing.to_string()),
        ];
        if let Some(month) = start_month {
            query.push(("start_month", month.to_string()));
        }
        if let Some(month) = end_month {
            query.push(("end_month", month.to_string()));
        }
        self.get_json(FINANCIAL_SERIES_PATH, &query).await
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

    /// 契约测试：路径锁定 backend 实际路由 `/monthly-reports/financial-series`
    #[test]
    fn financial_series_path_matches_backend_route() {
        assert_eq!(FINANCIAL_SERIES_PATH, "/api/v1/monthly-reports/financial-series");
    }

    #[tokio::test]
    async fn monthly_financial_series_sends_query_params_and_parses_response() {
        // 契约：financial-series 端点，query 含全部参数（含可选 start/end month）
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", FINANCIAL_SERIES_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("fill_missing".into(), "true".into()),
                Matcher::UrlEncoded("start_month".into(), "2025-08".into()),
                Matcher::UrlEncoded("end_month".into(), "2026-07".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "start_month": "2025-08",
                    "end_month": "2026-07",
                    "rows": [
                        {
                            "report_month": "2025-08",
                            "income_sales": 12000.5,
                            "income_refund": 120.0,
                            "income_adjustment": 30.0,
                            "income_other": 45.0,
                            "expense_selling_fee": 1800.0,
                            "expense_fba_fee": 2400.0,
                            "expense_inventory_fee": 300.0,
                            "expense_service_fee": 90.0,
                            "expense_advertising": 600.0,
                            "expense_other_fees": 20.0,
                            "income_total": 12195.5,
                            "expense_total": -5210.0,
                            "amazon_pay_back": 6500.0,
                            "credit_card_deduction_usd": 120.0,
                            "fob_cost_rmb": 30000.0,
                            "first_leg_cost_rmb": 5000.0,
                            "has_source_report": true
                        }
                    ],
                    "trend": {
                        "income_total_sum": 12195.5,
                        "expense_total_sum": -5210.0,
                        "amazon_pay_back_sum": 6500.0,
                        "net_amount_sum": 6985.5,
                        "points": [
                            {
                                "report_month": "2025-08",
                                "income_total": 12195.5,
                                "expense_total": -5210.0,
                                "amazon_pay_back": 6500.0,
                                "net_amount": 6985.5,
                                "has_source_report": true
                            }
                        ]
                    }
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .monthly_financial_series(3, "US", Some("2025-08"), Some("2026-07"), true)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.project_name, "测试项目 A");
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].report_month, "2025-08");
        assert_eq!(resp.rows[0].income_sales, 12000.5);
        assert_eq!(resp.trend.points.len(), 1);
        assert_eq!(resp.trend.net_amount_sum, 6985.5);
    }

    #[tokio::test]
    async fn monthly_financial_series_omits_optional_query_params_by_default() {
        // 契约：省略 start/end month 时 query 不含这两个 key（后端默认近 12 个月）
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", FINANCIAL_SERIES_PATH)
            // mockito 的 UrlEncoded 匹配是子集语义，无法断言缺省 → 用锚定 Regex
            // 锁定完整 query 字符串（恰好 3 个参数，无 start_month / end_month）
            .match_query(Matcher::Regex(
                r"^project_id=3&country=DE&fill_missing=true$".to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "project_name": "P",
                    "start_month": "2025-08",
                    "end_month": "2026-07",
                    "rows": [],
                    "trend": {
                        "income_total_sum": 0,
                        "expense_total_sum": 0,
                        "amazon_pay_back_sum": 0,
                        "net_amount_sum": 0,
                        "points": []
                    }
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .monthly_financial_series(3, "DE", None, None, true)
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.rows.is_empty());
        assert!(resp.trend.points.is_empty());
    }
}
