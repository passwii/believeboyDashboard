//! 运营 → 按周产品分析 API（P5-2，BLF-723）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/product_analysis.py`，
//! 与 frontend `app/dashboard/operations/weekly-product-analysis/` 的
//! `loadWeeklyData` / `loadWeeklyDetails` / 库存合并 / `handleRecomputeHistory`
//! URLSearchParams 口径一致：
//! - `GET /api/v1/product-analysis/weekly?project_id&country[&start_date][&end_date]`
//!   → 周度汇总行列表（web 端不携带 current_only，走 backend 默认 true）；
//! - `GET /api/v1/product-analysis/pt1/{pt1_id}/details?country&page&page_size`
//!   → 单周 SKU 明细（web 端固定 `page_size=1000` 翻页拉全量）；
//! - `GET /api/v1/product-analysis/inventory/current?project_id&country&start_date&end_date`
//!   → 区间内最新库存快照（明细「库存」列合并用；无快照时 backend 404，
//!   调用方按可选处理）；
//! - `POST /api/v1/product-analysis/weekly/recompute?project_id&country[&start_date][&end_date]`
//!   → 历史周报重算并持久化（web 端「重新核算」按钮）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::operations::weekly_product_analysis::{
    InventorySnapshotResponse, Pt1DetailsResponse, WeeklyProductRow, WeeklyRecomputeResponse,
};

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/product-analysis/weekly` —— 周度产品分析汇总列表
pub(crate) const WEEKLY_PRODUCT_PATH: &str = "/api/v1/product-analysis/weekly";

/// `GET /api/v1/product-analysis/pt1/{pt1_id}/details` —— 单周 SKU 明细
pub(crate) const PT1_DETAILS_PATH_PREFIX: &str = "/api/v1/product-analysis/pt1";

/// `GET /api/v1/product-analysis/inventory/current` —— 区间内最新库存快照
pub(crate) const INVENTORY_CURRENT_PATH: &str = "/api/v1/product-analysis/inventory/current";

/// `POST /api/v1/product-analysis/weekly/recompute` —— 历史周报重算
pub(crate) const WEEKLY_RECOMPUTE_PATH: &str = "/api/v1/product-analysis/weekly/recompute";

impl Client {
    /// 周度产品分析汇总（对齐 frontend `loadWeeklyData` 的 URLSearchParams 口径）：
    /// - `project_id`：必填（backend `Query(gt=0)`；视图层在项目列表为空时守卫）；
    /// - `country`：`US` / `DE` / `UK`（backend `_normalize_country` 严格模式，
    ///   非法值 422）；
    /// - `start_date` / `end_date`：`None` = 不携带（backend 默认不过滤）；
    ///   web 端默认「8 周前的周一 ~ 上周日」，由视图层计算后传入。
    pub async fn weekly_product_analysis(
        &self,
        project_id: i64,
        country: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<WeeklyProductRow>, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with_opt_date("start_date", start_date)
            .with_opt_date("end_date", end_date);
        self.get_json(WEEKLY_PRODUCT_PATH, &query.clone().into_pairs())
            .await
    }

    /// 单周 SKU 明细（对齐 frontend `loadWeeklyDetails`：`country` + 分页参数；
    /// web 端固定 `page_size=1000` 循环翻页直到 `has_next=false`）。
    pub async fn pt1_details(
        &self,
        pt1_id: i64,
        country: &str,
        page: i64,
        page_size: i64,
    ) -> Result<Pt1DetailsResponse, ApiError> {
        let path = format!("{PT1_DETAILS_PATH_PREFIX}/{pt1_id}/details");
        let query = QueryBuilder::new()
            .with("country", country)
            .with("page", page)
            .with("page_size", page_size);
        self.get_json(&path, &query.clone().into_pairs()).await
    }

    /// 区间内最新库存快照（对齐 frontend 明细加载后的库存合并请求）。
    /// backend 无快照时返回 404 —— 调用方（视图层）按可选数据容错处理。
    pub async fn inventory_current_snapshot(
        &self,
        project_id: i64,
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<InventorySnapshotResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with("start_date", start_date)
            .with("end_date", end_date);
        self.get_json(INVENTORY_CURRENT_PATH, &query.clone().into_pairs())
            .await
    }

    /// 历史周报重算（对齐 frontend `handleRecomputeHistory`：POST + query 参数，
    /// 无请求体；成功后 web 端清缓存并强制刷新周汇总）。
    pub async fn weekly_recompute(
        &self,
        project_id: i64,
        country: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<WeeklyRecomputeResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with_opt_date("start_date", start_date)
            .with_opt_date("end_date", end_date);
        self.request_json(
            reqwest::Method::POST,
            WEEKLY_RECOMPUTE_PATH,
            &query.clone().into_pairs(),
            None::<()>.as_ref(),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 seasonal_replenishment.rs 同款）
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
    fn weekly_paths_match_backend_routes() {
        assert_eq!(WEEKLY_PRODUCT_PATH, "/api/v1/product-analysis/weekly");
        assert_eq!(PT1_DETAILS_PATH_PREFIX, "/api/v1/product-analysis/pt1");
        assert_eq!(
            INVENTORY_CURRENT_PATH,
            "/api/v1/product-analysis/inventory/current"
        );
        assert_eq!(
            WEEKLY_RECOMPUTE_PATH,
            "/api/v1/product-analysis/weekly/recompute"
        );
    }

    /// mock HTTP：周汇总请求携带全部参数 + 会话身份头；响应按
    /// Vec<WeeklyProductRow> 解析（含中文键 summary_row）
    #[tokio::test]
    async fn weekly_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", WEEKLY_PRODUCT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-06-15".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-09".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[{
                    "id": 101, "project_id": 3, "project_name": "测试项目 A",
                    "country": "US",
                    "report_start_date": "2026-08-03",
                    "report_end_date": "2026-08-09",
                    "version": 2, "is_current": true, "row_count": 12,
                    "total_sales": 15320.5, "total_units": 421,
                    "total_ad_spend": 2100.25,
                    "summary_row": { "总销量": 421, "广告花费": 2100.25 }
                }]"#,
            )
            .create();

        let client = session_client(&server.url());
        let rows = client
            .weekly_product_analysis(
                3,
                "US",
                Some(NaiveDate::from_ymd_opt(2026, 6, 15).expect("合法日期")),
                Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")),
            )
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 101);
        assert_eq!(rows[0].total_units, 421);
        assert_eq!(
            rows[0]
                .summary_row
                .as_ref()
                .and_then(|s| s.get("总销量"))
                .and_then(|v| v.as_i64()),
            Some(421)
        );
    }

    /// 契约：`start_date` / `end_date` 为 None → 不携带日期参数
    #[tokio::test]
    async fn weekly_omits_dates_when_none() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", WEEKLY_PRODUCT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "7".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let client = session_client(&server.url());
        let rows = client.weekly_product_analysis(7, "DE", None, None).await.expect("请求失败");
        m.assert();
        assert!(rows.is_empty());
    }

    /// mock HTTP：SKU 明细请求路径含 pt1_id + 分页参数；响应解析（含 raw_row）
    #[tokio::test]
    async fn pt1_details_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/product-analysis/pt1/101/details")
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "1000".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "pt1_id": 101, "project_id": 3, "project_name": "测试项目 A",
                    "report_start_date": "2026-08-03",
                    "report_end_date": "2026-08-09",
                    "version": 2, "page": 1, "page_size": 1000,
                    "has_next": false,
                    "rows": [{
                        "id": 9001, "source_row_no": 2,
                        "sku": "SKU-A", "asin": "B0TEST123",
                        "raw_row": { "日期": "2026-08-03", "SKU": "SKU-A", "总销量": 12 }
                    }]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.pt1_details(101, "US", 1, 1000).await.expect("请求失败");
        m.assert();
        assert_eq!(resp.pt1_id, 101);
        assert!(!resp.has_next);
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].sku.as_deref(), Some("SKU-A"));
    }

    /// mock HTTP：库存快照请求携带 4 参数；响应解析（宽字典 rows 只取所需键）
    #[tokio::test]
    async fn inventory_snapshot_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INVENTORY_CURRENT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-03".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-09".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "source": { "id": 55, "report_type": "inventory" },
                    "rows": [{ "sku": "SKU-A", "available_qty": 100 }]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .inventory_current_snapshot(
                3,
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
                NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期"),
            )
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].available_qty, Some(100.0));
    }

    /// mock HTTP：重算为 POST + query 参数（无请求体）；响应解析 recomputed 计数
    #[tokio::test]
    async fn weekly_recompute_posts_with_query_params() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", WEEKLY_RECOMPUTE_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-06-15".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-09".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3, "project_name": "测试项目 A", "country": "US",
                    "recomputed": 8, "skipped": 1, "periods": []
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .weekly_recompute(
                3,
                "US",
                Some(NaiveDate::from_ymd_opt(2026, 6, 15).expect("合法日期")),
                Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")),
            )
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.recomputed, 8);
        assert_eq!(resp.skipped, 1);
    }

    /// 服务端 422（如 country 非法）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn weekly_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", WEEKLY_PRODUCT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "ALL".into()),
            ]))
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"不支持的国家站点: ALL"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .weekly_product_analysis(3, "ALL", None, None)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "不支持的国家站点: ALL");
    }
}
