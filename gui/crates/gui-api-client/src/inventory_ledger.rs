//! 运营 → 库存分类账 API（P5-2，BLF-720）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/inventory_ledger.py`
//! （前缀 `/api/v1/inventory-ledger`），与 frontend
//! `app/dashboard/operations/inventory-ledger/inventory-ledger-client.tsx`
//! 的 `fetchLedgerJson` 调用口径一致：
//! - `GET /months?project_id` —— 可用月份列表（每月 1 号）；
//! - `GET /snapshot?project_id&period` —— 月度快照（SKU 期末 + Disposition
//!   构成 + 跨月连续性校验）；
//! - `GET /trend?project_id&months` —— 近 N 月趋势（web 固定 `months=6`）；
//! - `GET /summary?project_id&period` —— Summary 视图日水位行；
//! - `GET /detail?project_id&period` —— Detail 视图事件行；
//! - `GET /batches?project_id` —— CSV 上传批次追溯；
//! - `GET /consistency?project_id&period` —— 双表对账结果。
//!
//! `period` 取 `/months` 返回的 `YYYY-MM-DD`（每月 1 号 = 整月口径；后端
//! 另支持 7d/last_month 等语法，页面只用月份值）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需 `api_key`
//! （`Authorization: Bearer`，BLF-711 登录按账号下发，见 client.rs）。

