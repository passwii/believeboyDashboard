//! 报表中心 → 订单信息 API（P5-4，BLF-731）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/order_info.py`，
//! 与 frontend `app/dashboard/reports/order-info/page.tsx` 的
//! `fetchData` / `ensureFilterOptions` / `handleExport` URLSearchParams
//! 口径一致：
//! - `GET /api/v1/order-info/overview?page&page_size&sort_by&sort_dir[&project_ids]*[&fulfillment_channels]*[&order_statuses]*[&countries]*[&currencies]*[&sku_keyword][&order_id_keyword][&asin_keyword][&date_from][&date_to]`
//!   → 列表 + 统计一次返回（web 端 BEL-422 后的单请求口径，`page_size` 默认 50）；
//! - `GET /api/v1/order-info/filter-options` → 筛选下拉选项
//!   （web 端按需懒加载；GUI 首屏后台并行拉取，不阻塞列表）；
//! - `POST /api/v1/order-info/export` → CSV 导出（base64；GUI 视图暂不接导出链路，
//!   客户端方法随模块一并提供，对齐 web 契约）；
//! - `PATCH /api/v1/order-info/{id}` → FBM 补录编辑（carrier / tracking_no /
//!   shipped_at / updated_by；GUI 视图暂不接写入，对齐 BLF-726 发货管理
//!   「写入走 web 端」取舍）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头（backend 侧按 `X-Operator` / `X-Is-Admin` 做
//! 项目可见性过滤）；生产后端 dashboard 路由另需 `Authorization: Bearer`
//! api_key（BLF-711，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::order_info::{
    OrderInfoExportResponse, OrderInfoFilterOptions, OrderInfoItem, OrderInfoOverview,
};
use serde::Serialize;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/order-info/overview` —— 列表 + 统计
pub(crate) const OVERVIEW_PATH: &str = "/api/v1/order-info/overview";

/// `GET /api/v1/order-info/filter-options` —— 筛选下拉选项
pub(crate) const FILTER_OPTIONS_PATH: &str = "/api/v1/order-info/filter-options";

/// `POST /api/v1/order-info/export` —— CSV 导出
pub(crate) const EXPORT_PATH: &str = "/api/v1/order-info/export";

/// `PATCH /api/v1/order-info/{id}` —— FBM 补录编辑（前缀 + id 拼接）
pub(crate) const ITEM_PATH_PREFIX: &str = "/api/v1/order-info";

/// 订单信息共享筛选（overview / export 同口径，对齐 frontend `buildQuery` /
/// `handleExport` 的组装：空条件不携带）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderInfoFilter {
    /// 店铺过滤（空 = 全部店铺；backend `project_ids: list[int]` 重复参数）
    pub project_ids: Vec<i64>,
    /// 订单类型（空 = 全部；`Amazon` = FBA / `Merchant` = FBM，重复参数）
    pub fulfillment_channels: Vec<String>,
    /// 订单状态（空 = 全部；重复参数）
    pub order_statuses: Vec<String>,
    /// 国家（空 = 全部；重复参数）
    pub countries: Vec<String>,
    /// 币种（空 = 全部；重复参数）
    pub currencies: Vec<String>,
    /// SKU 关键字
    pub sku_keyword: Option<String>,
    /// 订单号关键字
    pub order_id_keyword: Option<String>,
    /// ASIN 关键字
    pub asin_keyword: Option<String>,
    /// 下单日期起（PT 日期，闭区间）
    pub date_from: Option<NaiveDate>,
    /// 下单日期止（PT 日期，闭区间）
    pub date_to: Option<NaiveDate>,
}

impl OrderInfoFilter {
    /// 组装共享筛选参数（顺序稳定，便于 mockito 逐参断言；多值重复携带）
    pub fn base_query(&self) -> QueryBuilder {
        let mut query = QueryBuilder::new();
        for project_id in &self.project_ids {
            query = query.with("project_ids", project_id);
        }
        for channel in &self.fulfillment_channels {
            query = query.with("fulfillment_channels", channel);
        }
        for status in &self.order_statuses {
            query = query.with("order_statuses", status);
        }
        for country in &self.countries {
            query = query.with("countries", country);
        }
        for currency in &self.currencies {
            query = query.with("currencies", currency);
        }
        query
            .with_opt("sku_keyword", self.sku_keyword.as_deref())
            .with_opt("order_id_keyword", self.order_id_keyword.as_deref())
            .with_opt("asin_keyword", self.asin_keyword.as_deref())
            .with_opt_date("date_from", self.date_from)
            .with_opt_date("date_to", self.date_to)
    }
}

/// `POST /api/v1/order-info/export` 请求体（backend `OrderInfoExportRequest` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OrderInfoExportRequest {
    #[serde(default)]
    pub project_ids: Vec<i64>,
    #[serde(default)]
    pub fulfillment_channels: Vec<String>,
    #[serde(default)]
    pub order_statuses: Vec<String>,
    #[serde(default)]
    pub countries: Vec<String>,
    #[serde(default)]
    pub currencies: Vec<String>,
    pub sku_keyword: Option<String>,
    pub order_id_keyword: Option<String>,
    pub asin_keyword: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
}

impl OrderInfoExportRequest {
    /// 从共享筛选构造（对齐 frontend `handleExport`：日期转 `YYYY-MM-DD` 字符串）
    pub fn from_filter(filter: &OrderInfoFilter) -> Self {
        Self {
            project_ids: filter.project_ids.clone(),
            fulfillment_channels: filter.fulfillment_channels.clone(),
            order_statuses: filter.order_statuses.clone(),
            countries: filter.countries.clone(),
            currencies: filter.currencies.clone(),
            sku_keyword: filter.sku_keyword.clone().filter(|s| !s.is_empty()),
            order_id_keyword: filter.order_id_keyword.clone().filter(|s| !s.is_empty()),
            asin_keyword: filter.asin_keyword.clone().filter(|s| !s.is_empty()),
            date_from: filter.date_from.map(|d| d.to_string()),
            date_to: filter.date_to.map(|d| d.to_string()),
        }
    }
}

/// FBM 补录编辑请求体（backend `OrderInfoUpdate` 1:1；所有字段可选，
/// 未传入则不改；`None` 与缺省语义由 `skip_serializing_if` 区分）
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OrderInfoUpdatePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carrier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_no: Option<String>,
    /// ISO8601（web 端传北京时间当天 UTC 零点）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shipped_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

impl Client {
    /// 列表 + 统计（对齐 frontend `fetchData` 单请求口径）：
    /// - `page` / `page_size`：分页（web 端固定 `page_size=50`）；
    /// - `sort_by` / `sort_dir`：服务端排序（web 端默认
    ///   `purchase_at_pt` + `desc`；GUI 表格内数量/金额排序走 DataTable 客户端排序，
    ///   服务端排序保持默认）；
    /// - 其余筛选经 [`OrderInfoFilter`] 携带（空条件不携带）。
    pub async fn order_info_overview(
        &self,
        filter: &OrderInfoFilter,
        page: i64,
        page_size: i64,
    ) -> Result<OrderInfoOverview, ApiError> {
        let query = filter
            .base_query()
            .with("page", page)
            .with("page_size", page_size)
            .with("sort_by", "purchase_at_pt")
            .with("sort_dir", "desc");
        self.get_json(OVERVIEW_PATH, &query.clone().into_pairs())
            .await
    }

    /// 筛选下拉选项（对齐 frontend `ensureFilterOptions`；大表 distinct 全表扫
    /// 较慢，GUI 后台并行拉取不阻塞列表）
    pub async fn order_info_filter_options(&self) -> Result<OrderInfoFilterOptions, ApiError> {
        self.get_json(FILTER_OPTIONS_PATH, &[]).await
    }

    /// CSV 导出（对齐 frontend `handleExport`；返回 base64 编码 CSV）
    pub async fn order_info_export(
        &self,
        filter: &OrderInfoFilter,
    ) -> Result<OrderInfoExportResponse, ApiError> {
        let body = OrderInfoExportRequest::from_filter(filter);
        self.request_json(reqwest::Method::POST, EXPORT_PATH, &[], Some(&body))
            .await
    }

    /// FBM 补录编辑（对齐 frontend `OrderEditDialog.handleSubmit` 的 PATCH；
    /// 返回更新后的整条订单）
    pub async fn order_info_update(
        &self,
        order_id: i64,
        payload: &OrderInfoUpdatePayload,
    ) -> Result<OrderInfoItem, ApiError> {
        let path = format!("{ITEM_PATH_PREFIX}/{order_id}");
        self.request_json(reqwest::Method::PATCH, &path, &[], Some(payload))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 shipment_schedules.rs 同款）
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

    fn sample_filter() -> OrderInfoFilter {
        OrderInfoFilter {
            project_ids: vec![3],
            fulfillment_channels: vec!["Amazon".into()],
            order_statuses: vec!["Shipped".into()],
            countries: vec!["US".into()],
            currencies: vec!["USD".into()],
            sku_keyword: Some("JDB-4341".into()),
            order_id_keyword: None,
            asin_keyword: Some("B0C12345".into()),
            date_from: Some(NaiveDate::from_ymd_opt(2026, 8, 14).expect("合法日期")),
            date_to: Some(NaiveDate::from_ymd_opt(2026, 8, 20).expect("合法日期")),
        }
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(OVERVIEW_PATH, "/api/v1/order-info/overview");
        assert_eq!(FILTER_OPTIONS_PATH, "/api/v1/order-info/filter-options");
        assert_eq!(EXPORT_PATH, "/api/v1/order-info/export");
        assert_eq!(ITEM_PATH_PREFIX, "/api/v1/order-info");
    }

    /// 契约：空筛选不携带任何筛选参数（全部走后端默认）
    #[test]
    fn empty_filter_builds_no_filter_params() {
        let filter = OrderInfoFilter::default();
        assert!(filter.base_query().is_empty());
    }

    /// 契约：导出请求体从共享筛选构造（日期转 YYYY-MM-DD；空关键字落 None）
    #[test]
    fn export_request_from_filter_maps_fields() {
        let req = OrderInfoExportRequest::from_filter(&sample_filter());
        assert_eq!(req.project_ids, vec![3]);
        assert_eq!(req.fulfillment_channels, vec!["Amazon".to_string()]);
        assert_eq!(req.sku_keyword.as_deref(), Some("JDB-4341"));
        assert_eq!(req.order_id_keyword, None);
        assert_eq!(req.date_from.as_deref(), Some("2026-08-14"));
        assert_eq!(req.date_to.as_deref(), Some("2026-08-20"));

        let empty = OrderInfoExportRequest::from_filter(&OrderInfoFilter::default());
        assert!(empty.project_ids.is_empty());
        assert_eq!(empty.sku_keyword, None);
        assert_eq!(empty.date_from, None);
    }

    /// mock HTTP：overview 请求携带分页 + 全部筛选参数 + 会话头；响应按
    /// `OrderInfoOverview` 解析（items + stats）
    #[tokio::test]
    async fn overview_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", OVERVIEW_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_ids".into(), "3".into()),
                Matcher::UrlEncoded("fulfillment_channels".into(), "Amazon".into()),
                Matcher::UrlEncoded("order_statuses".into(), "Shipped".into()),
                Matcher::UrlEncoded("countries".into(), "US".into()),
                Matcher::UrlEncoded("currencies".into(), "USD".into()),
                Matcher::UrlEncoded("sku_keyword".into(), "JDB-4341".into()),
                Matcher::UrlEncoded("asin_keyword".into(), "B0C12345".into()),
                Matcher::UrlEncoded("date_from".into(), "2026-08-14".into()),
                Matcher::UrlEncoded("date_to".into(), "2026-08-20".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "50".into()),
                Matcher::UrlEncoded("sort_by".into(), "purchase_at_pt".into()),
                Matcher::UrlEncoded("sort_dir".into(), "desc".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
                            "id": 11, "project_id": 3, "project_name": "测试店铺",
                            "brand_name": "BrandX", "source_file_id": 9,
                            "purchase_at_utc": "2026-08-20T06:23:00+00:00",
                            "purchase_at_pt": "2026-08-19T23:23:00",
                            "purchase_date_pt": "2026-08-19",
                            "amazon_order_id": "111-3084457-2750632",
                            "order_status": "Shipped",
                            "fulfillment_channel": "Amazon",
                            "fulfillment_label": "FBA（亚马逊配送）",
                            "ship_service_level": "Standard",
                            "sku": "JDB-4341-29PCS", "asin": "B0C12345",
                            "product_name": "测试产品",
                            "quantity": 2, "item_price": 25.98, "shipping_price": 4.99,
                            "currency": "USD", "country": "US",
                            "state": "CA", "city": "Los Angeles", "postal_code": "90001",
                            "is_counted_sales": true,
                            "created_at": "2026-08-21T00:00:00+00:00",
                            "carrier": null, "tracking_no": null,
                            "shipped_at": null, "updated_by": null, "updated_at": null
                        }
                    ],
                    "total": 1, "page": 1, "page_size": 50,
                    "stats": {"total_orders": 1, "total_quantity": 2,
                              "total_amount": 25.98, "currency": "USD",
                              "fba_count": 1, "fbm_count": 0}
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .order_info_overview(&sample_filter(), 1, 50)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].amazon_order_id, "111-3084457-2750632");
        assert_eq!(resp.items[0].shipping_price, 4.99);
        assert!(!resp.items[0].is_fbm());
        assert_eq!(resp.total, 1);
        assert_eq!(resp.stats.fba_count, 1);
    }

    /// mock HTTP：多值筛选 → 重复参数（backend `list[...]` 契约）。
    /// 注：mockito `UrlEncoded` 经 `HashMap` 解析 query，重复 key 无法逐个断言，
    /// 故多值用 Regex 锚定原始 query 串（与 shipment_schedules.rs 同款）。
    #[tokio::test]
    async fn overview_sends_repeated_multi_value_params() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", OVERVIEW_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::Regex("project_ids=3".into()),
                Matcher::Regex("project_ids=7".into()),
                Matcher::Regex("fulfillment_channels=Amazon".into()),
                Matcher::Regex("fulfillment_channels=Merchant".into()),
                Matcher::UrlEncoded("page".into(), "2".into()),
                Matcher::UrlEncoded("page_size".into(), "50".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [], "total": 0, "page": 2, "page_size": 50,
                    "stats": {"total_orders": 0, "total_quantity": 0,
                              "total_amount": 0.0, "currency": null,
                              "fba_count": 0, "fbm_count": 0}}"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = OrderInfoFilter {
            project_ids: vec![3, 7],
            fulfillment_channels: vec!["Amazon".into(), "Merchant".into()],
            ..OrderInfoFilter::default()
        };
        let resp = client
            .order_info_overview(&filter, 2, 50)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.stats.total_orders, 0);
    }

    /// mock HTTP：filter-options 解析（五组下拉选项）
    #[tokio::test]
    async fn filter_options_parses_all_groups() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", FILTER_OPTIONS_PATH)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "projects": [{"value": "3", "label": "测试店铺"}],
                    "order_statuses": [{"value": "Shipped", "label": "Shipped"}],
                    "fulfillment_channels": [{"value": "Amazon", "label": "Amazon"}],
                    "countries": [{"value": "US", "label": "US"}],
                    "currencies": [{"value": "USD", "label": "USD"}]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let options = client.order_info_filter_options().await.expect("请求失败");
        m.assert();
        assert_eq!(options.projects.len(), 1);
        assert_eq!(options.projects[0].value, "3");
        assert_eq!(options.order_statuses[0].value, "Shipped");
        assert_eq!(options.currencies[0].label, "USD");
    }

    /// mock HTTP：export POST 携带 JSON body；响应解析 base64 CSV
    #[tokio::test]
    async fn export_posts_body_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", EXPORT_PATH)
            .match_body(Matcher::PartialJson(serde_json::json!({
                "project_ids": [3],
                "sku_keyword": "JDB-4341",
                "date_from": "2026-08-14",
                "date_to": "2026-08-20"
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "filename": "订单信息_2026-08-21.csv",
                    "content_type": "text/csv; charset=utf-8",
                    "content_base64": "aWQsYW1hem9uX29yZGVyX2lk"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .order_info_export(&sample_filter())
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.filename, "订单信息_2026-08-21.csv");
        assert_eq!(resp.content_base64, "aWQsYW1hem9uX29yZGVyX2lk");
    }

    /// mock HTTP：PATCH 携带增量 body；响应返回更新后的整条订单
    #[tokio::test]
    async fn update_patches_and_parses_updated_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("PATCH", "/api/v1/order-info/11")
            .match_body(Matcher::PartialJson(serde_json::json!({
                "carrier": "UPS",
                "tracking_no": "1Z999AA10123456784",
                "updated_by": "测试运营"
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 11, "project_id": 3, "project_name": "测试店铺",
                    "source_file_id": 9,
                    "purchase_at_utc": "2026-08-20T06:23:00+00:00",
                    "purchase_at_pt": "2026-08-19T23:23:00",
                    "purchase_date_pt": "2026-08-19",
                    "amazon_order_id": "111-3084457-2750632",
                    "order_status": "Shipped",
                    "fulfillment_channel": "Merchant",
                    "fulfillment_label": "FBM（自发货配送）",
                    "quantity": 2, "item_price": 25.98, "shipping_price": 0.0,
                    "currency": "USD", "country": "US", "is_counted_sales": true,
                    "created_at": "2026-08-21T00:00:00+00:00",
                    "carrier": "UPS", "tracking_no": "1Z999AA10123456784",
                    "shipped_at": "2026-08-20T00:00:00+00:00",
                    "updated_by": "测试运营",
                    "updated_at": "2026-08-21T08:00:00+00:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let payload = OrderInfoUpdatePayload {
            carrier: Some("UPS".into()),
            tracking_no: Some("1Z999AA10123456784".into()),
            updated_by: Some("测试运营".into()),
            ..OrderInfoUpdatePayload::default()
        };
        let updated = client
            .order_info_update(11, &payload)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(updated.carrier.as_deref(), Some("UPS"));
        assert!(updated.is_fbm());
        assert_eq!(updated.updated_by.as_deref(), Some("测试运营"));
    }

    /// 服务端 401（非 admin 缺 X-Operator 等）→ 透传错误消息（视图错误态提示）
    #[tokio::test]
    async fn overview_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", OVERVIEW_PATH)
            .match_query(Matcher::Any)
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"缺少 X-Operator 头，请重新登录后重试"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .order_info_overview(&OrderInfoFilter::default(), 1, 50)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(401));
        assert_eq!(err.user_message(), "缺少 X-Operator 头，请重新登录后重试");
    }
}
