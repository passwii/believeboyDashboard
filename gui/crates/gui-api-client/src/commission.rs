//! 财务资金 → 佣金管理 API（P5-5，BLF-734）
//!
//! 端点对齐 backend
//! `backend/app/api/v1/endpoints/system_management/commission/{records,summary}.py`，
//! 与 web 端 `frontend/app/dashboard/finance/commission-management/page.tsx` 的
//! 参数口径一致：
//! - `GET /api/v1/system-management/commission-management/project-months
//!   ?report_month&country` → 项目月度佣金行（总览 tab；`report_month` 必填
//!   `YYYY-MM`，`country` 可选 `US|DE|UK`）；
//! - `GET /api/v1/system-management/commission-management/summary/monthly
//!   ?year&country` → 年-月汇总（`year` 必填 `YYYY`）；
//! - `GET /api/v1/system-management/commission-management/summary/project
//!   ?year&country` → 项目年度汇总（项目 × 12 月矩阵）。
//!
//! 未接入（写入链路走 web 端，对齐 BLF-726 发货管理 / BLF-731 订单信息 /
//! BLF-732 汇率信息 / BLF-733 VAT 发票「写入走 web 端」取舍）：
//! - `PATCH /api/v1/system-management/commission-management/project-months/{id}/payment`
//!   （回款状态 / 已回款金额更新）——GUI 已回款列与回款状态列只读展示；
//! - `POST /api/v1/system-management/commission-management/recompute`（佣金核算）；
//! - `/records` 系列与 `/ratio-overrides` / `/role-assignments`（web 页面未消费）。
//!
//! 另：web 端总览还拉取 `GET /api/v1/exchange-rates?year_month=…`，但其
//! `exchangeRates` 仅透传给 DetailTab、未参与任何渲染（web 侧死数据），GUI
//! 不拉取。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需
//! `Authorization: Bearer` api_key（BLF-711，见 client.rs）。

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;
use gui_domain::commission::{
    CommissionProjectMonthsResponse, CommissionProjectYearlySummaryResponse,
    CommissionYearlyMonthlySummaryResponse,
};

/// `GET …/commission-management/project-months`
pub(crate) const PROJECT_MONTHS_PATH: &str =
    "/api/v1/system-management/commission-management/project-months";

/// `GET …/commission-management/summary/monthly`
pub(crate) const SUMMARY_MONTHLY_PATH: &str =
    "/api/v1/system-management/commission-management/summary/monthly";

/// `GET …/commission-management/summary/project`
pub(crate) const SUMMARY_PROJECT_PATH: &str =
    "/api/v1/system-management/commission-management/summary/project";

/// 总览月份筛选（`report_month` 必填 `YYYY-MM`；`country` `None` = 全部站点）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CommissionMonthFilter {
    /// 报告月份 `YYYY-MM`
    pub report_month: String,
    /// 站点（`US` / `DE` / `UK`；`None` = 全部站点）
    pub country: Option<String>,
}

impl CommissionMonthFilter {
    /// 组装 query 参数（顺序稳定，便于 mockito 逐参断言；空站点不携带）
    pub fn base_query(&self) -> QueryBuilder {
        QueryBuilder::new()
            .with("report_month", self.report_month.clone())
            .with_opt("country", self.country.as_deref())
    }
}

/// 汇总年份筛选（`year` 必填 `YYYY`；`country` `None` = 全部站点）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CommissionYearFilter {
    /// 年份 `YYYY`
    pub year: String,
    /// 站点（`US` / `DE` / `UK`；`None` = 全部站点）
    pub country: Option<String>,
}

impl CommissionYearFilter {
    /// 组装 query 参数（顺序稳定，便于 mockito 逐参断言；空站点不携带）
    pub fn base_query(&self) -> QueryBuilder {
        QueryBuilder::new()
            .with("year", self.year.clone())
            .with_opt("country", self.country.as_deref())
    }
}

impl Client {
    /// 项目月度佣金行（对齐 web `loadData`：总览 tab 数据源）
    pub async fn commission_project_months(
        &self,
        filter: &CommissionMonthFilter,
    ) -> Result<CommissionProjectMonthsResponse, ApiError> {
        self.get_json(PROJECT_MONTHS_PATH, &filter.base_query().into_pairs())
            .await
    }

    /// 年-月汇总（对齐 web `loadYearlySummary` 的 monthly 请求）
    pub async fn commission_summary_monthly(
        &self,
        filter: &CommissionYearFilter,
    ) -> Result<CommissionYearlyMonthlySummaryResponse, ApiError> {
        self.get_json(SUMMARY_MONTHLY_PATH, &filter.base_query().into_pairs())
            .await
    }

    /// 项目年度汇总（对齐 web `loadYearlySummary` 的 project 请求）
    pub async fn commission_summary_project(
        &self,
        filter: &CommissionYearFilter,
    ) -> Result<CommissionProjectYearlySummaryResponse, ApiError> {
        self.get_json(SUMMARY_PROJECT_PATH, &filter.base_query().into_pairs())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::commission::PAYMENT_STATUS_PARTIAL;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 vat_invoice.rs 同款）
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

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(
            PROJECT_MONTHS_PATH,
            "/api/v1/system-management/commission-management/project-months"
        );
        assert_eq!(
            SUMMARY_MONTHLY_PATH,
            "/api/v1/system-management/commission-management/summary/monthly"
        );
        assert_eq!(
            SUMMARY_PROJECT_PATH,
            "/api/v1/system-management/commission-management/summary/project"
        );
    }

