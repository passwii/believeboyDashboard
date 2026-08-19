//! 运营 → 发货管理 API（P5-3，BLF-726）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/shipment_schedules.py`，
//! 与 frontend `app/dashboard/operations/shipment-management/page.tsx`
//! `loadList` / `loadDetail` / `loadCostSummary` / `loadSkuSummary`
//! URLSearchParams 口径一致：
//! - `GET /api/v1/shipment-schedules?page&page_size&include_total[&project_id][&country][&shipment_status][&shipment_no]*[&created_date_from][&created_date_to]`
//!   → 分页列表（web 端默认 page_size=20 / include_total=true；`shipment_no` 可重复携带多值）；
//! - `GET /api/v1/shipment-schedules/{id}` → 单条详情（含 SKU 明细 items）；
//! - `GET /api/v1/shipment-schedules/cost-summary?[同列表筛选]` → 发货费用汇总
//!   （web 端「发货费用」tab KPI）；
//! - `GET /api/v1/shipment-schedules/sku-summary?[同列表筛选]` → SKU 汇总
//!   （web 端「SKU 汇总」tab）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。
//! backend 侧另按 `X-Operator` / `X-Is-Admin` 做项目可见性过滤（deps
//! `get_request_operator`），由 `Client` 会话头自动携带。
//!
//! 设计取舍（BLF-726）：
//! - **写入端点**（create / update / delete / import-csv / costs/calculate）：
//!   GUI 视图只做读取展示；新建 / 编辑 / 状态流转 / 导入走 web 端
//!   （与 research_analysis 导入、weekly_product_analysis 导出同款取舍）；
//! - **FBA 箱单明细**（`/fba-box-details`）：依赖 R2 图片 / FNSKU 标签下载链路，
//!   属打印/贴标操作面，GUI 暂不接入；
//! - **批次端点**（`/batches` 列表 / 隐藏）：服务 import-csv 批次管理，随写入
//!   端点一并走 web 端。

