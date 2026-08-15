//! 运营 → 库存分析 API（P5-2，BLF-719）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/inventory_replenishment.py`
//! （`/api/v1/inventory-analysis` 与 `/api/v1/inventory-snapshot-options`），
//! 与 frontend `app/dashboard/operations/inventory-analysis/` 的
//! `fetchOpsJsonCached` 调用口径一致：
//! - 库存分析：`GET /api/v1/inventory-analysis?project_id&country[&report_date]`
//!   （`report_date` 缺省 = 最新业务日期；业务日期筛选快照在 web 是 URL search
//!   param，GUI 由视图持有）；
//! - 业务日期快照选项：`GET /api/v1/inventory-snapshot-options?project_id&country`
//!   （web 端 BEL-423 下拉懒加载；GUI 随主数据并行拉取，后端 10min Redis 缓存）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::operations::inventory::{
    InventoryAnalysisResponse, InventorySnapshotOption,
};

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/inventory-analysis` —— 单项目 × 单站点的库存分析（含汇总 / 明细 /
/// 在途 shipment 动态列）
pub(crate) const INVENTORY_ANALYSIS_PATH: &str = "/api/v1/inventory-analysis";

/// `GET /api/v1/inventory-snapshot-options` —— 业务日期快照选项列表
pub(crate) const INVENTORY_SNAPSHOT_OPTIONS_PATH: &str = "/api/v1/inventory-snapshot-options";

impl Client {
    /// 库存分析（对齐 frontend `loadData` 的 URLSearchParams 口径）：
    /// - `project_id`：必填（backend `Query(gt=0)`；视图层在项目列表为空时守卫）；
    /// - `country`：`US` / `DE` / `UK` / `ALL`（backend 默认 `"US"`）；
    /// - `report_date`：`None` = 最新业务日期（不携带参数）；`Some` = 精确
    ///   快照日期 `YYYY-MM-DD`（与 `inventory_snapshot_options` 返回的
    ///   `report_date` 一一对应）。
    pub async fn inventory_analysis(
        &self,
        project_id: i64,
        country: &str,
        report_date: Option<NaiveDate>,
    ) -> Result<InventoryAnalysisResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with_opt_date("report_date", report_date);
        self.get_json(INVENTORY_ANALYSIS_PATH, &query.clone().into_pairs())
            .await
    }

    /// 业务日期快照选项（项目 × 站点维度；`is_current` 标记最新一期）
    pub async fn inventory_snapshot_options(
        &self,
        project_id: i64,
        country: &str,
    ) -> Result<Vec<InventorySnapshotOption>, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country);
        self.get_json(INVENTORY_SNAPSHOT_OPTIONS_PATH, &query.clone().into_pairs())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 portfolio.rs 测试同款）
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
    fn inventory_paths_match_backend_routes() {
        assert_eq!(INVENTORY_ANALYSIS_PATH, "/api/v1/inventory-analysis");
        assert_eq!(
            INVENTORY_SNAPSHOT_OPTIONS_PATH,
            "/api/v1/inventory-snapshot-options"
        );
    }

    /// mock HTTP：请求携带 project_id / country / report_date 三个参数并携带
    /// 会话身份头；响应按 InventoryAnalysisResponse 解析（汇总 + 明细 +
    /// shipment 动态列 + 合计）。
    #[tokio::test]
    async fn inventory_analysis_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INVENTORY_ANALYSIS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("report_date".into(), "2026-08-15".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "report_date": "2026-08-15",
                    "summary": {
                        "sku_count": 1, "out_of_stock_count": 0, "aging_sku_count": 0,
                        "over_aged_sku_count": 0, "total_available_qty": 100,
                        "total_age_0_90_qty": 80, "total_age_91_180_qty": 20,
                        "total_age_181_270_qty": 0, "total_age_271_365_qty": 0,
                        "total_age_365_plus_qty": 0, "action_type_count": 1
                    },
                    "action_options": ["补货"],
                    "items": [{
                        "project_id": 3, "project_name": "测试项目 A", "country": "US",
                        "sku": "SKU-A", "asin": "B0TEST", "product_name": "测试产品",
                        "available_qty": 100, "age_0_90_qty": 80, "age_91_180_qty": 20,
                        "age_181_270_qty": 0, "age_271_365_qty": 0, "age_365_plus_qty": 0,
                        "recommended_action": "replenish", "recommended_action_label": "建议补货",
                        "stock_status": "in_stock", "aging_status": "normal",
                        "shipment_quantities": {"SHIP-1": 50}
                    }],
                    "shipment_columns": [{
                        "shipment_no": "SHIP-1", "label": "在途 1",
                        "shipping_method": "海运", "forwarder_name": "货代甲",
                        "etd_date": "2026-08-20", "eta_date": "2026-09-05"
                    }],
                    "shipment_column_totals": {"SHIP-1": 50}
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .inventory_analysis(
                3,
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 15),
            )
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.summary.total_available_qty, 100);
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].sku, "SKU-A");
        assert_eq!(resp.shipment_columns[0].shipment_no, "SHIP-1");
        assert_eq!(resp.shipment_column_totals["SHIP-1"], 50);
    }

    /// 契约：`report_date = None`（最新业务日期）→ 不携带 report_date 参数
    #[tokio::test]
    async fn inventory_analysis_omits_report_date_when_none() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INVENTORY_ANALYSIS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "7".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 7, "project_name": "P", "country": "DE",
                    "report_date": "2026-08-15",
                    "summary": {
                        "sku_count": 0, "out_of_stock_count": 0, "aging_sku_count": 0,
                        "over_aged_sku_count": 0, "total_available_qty": 0,
                        "total_age_0_90_qty": 0, "total_age_91_180_qty": 0,
                        "total_age_181_270_qty": 0, "total_age_271_365_qty": 0,
                        "total_age_365_plus_qty": 0, "action_type_count": 0
                    },
                    "action_options": [], "items": [],
                    "shipment_columns": [], "shipment_column_totals": {}
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.inventory_analysis(7, "DE", None).await.expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
    }

    /// mock HTTP：快照选项列表解析（`is_current` 标记）
    #[tokio::test]
    async fn inventory_snapshot_options_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INVENTORY_SNAPSHOT_OPTIONS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"report_date": "2026-08-15", "is_current": true},
                    {"report_date": "2026-08-08", "is_current": false}
                ]"#,
            )
            .create();

        let client = session_client(&server.url());
        let opts = client
            .inventory_snapshot_options(3, "US")
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(opts.len(), 2);
        assert!(opts[0].is_current);
        assert_eq!(
            opts[0].report_date,
            NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期")
        );
        assert!(!opts[1].is_current);
    }

    /// 服务端 422（如 project_id 缺失）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn inventory_analysis_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", INVENTORY_ANALYSIS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "0".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
            ]))
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"project_id 必须为正整数"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .inventory_analysis(0, "US", None)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "project_id 必须为正整数");
    }
}
