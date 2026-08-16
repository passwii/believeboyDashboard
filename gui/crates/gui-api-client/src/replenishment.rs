//! 运营 → 补货分析 API（P5-2，BLF-721）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/inventory_replenishment.py`
//! （`/api/v1/inventory-replenishment-analysis`），与 frontend
//! `app/dashboard/operations/inventory-replenishment/` 的调用口径一致：
//! - `GET /api/v1/inventory-replenishment-analysis?project_id&country
//!   [&keyword][&risk_status][&in_transit_only][&page][&page_size]`
//!   （web 端 keyword / risk_status / in_transit_only 均为服务端过滤；GUI 首版
//!   只消费 project_id + country + 分页，风险/关键词过滤走客户端表格搜索，
//!   对齐 ledger 的「原始行唯一真相源」模式）。
//!
//! GUI 首版不迁移快照模式 / 日历 / 设置编辑 / 发货明细端点（issue 允许简化）；
//! 后续迭代如需，按本模块模式补 `PUT /inventory-replenishment-settings/...`
//! 与 `GET /inventory-replenishment-shipments`。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头（见 client.rs）。

use gui_domain::operations::replenishment::ReplenishmentResponse;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/inventory-replenishment-analysis` —— 单项目 × 单站点的实时补货分析
/// （items + summary + 分页）
pub(crate) const REPLENISHMENT_ANALYSIS_PATH: &str = "/api/v1/inventory-replenishment-analysis";

impl Client {
    /// 实时补货分析（对齐 frontend `fetchOpsJsonCached` 的 URLSearchParams 口径）：
    /// - `project_id`：必填（backend `Query(gt=0)`；视图层在项目列表为空时守卫）；
    /// - `country`：`US` / `DE` / `UK`（backend 默认 `"US"`）；
    /// - `page` / `page_size`：服务端分页（backend 默认 1 / 50，page_size ≤ 200）。
    ///   GUI 首版一次拉 200 条上限内的全量行做客户端筛选/排序（对齐 ledger 模式），
    ///   超出部分由 `has_next` 提示（视图层展示「仅显示前 N 条」）。
    pub async fn replenishment_analysis(
        &self,
        project_id: i64,
        country: &str,
        page: i64,
        page_size: i64,
    ) -> Result<ReplenishmentResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with("page", page)
            .with("page_size", page_size);
        self.get_json(REPLENISHMENT_ANALYSIS_PATH, &query.clone().into_pairs())
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
    fn replenishment_path_matches_backend_route() {
        assert_eq!(
            REPLENISHMENT_ANALYSIS_PATH,
            "/api/v1/inventory-replenishment-analysis"
        );
    }

    /// mock HTTP：请求携带 project_id / country / page / page_size 四个参数并携带
    /// 会话身份头；响应按 ReplenishmentResponse 解析（items + summary + 分页）。
    #[tokio::test]
    async fn replenishment_analysis_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", REPLENISHMENT_ANALYSIS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
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
                        "project_id": 3, "project_name": "测试项目 A", "sku": "SKU-A",
                        "country": "US", "asin": "B0TEST", "product_name": "测试产品",
                        "available_inventory": 100, "in_transit_quantity": 50,
                        "dms_30": 2.5, "weighted_dms": 2.1, "sellable_days": 47.6,
                        "sellout_date": "2026-10-01", "safety_factor": 1.2,
                        "production_lead_days": 30, "shipping_days": 35,
                        "estimated_replenishment_quantity": 200,
                        "risk_status": "健康库存", "inventory_state": "healthy",
                        "replenishment_action": "NO_ACTION",
                        "latest_order_date": "2026-09-01", "target_days": 90
                    }],
                    "summary": {
                        "sku_count": 1, "out_of_stock_risk_count": 0, "healthy_count": 1,
                        "slow_moving_count": 0, "pending_data_count": 0,
                        "total_available_inventory": 100, "total_in_transit_quantity": 50,
                        "critical_count": 0, "deteriorating_count": 0
                    },
                    "page": 1, "page_size": 200, "total": 1, "has_next": false
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .replenishment_analysis(3, "US", 1, 200)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].sku, "SKU-A");
        assert_eq!(resp.summary.healthy_count, 1);
        assert_eq!(resp.total, 1);
        assert!(!resp.has_next);
    }

    /// 服务端 422（如 project_id 非法）→ detail 透传（视图错误态提示）
    #[tokio::test]
    async fn replenishment_analysis_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", REPLENISHMENT_ANALYSIS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "0".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "200".into()),
            ]))
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"project_id 必须为正整数"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .replenishment_analysis(0, "US", 1, 200)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.user_message(), "project_id 必须为正整数");
    }
}
