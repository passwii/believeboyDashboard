//! 通用请求脚手架（P5-0 公共基建，BLF-759）
//!
//! 为后续 45 个业务板块视图提供「开箱即用」的模板方法，避免每个模块重复
//! 编写「拼 query → GET → 反序列化」样板：
//!
//! - [`QueryBuilder`]：顺序稳定的 query 参数构建器，支持直接消费
//!   [`gui_domain::filter::TableFilter`]（筛选栏输出 → HTTP 参数零转换）；
//! - [`Client::list_with_filter`]：`GET path?filter… → Vec<T>` 通用列表模板；
//! - [`Client::get_one`]：`GET path → T` 通用单条模板。
//!
//! ## 使用示例（新增一个业务模块）
//!
//! ```ignore
//! use gui_api_client::query::QueryBuilder;
//!
//! impl Client {
//!     /// GET /api/v1/inventory/stock-ledger → 库存分类账列表
//!     pub async fn stock_ledger(
//!         &self,
//!         filter: &gui_domain::filter::TableFilter,
//!         limit: i64,
//!     ) -> Result<Vec<StockLedgerItem>, ApiError> {
//!         let query = QueryBuilder::new()
//!             .with("limit", limit)
//!             .with_filter(filter);
//!         self.list_with_filter("/api/v1/inventory/stock-ledger", &query).await
//!     }
//! }
//! ```
//!
//! 分页注意：后端各端点的分页契约不统一（有的 `limit/offset`，有的 `page/page_size`，
//! 有的返回 `{data, summary}` 包裹），模板方法不假设任何分页形状——视图按各自
//! 端点契约自行拼 `page` / `limit` 参数，客户端分页可复用 gui-app 的
//! `widgets::pagination`。

use gui_domain::filter::TableFilter;

use crate::client::Client;
use crate::error::ApiError;

/// 顺序稳定的 query 参数构建器（空条件不携带；便于 mockito 逐参断言）
#[derive(Debug, Clone, Default)]
pub struct QueryBuilder {
    pairs: Vec<(&'static str, String)>,
}

impl QueryBuilder {
    /// 空构建器
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加必填参数（`v` 为 `ToString` 的任何值）
    pub fn with(mut self, key: &'static str, value: impl ToString) -> Self {
        self.pairs.push((key, value.to_string()));
        self
    }

    /// 追加可选参数（`None` 跳过）
    pub fn with_opt(mut self, key: &'static str, value: Option<impl ToString>) -> Self {
        if let Some(v) = value {
            self.pairs.push((key, v.to_string()));
        }
        self
    }

    /// 追加可选日期参数（ISO 格式 `YYYY-MM-DD`；`None` 跳过）
    pub fn with_opt_date(
        self,
        key: &'static str,
        value: Option<chrono::NaiveDate>,
    ) -> Self {
        self.with_opt(key, value.map(|d| d.to_string()))
    }

    /// 追加 `TableFilter`（项目 / 国家 / 日期区间；空条件不携带）
    pub fn with_filter(mut self, filter: &TableFilter) -> Self {
        for (key, value) in filter.to_query_params() {
            self.pairs.push((key, value));
        }
        self
    }

    /// 是否为空（无任何参数）
    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// 参数数量
    pub fn len(&self) -> usize {
        self.pairs.len()
    }

    /// 取出参数对（供 `Client` 内部请求使用）
    pub(crate) fn into_pairs(self) -> Vec<(&'static str, String)> {
        self.pairs
    }
}

impl Client {
    /// 通用列表模板：`GET path?query` → 解析 `Vec<T>`
    ///
    /// 适用于后端直接返回 JSON 数组的列表端点。若端点返回 `{data: [...], ...}`
    /// 包裹结构，请按该端点契约定义响应类型并走 `get_one` / 既有 `get_json`。
    pub async fn list_with_filter<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &QueryBuilder,
    ) -> Result<Vec<T>, ApiError> {
        self.get_json(path, &query.clone().into_pairs()).await
    }

