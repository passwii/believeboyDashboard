//! 运营 → 调研分析 API（P5-3，BLF-724）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/category_research.py`，
//! 与 frontend `app/dashboard/operations/research-analysis/page.tsx`
//! `loadKeywordOptions` / `loadDatasets` / `loadOverview` / `loadMarketTrend`
//! / `loadProducts` / `onRecomputeCurrent` URLSearchParams 口径一致：
//! - `GET /api/v1/category-research/datasets?marketplace[&category_keyword_en][&current_only][&include_history]`
//!   → 数据集列表（web 端关键词选项 + 历史版本列表）；
//! - `GET /api/v1/category-research/datasets/{id}[?price_band_standard][&price_band_breaks]`
//!   → 单数据集总览（KPI + 高级指标 + 价格分布等 buckets）；
//! - `GET /api/v1/category-research/datasets/{id}/market-trend?months`
//!   → 市场近 N 个月月销量序列（默认 24 个月）；
//! - `GET /api/v1/category-research/datasets/{id}/products?page&page_size[&brand][&fulfillment_method][&price_band]`
//!   → 产品明细分页（web 端默认 page_size=100）；
//! - `POST /api/v1/category-research/datasets/{id}/recompute` → 单数据集重算（GUI
//!   视图暂不消费——重算入口走 web 端；保留以备后用）；
//! - `POST /api/v1/category-research/datasets/recompute` → 批量重算（GUI 同款保留）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。
//!
//! 设计取舍（BLF-724）：
//! - **导入端点**（multipart `POST /datasets/import`）：GUI 视图只消费「数据看板」
//!   读取入口；导入 xlsx 走 web 端（GUI 文件选择/上传基建暂未沉淀；与 weekly_product
//!   analysis 同款取舍）；
//! - **导出端点**（`GET /datasets/{id}/exports[/{export_key}]`）：与 BLF-723
//!   `weekly_product_analysis` 一致——GUI 暂无导出基建，保留接口以便后续视图按需接入。

