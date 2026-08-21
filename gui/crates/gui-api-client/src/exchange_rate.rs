//! 财务资金 → 汇率信息 API（P5-5，BLF-732）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/exchange_rates.py`，
//! 与 frontend `app/api/exchange-rates/route.ts`（Next.js 代理层）的参数
//! 口径一致：
//! - `GET /api/v1/exchange-rates?currency&year_month&page&page_size` → 列表；
//!   代理层仅在 **年 + 月同时指定** 时才携带 `year_month`（后端为精确匹配，
//!   年/月单维筛选不支持），本模块同口径；
//! - `POST /api/v1/exchange-rates` → 新增（同货币同月唯一，冲突 409）；
//! - `PUT /api/v1/exchange-rates/{id}` → 更新；
//! - `DELETE /api/v1/exchange-rates/{id}` → 删除（204 空响应体）。
//!
//! 未接入（对齐 research_analysis 导入端点先例）：
//! - `POST /api/v1/exchange-rates/upload-image`（multipart 备注图上传）——
//!   reqwest 未启用 multipart feature，GUI 视图备注图上传 / 预览走 web 端；
//! - `GET /api/v1/exchange-rates/resolve` / `/options`——本页面未消费。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需
//! `Authorization: Bearer` api_key（BLF-711，见 client.rs）。

use serde::Serialize;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;
use gui_domain::exchange_rate::{ExchangeRateItem, ExchangeRateListResponse};

/// `GET /api/v1/exchange-rates` —— 汇率列表
pub(crate) const LIST_PATH: &str = "/api/v1/exchange-rates";

/// `POST /api/v1/exchange-rates` + `PUT|DELETE /api/v1/exchange-rates/{id}`
/// （前缀 + id 拼接）
pub(crate) const ITEM_PATH_PREFIX: &str = "/api/v1/exchange-rates";

/// 汇率列表共享筛选（对齐 web 代理层 `app/api/exchange-rates/route.ts` 的
/// GET 参数映射：`year_month` 仅在年 + 月同时指定时携带）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExchangeRateFilter {
    /// 货币代码（空 = 全部货币；backend 精确匹配 `currency.strip()`）
    pub currency: Option<String>,
    /// 年份（与 month 同时指定才生效）
    pub year: Option<i64>,
    /// 月份 1-12（与 year 同时指定才生效）
    pub month: Option<u32>,
}

impl ExchangeRateFilter {
    /// `YYYY-MM`（年 + 月同时指定时归一为两位月；否则 `None`——对齐 web 代理层
    /// `year && month` 才 set 的口径）
    pub fn year_month(&self) -> Option<String> {
        match (self.year, self.month) {
            (Some(year), Some(month)) => Some(format!("{year:04}-{month:02}")),
            _ => None,
        }
    }

    /// 组装列表 query 参数（顺序稳定，便于 mockito 逐参断言；空条件不携带）
    pub fn base_query(&self) -> QueryBuilder {
        QueryBuilder::new()
            .with_opt("currency", self.currency.as_deref())
            .with_opt("year_month", self.year_month())
    }
}

/// 新增 / 更新共享请求体（backend `ExchangeRateCreate` / `ExchangeRateUpdate`
/// 的并集；web 端新增与编辑提交同一 shape，`None` / 空列表不序列化）
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ExchangeRateSavePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub month: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub note_images: Vec<gui_domain::exchange_rate::ExchangeRateNoteImage>,
}

impl Client {
    /// 汇率列表（对齐 web `fetchRates`：分页 + 货币 / 年月筛选；
    /// 后端按 `year_month desc, currency asc` 排序）
    pub async fn exchange_rate_list(
        &self,
        filter: &ExchangeRateFilter,
        page: i64,
        page_size: i64,
    ) -> Result<ExchangeRateListResponse, ApiError> {
        let query = filter
            .base_query()
            .with("page", page)
            .with("page_size", page_size);
        self.get_json(LIST_PATH, &query.clone().into_pairs()).await
    }

    /// 新增汇率（对齐 web `handleSubmit` 新增分支；同货币同月唯一，冲突 409）
    pub async fn exchange_rate_create(
        &self,
        payload: &ExchangeRateSavePayload,
    ) -> Result<ExchangeRateItem, ApiError> {
        self.request_json(reqwest::Method::POST, LIST_PATH, &[], Some(payload))
            .await
    }

