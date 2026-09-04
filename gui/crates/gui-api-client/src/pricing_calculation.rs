//! 报表中心 → 新品核算 API（P5-4，BLF-728）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/pricing_calculation.py`，
//! 与 frontend `app/dashboard/reports/pricing-calculation/new-product/
//! new-product-client.tsx` 的调用口径一致：
//! - `GET /api/v1/pricing-calculation/runs` → 测算记录分页列表
//!   （page / page_size / keyword；`exclude_project_id` 走 backend 默认 true，
//!   只返回新品核算记录——对齐 web `loadRuns` 不带该参数的行为）；
//! - `POST /api/v1/pricing-calculation/quote` → 利润核算（输入售价 → 利润）；
//! - `POST /api/v1/pricing-calculation/reverse-quote` → 利润倒算
//!   （输入目标利润率 → 建议售价）；
//! - `POST /api/v1/pricing-calculation/reverse-cost` → 成本倒推
//!   （输入售价 + 目标利润率 → 最高可承受成本）；
//! - `POST /api/v1/pricing-calculation/fbm-quote` → FBM 测算
//!   （整柜头程 + 配送费口径）；
//! - `DELETE /api/v1/pricing-calculation/runs/{run_id}` → 删除测算记录（204）。
//!
//! 不接（范围边界，对齐 web 新品核算页口径）：
//! - `eu-quote`：欧洲店铺 SKU 核算专用（店铺测算板块，另一棒）；
//! - `runs/{run_id}/recalculate`：web 新品页未调用；
//! - `new-product-calculations` 快照端点：店铺测算 tab 专用（另一棒）。
//!
//! 鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；backend 路由 `Depends(protected)` 校验会话。