use gui_domain::operations::research_analysis::{
    CategoryResearchBatchRecomputeResponse, CategoryResearchDatasetItem,
    CategoryResearchMarketTrendResponse, CategoryResearchOverviewResponse,
    CategoryResearchProductsResponse, CategoryResearchRecomputeResponse,
};

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/category-research/datasets` —— 数据集列表（含历史版本）
pub(crate) const DATASETS_PATH: &str = "/api/v1/category-research/datasets";

/// `GET /api/v1/category-research/datasets/{id}` —— 单数据集总览
pub(crate) const DATASET_DETAIL_PATH_PREFIX: &str = "/api/v1/category-research/datasets";

/// `GET /api/v1/category-research/datasets/{id}/market-trend` —— 市场趋势
pub(crate) const MARKET_TREND_PATH_SUFFIX: &str = "/market-trend";

/// `GET /api/v1/category-research/datasets/{id}/products` —— 产品明细分页
pub(crate) const DATASET_PRODUCTS_PATH_SUFFIX: &str = "/products";

/// `POST /api/v1/category-research/datasets/{id}/recompute` —— 单数据集重算
pub(crate) const DATASET_RECOMPUTE_PATH_SUFFIX: &str = "/recompute";

/// `POST /api/v1/category-research/datasets/recompute` —— 批量重算
pub(crate) const BATCH_RECOMPUTE_PATH: &str = "/api/v1/category-research/datasets/recompute";

impl Client {
    /// 数据集列表（对齐 frontend `loadKeywordOptions` / `loadDatasets` 口径）：
    /// - `marketplace`：必填（`US` / `DE` / `UK` 等，backend `_normalize_country`
    ///   严格模式）；
    /// - `category_keyword_en`：`None` = 不过滤；提供时返回该关键词下所有版本
    ///   （web 端 `include_history=true`，否则只返回 `current_only=true` 当前版本）；
    /// - `include_history`：`None` = 走 backend 默认 `true`；web 端历史版本列表
    ///   显式 `include_history=true`，关键词选项显式 `current_only=true` /
    ///   `include_history=false`。
    ///
    /// 注：`current_only` 与 `include_history` 在 backend 是互斥的（`include_history=true`
    /// 时 backend 强制 `effective_current_only=false`），由调用方按场景传参。
    pub async fn category_research_datasets(
        &self,
        marketplace: &str,
        category_keyword_en: Option<&str>,
        current_only: Option<bool>,
        include_history: Option<bool>,
    ) -> Result<Vec<CategoryResearchDatasetItem>, ApiError> {
        let query = QueryBuilder::new()
            .with("marketplace", marketplace)
            .with_opt("category_keyword_en", category_keyword_en)
            .with_opt("current_only", current_only)
            .with_opt("include_history", include_history);
        self.get_json(DATASETS_PATH, &query.clone().into_pairs())
            .await
    }

    /// 单数据集总览（对齐 frontend `loadOverview` 口径）：
    /// `price_band_standard` 默认 `"refined"`（web 端常用值；backend 默认 `"default"`）；
    /// `price_band_breaks` 留空 = 走 backend 默认。
    pub async fn category_research_overview(
        &self,
        dataset_id: i64,
        price_band_standard: Option<&str>,
        price_band_breaks: Option<&str>,
    ) -> Result<CategoryResearchOverviewResponse, ApiError> {
        let path = format!("{DATASET_DETAIL_PATH_PREFIX}/{dataset_id}");
        let query = QueryBuilder::new()
            .with_opt("price_band_standard", price_band_standard)
            .with_opt("price_band_breaks", price_band_breaks);
        self.get_json(&path, &query.clone().into_pairs()).await
    }

    /// 市场近 N 个月月销量趋势（对齐 frontend `loadMarketTrend`，固定 `months=24`）。
    pub async fn category_research_market_trend(
        &self,
        dataset_id: i64,
        months: i64,
    ) -> Result<CategoryResearchMarketTrendResponse, ApiError> {
        let path = format!("{DATASET_DETAIL_PATH_PREFIX}/{dataset_id}{MARKET_TREND_PATH_SUFFIX}");
        let query = QueryBuilder::new().with("months", months);
        self.get_json(&path, &query.clone().into_pairs()).await
    }

    /// 产品明细分页（对齐 frontend 产品表格筛选 + 分页）：
    /// - `brand` / `fulfillment_method` / `price_band`：可选筛选；`None` = 不过滤；
    /// - `page` / `page_size`：分页参数（web 端默认 `page_size=100`，视图层按需调）。
    pub async fn category_research_products(
        &self,
        dataset_id: i64,
        page: i64,
        page_size: i64,
        brand: Option<&str>,
        fulfillment_method: Option<&str>,
        price_band: Option<&str>,
    ) -> Result<CategoryResearchProductsResponse, ApiError> {
        let path =
            format!("{DATASET_DETAIL_PATH_PREFIX}/{dataset_id}{DATASET_PRODUCTS_PATH_SUFFIX}");
        let query = QueryBuilder::new()
            .with("page", page)
            .with("page_size", page_size)
            .with_opt("brand", brand)
            .with_opt("fulfillment_method", fulfillment_method)
            .with_opt("price_band", price_band);
        self.get_json(&path, &query.clone().into_pairs()).await
    }

    /// 单数据集重算（POST + 无请求体；GUI 暂不消费，保留供后续「重新核算」按钮）。
    pub async fn category_research_recompute_dataset(
        &self,
        dataset_id: i64,
    ) -> Result<CategoryResearchRecomputeResponse, ApiError> {
        let path =
            format!("{DATASET_DETAIL_PATH_PREFIX}/{dataset_id}{DATASET_RECOMPUTE_PATH_SUFFIX}");
        self.request_json(reqwest::Method::POST, &path, &[], None::<()>.as_ref())
            .await
    }

    /// 批量重算（POST + 可选 query 参数；GUI 暂不消费，保留）。
    pub async fn category_research_recompute_batch(
        &self,
        marketplace: Option<&str>,
        category_keyword_en: Option<&str>,
        include_history: Option<bool>,
    ) -> Result<CategoryResearchBatchRecomputeResponse, ApiError> {
        let query = QueryBuilder::new()
            .with_opt("marketplace", marketplace)
            .with_opt("category_keyword_en", category_keyword_en)
            .with_opt("include_history", include_history);
        self.request_json(
            reqwest::Method::POST,
            BATCH_RECOMPUTE_PATH,
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

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(DATASETS_PATH, "/api/v1/category-research/datasets");
        assert_eq!(
            DATASET_DETAIL_PATH_PREFIX,
            "/api/v1/category-research/datasets"
        );
        assert_eq!(MARKET_TREND_PATH_SUFFIX, "/market-trend");
        assert_eq!(DATASET_PRODUCTS_PATH_SUFFIX, "/products");
        assert_eq!(DATASET_RECOMPUTE_PATH_SUFFIX, "/recompute");
        assert_eq!(
            BATCH_RECOMPUTE_PATH,
            "/api/v1/category-research/datasets/recompute"
        );
    }

    /// mock HTTP：数据集列表请求携带 marketplace + current_only；响应按
    /// `Vec<CategoryResearchDatasetItem>` 解析（含 history 记录）
    #[tokio::test]
    async fn datasets_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DATASETS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("marketplace".into(), "US".into()),
                Matcher::UrlEncoded("current_only".into(), "true".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {
                        "id": 7, "marketplace": "US", "category_keyword_en": "yoga mat",
                        "category_name_zh": "瑜伽垫", "version": 3, "is_current": true,
                        "upload_file_id": "u-7", "upload_file_path": "/srv/uploads/7.xlsx",
                        "stored_filename": "7.xlsx", "ingestion_status": "ok",
                        "data_date": "2026-08-12", "data_year": 2026,
                        "data_month": 8, "data_day": 12,
                        "row_count_products": 420, "row_count_trends": 1680,
                        "quality_warnings": {}
                    }
                ]"#,
            )
            .create();

        let client = session_client(&server.url());
        let rows = client
            .category_research_datasets("US", None, Some(true), None)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 7);
        assert!(rows[0].is_current);
    }

    /// 契约：`category_keyword_en` + `include_history` 携带过滤参数
    #[tokio::test]
    async fn datasets_with_keyword_history_filter() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DATASETS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("marketplace".into(), "US".into()),
                Matcher::UrlEncoded("category_keyword_en".into(), "yoga mat".into()),
                Matcher::UrlEncoded("include_history".into(), "true".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let client = session_client(&server.url());
        let rows = client
            .category_research_datasets("US", Some("yoga mat"), None, Some(true))
            .await
            .expect("请求失败");
        m.assert();
        assert!(rows.is_empty());
    }

    /// mock HTTP：overview 请求携带 price_band 参数；响应按 OverviewResponse 解析
    /// （含嵌套 advanced_metrics）
    #[tokio::test]
    async fn overview_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/category-research/datasets/7")
            .match_query(Matcher::AllOf(vec![Matcher::UrlEncoded(
                "price_band_standard".into(),
                "refined".into(),
            )]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "dataset": {
                        "id": 7, "marketplace": "US", "category_keyword_en": "yoga mat",
                        "category_name_zh": "瑜伽垫", "version": 3, "is_current": true,
                        "upload_file_id": "u-7", "upload_file_path": "/srv/uploads/7.xlsx",
                        "stored_filename": "7.xlsx", "ingestion_status": "ok",
                        "data_date": "2026-08-12", "data_year": 2026,
                        "data_month": 8, "data_day": 12,
                        "row_count_products": 420, "row_count_trends": 1680,
                        "quality_warnings": {}
                    },
                    "kpis": {
                        "sample_count": 420, "brand_count": 78,
                        "average_price_usd": 32.5, "total_monthly_sales": 12500,
                        "total_monthly_revenue_usd": 406250.0, "amazon_share": 0.18
                    },
                    "advanced_metrics": {
                        "brand_monopoly": {"risk_level": "medium"},
                        "market_growth": {"growth_tier": "fast_growing"}
                    }
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .category_research_overview(7, Some("refined"), None)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.dataset.id, 7);
        assert_eq!(resp.kpis.sample_count, 420);
        assert_eq!(resp.advanced_metrics.brand_monopoly.risk_level, "medium");
        assert_eq!(
            resp.advanced_metrics.market_growth.growth_tier,
            "fast_growing"
        );
    }

    /// mock HTTP：market-trend 请求携带 months=24；响应按 MarketTrendResponse 解析
    #[tokio::test]
    async fn market_trend_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/category-research/datasets/7/market-trend")
            .match_query(Matcher::AllOf(vec![Matcher::UrlEncoded(
                "months".into(),
                "24".into(),
            )]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "dataset_id": 7, "months": 24,
                    "points": [
                        {"year_month": "2024-09", "monthly_sales": 8500},
                        {"year_month": "2024-10", "monthly_sales": 9100}
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .category_research_market_trend(7, 24)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.points.len(), 2);
        assert_eq!(resp.points[0].year_month, "2024-09");
        assert_eq!(resp.points[1].monthly_sales, 9100);
    }

    /// mock HTTP：products 分页请求携带 page + page_size + 可选 brand 筛选
    #[tokio::test]
    async fn products_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/category-research/datasets/7/products")
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "100".into()),
                Matcher::UrlEncoded("brand".into(), "Gaiam".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "dataset_id": 7, "page": 1, "page_size": 100, "has_next": false,
                    "rows": [
                        {
                            "id": 9001, "source_row_no": 1,
                            "asin": "B0TEST123", "brand": "Gaiam",
                            "monthly_sales": 120, "is_amazon": false, "is_new_90d": false
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .category_research_products(7, 1, 100, Some("Gaiam"), None, None)
            .await
            .expect("请求失败");
        m.assert();
        assert!(!resp.has_next);
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].asin.as_deref(), Some("B0TEST123"));
        assert_eq!(resp.rows[0].brand.as_deref(), Some("Gaiam"));
    }

    /// mock HTTP：单数据集重算 POST 无请求体；响应按 RecomputeResponse 解析
    #[tokio::test]
    async fn dataset_recompute_posts_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/v1/category-research/datasets/7/recompute")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "dataset_id": 7, "row_count_products": 420,
                    "row_count_trends": 1680, "quality_warnings": {}
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .category_research_recompute_dataset(7)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.dataset_id, 7);
        assert_eq!(resp.row_count_products, 420);
    }

    /// mock HTTP：批量重算 POST 携带 marketplace 过滤；响应按 BatchRecomputeResponse 解析
    #[tokio::test]
    async fn batch_recompute_posts_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", BATCH_RECOMPUTE_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("marketplace".into(), "US".into()),
                Matcher::UrlEncoded("include_history".into(), "true".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "matched": 5, "recomputed": 4, "dataset_ids": [7, 6, 5, 4]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .category_research_recompute_batch(Some("US"), None, Some(true))
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.matched, 5);
        assert_eq!(resp.recomputed, 4);
    }

    /// 服务端 404（如 dataset 不存在）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn overview_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/category-research/datasets/999")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Dataset not found"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .category_research_overview(999, None, None)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(404));
        assert_eq!(err.user_message(), "Dataset not found");
    }
}