    /// 通用单条模板：`GET path` → 解析 `T`
    ///
    /// 适用于详情 / 包裹结构端点（对象或 `{...}` 响应体）。
    pub async fn get_one<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<T, ApiError> {
        self.get_json(path, &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use serde::Deserialize;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    // ---------- QueryBuilder 纯逻辑 ----------

    #[test]
    fn query_builder_default_is_empty() {
        let q = QueryBuilder::new();
        assert!(q.is_empty());
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn query_builder_with_opt_skips_none() {
        let q = QueryBuilder::new()
            .with("limit", 100)
            .with_opt("page", Some(2))
            .with_opt("offset", Option::<i64>::None);
        assert_eq!(q.len(), 2);
        let pairs = q.into_pairs();
        assert_eq!(pairs[0], ("limit", "100".to_string()));
        assert_eq!(pairs[1], ("page", "2".to_string()));
    }

    #[test]
    fn query_builder_with_opt_date_formats_iso() {
        let q = QueryBuilder::new()
            .with_opt_date("date_from", Some(d(2026, 8, 1)))
            .with_opt_date("date_to", None);
        let pairs = q.into_pairs();
        assert_eq!(pairs, vec![("date_from", "2026-08-01".to_string())]);
    }

    #[test]
    fn query_builder_with_filter_appends_all_set_fields() {
        let filter = TableFilter::default()
            .with_project(Some(7))
            .with_country("US")
            .with_range(Some(d(2026, 8, 1)), Some(d(2026, 8, 13)));
        let q = QueryBuilder::new().with_filter(&filter);
        assert_eq!(q.len(), 4);
        let pairs = q.into_pairs();
        assert_eq!(pairs[0], ("project_id", "7".to_string()));
        assert_eq!(pairs[3], ("date_to", "2026-08-13".to_string()));
    }

    #[test]
    fn query_builder_with_filter_empty_adds_nothing() {
        let q = QueryBuilder::new().with_filter(&TableFilter::default());
        assert!(q.is_empty());
    }

    // ---------- 模板方法（mock HTTP） ----------

    #[derive(Debug, Deserialize, PartialEq)]
    struct LedgerItem {
        id: i64,
        name: String,
    }

    #[tokio::test]
    async fn list_with_filter_sends_filter_params_and_parses_array() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/inventory/stock-ledger")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("project_id".into(), "7".into()),
                mockito::Matcher::UrlEncoded("country".into(), "US".into()),
                mockito::Matcher::UrlEncoded("date_from".into(), "2026-08-01".into()),
                mockito::Matcher::UrlEncoded("date_to".into(), "2026-08-13".into()),
                mockito::Matcher::UrlEncoded("limit".into(), "50".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"id": 1, "name": "SKU-A"}, {"id": 2, "name": "SKU-B"}]"#)
            .create();

        let client = Client::new(server.url());
        let filter = TableFilter::default()
            .with_project(Some(7))
            .with_country("US")
            .with_range(Some(d(2026, 8, 1)), Some(d(2026, 8, 13)));
        let query = QueryBuilder::new().with("limit", 50).with_filter(&filter);
        let items: Vec<LedgerItem> = client
            .list_with_filter("/api/v1/inventory/stock-ledger", &query)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], LedgerItem { id: 1, name: "SKU-A".into() });
    }

    #[tokio::test]
    async fn list_with_filter_empty_query_sends_no_params() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/inventory/stock-ledger")
            .match_query(mockito::Matcher::Regex("^$".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let client = Client::new(server.url());
        let items: Vec<LedgerItem> = client
            .list_with_filter(
                "/api/v1/inventory/stock-ledger",
                &QueryBuilder::new(),
            )
            .await
            .expect("请求失败");
        m.assert();
        assert!(items.is_empty());
    }

    #[tokio::test]
    async fn get_one_parses_object_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/projects/3")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id": 3, "name": "测试项目"}"#)
            .create();

        let client = Client::new(server.url());
        let item: LedgerItem = client
            .get_one("/api/v1/projects/3")
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(item, LedgerItem { id: 3, name: "测试项目".into() });
    }

    #[tokio::test]
    async fn get_one_propagates_server_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/projects/404")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"not found"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .get_one::<LedgerItem>("/api/v1/projects/404")
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(404));
    }
}
