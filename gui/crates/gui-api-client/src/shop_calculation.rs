//! 报表中心 → 店铺测算 API（P5-4，BLF-729）
//!
//! 端点对齐 backend：
//! - `GET /api/v1/sku-info` → SKU 档案分页（web 蓝本按 project_name + country
//!   + is_active=true 拉 200 条；`include_total=true`）；
//! - `GET /api/v1/shop-calculation` → 店铺测算「当前态」列表（每 SKU 最新有效
//!   行，软删过滤；project_id + country 筛选）；
//! - `POST /api/v1/shop-calculation` → 追加店铺测算记录（append-only，
//!   BEL-378；201 Created）。
//!
//! 不接（范围边界，对齐 web 店铺测算页口径取舍）：
//! - `GET /shop-calculation/history`：append-only 全历史时间线（web 页未调）；
//! - `DELETE /shop-calculation/{id}`：web 页未调用；
//! - `/pricing-calculation-snapshots/*` 定价历史快照 CRUD（GUI 首版不接，
//!   取舍见视图头注释）。
//!
//! 鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；backend 路由 `Depends(protected)` 校验会话。

use gui_domain::operations::shop_calculation::{
    ShopCalculationCreateRequest, ShopCalculationItem, ShopCalculationListResponse, SkuRecordsPage,
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /api/v1/sku-info` —— SKU 档案分页
pub(crate) const SKU_LIST_PATH: &str = "/api/v1/sku-info";

/// `GET|POST /api/v1/shop-calculation` —— 店铺测算当前态列表 / 追加记录
pub(crate) const SHOP_CALCULATION_PATH: &str = "/api/v1/shop-calculation";

impl Client {
    /// SKU 档案分页（对齐 web 实时模式：project_name + country + is_active
    /// 必带，page/page_size 固定 1/200，include_total=true）
    pub async fn list_sku_records(
        &self,
        project_name: &str,
        country: &str,
        page: usize,
        page_size: usize,
    ) -> Result<SkuRecordsPage, ApiError> {
        let query = [
            ("project_name", project_name.to_string()),
            ("country", country.to_string()),
            ("is_active", "true".to_string()),
            ("page", page.to_string()),
            ("page_size", page_size.to_string()),
            ("include_total", "true".to_string()),
        ];
        self.get_json(SKU_LIST_PATH, &query).await
    }

    /// 店铺测算「当前态」列表（每 SKU 最新有效行；对齐 web
    /// `?project_id=&country=&page=1&page_size=200` 口径）
    pub async fn list_shop_calculations(
        &self,
        project_id: i64,
        country: &str,
        page: usize,
        page_size: usize,
    ) -> Result<ShopCalculationListResponse, ApiError> {
        let query = [
            ("project_id", project_id.to_string()),
            ("country", country.to_string()),
            ("page", page.to_string()),
            ("page_size", page_size.to_string()),
        ];
        self.get_json(SHOP_CALCULATION_PATH, &query).await
    }

    /// 追加店铺测算记录（backend append-only，201 Created；失败由调用方
    /// 降级为非致命提示——测算结果仍保留在会话内，对齐 web console.warn）
    pub async fn save_shop_calculation(
        &self,
        payload: &ShopCalculationCreateRequest,
    ) -> Result<ShopCalculationItem, ApiError> {
        self.request_json(reqwest::Method::POST, SHOP_CALCULATION_PATH, &[], Some(payload))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::operations::new_product_calculation::InboundPlacementMode;
    use mockito::Matcher;

    /// 构造一个带会话的 client（与 pricing_calculation.rs 同款）
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

    /// 最小完整 shop-calculation 记录体（四嵌套块齐全）
    fn shop_item_body(id: i64, sku: &str) -> String {
        format!(
            r#"{{
                "id": {id},
                "project_id": 3,
                "project_name": "测试项目 A",
                "sku": "{sku}",
                "asin": "B0TEST01",
                "country": "US",
                "accounting_type": "profit_calc",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
                "ddp_cost_rmb": 106.3,
                "ddp_cost_usd": 14.87,
                "sale_price_usd": 29.99,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination",
                "usd_to_rmb_rate": 7.15,
                "usd_to_rmb_rate_source": "system",
                "size_tier": "standard",
                "size_tier_label": "标准尺寸",
                "price_band": "20_50",
                "price_band_label": "$20-$50",
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
                "observed_at": "2026-08-22T08:00:00Z",
                "source": "manual",
                "created_at": "2026-08-22T08:00:00Z",
                "updated_at": "2026-08-22T08:00:00Z"
            }}"#
        )
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn shop_paths_match_backend_routes() {
        assert_eq!(SKU_LIST_PATH, "/api/v1/sku-info");
        assert_eq!(SHOP_CALCULATION_PATH, "/api/v1/shop-calculation");
    }

    /// mock HTTP：SKU 列表带全量 query（project_name / country / is_active /
    /// 分页 / include_total）；会话身份头携带
    #[tokio::test]
    async fn list_sku_records_sends_params_and_parses_page() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SKU_LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_name".into(), "测试项目 A".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("is_active".into(), "true".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "200".into()),
                Matcher::UrlEncoded("include_total".into(), "true".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(format!(
                r#"{{"items": [{}], "page": 1, "page_size": 200, "total": 1, "has_next": false}}"#,
                r#"{
                    "id": 11, "project_name": "测试项目 A", "sku": "BB-US-001",
                    "asin": "B0TEST01", "fob_unit_cost": 45.0,
                    "first_leg_cost_rmb": 8.5, "package_length_cm": 30.0,
                    "package_width_cm": 20.0, "package_height_cm": 10.0,
                    "weight_kg": 1.2, "currency": "USD", "country": "US",
                    "sort_order": 0, "is_active": true
                }"#
            ))
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_sku_records("测试项目 A", "US", 1, 200)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, Some(1));
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].sku, "BB-US-001");
        assert_eq!(resp.items[0].fob_unit_cost, 45.0);
    }

    /// mock HTTP：店铺测算当前态列表按 project_id + country 筛选解析
    #[tokio::test]
    async fn list_shop_calculations_parses_items() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SHOP_CALCULATION_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "200".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(format!(
                r#"{{"items": [{}], "total": 1, "page": 1, "page_size": 200}}"#,
                shop_item_body(21, "BB-DE-001")
            ))
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_shop_calculations(3, "DE", 1, 200)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items[0].id, 21);
        assert_eq!(resp.items[0].sku, "BB-DE-001");
    }

    /// mock HTTP：追加记录 POST 全量请求体（EU 扩展字段携带）→ 201 + 记录回包
    #[tokio::test]
    async fn save_shop_calculation_posts_payload_and_parses_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", SHOP_CALCULATION_PATH)
            // PartialJson：载荷 50+ 字段，只锁业务关键列（EU 扩展字段 + 归属 +
            // append-only 固定口径），其余数值列由 domain 层 serde 测试覆盖
            .match_body(Matcher::PartialJson(serde_json::json!({
                "project_id": 3,
                "project_name": "测试项目 A",
                "sku": "BB-DE-001",
                "country": "DE",
                "accounting_type": "eu_accounting",
                "storage_months": 1.0,
                "inbound_placement_mode": "single_destination",
                "usd_to_rmb_rate_source": "",
                "delivery_fee_usd": 3.2,
                "inbound_config_fee_manual_usd": 0.3,
                "storage_fee_manual_usd": 0.1,
                "platform_fee_usd": 4.5,
                "vat_usd": 4.84
            })))
            .match_header("X-Session-Id", "sess_1")
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(shop_item_body(21, "BB-DE-001"))
            .create();

        let client = session_client(&server.url());
        let item = client
            .save_shop_calculation(&eu_payload())
            .await
            .expect("保存失败");
        m.assert();
        assert_eq!(item.id, 21);
        assert_eq!(item.sku, "BB-DE-001");
    }

    /// mock HTTP：追加记录 500 → detail 透传（调用方降级为非致命提示）
    #[tokio::test]
    async fn save_shop_calculation_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", SHOP_CALCULATION_PATH)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"保存店铺测算失败"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .save_shop_calculation(&eu_payload())
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(500));
        assert_eq!(err.user_message(), "保存店铺测算失败");
    }

    /// EU 保存载荷样本（与上一测试的请求体断言同口径）
    fn eu_payload() -> ShopCalculationCreateRequest {
        ShopCalculationCreateRequest {
            project_id: 3,
            project_name: "测试项目 A".into(),
            sku: "BB-DE-001".into(),
            asin: None,
            country: Some("DE".into()),
            accounting_type: "eu_accounting".into(),
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            ddp_cost_rmb: 106.3,
            ddp_cost_usd: 14.87,
            sale_price_usd: 29.99,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            usd_to_rmb_rate: 7.15,
            usd_to_rmb_rate_source: String::new(),
            size_tier: "standard".into(),
            size_tier_label: "标准尺寸".into(),
            price_band: "20_50".into(),
            price_band_label: "$20-$50".into(),
            fulfillment_fee_rule_label: "FBA 标准".into(),
            inbound_config_fee_rule_label: "入库配置".into(),
            storage_fee_rule_label: "仓储规则".into(),
            longest_side_in: 11.81,
            middle_side_in: 7.87,
            shortest_side_in: 3.94,
            length_plus_girth_in: 35.43,
            volume_cubic_in: 366.14,
            volume_cubic_ft: 0.21,
            product_weight_lb: 2.65,
            product_weight_oz: 42.33,
            dimensional_weight_lb: 1.27,
            chargeable_weight_lb: 2.65,
            chargeable_weight_oz: 42.33,
            chargeable_weight_rule: "取大".into(),
            referral_fee_usd: 4.5,
            advertising_fee_usd: 3.6,
            return_loss_usd: 1.2,
            fba_fulfillment_fee_usd: 5.4,
            inbound_config_fee_usd: 0.3,
            storage_fee_usd: 0.1,
            total_fee_usd: 15.1,
            delivery_fee_usd: 3.2,
            inbound_config_fee_manual_usd: 0.3,
            storage_fee_manual_usd: 0.1,
            platform_fee_usd: 4.5,
            payout_usd: 25.49,
            profit_usd: 10.62,
            profit_rate: 0.354,
            vat_usd: 4.84,
            profit_after_vat_usd: None,
            profit_after_vat_rate: None,
            warnings: vec![],
        }
    }
}