use gui_domain::operations::new_product_calculation::{
    PricingCostReverseRequest, PricingFbmQuoteRequest, PricingQuoteRequest,
    PricingReverseQuoteRequest, PricingRunItem, PricingRunListResponse,
};
use gui_domain::operations::shop_calculation::PricingEuQuoteRequest;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /api/v1/pricing-calculation/runs` —— 测算记录分页列表
pub(crate) const RUNS_LIST_PATH: &str = "/api/v1/pricing-calculation/runs";

/// `POST /api/v1/pricing-calculation/quote` —— 利润核算
pub(crate) const QUOTE_PATH: &str = "/api/v1/pricing-calculation/quote";

/// `POST /api/v1/pricing-calculation/reverse-quote` —— 利润倒算
pub(crate) const REVERSE_QUOTE_PATH: &str = "/api/v1/pricing-calculation/reverse-quote";

/// `POST /api/v1/pricing-calculation/reverse-cost` —— 成本倒推
pub(crate) const REVERSE_COST_PATH: &str = "/api/v1/pricing-calculation/reverse-cost";

/// `POST /api/v1/pricing-calculation/fbm-quote` —— FBM 测算
pub(crate) const FBM_QUOTE_PATH: &str = "/api/v1/pricing-calculation/fbm-quote";

/// `POST /api/v1/pricing-calculation/eu-quote` —— 欧洲（DE/UK）店铺 SKU 核算
/// （BLF-729 店铺测算板块；新品核算不接）
pub(crate) const EU_QUOTE_PATH: &str = "/api/v1/pricing-calculation/eu-quote";

/// `DELETE /api/v1/pricing-calculation/runs/{run_id}` —— 删除测算记录
pub(crate) fn run_delete_path(run_id: i64) -> String {
    format!("/api/v1/pricing-calculation/runs/{run_id}")
}

impl Client {
    /// 测算记录分页列表（对齐 web `loadRuns`：page / page_size 必填，
    /// keyword 为空不带——backend 按产品名 / 创建人模糊搜索）。
    ///
    /// `exclude_project_id` 不传（backend 默认 true：排除店铺核算记录，
    /// 只返回新品核算）——与 web 行为一致。
    pub async fn list_pricing_runs(
        &self,
        page: usize,
        page_size: usize,
        keyword: Option<&str>,
    ) -> Result<PricingRunListResponse, ApiError> {
        let mut query: Vec<(&str, String)> = vec![
            ("page", page.to_string()),
            ("page_size", page_size.to_string()),
        ];
        let trimmed = keyword.map(str::trim).filter(|k| !k.is_empty());
        if let Some(k) = trimmed {
            query.push(("keyword", k.to_string()));
        }
        self.get_json(RUNS_LIST_PATH, &query).await
    }

    /// 删除测算记录（backend 204 No Content；走 `request_discard` 管线）。
    /// 非管理员只能删自己创建的记录（backend `delete_pricing_run` 权限校验，
    /// 越权 403 → `user_message` 透传 detail）。
    pub async fn delete_pricing_run(&self, run_id: i64) -> Result<(), ApiError> {
        self.request_discard::<()>(reqwest::Method::DELETE, &run_delete_path(run_id), &[], None)
            .await
    }

    /// 利润核算（对齐 web `requestPricingCalculation` 的 `profit-calc` 分支：
    /// 售价必带，无目标利润率）
    pub async fn pricing_quote(
        &self,
        body: &PricingQuoteRequest,
    ) -> Result<PricingRunItem, ApiError> {
        self.request_json(reqwest::Method::POST, QUOTE_PATH, &[], Some(body))
            .await
    }

    /// 利润倒算（`profit-reverse` 分支：目标利润率必带，无售价）
    pub async fn pricing_reverse_quote(
        &self,
        body: &PricingReverseQuoteRequest,
    ) -> Result<PricingRunItem, ApiError> {
        self.request_json(reqwest::Method::POST, REVERSE_QUOTE_PATH, &[], Some(body))
            .await
    }

    /// 成本倒推（`cost-reverse` 分支：售价 + 目标利润率必带，无 FOB 成本）
    pub async fn pricing_reverse_cost(
        &self,
        body: &PricingCostReverseRequest,
    ) -> Result<PricingRunItem, ApiError> {
        self.request_json(reqwest::Method::POST, REVERSE_COST_PATH, &[], Some(body))
            .await
    }

    /// FBM 测算（`fbm-calc` 分支：整柜数量 / 整柜价格 / 配送费必带；
    /// `first_leg_cost_rmb` = 整柜价格 ÷ 整柜数量，调用方算好传入）
    pub async fn pricing_fbm_quote(
        &self,
        body: &PricingFbmQuoteRequest,
    ) -> Result<PricingRunItem, ApiError> {
        self.request_json(reqwest::Method::POST, FBM_QUOTE_PATH, &[], Some(body))
            .await
    }

    /// 欧洲店铺 SKU 核算（BLF-729：DE/UK 站；配送 / 配置 / 仓储三费手动
    /// 填写口径，响应与 quote 同为 PricingRunItem）
    pub async fn pricing_eu_quote(
        &self,
        body: &PricingEuQuoteRequest,
    ) -> Result<PricingRunItem, ApiError> {
        self.request_json(reqwest::Method::POST, EU_QUOTE_PATH, &[], Some(body))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::operations::new_product_calculation::{CalculationType, InboundPlacementMode};
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 product_analysis.rs 同款）
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

    /// 最小完整 run 响应体（四嵌套块齐全；供各 quote 测试复用）
    fn run_response_body(id: i64, calculation_type: &str) -> String {
        format!(
            r#"{{
                "id": {id},
                "country": "US",
                "product_name": "桌面置物架",
                "calculation_type": "{calculation_type}",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
                "sale_price_usd": 29.99,
                "commission_rate": 0.15,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination",
                "size_tier": "standard",
                "size_tier_label": "标准尺寸",
                "price_band": "20_50",
                "price_band_label": "$20-$50",
                "usd_to_rmb_rate": 7.15,
                "usd_to_rmb_rate_source": "system",
                "fulfillment_fee_rule_label": "FBA 标准",
                "inbound_config_fee_rule_label": "入库配置",
                "storage_fee_rule_label": "仓储规则",
                "dimensions": {{
                    "longest_side_in": 11.81, "middle_side_in": 7.87,
                    "shortest_side_in": 3.94, "length_plus_girth_in": 35.43,
                    "volume_cubic_in": 366.14, "volume_cubic_ft": 0.21
                }},
                "weights": {{
                    "product_weight_lb": 2.65, "product_weight_oz": 42.33,
                    "dimensional_weight_lb": 1.27, "chargeable_weight_lb": 2.65,
                    "chargeable_weight_oz": 42.33, "chargeable_weight_rule": "取大"
                }},
                "fees": {{
                    "referral_fee_usd": 4.5, "advertising_fee_usd": 3.6,
                    "return_loss_usd": 1.2, "fba_fulfillment_fee_usd": 5.4,
                    "inbound_config_fee_usd": 0.3, "storage_fee_usd": 0.1,
                    "total_fee_usd": 15.1
                }},
                "profit": {{
                    "ddp_cost_rmb": 106.3, "ddp_cost_usd": 14.87,
                    "payout_usd": 25.49, "profit_usd": 10.62, "profit_rate": 0.354
                }},
                "warnings": [],
                "created_at": "2026-08-18T10:00:00Z",
                "updated_at": "2026-08-18T10:00:00Z"
            }}"#
        )
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn pricing_paths_match_backend_routes() {
        assert_eq!(RUNS_LIST_PATH, "/api/v1/pricing-calculation/runs");
        assert_eq!(QUOTE_PATH, "/api/v1/pricing-calculation/quote");
        assert_eq!(
            REVERSE_QUOTE_PATH,
            "/api/v1/pricing-calculation/reverse-quote"
        );
        assert_eq!(
            REVERSE_COST_PATH,
            "/api/v1/pricing-calculation/reverse-cost"
        );
        assert_eq!(FBM_QUOTE_PATH, "/api/v1/pricing-calculation/fbm-quote");
        assert_eq!(run_delete_path(42), "/api/v1/pricing-calculation/runs/42");
        assert_eq!(EU_QUOTE_PATH, "/api/v1/pricing-calculation/eu-quote");
    }

    /// mock HTTP：runs 列表带分页 + keyword query；会话身份头携带；
    /// 响应按 PricingRunListResponse 解析
    #[tokio::test]
    async fn list_runs_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", RUNS_LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("page".into(), "2".into()),
                Matcher::UrlEncoded("page_size".into(), "12".into()),
                Matcher::UrlEncoded("keyword".into(), "置物架".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(format!(
                r#"{{"items": [{}], "total": 13, "page": 2, "page_size": 12}}"#,
                run_response_body(7, "profit_calc")
            ))
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_pricing_runs(2, 12, Some("置物架"))
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 13);
        assert_eq!(resp.page, 2);
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].id, 7);
        assert_eq!(resp.items[0].calculation_type, CalculationType::ProfitCalc);
    }

    /// mock HTTP：keyword 为空 / 纯空白时不带 keyword 参数（backend 缺省全量）
    #[tokio::test]
    async fn list_runs_omits_blank_keyword() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", RUNS_LIST_PATH)
            // 硬断言：query 恰为 page / page_size 两参，**不含** keyword
            // （AllOf+UrlEncoded 只断言存在性，检测不到多余参数；regex crate
            // 不支持 lookahead，直接全串精确匹配；参数顺序由 client 拼装保证）
            .match_query(Matcher::Regex(r"^page=1&page_size=12$".into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "total": 0, "page": 1, "page_size": 12}"#)
            .create();

        let client = Client::new(server.url());
        let resp = client
            .list_pricing_runs(1, 12, Some("   "))
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.total, 0);
    }

    /// mock HTTP：列表错误透传（422 / 500 的 detail → user_message）
    #[tokio::test]
    async fn list_runs_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", RUNS_LIST_PATH)
            .match_query(Matcher::Any)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"测算记录加载失败"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .list_pricing_runs(1, 12, None)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(500));
        assert_eq!(err.user_message(), "测算记录加载失败");
    }

    /// mock HTTP：DELETE 204 No Content 成功（request_discard 管线，空体不误报）
    #[tokio::test]
    async fn delete_run_accepts_no_content() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("DELETE", "/api/v1/pricing-calculation/runs/9")
            .match_header("X-User-Id", "u_1")
            .with_status(204)
            .create();

        let client = session_client(&server.url());
        client.delete_pricing_run(9).await.expect("删除失败");
        m.assert();
    }

    /// mock HTTP：DELETE 越权 403 → detail 透传
    #[tokio::test]
    async fn delete_run_propagates_forbidden() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("DELETE", "/api/v1/pricing-calculation/runs/9")
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"只能删除自己创建的测算记录"}"#)
            .create();

        let client = session_client(&server.url());
        let err = client.delete_pricing_run(9).await.expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "只能删除自己创建的测算记录");
    }

    fn base_quote() -> PricingQuoteRequest {
        PricingQuoteRequest {
            country: "US".into(),
            product_name: "桌面置物架".into(),
            competitor_url: Some("https://www.amazon.com/dp/B0TEST".into()),
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            first_leg_unit_price_rmb: Some(5.0),
            sale_price_usd: 29.99,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            usd_to_rmb_rate: None,
            project_id: None,
            sku: None,
            use_historical_shipping_cost: None,
        }
    }

    /// mock HTTP：quote 为 POST + JSON 全量请求体（售价必带、无目标利润率）；
    /// 响应按 PricingRunItem 解析（含嵌套 fees / profit / warnings）
    #[tokio::test]
    async fn quote_posts_body_and_parses_run_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", QUOTE_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "country": "US",
                "product_name": "桌面置物架",
                "competitor_url": "https://www.amazon.com/dp/B0TEST",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
                "first_leg_unit_price_rmb": 5.0,
                "sale_price_usd": 29.99,
                "commission_rate": 0.15,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination"
            })))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(run_response_body(101, "profit_calc"))
            .create();

        let client = session_client(&server.url());
        let run = client.pricing_quote(&base_quote()).await.expect("请求失败");

        m.assert();
        assert_eq!(run.id, 101);
        assert_eq!(run.calculation_type, CalculationType::ProfitCalc);
        assert_eq!(run.fees.total_fee_usd, 15.1);
        assert_eq!(run.profit.profit_rate, 0.354);
        assert_eq!(run.size_tier_label, "标准尺寸");
    }

    /// mock HTTP：reverse-quote 请求体带 target_profit_rate、无 sale_price_usd
    #[tokio::test]
    async fn reverse_quote_posts_target_rate_without_sale_price() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", REVERSE_QUOTE_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "country": "US",
                "product_name": "桌面置物架",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
                "target_profit_rate": 0.25,
                "commission_rate": 0.15,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination"
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(run_response_body(102, "profit_reverse"))
            .create();

        let client = Client::new(server.url());
        let body = PricingReverseQuoteRequest {
            country: "US".into(),
            product_name: "桌面置物架".into(),
            competitor_url: None,
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            first_leg_unit_price_rmb: None,
            target_profit_rate: 0.25,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            usd_to_rmb_rate: None,
        };
        let run = client.pricing_reverse_quote(&body).await.expect("请求失败");
        m.assert();
        assert_eq!(run.calculation_type, CalculationType::ProfitReverse);
    }

    /// mock HTTP：reverse-cost 请求体无 FOB 字段，带售价 + 目标利润率
    #[tokio::test]
    async fn reverse_cost_posts_sale_price_and_target_rate() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", REVERSE_COST_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "country": "US",
                "product_name": "桌面置物架",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "first_leg_cost_rmb": 8.5,
                "sale_price_usd": 29.99,
                "target_profit_rate": 0.25,
                "commission_rate": 0.15,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination"
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(run_response_body(103, "cost_reverse"))
            .create();

        let client = Client::new(server.url());
        let body = PricingCostReverseRequest {
            country: "US".into(),
            product_name: "桌面置物架".into(),
            competitor_url: None,
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            first_leg_cost_rmb: 8.5,
            first_leg_unit_price_rmb: None,
            sale_price_usd: 29.99,
            target_profit_rate: 0.25,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            usd_to_rmb_rate: None,
        };
        let run = client.pricing_reverse_cost(&body).await.expect("请求失败");
        m.assert();
        assert_eq!(run.calculation_type, CalculationType::CostReverse);
    }

    /// mock HTTP：fbm-quote 请求体带整柜数量 / 整柜价格 / 配送费，
    /// first_leg_cost_rmb = 整柜价格 ÷ 整柜数量（调用方算好传入）
    #[tokio::test]
    async fn fbm_quote_posts_full_container_fields() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", FBM_QUOTE_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "country": "US",
                "product_name": "桌面置物架",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
                "full_container_quantity": 1000.0,
                "full_container_price_rmb": 8500.0,
                "delivery_fee_usd": 3.2,
                "sale_price_usd": 29.99,
                "commission_rate": 0.15,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination"
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(run_response_body(104, "fbm_calc"))
            .create();

        let client = Client::new(server.url());
        let body = PricingFbmQuoteRequest {
            country: "US".into(),
            product_name: "桌面置物架".into(),
            competitor_url: None,
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            full_container_quantity: 1000.0,
            full_container_price_rmb: 8500.0,
            delivery_fee_usd: 3.2,
            sale_price_usd: 29.99,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            usd_to_rmb_rate: None,
        };
        let run = client.pricing_fbm_quote(&body).await.expect("请求失败");
        m.assert();
        assert_eq!(run.calculation_type, CalculationType::FbmCalc);
    }

    /// mock HTTP：eu-quote（BLF-729 店铺测算 DE/UK 站）——手动三费 + 项目归属
    /// 字段携带；响应与 quote 同构（PricingRunItem）
    #[tokio::test]
    async fn eu_quote_posts_manual_fees_and_project_fields() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", EU_QUOTE_PATH)
            .match_body(Matcher::Json(serde_json::json!({
                "country": "DE",
                "product_name": "测试项目 / SKU-1",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
                "project_id": 3,
                "sku": "SKU-1",
                "sale_price_usd": 29.99,
                "delivery_fee_usd": 3.2,
                "inbound_config_fee_usd": 0.3,
                "storage_fee_usd": 0.1,
                "commission_rate": 0.15,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(run_response_body(105, "eu_accounting"))
            .create();

        let client = Client::new(server.url());
        let body = PricingEuQuoteRequest {
            country: "DE".into(),
            product_name: "测试项目 / SKU-1".into(),
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            project_id: Some(3),
            sku: Some("SKU-1".into()),
            sale_price_usd: 29.99,
            delivery_fee_usd: 3.2,
            inbound_config_fee_usd: 0.3,
            storage_fee_usd: 0.1,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            usd_to_rmb_rate: None,
        };
        let run = client.pricing_eu_quote(&body).await.expect("请求失败");
        m.assert();
        assert_eq!(run.calculation_type, CalculationType::EuAccounting);
        assert_eq!(run.calculation_type.label(), "欧洲核算");
    }

    /// mock HTTP：quote 422（backend pydantic 校验失败）→ detail 透传
    #[tokio::test]
    async fn quote_propagates_validation_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", QUOTE_PATH)
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"售价必须大于 0"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .pricing_quote(&base_quote())
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "售价必须大于 0");
    }
}