    /// 更新汇率（对齐 web `handleSubmit` 编辑分支；返回更新后的整条记录）
    pub async fn exchange_rate_update(
        &self,
        rate_id: i64,
        payload: &ExchangeRateSavePayload,
    ) -> Result<ExchangeRateItem, ApiError> {
        let path = format!("{ITEM_PATH_PREFIX}/{rate_id}");
        self.request_json(reqwest::Method::PUT, &path, &[], Some(payload))
            .await
    }

    /// 删除汇率（对齐 web `handleDelete`；204 空响应体）
    pub async fn exchange_rate_delete(&self, rate_id: i64) -> Result<(), ApiError> {
        let path = format!("{ITEM_PATH_PREFIX}/{rate_id}");
        self.request_discard::<ExchangeRateSavePayload>(
            reqwest::Method::DELETE,
            &path,
            &[],
            None,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::exchange_rate::ExchangeRateNoteImage;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 order_info.rs 同款）
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
        assert_eq!(LIST_PATH, "/api/v1/exchange-rates");
        assert_eq!(ITEM_PATH_PREFIX, "/api/v1/exchange-rates");
    }

    /// 契约：年 + 月同时指定 → `year_month=YYYY-MM`（两位月归一）
    #[test]
    fn filter_builds_year_month_only_when_both_set() {
        let both = ExchangeRateFilter {
            currency: Some("USD".into()),
            year: Some(2026),
            month: Some(8),
        };
        assert_eq!(both.year_month().as_deref(), Some("2026-08"));
        let pairs = both.base_query().into_pairs();
        assert_eq!(
            pairs,
            vec![
                ("currency", "USD".to_string()),
                ("year_month", "2026-08".to_string()),
            ]
        );

        // 仅年 / 仅月 → 不携带 year_month（对齐 web 代理层口径）
        let year_only = ExchangeRateFilter {
            year: Some(2026),
            ..ExchangeRateFilter::default()
        };
        assert_eq!(year_only.year_month(), None);
        assert!(year_only.base_query().into_pairs().is_empty());

        let month_only = ExchangeRateFilter {
            month: Some(3),
            ..ExchangeRateFilter::default()
        };
        assert_eq!(month_only.year_month(), None);

        // 空筛选不携带任何参数
        assert!(ExchangeRateFilter::default().base_query().is_empty());
    }

    /// mock HTTP：列表请求携带筛选 + 分页参数 + 会话头；响应按
    /// `ExchangeRateListResponse` 解析
    #[tokio::test]
    async fn list_sends_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("currency".into(), "USD".into()),
                Matcher::UrlEncoded("year_month".into(), "2026-08".into()),
                Matcher::UrlEncoded("page".into(), "2".into()),
                Matcher::UrlEncoded("page_size".into(), "12".into()),
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
                            "id": 11, "currency": "USD", "currency_name": "美元",
                            "year_month": "2026-08", "rate": 7.2345,
                            "description": "月初锁汇", "note_images": [],
                            "created_at": "2026-08-01T00:00:00+00:00",
                            "updated_at": "2026-08-20T06:23:00+00:00"
                        }
                    ],
                    "total": 1, "page": 2, "page_size": 12
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = ExchangeRateFilter {
            currency: Some("USD".into()),
            year: Some(2026),
            month: Some(8),
        };
        let resp = client
            .exchange_rate_list(&filter, 2, 12)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].currency, "USD");
        assert_eq!(resp.items[0].rate, 7.2345);
        assert_eq!(resp.items[0].year(), Some(2026));
        assert_eq!(resp.items[0].month(), Some(8));
    }

    /// mock HTTP：空筛选 → 仅分页参数
    #[tokio::test]
    async fn list_with_empty_filter_sends_only_paging() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "12".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "total": 0, "page": 1, "page_size": 12}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .exchange_rate_list(&ExchangeRateFilter::default(), 1, 12)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.total, 0);
    }

    /// mock HTTP：新增 POST 携带 JSON body（camelCase 不出现——serde 契约
    /// 全 snake_case 对齐 backend Pydantic）；响应解析整条记录
    #[tokio::test]
    async fn create_posts_body_and_parses_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", LIST_PATH)
            .match_body(Matcher::PartialJson(serde_json::json!({
                "currency": "EUR",
                "currency_name": "欧元",
                "year": 2026,
                "month": 9,
                "rate": 7.85,
                "description": "备注"
            })))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 21, "currency": "EUR", "currency_name": "欧元",
                    "year_month": "2026-09", "rate": 7.85,
                    "description": "备注", "note_images": [],
                    "created_at": "2026-08-21T00:00:00+00:00",
                    "updated_at": "2026-08-21T00:00:00+00:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let payload = ExchangeRateSavePayload {
            currency: Some("EUR".into()),
            currency_name: Some("欧元".into()),
            year: Some(2026),
            month: Some(9),
            rate: Some(7.85),
            description: Some("备注".into()),
            note_images: Vec::new(),
        };
        let created = client.exchange_rate_create(&payload).await.expect("请求失败");
        m.assert();
        assert_eq!(created.id, 21);
        assert_eq!(created.year_month, "2026-09");
    }

    /// mock HTTP：更新 PUT 携带增量 body；响应返回更新后的整条记录
    #[tokio::test]
    async fn update_puts_partial_body_and_parses_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("PUT", "/api/v1/exchange-rates/21")
            .match_body(Matcher::PartialJson(serde_json::json!({
                "rate": 7.9,
                "description": "月中调整"
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 21, "currency": "EUR", "currency_name": "欧元",
                    "year_month": "2026-09", "rate": 7.9,
                    "description": "月中调整", "note_images": [],
                    "created_at": "2026-08-21T00:00:00+00:00",
                    "updated_at": "2026-08-21T08:00:00+00:00"
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let payload = ExchangeRateSavePayload {
            rate: Some(7.9),
            description: Some("月中调整".into()),
            ..ExchangeRateSavePayload::default()
        };
        let updated = client
            .exchange_rate_update(21, &payload)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(updated.rate, 7.9);
        assert_eq!(updated.description.as_deref(), Some("月中调整"));
    }

    /// mock HTTP：删除 → 204 空响应体走 request_discard 不误报
    #[tokio::test]
    async fn delete_handles_204_empty_body() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("DELETE", "/api/v1/exchange-rates/21")
            .with_status(204)
            .create();

        let client = session_client(&server.url());
        client.exchange_rate_delete(21).await.expect("请求失败");
        m.assert();
    }

    /// 服务端 409（同货币同月重复）→ 透传错误消息
    #[tokio::test]
    async fn create_propagates_conflict_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", LIST_PATH)
            .match_body(Matcher::Any)
            .with_status(409)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"detail":"Exchange rate for this currency and month already exists"}"#,
            )
            .create();

        let client = Client::new(server.url());
        let payload = ExchangeRateSavePayload {
            currency: Some("USD".into()),
            year: Some(2026),
            month: Some(8),
            rate: Some(7.2),
            ..ExchangeRateSavePayload::default()
        };
        let err = client
            .exchange_rate_create(&payload)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(409));
        assert_eq!(
            err.user_message(),
            "Exchange rate for this currency and month already exists"
        );
    }

    /// payload 序列化：`None` 字段不出现（skip_serializing_if 契约）；
    /// 备注图嵌套结构对齐 backend `ExchangeRateNoteImage`
    #[test]
    fn save_payload_serializes_only_set_fields() {
        let minimal = ExchangeRateSavePayload::default();
        let json = serde_json::to_value(&minimal).expect("序列化失败");
        assert_eq!(json, serde_json::json!({}));

        let note = ExchangeRateNoteImage {
            id: "abc".into(),
            url: "https://r2/img.webp".into(),
            thumbnail_url: Some("https://r2/thumb.webp".into()),
            r2_key: None,
            thumbnail_key: None,
            filename: "note.webp".into(),
            content_type: "image/webp".into(),
            size: 1024,
            uploaded_at: "2026-08-01T00:00:00+00:00".into(),
        };
        let full = ExchangeRateSavePayload {
            currency: Some("USD".into()),
            note_images: vec![note],
            ..ExchangeRateSavePayload::default()
        };
        let json = serde_json::to_value(&full).expect("序列化失败");
        assert_eq!(
            json,
            serde_json::json!({
                "currency": "USD",
                "note_images": [{
                    "id": "abc",
                    "url": "https://r2/img.webp",
                    "thumbnail_url": "https://r2/thumb.webp",
                    "filename": "note.webp",
                    "content_type": "image/webp",
                    "size": 1024,
                    "uploaded_at": "2026-08-01T00:00:00+00:00"
                }]
            })
        );
    }
}