use gui_domain::operations::inventory_ledger::{
    LedgerConsistencyResult, LedgerDetailResponse, LedgerIngestBatchesResponse,
    LedgerMonthsResponse, LedgerSnapshotResponse, LedgerSummaryResponse, LedgerTrendResponse,
};

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /api/v1/inventory-ledger/months` —— 可用月份列表
pub(crate) const LEDGER_MONTHS_PATH: &str = "/api/v1/inventory-ledger/months";

/// `GET /api/v1/inventory-ledger/snapshot` —— 月度快照
pub(crate) const LEDGER_SNAPSHOT_PATH: &str = "/api/v1/inventory-ledger/snapshot";

/// `GET /api/v1/inventory-ledger/trend` —— 近 N 月趋势
pub(crate) const LEDGER_TREND_PATH: &str = "/api/v1/inventory-ledger/trend";

/// `GET /api/v1/inventory-ledger/summary` —— Summary 日水位行
pub(crate) const LEDGER_SUMMARY_PATH: &str = "/api/v1/inventory-ledger/summary";

/// `GET /api/v1/inventory-ledger/detail` —— Detail 事件行
pub(crate) const LEDGER_DETAIL_PATH: &str = "/api/v1/inventory-ledger/detail";

/// `GET /api/v1/inventory-ledger/batches` —— CSV 上传批次
pub(crate) const LEDGER_BATCHES_PATH: &str = "/api/v1/inventory-ledger/batches";

/// `GET /api/v1/inventory-ledger/consistency` —— 双表对账
pub(crate) const LEDGER_CONSISTENCY_PATH: &str = "/api/v1/inventory-ledger/consistency";

/// 趋势端点拉取月数（对齐 frontend `trend?...&months=6`）
pub const LEDGER_TREND_MONTHS: i64 = 6;

impl Client {
    /// 可用月份列表（`period` 下拉数据源；返回每月 1 号日期，倒序由后端给出）
    pub async fn ledger_months(
        &self,
        project_id: i64,
    ) -> Result<LedgerMonthsResponse, ApiError> {
        let query = QueryBuilder::new().with("project_id", project_id);
        self.get_json(LEDGER_MONTHS_PATH, &query.clone().into_pairs())
            .await
    }

    /// 月度快照（SKU 期末 + Disposition 构成 + 跨月连续性校验；
    /// `period` 为 `/months` 返回的 `YYYY-MM-DD` 月份值）
    pub async fn ledger_snapshot(
        &self,
        project_id: i64,
        period: &str,
    ) -> Result<LedgerSnapshotResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("period", period);
        self.get_json(LEDGER_SNAPSHOT_PATH, &query.clone().into_pairs())
            .await
    }

    /// 近 N 月趋势（项目级口径；`months` 为拉取月数，web 固定 6）
    pub async fn ledger_trend(
        &self,
        project_id: i64,
        months: i64,
    ) -> Result<LedgerTrendResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("months", months);
        self.get_json(LEDGER_TREND_PATH, &query.clone().into_pairs())
            .await
    }

    /// Summary 视图日水位行（22 列；date desc）
    pub async fn ledger_summary(
        &self,
        project_id: i64,
        period: &str,
    ) -> Result<LedgerSummaryResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("period", period);
        self.get_json(LEDGER_SUMMARY_PATH, &query.clone().into_pairs())
            .await
    }

    /// Detail 视图事件行（16 列；date desc）
    pub async fn ledger_detail(
        &self,
        project_id: i64,
        period: &str,
    ) -> Result<LedgerDetailResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("period", period);
        self.get_json(LEDGER_DETAIL_PATH, &query.clone().into_pairs())
            .await
    }

    /// CSV 上传批次追溯（项目维度，不分月）
    pub async fn ledger_batches(
        &self,
        project_id: i64,
    ) -> Result<LedgerIngestBatchesResponse, ApiError> {
        let query = QueryBuilder::new().with("project_id", project_id);
        self.get_json(LEDGER_BATCHES_PATH, &query.clone().into_pairs())
            .await
    }

    /// 双表对账（Detail 累加 vs Summary 水位变动）
    pub async fn ledger_consistency(
        &self,
        project_id: i64,
        period: &str,
    ) -> Result<LedgerConsistencyResult, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("period", period);
        self.get_json(LEDGER_CONSISTENCY_PATH, &query.clone().into_pairs())
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
    fn ledger_paths_match_backend_routes() {
        assert_eq!(LEDGER_MONTHS_PATH, "/api/v1/inventory-ledger/months");
        assert_eq!(LEDGER_SNAPSHOT_PATH, "/api/v1/inventory-ledger/snapshot");
        assert_eq!(LEDGER_TREND_PATH, "/api/v1/inventory-ledger/trend");
        assert_eq!(LEDGER_SUMMARY_PATH, "/api/v1/inventory-ledger/summary");
        assert_eq!(LEDGER_DETAIL_PATH, "/api/v1/inventory-ledger/detail");
        assert_eq!(LEDGER_BATCHES_PATH, "/api/v1/inventory-ledger/batches");
        assert_eq!(
            LEDGER_CONSISTENCY_PATH,
            "/api/v1/inventory-ledger/consistency"
        );
        assert_eq!(LEDGER_TREND_MONTHS, 6);
    }

    /// mock HTTP：months 携带 project_id + 会话身份头；响应解析
    #[tokio::test]
    async fn ledger_months_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_MONTHS_PATH)
            .match_query(Matcher::AllOf(vec![Matcher::UrlEncoded(
                "project_id".into(),
                "3".into(),
            )]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"project_id": 3, "months": ["2026-07-01", "2026-06-01"]}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client.ledger_months(3).await.expect("请求失败");
        m.assert();
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.months.len(), 2);
    }

    /// mock HTTP：snapshot 携带 project_id + period；响应解析（含 integrity）
    #[tokio::test]
    async fn ledger_snapshot_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_SNAPSHOT_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("period".into(), "2026-07-01".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "report_month": "2026-07-01", "sku_count": 1, "total_qty": 100,
                    "disposition_summary": [
                        {"disposition": "SELLABLE", "qty_eom": 100, "pct_of_total": 100.0}
                    ],
                    "skus": [{"msku": "SKU-A", "qty_eom": 100, "sellable_qty": 100}],
                    "integrity": null
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ledger_snapshot(3, "2026-07-01")
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.sku_count, 1);
        assert_eq!(resp.total_qty, 100);
        assert_eq!(resp.integrity, None);
    }

    /// mock HTTP：trend 携带 project_id + months=6；响应解析
    #[tokio::test]
    async fn ledger_trend_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_TREND_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("months".into(), "6".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "months": [
                        {"report_month": "2026-07", "total_qty_eom": 100, "damaged_pct": 1.5}
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ledger_trend(3, LEDGER_TREND_MONTHS)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.months.len(), 1);
        assert_eq!(resp.months[0].total_qty_eom, 100);
    }

    /// mock HTTP：summary 携带 project_id + period；行解析
    #[tokio::test]
    async fn ledger_summary_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_SUMMARY_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("period".into(), "2026-07-01".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "report_month": "2026-07-01",
                    "rows": [{
                        "id": 1, "date": "2026-07-15", "msku": "SKU-A",
                        "disposition": "SELLABLE", "location": "ONT8",
                        "starting_balance": 100, "ending_balance": 105
                    }]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ledger_summary(3, "2026-07-01")
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].ending_balance, 105);
    }

    /// mock HTTP：detail 携带 project_id + period；行解析
    #[tokio::test]
    async fn ledger_detail_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_DETAIL_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("period".into(), "2026-07-01".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "report_month": "2026-07-01",
                    "rows": [{
                        "id": 9, "date": "2026-07-10", "msku": "SKU-A",
                        "event_type": "Receipts", "quantity": 20,
                        "fulfillment_center": "ONT8", "disposition": "SELLABLE"
                    }]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ledger_detail(3, "2026-07-01")
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].quantity, 20);
    }

    /// mock HTTP：batches 携带 project_id；批次解析
    #[tokio::test]
    async fn ledger_batches_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_BATCHES_PATH)
            .match_query(Matcher::AllOf(vec![Matcher::UrlEncoded(
                "project_id".into(),
                "3".into(),
            )]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "batches": [{
                        "id": 7, "project_id": 3, "report_month": "2026-07-01",
                        "source_filename": "ledger.csv", "file_hash": "abc",
                        "file_size_bytes": 1024, "file_kind": "summary",
                        "loaded_at": "2026-08-01T09:00:00+00:00", "status": "success",
                        "rows_parsed": 100
                    }]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.ledger_batches(3).await.expect("请求失败");
        m.assert();
        assert_eq!(resp.batches.len(), 1);
        assert_eq!(resp.batches[0].status, "success");
    }

    /// mock HTTP：consistency 携带 project_id + period；对账结果解析
    #[tokio::test]
    async fn ledger_consistency_sends_params_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_CONSISTENCY_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("period".into(), "2026-07-01".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "report_month": "2026-07-01", "status": "OK",
                    "mismatch_count": 0, "mismatches": [],
                    "checked_at": "2026-08-15T10:00:00+00:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .ledger_consistency(3, "2026-07-01")
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.status, "OK");
        assert_eq!(resp.mismatch_count, 0);
    }

    /// 服务端 500（BEL-417 教训：后端错误不能伪装成空数据）→ detail 透传
    #[tokio::test]
    async fn ledger_summary_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LEDGER_SUMMARY_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("period".into(), "2026-07-01".into()),
            ]))
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Internal Server Error"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .ledger_summary(3, "2026-07-01")
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(500));
        assert_eq!(err.user_message(), "Internal Server Error");
    }
}
