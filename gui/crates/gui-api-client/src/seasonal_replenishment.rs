//! 运营 → 季节性补货分析 API（P5-2，BLF-722）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/inventory_replenishment.py`
//! （`/api/v1/seasonal-replenishment-analysis`），与 frontend
//! `app/dashboard/operations/seasonal-replenishment/` 的 `loadAnalysis`
//! URLSearchParams 口径一致：
//! - `GET /api/v1/seasonal-replenishment-analysis?project_id&country&from_date&to_date&compare_year_offset[&keyword][&page][&page_size]`
//!   （web 端固定 `page=1&page_size=200` 一次拉全量；GUI 同口径，视图层
//!   客户端分页展示）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::operations::seasonal_replenishment::SeasonalReplenishmentResponse;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/seasonal-replenishment-analysis` —— 单项目 × 单站点的季节性
/// 补货分析（历史窗口 + 可选去年同期对照）
pub(crate) const SEASONAL_REPLENISHMENT_PATH: &str = "/api/v1/seasonal-replenishment-analysis";

impl Client {
    /// 季节性补货分析（对齐 frontend `loadAnalysis` 的 URLSearchParams 口径）：
    /// - `project_id`：必填（backend `Query(gt=0)`；视图层在项目列表为空时守卫）；
    /// - `country`：`US` / `DE` / `UK`（backend `normalize_country` 严格模式，
    ///   **不支持 ALL**——与常规补货分析端点一致）；
    /// - `from_date` / `to_date`：历史回看窗口（双闭区间；backend 校验
    ///   `to_date ≥ from_date` 且跨度 ≥ 7 天，否则 422）；
    /// - `compare_year_offset`：0=关闭去年同期 / 1=去年同期 / 2=前年同期；
    /// - `keyword`：`None` = 不过滤；`Some` = SKU / ASIN 模糊匹配（backend
    ///   大小写不敏感）；
    /// - `page` / `page_size`：分页（backend `page_size ≤ 200`；web 固定
    ///   `page=1&page_size=200`，GUI 同口径）。
    #[allow(clippy::too_many_arguments)]
    pub async fn seasonal_replenishment_analysis(
        &self,
        project_id: i64,
        country: &str,
        from_date: NaiveDate,
        to_date: NaiveDate,
        compare_year_offset: i64,
        keyword: Option<&str>,
        page: i64,
        page_size: i64,
    ) -> Result<SeasonalReplenishmentResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with("from_date", from_date)
            .with("to_date", to_date)
            .with("compare_year_offset", compare_year_offset)
            .with_opt("keyword", keyword.filter(|k| !k.trim().is_empty()))
            .with("page", page)
            .with("page_size", page_size);
        self.get_json(SEASONAL_REPLENISHMENT_PATH, &query.clone().into_pairs())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 inventory.rs 测试同款）
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
    fn seasonal_path_matches_backend_route() {
        assert_eq!(
            SEASONAL_REPLENISHMENT_PATH,
            "/api/v1/seasonal-replenishment-analysis"
        );
    }

    /// mock HTTP：请求携带全部参数并携带会话身份头；响应按
    /// SeasonalReplenishmentResponse 解析（汇总 + 明细 + 窗口回显）
    #[tokio::test]
    async fn seasonal_replenishment_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SEASONAL_REPLENISHMENT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("from_date".into(), "2026-05-18".into()),
                Matcher::UrlEncoded("to_date".into(), "2026-08-15".into()),
                Matcher::UrlEncoded("compare_year_offset".into(), "1".into()),
                Matcher::UrlEncoded("keyword".into(), "SKU".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "200".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [{
                        "project_id": 3, "project_name": "测试项目 A",
                        "sku": "SKU-A", "country": "US",
                        "asin": "B0TEST", "product_name": "测试产品",
                        "available_inventory": 100, "in_transit_quantity": 50,
                        "dms_90": 1.5, "dms_30": 2.0, "dms_14": 2.5, "dms_7": 3.0,
                        "dms_90_yoy": 1.2, "dms_30_yoy": 1.8,
                        "dms_14_yoy": 2.2, "dms_7_yoy": 2.6,
                        "base_dms": 1.85, "weighted_dms": 2.4,
                        "sellable_days": 41.67,
                        "sellout_date": "2026-09-26",
                        "sellout_date_with_transit": "2026-10-17",
                        "production_lead_days": 30, "shipping_days": 35,
                        "estimated_replenishment_quantity": 156
                    }],
                    "summary": {
                        "sku_count": 1, "out_of_stock_risk_count": 0,
                        "healthy_count": 1, "slow_moving_count": 0,
                        "pending_data_count": 0,
                        "total_available_inventory": 100,
                        "total_in_transit_quantity": 50
                    },
                    "page": 1, "page_size": 200, "total": 1, "has_next": false,
                    "from_date": "2026-05-18", "to_date": "2026-08-15",
                    "compare_year_offset": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .seasonal_replenishment_analysis(
                3,
                "US",
                NaiveDate::from_ymd_opt(2026, 5, 18).expect("合法日期"),
                NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"),
                1,
                Some("SKU"),
                1,
                200,
            )
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].sku, "SKU-A");
        assert_eq!(resp.items[0].dms_90, Some(1.5));
        assert_eq!(resp.summary.sku_count, 1);
        assert_eq!(resp.compare_year_offset, 1);
        assert_eq!(
            resp.to_date,
            NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期")
        );
    }

    /// 契约：`keyword = None`（不过滤）→ 不携带 keyword 参数
    #[tokio::test]
    async fn seasonal_replenishment_omits_keyword_when_none() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SEASONAL_REPLENISHMENT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "7".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
                Matcher::UrlEncoded("from_date".into(), "2026-05-18".into()),
                Matcher::UrlEncoded("to_date".into(), "2026-08-15".into()),
                Matcher::UrlEncoded("compare_year_offset".into(), "0".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "200".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [],
                    "summary": {
                        "sku_count": 0, "out_of_stock_risk_count": 0,
                        "healthy_count": 0, "slow_moving_count": 0,
                        "pending_data_count": 0,
                        "total_available_inventory": 0,
                        "total_in_transit_quantity": 0
                    },
                    "page": 1, "page_size": 200, "total": 0, "has_next": false,
                    "from_date": "2026-05-18", "to_date": "2026-08-15",
                    "compare_year_offset": 0
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .seasonal_replenishment_analysis(
                7,
                "DE",
                NaiveDate::from_ymd_opt(2026, 5, 18).expect("合法日期"),
                NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"),
                0,
                None,
                1,
                200,
            )
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
    }

    /// 服务端 422（如日期跨度不足 7 天）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn seasonal_replenishment_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SEASONAL_REPLENISHMENT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("from_date".into(), "2026-08-10".into()),
                Matcher::UrlEncoded("to_date".into(), "2026-08-15".into()),
                Matcher::UrlEncoded("compare_year_offset".into(), "0".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "200".into()),
            ]))
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"日期范围跨度至少 7 天"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .seasonal_replenishment_analysis(
                3,
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 10).expect("合法日期"),
                NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"),
                0,
                None,
                1,
                200,
            )
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "日期范围跨度至少 7 天");
    }
}