use chrono::NaiveDate;
use gui_domain::operations::shipment_schedules::{
    ShipmentScheduleCostSummary, ShipmentScheduleDetail, ShipmentScheduleListResponse,
    ShipmentSkuSummaryResponse,
};

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/shipment-schedules` —— 分页列表
pub(crate) const LIST_PATH: &str = "/api/v1/shipment-schedules";

/// `GET /api/v1/shipment-schedules/{id}` —— 详情（前缀 + id 拼接）
pub(crate) const DETAIL_PATH_PREFIX: &str = "/api/v1/shipment-schedules";

/// `GET /api/v1/shipment-schedules/cost-summary` —— 发货费用汇总
pub(crate) const COST_SUMMARY_PATH: &str = "/api/v1/shipment-schedules/cost-summary";

/// `GET /api/v1/shipment-schedules/sku-summary` —— SKU 汇总
pub(crate) const SKU_SUMMARY_PATH: &str = "/api/v1/shipment-schedules/sku-summary";

/// 发货计划共享筛选（列表 / cost-summary / sku-summary 同口径，对齐
/// frontend `loadList` / `loadCostSummary` / `loadSkuSummary` 的 URLSearchParams
/// 组装：空条件不携带）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShipmentScheduleFilter {
    /// 项目过滤（`None` = 全部项目）
    pub project_id: Option<i64>,
    /// 国家过滤（`None` = 全部国家；`US` / `UK` / `DE`）
    pub country: Option<String>,
    /// 状态过滤（`None` = 全部状态；`draft` / `in_transit` / `completed`）
    pub shipment_status: Option<String>,
    /// 货件编号多选（空 = 不过滤；backend `shipment_no: list[str]` 重复参数）
    pub shipment_nos: Vec<String>,
    /// 发货日期起（闭区间，YYYY-MM-DD）
    pub created_date_from: Option<NaiveDate>,
    /// 发货日期止（闭区间，YYYY-MM-DD）
    pub created_date_to: Option<NaiveDate>,
}

impl ShipmentScheduleFilter {
    /// 组装共享筛选参数（顺序稳定，便于 mockito 逐参断言）
    fn base_query(&self) -> QueryBuilder {
        let mut query = QueryBuilder::new()
            .with_opt("project_id", self.project_id)
            .with_opt("country", self.country.as_deref())
            .with_opt("shipment_status", self.shipment_status.as_deref());
        for shipment_no in &self.shipment_nos {
            query = query.with("shipment_no", shipment_no);
        }
        query
            .with_opt_date("created_date_from", self.created_date_from)
            .with_opt_date("created_date_to", self.created_date_to)
    }
}

impl Client {
    /// 分页列表（对齐 frontend `loadList` 口径）：
    /// - `page` / `page_size`：分页（web 端默认 `page_size=20`）；
    /// - `include_total`：true 时返回 `total`（web 端列表固定 true）；
    /// - 其余筛选经 [`ShipmentScheduleFilter`] 携带（空条件不携带）。
    pub async fn shipment_schedule_list(
        &self,
        filter: &ShipmentScheduleFilter,
        page: i64,
        page_size: i64,
        include_total: bool,
    ) -> Result<ShipmentScheduleListResponse, ApiError> {
        let query = filter
            .base_query()
            .with("page", page)
            .with("page_size", page_size)
            .with("include_total", include_total);
        self.get_json(LIST_PATH, &query.clone().into_pairs()).await
    }

    /// 单条详情（含 SKU 明细 items；对齐 frontend `loadDetail`）
    pub async fn shipment_schedule_detail(
        &self,
        schedule_id: i64,
    ) -> Result<ShipmentScheduleDetail, ApiError> {
        let path = format!("{DETAIL_PATH_PREFIX}/{schedule_id}");
        self.get_json(&path, &[]).await
    }

    /// 发货费用汇总（对齐 frontend `loadCostSummary`；筛选与列表同口径）
    pub async fn shipment_schedule_cost_summary(
        &self,
        filter: &ShipmentScheduleFilter,
    ) -> Result<ShipmentScheduleCostSummary, ApiError> {
        let query = filter.base_query();
        self.get_json(COST_SUMMARY_PATH, &query.clone().into_pairs())
            .await
    }

    /// SKU 汇总（对齐 frontend `loadSkuSummary`；筛选与列表同口径）
    pub async fn shipment_schedule_sku_summary(
        &self,
        filter: &ShipmentScheduleFilter,
    ) -> Result<ShipmentSkuSummaryResponse, ApiError> {
        let query = filter.base_query();
        self.get_json(SKU_SUMMARY_PATH, &query.clone().into_pairs())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 research_analysis.rs 同款）
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

    fn sample_filter() -> ShipmentScheduleFilter {
        ShipmentScheduleFilter {
            project_id: Some(3),
            country: Some("US".into()),
            shipment_status: Some("in_transit".into()),
            shipment_nos: Vec::new(),
            created_date_from: Some(NaiveDate::from_ymd_opt(2026, 7, 1).expect("合法日期")),
            created_date_to: Some(NaiveDate::from_ymd_opt(2026, 7, 31).expect("合法日期")),
        }
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(LIST_PATH, "/api/v1/shipment-schedules");
        assert_eq!(DETAIL_PATH_PREFIX, "/api/v1/shipment-schedules");
        assert_eq!(COST_SUMMARY_PATH, "/api/v1/shipment-schedules/cost-summary");
        assert_eq!(SKU_SUMMARY_PATH, "/api/v1/shipment-schedules/sku-summary");
    }

    /// 契约：空筛选不携带任何筛选参数（全部走后端默认）
    #[test]
    fn empty_filter_builds_no_filter_params() {
        let filter = ShipmentScheduleFilter::default();
        let query = filter.base_query();
        assert!(query.is_empty());
    }

    /// mock HTTP：列表请求携带分页 + 全部筛选参数 + 会话头；响应按
    /// `ShipmentScheduleListResponse` 解析（含可空字段）
    #[tokio::test]
    async fn list_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("shipment_status".into(), "in_transit".into()),
                Matcher::UrlEncoded("created_date_from".into(), "2026-07-01".into()),
                Matcher::UrlEncoded("created_date_to".into(), "2026-07-31".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "20".into()),
                Matcher::UrlEncoded("include_total".into(), "true".into()),
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
                            "id": 7, "project_id": 3, "project_name": "测试项目",
                            "country": "US", "shipment_no": "FBA123",
                            "tracking_no": "T-9", "warehouse_code": "ONT8",
                            "forwarder_name": "递四方", "shipping_method": "sea",
                            "created_date": "2026-07-02", "etd_date": "2026-07-05",
                            "eta_date": "2026-08-05", "actual_inbound_date": null,
                            "shipment_status": "in_transit", "remark": null,
                            "sku_count": 2, "total_quantity": 100,
                            "logistics_unit_price": 9.5, "total_volume_m3": 1.2,
                            "total_chargeable_weight_kg": 320.0,
                            "logistics_total_price": 3040.0,
                            "include_in_history_shipping_calc": true,
                            "updated_at": "2026-08-01T00:00:00",
                            "shipment_batch": "B-1"
                        }
                    ],
                    "page": 1, "page_size": 20, "total": 1, "has_next": false
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .shipment_schedule_list(&sample_filter(), 1, 20, true)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].shipment_no, "FBA123");
        assert_eq!(resp.items[0].tracking_no.as_deref(), Some("T-9"));
        assert_eq!(resp.items[0].actual_inbound_date, None);
        assert_eq!(resp.total, Some(1));
        assert!(!resp.has_next);
    }

    /// mock HTTP：`shipment_no` 多选 → 重复参数（backend `list[str]` 契约）。
    /// 注：mockito `UrlEncoded` 经 `HashMap` 解析 query，重复 key 无法逐个断言，
    /// 故多值用 Regex 锚定原始 query 串。
    #[tokio::test]
    async fn list_sends_repeated_shipment_no_params() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::Regex("shipment_no=FBA1".into()),
                Matcher::Regex("shipment_no=FBA2".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "20".into()),
                Matcher::UrlEncoded("include_total".into(), "false".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [], "page": 1, "page_size": 20, "total": null, "has_next": false}"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = ShipmentScheduleFilter {
            shipment_nos: vec!["FBA1".into(), "FBA2".into()],
            ..ShipmentScheduleFilter::default()
        };
        let resp = client
            .shipment_schedule_list(&filter, 1, 20, false)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.total, None);
    }

    /// mock HTTP：详情路径携带 id；响应按 `ShipmentScheduleDetail` 解析
    /// （嵌套 items，缺省数值字段走 Pydantic 默认 0）
    #[tokio::test]
    async fn detail_parses_nested_items() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/shipment-schedules/7")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 7, "project_id": 3, "project_name": "测试项目",
                    "country": "US", "shipment_no": "FBA123", "shipping_method": "sea",
                    "shipment_status": "draft", "sku_count": 1, "total_quantity": 50,
                    "items": [
                        {"id": 11, "sku": "SKU-A", "quantity": 50, "carton_count": 5,
                         "chargeable_weight_kg": 160.0, "estimated_logistics_cost": 1520.0,
                         "average_logistics_unit_price": 9.5}
                    ],
                    "updated_at": "2026-08-01T00:00:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let detail = client.shipment_schedule_detail(7).await.expect("请求失败");
        m.assert();
        assert_eq!(detail.id, 7);
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].sku, "SKU-A");
        assert_eq!(detail.items[0].carton_count, Some(5));
        assert_eq!(detail.items[0].volume_m3, 0.0);
    }

    /// mock HTTP：cost-summary 携带筛选参数；响应按 CostSummary 解析
    #[tokio::test]
    async fn cost_summary_sends_filter_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", COST_SUMMARY_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("shipment_status".into(), "in_transit".into()),
                Matcher::UrlEncoded("created_date_from".into(), "2026-07-01".into()),
                Matcher::UrlEncoded("created_date_to".into(), "2026-07-31".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "shipment_count": 4, "total_sku": 12, "total_quantity": 800,
                    "total_chargeable_weight_kg": 1280.5, "total_logistics_cost": 12164.75
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let summary = client
            .shipment_schedule_cost_summary(&sample_filter())
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(summary.shipment_count, 4);
        assert_eq!(summary.total_sku, 12);
        assert_eq!(summary.total_logistics_cost, 12164.75);
    }

    /// mock HTTP：sku-summary 携带筛选参数；响应按 SkuSummaryResponse 解析
    #[tokio::test]
    async fn sku_summary_sends_filter_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SKU_SUMMARY_PATH)
            .match_query(Matcher::AllOf(vec![Matcher::UrlEncoded(
                "country".into(),
                "DE".into(),
            )]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
                            "project_id": 3, "project_name": "测试项目", "country": "DE",
                            "sku": "SKU-A", "shipment_count": 2, "total_quantity": 100,
                            "total_chargeable_weight_kg": 320.0,
                            "total_logistics_cost": 3040.0,
                            "average_logistics_unit_price": 9.5
                        }
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = ShipmentScheduleFilter {
            country: Some("DE".into()),
            ..ShipmentScheduleFilter::default()
        };
        let resp = client
            .shipment_schedule_sku_summary(&filter)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].sku, "SKU-A");
        assert_eq!(resp.items[0].average_logistics_unit_price, 9.5);
    }

    /// 服务端 404（如货件不存在）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn detail_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/shipment-schedules/999")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Shipment schedule not found"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .shipment_schedule_detail(999)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(404));
        assert_eq!(err.user_message(), "Shipment schedule not found");
    }
}
