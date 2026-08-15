//! 运营 → 组合分析 API（P5-1，BLF-718）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/daily_analysis.py`，与 frontend
//! `app/dashboard/operations/portfolio-overview` 的 `usePortfolioData` 调用口径一致）：
//! - 跨项目组合分析（按天 + 项目分解）→  `GET /api/v1/daily-analysis/all`
//!
//! 组合分析不新开后端端点——它与销售数据（daily-analysis）共用 `/daily-analysis/all`
//! 聚合端点（frontend `fetchOpsJsonCached` 的 BEL-423 2min 客户端缓存也是两页共用），
//! 本模块的职责是**按组合分析语义收口入参**（`project_ids` 逗号分隔整数 + 站点 +
//! 日期区间），并对齐 P5-0 `QueryBuilder` 的稳定参数顺序，方便 mockito 逐参断言。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 三个 header，生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::dashboard::DailyAnalysisResponse;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /daily-analysis/all` —— 跨项目聚合（组合分析数据源，与 daily-analysis 共用）
pub(crate) const PORTFOLIO_ALL_PATH: &str = "/api/v1/daily-analysis/all";

impl Client {
    /// 组合分析聚合（**多项目 × 单站点**；frontend `usePortfolioData` 数据源）
    ///
    /// 对齐 frontend `portfolio-overview-client.tsx` 的 `URLSearchParams` 调用口径：
    /// - `project_ids`：逗号分隔的整数（如 `"1,2,3"`）——backend 侧逐项 `int()`
    ///   解析，空列表不发起请求（视图层守卫，对齐 frontend「未选项目不发请求」）；
    /// - `country`：`US` / `DE` / `UK`（`ALL` 会 422——后端 `normalize_country`
    ///   只接受 US/DE/UK，组合分析视图不提供「全部站点」选项）；
    /// - `start_date` / `end_date`：`YYYY-MM-DD` 闭区间。
    pub async fn portfolio_overview(
        &self,
        project_ids: &[i64],
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<DailyAnalysisResponse, ApiError> {
        let ids = project_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let query = QueryBuilder::new()
            .with("project_ids", ids)
            .with("country", country)
            .with("start_date", start_date)
            .with("end_date", end_date);
        self.get_json(PORTFOLIO_ALL_PATH, &query.clone().into_pairs())
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

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// 契约测试：路径锁定 backend 实际路由 `/daily-analysis/all`
    #[test]
    fn portfolio_all_path_matches_backend_route() {
        assert_eq!(PORTFOLIO_ALL_PATH, "/api/v1/daily-analysis/all");
    }

    #[tokio::test]
    async fn portfolio_overview_sends_query_params_and_parses_response() {
        // 契约：/daily-analysis/all 端点，query 含 project_ids（逗号分隔整数）/
        // country / start_date / end_date；响应反序列化为 DailyAnalysisResponse
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PORTFOLIO_ALL_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_ids".into(), "1,2,3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-09".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-15".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "summary_rows": [
                        {
                            "date": "2026-08-15",
                            "order_qty": 12,
                            "sales_amount": 1234.5,
                            "impressions": 300,
                            "clicks": 21,
                            "cpc": 1.2,
                            "ad_spend": 25.2,
                            "ad_orders": 2,
                            "available_qty": 88,
                            "page_views": 410,
                            "units_ordered": 15,
                            "sessions": 380,
                            "ordered_sales_amount": 1200.0,
                            "conversion_rate": 3.66
                        }
                    ],
                    "detail_rows": [],
                    "available_dates": {},
                    "project_breakdown": {
                        "1": {
                            "project_name": "测试项目 A",
                            "summary_rows": [],
                            "detail_rows": []
                        },
                        "2": {
                            "project_name": "测试项目 B",
                            "summary_rows": [],
                            "detail_rows": []
                        },
                        "3": {
                            "project_name": "测试项目 C",
                            "summary_rows": [],
                            "detail_rows": []
                        }
                    }
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .portfolio_overview(&[1, 2, 3], "US", date("2026-08-09"), date("2026-08-15"))
            .await
            .expect("请求失败");

        m.assert();
        // 全局聚合行解析成功
        assert_eq!(resp.summary_rows.len(), 1);
        assert_eq!(resp.summary_rows[0].sales_amount, 1234.5);
        // project_breakdown 按 id 解析（key 为字符串 → i64）
        assert_eq!(resp.project_breakdown.len(), 3);
        let entry = &resp.project_breakdown[&2];
        assert_eq!(entry.project_name, "测试项目 B");
    }

    #[tokio::test]
    async fn portfolio_overview_joins_single_project_id() {
        // 契约：单项目 → project_ids 为单值（无逗号）
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PORTFOLIO_ALL_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_ids".into(), "7".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-01".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-15".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"summary_rows":[],"detail_rows":[],"available_dates":{},"project_breakdown":{}}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .portfolio_overview(&[7], "DE", date("2026-08-01"), date("2026-08-15"))
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.project_breakdown.is_empty());
    }
}
