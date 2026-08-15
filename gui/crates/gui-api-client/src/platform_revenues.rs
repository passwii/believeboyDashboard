//! 财务资金 API（P3-4，BLF-704）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/platform_revenues.py`，与 frontend
//! `app/dashboard/finance/platform-revenue/page.tsx` 调用口径一致）：
//! - 平台回款列表      →  `GET /api/v1/platform-revenues`
//! - 项目可用站点      →  `GET /api/v1/platform-revenues/project-countries/{project_id}`
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 三个 header（backend `protected` 依赖读取，见 client.rs）。

use gui_domain::finance::PlatformRevenueListResponse;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /platform-revenues` —— 平台回款分页列表主端点
pub(crate) const PLATFORM_REVENUES_PATH: &str = "/api/v1/platform-revenues";

/// `GET /platform-revenues/project-countries/{project_id}` —— 项目可用站点
pub(crate) const PLATFORM_REVENUE_COUNTRIES_PATH: &str =
    "/api/v1/platform-revenues/project-countries";

impl Client {
    /// 平台回款分页列表
    ///
    /// 对齐 frontend `platform-revenue/page.tsx` 的 `URLSearchParams` 调用口径：
    /// - `page` / `page_size`：必填（backend 上限 200）；
    /// - `project_id` / `year` / `month` / `country` / `currency`：可选筛选；
    /// - `revenue_type` 不做筛选参数（frontend 传了但 backend list 端点未消费；
    ///   对齐时省略，避免多余契约）。
    #[allow(clippy::too_many_arguments)]
    pub async fn list_platform_revenues(
        &self,
        page: i64,
        page_size: i64,
        project_id: Option<i64>,
        year: Option<i64>,
        month: Option<i64>,
        country: Option<&str>,
        currency: Option<&str>,
    ) -> Result<PlatformRevenueListResponse, ApiError> {
        let mut query = vec![
            ("page", page.to_string()),
            ("page_size", page_size.to_string()),
        ];
        if let Some(id) = project_id {
            query.push(("project_id", id.to_string()));
        }
        if let Some(y) = year {
            query.push(("year", y.to_string()));
        }
        if let Some(m) = month {
            query.push(("month", m.to_string()));
        }
        if let Some(c) = country {
            query.push(("country", c.to_string()));
        }
        if let Some(c) = currency {
            query.push(("currency", c.to_string()));
        }
        self.get_json(PLATFORM_REVENUES_PATH, &query).await
    }

    /// 项目可用站点列表（平台回款录入时用；GUI 只读视图暂不消费，供后续扩展）
    pub async fn platform_revenue_project_countries(
        &self,
        project_id: i64,
    ) -> Result<Vec<String>, ApiError> {
        let path = format!("{PLATFORM_REVENUE_COUNTRIES_PATH}/{project_id}");
        self.get_json(&path, &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用）
    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试".into()),
            role_type: gui_domain::auth::UserRoleType::Operator,
            is_admin: false,
        };
        Client::new(base_url).with_session(session)
    }

    /// 契约测试：路径锁定 backend 实际路由
    #[test]
    fn platform_revenue_paths_match_backend_routes() {
        assert_eq!(PLATFORM_REVENUES_PATH, "/api/v1/platform-revenues");
        assert_eq!(
            PLATFORM_REVENUE_COUNTRIES_PATH,
            "/api/v1/platform-revenues/project-countries"
        );
    }

    #[tokio::test]
    async fn list_platform_revenues_sends_query_params_and_parses_response() {
        // 契约：列表端点，query 含分页 + 全部可选筛选（frontend 口径）
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PLATFORM_REVENUES_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "20".into()),
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("year".into(), "2026".into()),
                Matcher::UrlEncoded("month".into(), "8".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("currency".into(), "USD".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {
                            "id": 12,
                            "project_id": 3,
                            "project_name": "测试项目 A",
                            "country": "US",
                            "received_date": "2026-08-05",
                            "amount": "11693.69",
                            "currency": "USD",
                            "exchange_rate": null,
                            "revenue_type": "订单回款",
                            "note": null,
                            "attachments": [],
                            "screenshot_r2_key": null,
                            "screenshot_r2_url": null,
                            "created_by": "甲",
                            "created_at": "2026-08-05T10:00:00Z",
                            "updated_at": "2026-08-05T10:00:00Z"
                        }
                    ],
                    "total": 1,
                    "page": 1,
                    "page_size": 20,
                    "total_pages": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_platform_revenues(1, 20, Some(3), Some(2026), Some(8), Some("US"), Some("USD"))
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].id, 12);
        assert_eq!(resp.items[0].amount, "11693.69");
        assert_eq!(resp.items[0].currency, "USD");
    }

    #[tokio::test]
    async fn list_platform_revenues_omits_optional_filters_by_default() {
        // 契约：无筛选时只发 page / page_size
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", PLATFORM_REVENUES_PATH)
            // mockito 的 UrlEncoded 匹配是子集语义，无法断言缺省 → 用锚定 Regex
            // 锁定完整 query 字符串（恰好 2 个参数，无 project_id / year 等筛选）
            .match_query(Matcher::Regex(
                r"^page=2&page_size=50$".to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [],
                    "total": 0,
                    "page": 2,
                    "page_size": 50,
                    "total_pages": 1
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_platform_revenues(2, 50, None, None, None, None, None)
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.page, 2);
        assert_eq!(resp.page_size, 50);
    }
}
