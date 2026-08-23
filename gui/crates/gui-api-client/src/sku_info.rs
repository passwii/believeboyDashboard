//! 运营 → SKU 信息 API（BLF-798）
//!
//! 端点对齐 backend `GET /api/v1/sku-info`（web 蓝本
//! `app/dashboard/operations/sku-info/page.tsx` 同源）：
//! 全参数可选（project_name / sku / country / is_active / 分页 /
//! include_total），供 GUI SKU 信息页按 Console Bar 筛选组合查询。
//!
//! 与 [`crate::shop_calculation::list_sku_records`] 的差异：那一个是店铺测算
//! 视图专用口径（project_name/country/is_active 必带、固定 1/200）；本模块
//! 提供全可选签名，两套调用互不影响、共享同一后端路由。
//!
//! 鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；backend 路由校验会话并按 operator 过滤可见项目。

use gui_domain::operations::shop_calculation::SkuRecordsPage;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /api/v1/sku-info` —— SKU 档案分页（与 shop_calculation 共享后端路由）
pub const SKU_INFO_PATH: &str = "/api/v1/sku-info";

impl Client {
    /// SKU 档案分页（全参数可选；`None` 字段不下发 query）。
    ///
    /// - `project_name`：按项目名过滤；`None` = 全部可管理项目；
    /// - `keyword`：SKU 前缀/包含匹配（backend `sku` 参数，服务端过滤）；
    /// - `country`：站点码（US/DE/UK…）；`None` = 全部站点；
    /// - `is_active`：启用态过滤；`None` = 不筛；
    /// - `include_total`：需要精确总数时开启（底部分页器依赖）。
    #[allow(clippy::too_many_arguments)] // 查询参数一一对应 backend Query 字段，聚合结构反降可读性
    pub async fn list_sku_records_filtered(
        &self,
        project_name: Option<&str>,
        keyword: Option<&str>,
        country: Option<&str>,
        is_active: Option<bool>,
        page: usize,
        page_size: usize,
        include_total: bool,
    ) -> Result<SkuRecordsPage, ApiError> {
        let refs = sku_info_query(
            project_name,
            keyword,
            country,
            is_active,
            page,
            page_size,
            include_total,
        );
        self.get_json(SKU_INFO_PATH, &refs).await
    }
}


/// 构造 `GET /api/v1/sku-info` 的 query 对（纯函数；`None` 字段不下发）
fn sku_info_query(
    project_name: Option<&str>,
    keyword: Option<&str>,
    country: Option<&str>,
    is_active: Option<bool>,
    page: usize,
    page_size: usize,
    include_total: bool,
) -> Vec<(&'static str, String)> {
    let mut query: Vec<(&'static str, String)> = Vec::new();
    if let Some(name) = project_name {
        query.push(("project_name", name.to_string()));
    }
    if let Some(kw) = keyword {
        query.push(("sku", kw.to_string()));
    }
    if let Some(c) = country {
        query.push(("country", c.to_string()));
    }
    if let Some(active) = is_active {
        query.push(("is_active", active.to_string()));
    }
    query.push(("page", page.to_string()));
    query.push(("page_size", page_size.to_string()));
    query.push((
        "include_total",
        if include_total { "true" } else { "false" }.to_string(),
    ));
    query
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::auth::UserRoleType;
    use mockito::Matcher;

    /// 构造一个带会话的 client（与 shop_calculation.rs 同款）
    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试运营".into()),
            role_type: UserRoleType::Operator,
            is_admin: false,
        };
        Client::new(base_url).with_session(session)
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn path_matches_backend_route() {
        assert_eq!(SKU_INFO_PATH, "/api/v1/sku-info");
    }

    /// mock HTTP：Some 字段全量下发 + 分页 + include_total；会话身份头携带
    #[tokio::test]
    async fn sends_all_params_and_parses_page() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SKU_INFO_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_name".into(), "测试项目 A".into()),
                Matcher::UrlEncoded("sku".into(), "BB-US".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("is_active".into(), "true".into()),
                Matcher::UrlEncoded("page".into(), "2".into()),
                Matcher::UrlEncoded("page_size".into(), "100".into()),
                Matcher::UrlEncoded("include_total".into(), "true".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [{
                    "id": 11, "project_name": "测试项目 A", "sku": "BB-US-001",
                    "asin": "B0TEST01", "fob_unit_cost": 45.0,
                    "first_leg_cost_rmb": 8.5, "package_length_cm": 30.0,
                    "package_width_cm": 20.0, "package_height_cm": 10.0,
                    "weight_kg": 1.2, "currency": "USD", "country": "US",
                    "sort_order": 0, "is_active": true
                }], "page": 2, "page_size": 100, "total": 101, "has_next": false}"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_sku_records_filtered(
                Some("测试项目 A"),
                Some("BB-US"),
                Some("US"),
                Some(true),
                2,
                100,
                true,
            )
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.total, Some(101));
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].sku, "BB-US-001");
        assert!(resp.items[0].is_active);
    }

    /// None 字段不下发 query（全部项目 / 不筛状态）——纯函数层断言
    #[test]
    fn omits_none_fields_from_query() {
        let q = sku_info_query(None, None, None, None, 1, 50, true);
        assert_eq!(
            q,
            vec![
                ("page", "1".to_string()),
                ("page_size", "50".to_string()),
                ("include_total", "true".to_string()),
            ]
        );
        // 全参数形态：键序稳定、值正确
        let q = sku_info_query(Some("项目 A"), Some("BB"), Some("US"), Some(false), 2, 100, false);
        assert_eq!(
            q,
            vec![
                ("project_name", "项目 A".to_string()),
                ("sku", "BB".to_string()),
                ("country", "US".to_string()),
                ("is_active", "false".to_string()),
                ("page", "2".to_string()),
                ("page_size", "100".to_string()),
                ("include_total", "false".to_string()),
            ]
        );
    }

    /// mock HTTP：最小查询（仅分页）可正常请求并解析
    #[tokio::test]
    async fn minimal_query_requests_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", SKU_INFO_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("page".into(), "1".into()),
                Matcher::UrlEncoded("page_size".into(), "50".into()),
                Matcher::UrlEncoded("include_total".into(), "true".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "page": 1, "page_size": 50}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client
            .list_sku_records_filtered(None, None, None, None, 1, 50, true)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
    }
}