    /// 契约：筛选组装——必填参数恒携带；站点空条件不携带
    #[test]
    fn filters_build_query_and_skip_blank_country() {
        let month = CommissionMonthFilter {
            report_month: "2026-07".into(),
            country: Some("DE".into()),
        };
        assert_eq!(
            month.base_query().into_pairs(),
            vec![
                ("report_month", "2026-07".to_string()),
                ("country", "DE".to_string()),
            ]
        );
        let month_all = CommissionMonthFilter {
            report_month: "2026-07".into(),
            country: None,
        };
        assert_eq!(
            month_all.base_query().into_pairs(),
            vec![("report_month", "2026-07".to_string())]
        );

        let year = CommissionYearFilter {
            year: "2026".into(),
            country: Some("US".into()),
        };
        assert_eq!(
            year.base_query().into_pairs(),
            vec![("year", "2026".to_string()), ("country", "US".to_string()),]
        );
        let year_all = CommissionYearFilter {
            year: "2026".into(),
            country: None,
        };
        assert_eq!(
            year_all.base_query().into_pairs(),
            vec![("year", "2026".to_string())]
        );
    }

    /// mock HTTP：project-months 携带 report_month/country + 会话头；响应解析
    #[tokio::test]
    async fn project_months_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PROJECT_MONTHS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("report_month".into(), "2026-07".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "report_month": "2026-07",
                    "items": [
                        {
                            "id": 12, "report_month": "2026-07", "country": "DE",
                            "project_id": 3, "project_name": "德国店",
                            "income_total_usd": 1234.56,
                            "factory_commission_rate": 0.1,
                            "usd_to_rmb_rate": 7.23,
                            "factory_commission_usd": 123.46,
                            "factory_commission_rmb": 892.61,
                            "payment_status": "partial", "received_rmb": 400.0,
                            "payment_confirmed_at": null,
                            "payment_confirmed_by": null, "note": null,
                            "computed_at": "2026-08-01T00:00:00+00:00",
                            "updated_at": "2026-08-02T00:00:00+00:00"
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = CommissionMonthFilter {
            report_month: "2026-07".into(),
            country: Some("DE".into()),
        };
        let resp = client
            .commission_project_months(&filter)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.report_month, "2026-07");
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].project_name, "德国店");
        assert_eq!(resp.items[0].payment_status, PAYMENT_STATUS_PARTIAL);
    }

    /// mock HTTP：summary/monthly 携带 year（无 country）；响应解析
    #[tokio::test]
    async fn summary_monthly_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SUMMARY_MONTHLY_PATH)
            .match_query(Matcher::UrlEncoded("year".into(), "2026".into()))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "year": "2026",
                    "items": [
                        {
                            "report_month": "2026-07",
                            "income_total_usd": 5000.0,
                            "factory_commission_usd": 500.0,
                            "factory_commission_rmb": 3615.0,
                            "received_rmb": 1807.5,
                            "receive_rate": 0.5
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = CommissionYearFilter {
            year: "2026".into(),
            country: None,
        };
        let resp = client
            .commission_summary_monthly(&filter)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.year, "2026");
        assert_eq!(resp.items.len(), 1);
        assert!((resp.items[0].receive_rate - 0.5).abs() < 1e-9);
    }

    /// mock HTTP：summary/project 携带 year + country；`months` dict 按
    /// `BTreeMap` 解析（键序稳定）
    #[tokio::test]
    async fn summary_project_parses_months_map() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SUMMARY_PROJECT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("year".into(), "2026".into()),
                Matcher::UrlEncoded("country".into(), "UK".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "year": "2026",
                    "items": [
                        {
                            "project_id": 3, "project_name": "德国店",
                            "months": {
                                "2026-02": {"report_month": "2026-02",
                                            "income_total_usd": 100.0,
                                            "factory_commission_rmb": 70.0,
                                            "received_rmb": 70.0,
                                            "receive_rate": 1.0},
                                "2026-01": {"report_month": "2026-01",
                                            "income_total_usd": 200.0,
                                            "factory_commission_rmb": 140.0,
                                            "received_rmb": 0.0,
                                            "receive_rate": 0.0}
                            },
                            "total_income_usd": 300.0,
                            "total_commission_rmb": 210.0,
                            "total_received_rmb": 70.0,
                            "receive_rate": 0.3333
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = CommissionYearFilter {
            year: "2026".into(),
            country: Some("UK".into()),
        };
        let resp = client
            .commission_summary_project(&filter)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.items.len(), 1);
        let project = &resp.items[0];
        assert_eq!(project.months.len(), 2);
        assert_eq!(
            project.months.keys().next().map(String::as_str),
            Some("2026-01")
        );
        assert!(project.month("2026-02").is_some());
    }

    /// 服务端 401 → 透传错误消息
    #[tokio::test]
    async fn request_propagates_error_message() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PROJECT_MONTHS_PATH)
            .match_query(Matcher::UrlEncoded("report_month".into(), "2026-07".into()))
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"未登录或会话已过期"}"#)
            .create();

        let client = Client::new(server.url());
        let filter = CommissionMonthFilter {
            report_month: "2026-07".into(),
            country: None,
        };
        let err = client
            .commission_project_months(&filter)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(401));
        assert_eq!(err.user_message(), "未登录或会话已过期");
    }
}
